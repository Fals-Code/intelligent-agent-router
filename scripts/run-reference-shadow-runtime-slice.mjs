import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  DurableWorkflowStateMachine,
  ExecutionIntegrityCoordinator,
  JsonlExecutionIntegrityJournal,
  JsonlRunLedger,
  JsonlRuntimeBindingStore,
  JsonlWorkflowCheckpointStore,
  OpenCodeHttpClient,
  OpenCodeRuntimeAdapter,
  OpenCodeRuntimeReconciliationProbe,
  RuntimeBackedShadowExperimentExecutionAdapter,
  RuntimeReconciliationCoordinator,
  RuntimeRunLedgerFinalizer,
  RuntimeVerificationCoordinator,
} from "../dist/index.js";
import {
  validateShadowRuntimePrepareProof,
  validateShadowRuntimeRecoveryProof,
} from "./shadow-runtime-slice-policy.mjs";

const execFile = promisify(execFileCallback);
const phase = process.argv[2];
const projectDir = resolve(process.env.ROUTER_SHADOW_RUNTIME_PROJECT_DIR?.trim() || process.cwd());
const stateRootInput = process.env.ROUTER_SHADOW_RUNTIME_STATE_ROOT?.trim();
const baseUrl = process.env.OPENCODE_BASE_URL?.trim() || "http://127.0.0.1:4096";
const username = process.env.OPENCODE_SERVER_USERNAME?.trim() || "opencode";
const password = process.env.OPENCODE_SERVER_PASSWORD;
const referenceProviderId = requiredEnv("ROUTER_SHADOW_REFERENCE_PROVIDER_ID");
const referenceModelId = requiredEnv("ROUTER_SHADOW_REFERENCE_MODEL_ID");
const candidateProviderId = requiredEnv("ROUTER_SHADOW_CANDIDATE_PROVIDER_ID");
const candidateModelId = requiredEnv("ROUTER_SHADOW_CANDIDATE_MODEL_ID");
const STORE_LIMITS = Object.freeze({ maxFileBytes: 2 * 1024 * 1024, maxRecordBytes: 256 * 1024 });

if (phase !== "prepare" && phase !== "recover") {
  console.error("Usage: node scripts/run-reference-shadow-runtime-slice.mjs <prepare|recover>");
  process.exit(2);
}
if (!stateRootInput) {
  console.error("ROUTER_SHADOW_RUNTIME_STATE_ROOT is required and must identify one dedicated proof directory");
  process.exit(2);
}
if (referenceProviderId === candidateProviderId && referenceModelId === candidateModelId) {
  console.error("Reference and candidate OpenCode model targets must be distinct");
  process.exit(2);
}

const stateRoot = resolve(stateRootInput);
const manifestPath = join(stateRoot, "manifest.json");

try {
  if (phase === "prepare") await mkdir(stateRoot, { recursive: true });
  if (phase === "prepare") await prepare();
  else await recover();
} catch (error) {
  console.error(JSON.stringify({ overall: "FAIL", phase, error: safeError(error), stateRoot }, null, 2));
  process.exitCode = 1;
}

async function prepare() {
  await assertRouterRepository();
  const existingEntries = await readdir(stateRoot);
  if (existingEntries.length > 0) throw new Error(`Shadow runtime state root must be empty before prepare: ${stateRoot}`);

  const originalHead = await gitOutput(["rev-parse", "HEAD"]);
  const originalSnapshot = await workingTreeSnapshot();
  if (originalSnapshot.length > 0) throw new Error("Shadow runtime reference slice requires a clean router working tree");

  const stores = openStores();
  const machine = new DurableWorkflowStateMachine(stores.workflowStore);
  const projectId = "9router-reference-shadow-runtime";
  const referenceRun = createExecuteRun(machine, `shadow-reference-${Date.now()}`, projectId);
  const candidateRun = createExecuteRun(machine, `shadow-candidate-${Date.now()}`, projectId);

  const referenceRuntime = new OpenCodeRuntimeAdapter({
    baseUrl,
    username,
    password,
    model: { providerID: referenceProviderId, modelID: referenceModelId },
  });
  const candidateRuntime = new OpenCodeRuntimeAdapter({
    baseUrl,
    username,
    password,
    model: { providerID: candidateProviderId, modelID: candidateModelId },
  });
  const taskPrompt = [
    "This is a read-only shadow runtime infrastructure proof.",
    "Return a concise acknowledgement that the request was processed.",
    "Do not modify files, call tools, access the network, install packages, commit, push, deploy, or request approval.",
  ].join("\n");
  const taskContext = [
    "9Router controlled experiment shadow execution.",
    "No runtime tools are exposed.",
    "Provider output remains internal to the runtime session and is not eligible for publication or production routing.",
  ];

  const resolver = {
    async resolve({ role, subjectId }) {
      if (role === "reference") {
        return {
          subjectId,
          run: referenceRun,
          workspace: projectDir,
          adapter: referenceRuntime,
          bindingStore: stores.bindingStore,
          task: { taskId: `shadow-reference-task-${referenceRun.id}`, prompt: taskPrompt, context: taskContext, toolIds: [] },
        };
      }
      return {
        subjectId,
        run: candidateRun,
        workspace: projectDir,
        adapter: candidateRuntime,
        bindingStore: stores.bindingStore,
        task: { taskId: `shadow-candidate-task-${candidateRun.id}`, prompt: taskPrompt, context: taskContext, toolIds: [] },
      };
    },
  };

  const experimentAdapter = new RuntimeBackedShadowExperimentExecutionAdapter(resolver, {
    id: "opencode-shadow-runtime-reference-slice",
  });
  const dispatchRequest = Object.freeze({
    experimentId: "m5experiment:live-shadow-runtime-reference-slice",
    experimentSha256: "a".repeat(64),
    authorizationId: "m5expauth:live-shadow-runtime-reference-slice",
    authorizationSha256: "b".repeat(64),
    sampleId: `live-shadow-sample-${Date.now()}`,
    exposure: "shadow",
    liveAssignment: "none",
    inputReference: "reference-slice:fixed-shadow-input",
    referenceSubjectId: `opencode:${referenceProviderId}/${referenceModelId}`,
    candidateSubjectId: `opencode:${candidateProviderId}/${candidateModelId}`,
    candidateOutputMayBeExternallyVisible: false,
    idempotencyKey: `shadow-runtime-proof:${originalHead}:${Date.now()}`,
  });

  const receipt = await experimentAdapter.dispatch(dispatchRequest);
  const referenceBinding = requireBinding(stores.bindingStore, referenceRun.id, "reference");
  const candidateBinding = requireBinding(stores.bindingStore, candidateRun.id, "candidate");
  const integrity = new ExecutionIntegrityCoordinator({
    workflowStore: stores.workflowStore,
    bindingStore: stores.bindingStore,
    runLedger: stores.ledger,
    journal: stores.journal,
  });
  integrity.recordRuntimeBound(referenceRun, referenceBinding);
  integrity.recordRuntimeBound(candidateRun, candidateBinding);

  const [referenceRuntimeStatus, candidateRuntimeStatus] = await Promise.all([
    waitForCompletion(referenceRuntime, referenceBinding.sessionId, 5 * 60_000, "reference"),
    waitForCompletion(candidateRuntime, candidateBinding.sessionId, 5 * 60_000, "candidate"),
  ]);
  if (referenceRuntimeStatus !== "completed" || candidateRuntimeStatus !== "completed") {
    throw new Error(`Shadow runtime did not complete cleanly: reference=${referenceRuntimeStatus} candidate=${candidateRuntimeStatus}`);
  }

  const [referenceDiff, candidateDiff] = await Promise.all([
    referenceRuntime.getDiff(referenceBinding.sessionId),
    candidateRuntime.getDiff(candidateBinding.sessionId),
  ]);
  assertNoRuntimeMutation(referenceDiff, "reference");
  assertNoRuntimeMutation(candidateDiff, "candidate");

  const postHead = await gitOutput(["rev-parse", "HEAD"]);
  const postSnapshot = await workingTreeSnapshot();
  const proof = Object.freeze({
    phase: "prepare",
    processId: process.pid,
    referenceRunId: referenceRun.id,
    candidateRunId: candidateRun.id,
    referenceSessionId: referenceBinding.sessionId,
    candidateSessionId: candidateBinding.sessionId,
    referenceRuntimeStatus,
    candidateRuntimeStatus,
    referenceRuntimeBound: stores.journal.history(referenceRun.id).some((entry) => entry.stage === "runtime_bound"),
    candidateRuntimeBound: stores.journal.history(candidateRun.id).some((entry) => entry.stage === "runtime_bound"),
    identicalPromptAndContext: true,
    zeroRuntimeTools: true,
    candidateOutputMayBeExternallyVisible: dispatchRequest.candidateOutputMayBeExternallyVisible,
    candidateOutputExternallyVisible: receipt.candidateOutputExternallyVisible,
    productionRoutingMutationAllowed: false,
    automaticRedispatchAllowed: false,
    gitHeadUnchanged: postHead === originalHead,
    workingTreeUnchanged: sameArray(postSnapshot, originalSnapshot),
  });
  validateShadowRuntimePrepareProof(proof);

  await writeFile(manifestPath, `${JSON.stringify({
    schemaVersion: 1,
    prepareProcessId: process.pid,
    projectDir,
    originalHead,
    originalSnapshot,
    referenceRunId: referenceRun.id,
    candidateRunId: candidateRun.id,
    referenceSessionId: referenceBinding.sessionId,
    candidateSessionId: candidateBinding.sessionId,
    referenceModelRef: `${referenceProviderId}/${referenceModelId}`,
    candidateModelRef: `${candidateProviderId}/${candidateModelId}`,
    referenceExecutionReference: receipt.referenceExecutionReference,
    candidateExecutionReference: receipt.candidateExecutionReference,
    candidateOutputExternallyVisible: receipt.candidateOutputExternallyVisible,
    preparedAt: new Date().toISOString(),
  }, null, 2)}\n`, "utf8");

  console.log(JSON.stringify({
    overall: "PASS",
    referenceSlice: "9router-real-shadow-runtime-prepare",
    ...proof,
    stateRoot,
    nextPhase: "recover",
  }, null, 2));
}

async function recover() {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assertManifest(manifest);
  if (resolve(manifest.projectDir) !== projectDir) throw new Error("Shadow runtime project directory drifted between prepare and recover");
  if (manifest.prepareProcessId === process.pid) throw new Error("Shadow runtime recovery must run in a distinct control-plane process");

  const beforeHead = await gitOutput(["rev-parse", "HEAD"]);
  const beforeSnapshot = await workingTreeSnapshot();
  if (beforeHead !== manifest.originalHead || !sameArray(beforeSnapshot, manifest.originalSnapshot)) {
    throw new Error("Router repository drifted between shadow runtime prepare and recover phases");
  }

  let stores = openStores();
  let integrity = new ExecutionIntegrityCoordinator({
    workflowStore: stores.workflowStore,
    bindingStore: stores.bindingStore,
    runLedger: stores.ledger,
    journal: stores.journal,
  });
  const referenceRun = requireRun(stores.workflowStore, manifest.referenceRunId, "reference");
  const candidateRun = requireRun(stores.workflowStore, manifest.candidateRunId, "candidate");
  const referenceBinding = requireBinding(stores.bindingStore, referenceRun.id, "reference");
  const candidateBinding = requireBinding(stores.bindingStore, candidateRun.id, "candidate");
  if (referenceBinding.sessionId !== manifest.referenceSessionId || candidateBinding.sessionId !== manifest.candidateSessionId) {
    throw new Error("Recovered shadow runtime bindings do not match prepare manifest sessions");
  }

  const referencePreRecovery = integrity.inspect(referenceRun.id);
  const candidatePreRecovery = integrity.inspect(candidateRun.id);
  if (referencePreRecovery.disposition !== "reconcile_runtime" || candidatePreRecovery.disposition !== "reconcile_runtime") {
    throw new Error(`Expected reconcile_runtime after restart: reference=${referencePreRecovery.disposition} candidate=${candidatePreRecovery.disposition}`);
  }

  const probe = new OpenCodeRuntimeReconciliationProbe({ baseUrl, username, password });
  const reconciliationCoordinator = new RuntimeReconciliationCoordinator();
  const referenceReconciliation = await reconciliationCoordinator.reconcile(referenceRun, referenceBinding, probe);
  const candidateReconciliation = await reconciliationCoordinator.reconcile(candidateRun, candidateBinding, probe);
  assertVerificationReady(referenceReconciliation, "reference");
  assertVerificationReady(candidateReconciliation, "candidate");

  const verificationCoordinator = new RuntimeVerificationCoordinator();
  const referenceVerification = await verifyShadowRuntime(
    verificationCoordinator,
    referenceRun,
    referenceReconciliation,
    "reference",
    manifest,
  );
  const candidateVerification = await verifyShadowRuntime(
    verificationCoordinator,
    candidateRun,
    candidateReconciliation,
    "candidate",
    manifest,
  );
  if (!referenceVerification.passed || !candidateVerification.passed) throw new Error("Shadow runtime deterministic verification failed");
  integrity.recordVerification(referenceRun, referenceBinding, referenceVerification);
  integrity.recordVerification(candidateRun, candidateBinding, candidateVerification);

  // Reopen all state before continuation; verification itself must survive disk.
  stores = openStores();
  integrity = new ExecutionIntegrityCoordinator({
    workflowStore: stores.workflowStore,
    bindingStore: stores.bindingStore,
    runLedger: stores.ledger,
    journal: stores.journal,
  });
  const recoveredReferenceVerification = integrity.recoverVerification(referenceRun.id, referenceRun.attempt);
  const recoveredCandidateVerification = integrity.recoverVerification(candidateRun.id, candidateRun.attempt);
  if (!recoveredReferenceVerification?.passed || !recoveredCandidateVerification?.passed) {
    throw new Error("Shadow runtime verification evidence did not survive durable reopen");
  }

  finalizeShadowRun(stores, integrity, referenceRun.id, recoveredReferenceVerification, manifest.referenceModelRef, "reference", referenceReconciliation);
  finalizeShadowRun(stores, integrity, candidateRun.id, recoveredCandidateVerification, manifest.candidateModelRef, "candidate", candidateReconciliation);

  stores = openStores();
  integrity = new ExecutionIntegrityCoordinator({
    workflowStore: stores.workflowStore,
    bindingStore: stores.bindingStore,
    runLedger: stores.ledger,
    journal: stores.journal,
  });
  const referenceFinalInspection = integrity.inspect(referenceRun.id);
  const candidateFinalInspection = integrity.inspect(candidateRun.id);
  const referenceLedger = stores.ledger.get(referenceRun.id);
  const candidateLedger = stores.ledger.get(candidateRun.id);
  const finalReferenceVerification = integrity.recoverVerification(referenceRun.id, referenceRun.attempt);
  const finalCandidateVerification = integrity.recoverVerification(candidateRun.id, candidateRun.attempt);
  if (!referenceLedger || !candidateLedger || !finalReferenceVerification?.passed || !finalCandidateVerification?.passed) {
    throw new Error("Final shadow runtime durable reopen lost terminal ledger or verification evidence");
  }

  let referenceSessionDestroyed = false;
  let candidateSessionDestroyed = false;
  const client = new OpenCodeHttpClient({ baseUrl, username, password });
  await client.request({ method: "DELETE", path: `/session/${encodeURIComponent(manifest.referenceSessionId)}`, directory: referenceBinding.workspace });
  referenceSessionDestroyed = true;
  await client.request({ method: "DELETE", path: `/session/${encodeURIComponent(manifest.candidateSessionId)}`, directory: candidateBinding.workspace });
  candidateSessionDestroyed = true;

  const afterHead = await gitOutput(["rev-parse", "HEAD"]);
  const afterSnapshot = await workingTreeSnapshot();
  const proof = Object.freeze({
    phase: "recover",
    prepareProcessId: manifest.prepareProcessId,
    recoverProcessId: process.pid,
    processRestartProven: manifest.prepareProcessId !== process.pid,
    providerRestarted: false,
    referencePreRecoveryDisposition: referencePreRecovery.disposition,
    candidatePreRecoveryDisposition: candidatePreRecovery.disposition,
    referenceRuntimeReconciliationDisposition: referenceReconciliation.disposition,
    candidateRuntimeReconciliationDisposition: candidateReconciliation.disposition,
    referenceRuntimeObservationStatus: referenceReconciliation.observation.status,
    candidateRuntimeObservationStatus: candidateReconciliation.observation.status,
    referenceVerificationPassed: referenceVerification.passed,
    candidateVerificationPassed: candidateVerification.passed,
    referenceVerificationRecoveredFromDisk: finalReferenceVerification.passed,
    candidateVerificationRecoveredFromDisk: finalCandidateVerification.passed,
    referenceFinalIntegrityDisposition: referenceFinalInspection.disposition,
    candidateFinalIntegrityDisposition: candidateFinalInspection.disposition,
    referenceRunLedgerOutcome: referenceLedger.outcome,
    candidateRunLedgerOutcome: candidateLedger.outcome,
    referenceSessionDestroyed,
    candidateSessionDestroyed,
    candidateOutputExternallyVisible: manifest.candidateOutputExternallyVisible,
    productionRoutingMutationAllowed: false,
    automaticRedispatchAllowed: false,
    gitHeadUnchanged: afterHead === manifest.originalHead,
    workingTreeUnchanged: sameArray(afterSnapshot, manifest.originalSnapshot),
  });
  validateShadowRuntimeRecoveryProof(proof);

  const hashes = {};
  for (const name of ["workflow.jsonl", "binding.jsonl", "integrity.jsonl", "ledger.jsonl", "manifest.json"]) {
    hashes[name] = await sha256File(join(stateRoot, name));
  }

  console.log(JSON.stringify({
    overall: "PASS",
    referenceSlice: "9router-real-shadow-runtime-recovery",
    ...proof,
    stateRoot,
    durableHashes: hashes,
    referenceExecutionReference: manifest.referenceExecutionReference,
    candidateExecutionReference: manifest.candidateExecutionReference,
    rawProviderOutputPersisted: false,
    rawProviderPatchPersisted: false,
    nextGate: "INDEPENDENT_LIVE_SHADOW_RUNTIME_REVIEW",
  }, null, 2));
}

function createExecuteRun(machine, id, projectId) {
  let run = machine.create({ id, projectId, riskClass: "R0" });
  run = machine.start(run);
  run = machine.advance(run);
  run = machine.advance(run);
  if (run.phase !== "execute" || run.status !== "running" || run.attempt !== 1) {
    throw new Error(`Unexpected shadow runtime workflow state: ${run.id} ${run.phase}/${run.status}/attempt=${run.attempt}`);
  }
  return run;
}

async function verifyShadowRuntime(coordinator, run, reconciliation, role, manifest) {
  return coordinator.verify(run, reconciliation, {
    id: `shadow-runtime-${role}-verifier`,
    async verify({ observation }) {
      const currentHead = await gitOutput(["rev-parse", "HEAD"]);
      const currentSnapshot = await workingTreeSnapshot();
      const checks = {
        completed: observation.status === "completed",
        taskStarted: observation.events.types.includes("task_started"),
        taskCompleted: observation.events.types.includes("task_completed"),
        noChangedFiles: observation.diff.filesChanged.length === 0,
        noPatch: observation.diff.patchObserved === false,
        headUnchanged: currentHead === manifest.originalHead,
        workingTreeUnchanged: sameArray(currentSnapshot, manifest.originalSnapshot),
        distinctProcess: manifest.prepareProcessId !== process.pid,
        candidateOutputExternallyVisible: false,
        productionRoutingMutationAllowed: false,
      };
      return {
        passed: Object.values(checks).every((value) => value === true || value === false && role !== "candidate" ? Boolean(value) : Boolean(value)),
        reference: `shadow-runtime:${role}:${run.id}:deterministic-proof`,
        collectedAt: new Date().toISOString(),
        metadata: {
          completed: checks.completed,
          taskStarted: checks.taskStarted,
          taskCompleted: checks.taskCompleted,
          noChangedFiles: checks.noChangedFiles,
          noPatch: checks.noPatch,
          headUnchanged: checks.headUnchanged,
          workingTreeUnchanged: checks.workingTreeUnchanged,
          distinctProcess: checks.distinctProcess,
          candidateOutputExternallyVisible: false,
          productionRoutingMutationAllowed: false,
          eventCount: observation.events.count,
        },
      };
    },
  });
}

function finalizeShadowRun(stores, integrity, runId, verification, modelRef, role, reconciliation) {
  let run = requireRun(stores.workflowStore, runId, role);
  const machine = new DurableWorkflowStateMachine(stores.workflowStore);
  run = machine.advance(run); // execute -> verify
  run = machine.advance(run); // verify -> review
  run = machine.skipApproval(run); // R0 read-only shadow proof
  run = machine.succeed(run, true);
  integrity.recordWorkflowTerminal(run);
  const binding = requireBinding(stores.bindingStore, run.id, role);
  new RuntimeRunLedgerFinalizer().appendTerminal({
    run,
    binding,
    ledger: stores.ledger,
    task: `live OpenCode ${role} shadow runtime reference slice`,
    modelRoute: [`opencode:${modelRef}`],
    contextCompilerVersion: "reference-shadow-runtime/v1",
    skills: ["runtime.binding", "runtime.reconciliation", "deterministic.verification"],
    toolsets: [],
    policyDecisions: ["R0 shadow-only", "zero runtime tools", "no external candidate output", "no automatic redispatch"],
    changeReferences: [],
    evidence: [{
      kind: "policy",
      status: "passed",
      reference: `policy:reference-shadow-runtime-${role}`,
      producer: "reference-shadow-runtime-harness",
      collectedAt: new Date().toISOString(),
      metadata: {
        shadowOnly: true,
        mutationAllowed: false,
        candidateOutputExternallyVisible: false,
        automaticRedispatchAllowed: false,
      },
    }],
    verification,
    resourceMetrics: {
      runtimeEventCount: reconciliation.observation.events.count,
      runtimeFilesChanged: reconciliation.observation.diff.filesChanged.length,
    },
    traceId: `shadow-runtime:${role}:${run.id}`,
  });
  integrity.recordLedgerFinalized(run);
}

async function waitForCompletion(runtime, sessionId, timeoutMs, role) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const events = await runtime.getEvents(sessionId);
    const approval = events.find((event) => event.type === "approval_requested");
    if (approval) {
      const approvalId = typeof approval.metadata?.approvalId === "string" ? approval.metadata.approvalId : undefined;
      if (approvalId) {
        try { await runtime.respondToApproval(sessionId, { approvalId, decision: "denied", actor: "shadow-runtime-reference-policy" }); } catch {}
      }
      throw new Error(`${role} shadow runtime requested approval; request denied`);
    }
    const status = await runtime.getStatus(sessionId);
    if (["completed", "failed", "aborted", "destroyed", "interrupted"].includes(status)) return status;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
  }
  try { await runtime.abort(sessionId, `${role} shadow runtime reference slice timeout`); } catch {}
  throw new Error(`${role} shadow runtime exceeded ${Math.round(timeoutMs / 1000)} seconds`);
}

function assertNoRuntimeMutation(diff, role) {
  if (diff.filesChanged.length > 0 || Boolean(diff.patch) || Boolean(diff.commitSha)) {
    throw new Error(`${role} shadow runtime reported a mutation`);
  }
}

function assertVerificationReady(reconciliation, role) {
  if (reconciliation.disposition !== "verify_runtime_result" || reconciliation.observation?.status !== "completed") {
    throw new Error(`${role} shadow runtime is not verification-ready: disposition=${reconciliation.disposition} status=${reconciliation.observation?.status ?? "missing"}`);
  }
}

function openStores() {
  return {
    workflowStore: new JsonlWorkflowCheckpointStore({
      filePath: join(stateRoot, "workflow.jsonl"),
      maxFileBytes: STORE_LIMITS.maxFileBytes,
      maxCheckpointBytes: STORE_LIMITS.maxRecordBytes,
    }),
    bindingStore: new JsonlRuntimeBindingStore({
      filePath: join(stateRoot, "binding.jsonl"),
      maxFileBytes: STORE_LIMITS.maxFileBytes,
      maxBindingBytes: STORE_LIMITS.maxRecordBytes,
    }),
    journal: new JsonlExecutionIntegrityJournal({
      filePath: join(stateRoot, "integrity.jsonl"),
      maxFileBytes: STORE_LIMITS.maxFileBytes,
      maxEntryBytes: STORE_LIMITS.maxRecordBytes,
    }),
    ledger: new JsonlRunLedger({
      filePath: join(stateRoot, "ledger.jsonl"),
      maxFileBytes: STORE_LIMITS.maxFileBytes,
      maxRecordBytes: STORE_LIMITS.maxRecordBytes,
    }),
  };
}

function requireRun(store, runId, role) {
  const run = store.get(runId);
  if (!run) throw new Error(`Durable ${role} shadow workflow is missing: ${runId}`);
  return run;
}

function requireBinding(store, runId, role) {
  const binding = store.get(runId);
  if (!binding) throw new Error(`Durable ${role} shadow runtime binding is missing: ${runId}`);
  return binding;
}

async function assertRouterRepository() {
  const packageJson = JSON.parse(await readFile(join(projectDir, "package.json"), "utf8"));
  if (packageJson?.name !== "intelligent-agent-router") {
    throw new Error(`Shadow runtime reference slice must target intelligent-agent-router, received=${String(packageJson?.name ?? "unknown")}`);
  }
}

async function gitOutput(args) {
  const result = await execFile("git", ["-C", projectDir, ...args], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  return result.stdout.trim();
}

async function workingTreeSnapshot() {
  const output = await gitOutput(["status", "--porcelain=v1", "--untracked-files=all"]);
  return output ? output.split(/\r?\n/).filter(Boolean).sort() : [];
}

function sameArray(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => item === right[index]);
}

function assertManifest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Shadow runtime manifest must be an object");
  if (value.schemaVersion !== 1) throw new Error(`Unsupported shadow runtime manifest schema: ${String(value.schemaVersion)}`);
  for (const field of [
    "projectDir", "originalHead", "referenceRunId", "candidateRunId", "referenceSessionId", "candidateSessionId",
    "referenceModelRef", "candidateModelRef", "referenceExecutionReference", "candidateExecutionReference",
  ]) {
    if (typeof value[field] !== "string" || !value[field].trim()) throw new Error(`Shadow runtime manifest.${field} must not be empty`);
  }
  if (!Number.isInteger(value.prepareProcessId) || value.prepareProcessId <= 0) throw new Error("Shadow runtime manifest.prepareProcessId must be a positive integer");
  if (!Array.isArray(value.originalSnapshot) || value.originalSnapshot.some((item) => typeof item !== "string")) {
    throw new Error("Shadow runtime manifest.originalSnapshot must be an array of strings");
  }
  if (value.candidateOutputExternallyVisible !== false) throw new Error("Shadow runtime manifest cannot claim candidate external visibility");
}

async function sha256File(path) {
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`${name} is required`);
    process.exit(2);
  }
  return value;
}

function safeError(error) {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/(authorization|api[_-]?key|access[_-]?token|password|secret|credential)\s*[:=]\s*(Bearer\s+)?[^\s,;]+/gi, "$1=[redacted]")
    .slice(0, 2000);
}
