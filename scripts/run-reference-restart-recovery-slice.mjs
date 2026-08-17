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
  RuntimeReconciliationCoordinator,
  RuntimeRunLedgerFinalizer,
  RuntimeSessionBindingCoordinator,
  RuntimeVerificationCoordinator,
} from "../dist/index.js";
import { validatePrepareProof, validateRecoveryProof } from "./restart-recovery-slice-policy.mjs";

const execFile = promisify(execFileCallback);
const phase = process.argv[2];
const projectDir = resolve(process.env.ROUTER_RESTART_RECOVERY_PROJECT_DIR?.trim() || process.cwd());
const stateRootInput = process.env.ROUTER_RESTART_RECOVERY_STATE_ROOT?.trim();
const baseUrl = process.env.OPENCODE_BASE_URL?.trim() || "http://127.0.0.1:4096";
const username = process.env.OPENCODE_SERVER_USERNAME?.trim() || "opencode";
const password = process.env.OPENCODE_SERVER_PASSWORD;
const STORE_LIMITS = Object.freeze({ maxFileBytes: 2 * 1024 * 1024, maxRecordBytes: 256 * 1024 });

if (phase !== "prepare" && phase !== "recover") {
  console.error("Usage: node scripts/run-reference-restart-recovery-slice.mjs <prepare|recover>");
  process.exit(2);
}
if (!stateRootInput) {
  console.error("ROUTER_RESTART_RECOVERY_STATE_ROOT is required and must identify one dedicated proof directory");
  process.exit(2);
}

const stateRoot = resolve(stateRootInput);
const manifestPath = join(stateRoot, "manifest.json");

try {
  if (phase === "prepare") await mkdir(stateRoot, { recursive: true });
  if (phase === "prepare") await prepare();
  else await recover();
} catch (error) {
  console.error(JSON.stringify({
    overall: "FAIL",
    phase,
    error: safeError(error),
    stateRoot,
  }, null, 2));
  process.exitCode = 1;
}

async function prepare() {
  await assertRouterRepository();
  const existingStateEntries = await readdir(stateRoot);
  if (existingStateEntries.length > 0) {
    throw new Error(`Restart/recovery state root must be empty before prepare: ${stateRoot}`);
  }

  const originalHead = await gitOutput(["rev-parse", "HEAD"]);
  const originMain = await gitOutput(["rev-parse", "refs/remotes/origin/main"]);
  if (originalHead !== originMain) {
    throw new Error(`Router HEAD is not synchronized with origin/main: HEAD=${originalHead} origin/main=${originMain}`);
  }
  const originalSnapshot = await workingTreeSnapshot();
  if (originalSnapshot.length > 0) {
    throw new Error("Reference restart/recovery slice requires a clean router working tree");
  }

  const stores = openStores();
  const runId = `restart-recovery-${Date.now()}`;
  const projectId = "9router-reference-restart-recovery";
  const machine = new DurableWorkflowStateMachine(stores.workflowStore);
  let run = machine.create({ id: runId, projectId, riskClass: "R0" });
  run = machine.start(run);
  run = machine.advance(run);
  run = machine.advance(run);
  if (run.phase !== "execute" || run.status !== "running" || run.attempt !== 1) {
    throw new Error(`Unexpected prepare workflow state: ${run.phase}/${run.status}/attempt=${run.attempt}`);
  }

  const runtime = new OpenCodeRuntimeAdapter({ baseUrl, username, password });
  let sessionId;
  try {
    const bound = await new RuntimeSessionBindingCoordinator().createBoundSession({
      run,
      workspace: projectDir,
      adapter: runtime,
      bindingStore: stores.bindingStore,
      metadata: {
        purpose: "live-control-plane-restart-recovery-reference-slice",
        mutationPolicy: "read-only",
      },
    });
    sessionId = bound.session.id;

    const integrity = new ExecutionIntegrityCoordinator({
      workflowStore: stores.workflowStore,
      bindingStore: stores.bindingStore,
      runLedger: stores.ledger,
      journal: stores.journal,
    });
    integrity.recordRuntimeBound(run, bound.binding);

    await runtime.sendTask(bound.session.id, {
      taskId: `restart-recovery-readonly-${Date.now()}`,
      prompt: [
        "Inspect package.json and src/control-plane/contracts.ts.",
        "Return a concise statement of the package name and the purpose of WorkflowRun.",
        "Do not modify any file. Do not use shell, network access, package installation, commit, push, or deployment.",
      ].join("\n"),
      context: [
        "This is a read-only 9Router restart/recovery reference slice.",
        "The router repository must remain byte-for-byte unchanged at Git working-tree level.",
        "Only read, glob, grep, and list tools are allowed. Treat every mutation or approval request as a failure.",
      ],
      toolIds: ["read", "glob", "grep", "list"],
    });

    const runtimeStatus = await waitForCompletion(runtime, bound.session.id, 5 * 60_000);
    if (runtimeStatus !== "completed") throw new Error(`Live read-only OpenCode task ended as ${runtimeStatus}`);

    const postHead = await gitOutput(["rev-parse", "HEAD"]);
    const postSnapshot = await workingTreeSnapshot();
    const headUnchanged = postHead === originalHead;
    const treeUnchanged = sameArray(originalSnapshot, postSnapshot);
    if (!headUnchanged || !treeUnchanged) {
      throw new Error("Router repository changed during read-only restart/recovery prepare phase");
    }

    const inspection = integrity.inspect(run.id);
    const proof = Object.freeze({
      phase: "prepare",
      processId: process.pid,
      runId: run.id,
      sessionId: bound.session.id,
      workflowStatus: run.status,
      workflowPhase: run.phase,
      runtimeStatus,
      runtimeBound: stores.journal.history(run.id).some((entry) => entry.stage === "runtime_bound"),
      integrityDisposition: inspection.disposition,
      gitHeadUnchanged: headUnchanged,
      workingTreeUnchanged: treeUnchanged,
    });
    validatePrepareProof(proof);

    await writeFile(manifestPath, `${JSON.stringify({
      schemaVersion: 1,
      runId: run.id,
      sessionId: bound.session.id,
      prepareProcessId: process.pid,
      projectDir,
      originalHead,
      originalSnapshot,
      preparedAt: new Date().toISOString(),
    }, null, 2)}\n`, "utf8");

    console.log(JSON.stringify({ overall: "PASS", ...proof, stateRoot, nextPhase: "recover" }, null, 2));
  } catch (error) {
    if (sessionId) {
      try { await runtime.destroy(sessionId); } catch {}
    }
    throw error;
  }
}

async function recover() {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assertManifest(manifest);
  if (resolve(manifest.projectDir) !== projectDir) {
    throw new Error(`Restart/recovery project directory drift: manifest=${manifest.projectDir} current=${projectDir}`);
  }
  if (manifest.prepareProcessId === process.pid) {
    throw new Error("Recovery must execute in a distinct control-plane process");
  }

  let sessionDestroyed = false;
  try {
    const beforeHead = await gitOutput(["rev-parse", "HEAD"]);
    const beforeSnapshot = await workingTreeSnapshot();
    if (beforeHead !== manifest.originalHead || !sameArray(beforeSnapshot, manifest.originalSnapshot)) {
      throw new Error("Router repository drifted between prepare and recover process boundaries");
    }

    let stores = openStores();
    let integrity = new ExecutionIntegrityCoordinator({
      workflowStore: stores.workflowStore,
      bindingStore: stores.bindingStore,
      runLedger: stores.ledger,
      journal: stores.journal,
    });
    let run = stores.workflowStore.get(manifest.runId);
    if (!run) throw new Error(`Durable workflow ${manifest.runId} is missing after restart`);
    const binding = stores.bindingStore.get(run.id);
    if (!binding) throw new Error(`Durable runtime binding ${run.id} is missing after restart`);
    if (binding.sessionId !== manifest.sessionId) throw new Error("Recovered runtime session id does not match prepare manifest");

    const preRecovery = integrity.inspect(run.id);
    if (preRecovery.disposition !== "reconcile_runtime") {
      throw new Error(`Expected reconcile_runtime after restart, received ${preRecovery.disposition}`);
    }

    const probe = new OpenCodeRuntimeReconciliationProbe({ baseUrl, username, password });
    const reconciliation = await new RuntimeReconciliationCoordinator().reconcile(run, binding, probe);
    if (reconciliation.disposition !== "verify_runtime_result" || reconciliation.observation?.status !== "completed") {
      throw new Error(
        `Recovered OpenCode session is not verification-ready: disposition=${reconciliation.disposition} status=${reconciliation.observation?.status ?? "missing"}`,
      );
    }

    const verification = await new RuntimeVerificationCoordinator().verify(run, reconciliation, {
      id: "reference-restart-recovery-verifier",
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
        };
        return {
          passed: Object.values(checks).every(Boolean),
          reference: `restart-recovery:${run.id}:deterministic-proof`,
          collectedAt: new Date().toISOString(),
          metadata: {
            ...checks,
            prepareProcessId: manifest.prepareProcessId,
            recoverProcessId: process.pid,
            eventCount: observation.events.count,
          },
        };
      },
    });
    if (!verification.passed) throw new Error("Deterministic restart/recovery verification failed");
    integrity.recordVerification(run, binding, verification);

    // Reopen all durable stores before any workflow continuation. This is the
    // proof that verification evidence itself survived persistence/reload.
    stores = openStores();
    integrity = new ExecutionIntegrityCoordinator({
      workflowStore: stores.workflowStore,
      bindingStore: stores.bindingStore,
      runLedger: stores.ledger,
      journal: stores.journal,
    });
    const recoveredVerification = integrity.recoverVerification(run.id, run.attempt);
    if (!recoveredVerification?.passed) throw new Error("Passed verification did not survive integrity journal reopen");

    run = stores.workflowStore.get(run.id);
    if (!run) throw new Error("Workflow disappeared after durable store reopen");
    const durableMachine = new DurableWorkflowStateMachine(stores.workflowStore);
    run = durableMachine.advance(run); // execute -> verify
    run = durableMachine.advance(run); // verify -> review
    run = durableMachine.skipApproval(run); // R0 read-only reference slice
    run = durableMachine.succeed(run, true);

    integrity.recordWorkflowTerminal(run);
    const terminalBinding = stores.bindingStore.get(run.id);
    if (!terminalBinding) throw new Error("Terminal workflow lost its durable runtime binding");

    const baseEvidence = [{
      kind: "policy",
      status: "passed",
      reference: "policy:reference-restart-recovery-readonly",
      producer: "reference-restart-recovery-harness",
      collectedAt: new Date().toISOString(),
      metadata: {
        mutationAllowed: false,
        automaticMutationAllowed: false,
        providerRestarted: false,
      },
    }];

    new RuntimeRunLedgerFinalizer().appendTerminal({
      run,
      binding: terminalBinding,
      ledger: stores.ledger,
      task: "live OpenCode control-plane restart/recovery reference slice",
      modelRoute: ["opencode:configured-default"],
      contextCompilerVersion: "reference-restart-recovery/v1",
      skills: ["runtime.reconciliation", "deterministic.verification"],
      toolsets: ["read", "glob", "grep", "list"],
      policyDecisions: ["R0 read-only", "no automatic redispatch", "provider state is evidence only"],
      changeReferences: [],
      evidence: baseEvidence,
      verification: recoveredVerification,
      resourceMetrics: {
        runtimeEventCount: reconciliation.observation.events.count,
        runtimeFilesChanged: reconciliation.observation.diff.filesChanged.length,
      },
      traceId: `restart-recovery:${run.id}`,
    });
    integrity.recordLedgerFinalized(run);

    // Reopen once more and demand a fully consistent terminal classification.
    stores = openStores();
    integrity = new ExecutionIntegrityCoordinator({
      workflowStore: stores.workflowStore,
      bindingStore: stores.bindingStore,
      runLedger: stores.ledger,
      journal: stores.journal,
    });
    const finalInspection = integrity.inspect(run.id);
    const finalLedger = stores.ledger.get(run.id);
    const finalVerification = integrity.recoverVerification(run.id, run.attempt);
    if (!finalLedger || !finalVerification?.passed) {
      throw new Error("Final durable reopen lost Run Ledger or verification evidence");
    }

    const client = new OpenCodeHttpClient({ baseUrl, username, password });
    await client.request({
      method: "DELETE",
      path: `/session/${encodeURIComponent(manifest.sessionId)}`,
      directory: terminalBinding.workspace,
    });
    sessionDestroyed = true;

    const afterHead = await gitOutput(["rev-parse", "HEAD"]);
    const afterSnapshot = await workingTreeSnapshot();
    const proof = Object.freeze({
      phase: "recover",
      runId: run.id,
      prepareProcessId: manifest.prepareProcessId,
      recoverProcessId: process.pid,
      processRestartProven: manifest.prepareProcessId !== process.pid,
      providerRestarted: false,
      preRecoveryDisposition: preRecovery.disposition,
      runtimeReconciliationDisposition: reconciliation.disposition,
      runtimeObservationStatus: reconciliation.observation.status,
      verificationPassed: verification.passed,
      verificationRecoveredFromDisk: finalVerification.passed,
      finalIntegrityDisposition: finalInspection.disposition,
      runLedgerOutcome: finalLedger.outcome,
      sessionDestroyed,
      gitHeadUnchanged: afterHead === manifest.originalHead,
      workingTreeUnchanged: sameArray(afterSnapshot, manifest.originalSnapshot),
    });
    validateRecoveryProof(proof);

    const hashes = {};
    for (const name of ["workflow.jsonl", "binding.jsonl", "integrity.jsonl", "ledger.jsonl"]) {
      hashes[name] = await sha256File(join(stateRoot, name));
    }

    console.log(JSON.stringify({
      overall: "PASS",
      referenceSlice: "9router-live-control-plane-restart-recovery",
      ...proof,
      stateRoot,
      durableHashes: hashes,
      providerSessionPersistedAcrossControlPlaneRestart: true,
      rawProviderPatchPersisted: false,
      automaticRedispatchAllowed: false,
      nextGate: "INDEPENDENT_LIVE_RECOVERY_REVIEW",
    }, null, 2));
  } catch (error) {
    if (!sessionDestroyed && manifest?.sessionId) {
      try {
        const stores = openStores();
        const binding = stores.bindingStore.get(manifest.runId);
        if (binding) {
          const client = new OpenCodeHttpClient({ baseUrl, username, password });
          await client.request({
            method: "DELETE",
            path: `/session/${encodeURIComponent(manifest.sessionId)}`,
            directory: binding.workspace,
          });
          sessionDestroyed = true;
        }
      } catch {}
    }
    throw error;
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

async function waitForCompletion(runtime, sessionId, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const events = await runtime.getEvents(sessionId);
    const approval = events.find((event) => event.type === "approval_requested");
    if (approval) {
      const approvalId = typeof approval.metadata?.approvalId === "string" ? approval.metadata.approvalId : undefined;
      if (approvalId) {
        try {
          await runtime.respondToApproval(sessionId, {
            approvalId,
            decision: "denied",
            actor: "reference-restart-recovery-policy",
          });
        } catch {}
      }
      throw new Error("Read-only restart/recovery task requested an approval; request denied");
    }
    const status = await runtime.getStatus(sessionId);
    if (["completed", "failed", "aborted", "destroyed", "interrupted"].includes(status)) return status;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
  }
  try { await runtime.abort(sessionId, "restart/recovery reference slice timeout"); } catch {}
  throw new Error(`Restart/recovery task exceeded ${Math.round(timeoutMs / 1000)} seconds`);
}

async function assertRouterRepository() {
  const packageJson = JSON.parse(await readFile(join(projectDir, "package.json"), "utf8"));
  if (packageJson?.name !== "intelligent-agent-router") {
    throw new Error(`Restart/recovery reference slice must target intelligent-agent-router, received=${String(packageJson?.name ?? "unknown")}`);
  }
}

async function gitOutput(args) {
  const result = await execFile("git", ["-C", projectDir, ...args], { encoding: "utf8", windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
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
  if (!value || typeof value !== "object") throw new Error("Restart/recovery manifest must be an object");
  if (value.schemaVersion !== 1) throw new Error(`Unsupported restart/recovery manifest schema: ${String(value.schemaVersion)}`);
  for (const field of ["runId", "sessionId", "projectDir", "originalHead"]) {
    if (typeof value[field] !== "string" || !value[field].trim()) throw new Error(`Restart/recovery manifest.${field} must not be empty`);
  }
  if (!Number.isInteger(value.prepareProcessId) || value.prepareProcessId <= 0) throw new Error("Restart/recovery manifest.prepareProcessId must be a positive integer");
  if (!Array.isArray(value.originalSnapshot) || value.originalSnapshot.some((item) => typeof item !== "string")) {
    throw new Error("Restart/recovery manifest.originalSnapshot must be an array of strings");
  }
}

async function sha256File(path) {
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function safeError(error) {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/(authorization|api[_-]?key|access[_-]?token|password|secret|credential)\s*[:=]\s*(Bearer\s+)?[^\s,;]+/gi, "$1=[redacted]")
    .slice(0, 2000);
}
