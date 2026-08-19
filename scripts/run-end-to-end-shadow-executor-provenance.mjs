import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  BoundedExperimentExecutor,
  DurableWorkflowStateMachine,
  ExecutionIntegrityCoordinator,
  ExecutionMetricProjector,
  JsonlControlledExperimentExecutionJournal,
  JsonlEvalHistory,
  JsonlExecutionIntegrityJournal,
  JsonlRunLedger,
  JsonlRuntimeBindingStore,
  JsonlWorkflowCheckpointStore,
  OpenCodeHttpClient,
  OpenCodeRuntimeAdapter,
  OpenCodeRuntimeReconciliationProbe,
  RoutingEvalPlane,
  RuntimeBackedShadowExperimentExecutionAdapter,
  RuntimeReconciliationCoordinator,
  RuntimeRunLedgerFinalizer,
  RuntimeVerificationCoordinator,
  assessM5ControlledExperimentAdmission,
  buildCanonicalMetricTaxonomy,
  buildEvalCohortSummary,
  buildExecutionReliabilitySummary,
  executionProjectionToEvalMeasurement,
  prepareControlledExperimentAuthorization,
  prepareControlledExperimentDefinition,
  prepareGoldenTaskSuite,
  prepareM5AdmissionPolicy,
  prepareShadowExperimentSampleProvenance,
  verifyShadowExperimentSampleProvenance,
} from "../dist/index.js";

const execFile = promisify(execFileCallback);
const phase = process.argv[2];
const projectDir = resolve(process.env.ROUTER_SHADOW_E2E_PROJECT_DIR?.trim() || process.cwd());
const stateRootInput = process.env.ROUTER_SHADOW_E2E_STATE_ROOT?.trim();
const baseUrl = process.env.OPENCODE_BASE_URL?.trim() || "http://127.0.0.1:4096";
const username = process.env.OPENCODE_SERVER_USERNAME?.trim() || "opencode";
const password = process.env.OPENCODE_SERVER_PASSWORD;
const referenceProviderId = requiredEnv("ROUTER_SHADOW_REFERENCE_PROVIDER_ID");
const referenceModelId = requiredEnv("ROUTER_SHADOW_REFERENCE_MODEL_ID");
const candidateProviderId = requiredEnv("ROUTER_SHADOW_CANDIDATE_PROVIDER_ID");
const candidateModelId = requiredEnv("ROUTER_SHADOW_CANDIDATE_MODEL_ID");
const STORE_LIMITS = Object.freeze({ maxFileBytes: 2 * 1024 * 1024, maxRecordBytes: 256 * 1024 });
const PROJECT_ID = "9router-end-to-end-shadow-provenance";
const LATENCY_METRIC_KEY = "runtime.shadow_completion_wait_ms";
const authorityPath = () => join(stateRoot, "authority.json");
const manifestPath = () => join(stateRoot, "manifest.json");
const provenancePath = () => join(stateRoot, "provenance.json");

if (phase !== "prepare" && phase !== "recover") {
  console.error("Usage: node scripts/run-end-to-end-shadow-executor-provenance.mjs <prepare|recover>");
  process.exit(2);
}
if (!stateRootInput) {
  console.error("ROUTER_SHADOW_E2E_STATE_ROOT is required");
  process.exit(2);
}
if (referenceProviderId === candidateProviderId && referenceModelId === candidateModelId) {
  console.error("Reference and candidate OpenCode model targets must be distinct");
  process.exit(2);
}

const stateRoot = resolve(stateRootInput);

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
  if (existingEntries.length > 0) throw new Error(`End-to-end shadow state root must be empty before prepare: ${stateRoot}`);

  const originalHead = await gitOutput(["rev-parse", "HEAD"]);
  const originalSnapshot = await workingTreeSnapshot();
  if (originalSnapshot.length > 0) throw new Error("End-to-end shadow proof requires a clean router working tree");

  const referenceSubjectId = `opencode:${referenceProviderId}/${referenceModelId}`;
  const candidateSubjectId = `opencode:${candidateProviderId}/${candidateModelId}`;
  const authority = await prepareAuthority(referenceSubjectId, candidateSubjectId);
  await writeFile(authorityPath(), `${JSON.stringify(authority, null, 2)}\n`, "utf8");

  const runtimeStores = openRuntimeStores();
  const runtimeMachine = new DurableWorkflowStateMachine(runtimeStores.workflowStore);
  const referenceRun = createExecuteRun(runtimeMachine, `shadow-reference-${Date.now()}`);
  const candidateRun = createExecuteRun(runtimeMachine, `shadow-candidate-${Date.now()}`);
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
    "This is an end-to-end read-only shadow experiment provenance proof.",
    "Return a concise acknowledgement that the request was processed.",
    "Do not modify files, call tools, access the network, install packages, commit, push, deploy, or request approval.",
  ].join("\n");
  const taskContext = [
    "9Router #34/#35/#36 end-to-end shadow proof.",
    "No runtime tools are exposed.",
    "Candidate output remains internal and is not eligible for publication or production routing.",
  ];
  const resolver = {
    async resolve({ role, subjectId }) {
      if (role === "reference") {
        return {
          subjectId,
          run: referenceRun,
          workspace: projectDir,
          adapter: referenceRuntime,
          bindingStore: runtimeStores.bindingStore,
          task: { taskId: `shadow-reference-task-${referenceRun.id}`, prompt: taskPrompt, context: taskContext, toolIds: [] },
        };
      }
      return {
        subjectId,
        run: candidateRun,
        workspace: projectDir,
        adapter: candidateRuntime,
        bindingStore: runtimeStores.bindingStore,
        task: { taskId: `shadow-candidate-task-${candidateRun.id}`, prompt: taskPrompt, context: taskContext, toolIds: [] },
      };
    },
  };
  const runtimeAdapter = new RuntimeBackedShadowExperimentExecutionAdapter(resolver, {
    id: "opencode-end-to-end-shadow-provenance",
  });
  const journal = await openExperimentJournal(authority.experiment.experimentId);
  const executor = new BoundedExperimentExecutor(journal, runtimeAdapter, {
    maxStringBytes: 2048,
  });
  const sampleId = `shadow-e2e-${Date.now()}`;
  const dispatchStartedAt = Date.now();
  const dispatch = await executor.dispatchSample({
    experiment: authority.experiment,
    authorization: authority.authorization,
    admissionDecision: authority.admissionDecision,
    workflow: authority.controlWorkflow,
    request: {
      sampleId,
      inputReference: "live-proof:fixed-shadow-input-v1",
      exposure: "shadow",
      liveAssignment: "none",
      requestedAt: new Date().toISOString(),
    },
  });

  const referenceBinding = requireBinding(runtimeStores.bindingStore, referenceRun.id, "reference");
  const candidateBinding = requireBinding(runtimeStores.bindingStore, candidateRun.id, "candidate");
  const integrity = new ExecutionIntegrityCoordinator({
    workflowStore: runtimeStores.workflowStore,
    bindingStore: runtimeStores.bindingStore,
    runLedger: runtimeStores.ledger,
    journal: runtimeStores.integrityJournal,
  });
  integrity.recordRuntimeBound(referenceRun, referenceBinding);
  integrity.recordRuntimeBound(candidateRun, candidateBinding);

  const [referenceCompletion, candidateCompletion] = await Promise.all([
    waitForCompletion(referenceRuntime, referenceBinding.sessionId, 5 * 60_000, "reference", dispatchStartedAt),
    waitForCompletion(candidateRuntime, candidateBinding.sessionId, 5 * 60_000, "candidate", dispatchStartedAt),
  ]);
  if (referenceCompletion.status !== "completed" || candidateCompletion.status !== "completed") {
    throw new Error(`End-to-end shadow runtime did not complete: reference=${referenceCompletion.status} candidate=${candidateCompletion.status}`);
  }

  const [referenceDiff, candidateDiff] = await Promise.all([
    referenceRuntime.getDiff(referenceBinding.sessionId),
    candidateRuntime.getDiff(candidateBinding.sessionId),
  ]);
  assertNoRuntimeMutation(referenceDiff, "reference");
  assertNoRuntimeMutation(candidateDiff, "candidate");
  const postHead = await gitOutput(["rev-parse", "HEAD"]);
  const postSnapshot = await workingTreeSnapshot();
  if (postHead !== originalHead || !sameArray(postSnapshot, originalSnapshot)) {
    throw new Error("Router repository changed during end-to-end shadow prepare");
  }

  const journalState = journal.inspect();
  if (journalState.eventCount !== 2 || journalState.reservedSampleCount !== 1 || journalState.completedSampleCount !== 0
    || journalState.unresolvedSampleIds.length !== 1 || journalState.unresolvedSampleIds[0] !== sampleId) {
    throw new Error("End-to-end shadow execution journal did not persist exact reserved+dispatched unresolved state");
  }
  const manifest = {
    schemaVersion: 1,
    prepareProcessId: process.pid,
    projectDir,
    originalHead,
    originalSnapshot,
    controlWorkflowRunId: authority.controlWorkflow.id,
    experimentId: authority.experiment.experimentId,
    authorizationId: authority.authorization.authorizationId,
    sampleId,
    adapterId: runtimeAdapter.id,
    reservationEventId: dispatch.reservationEvent.eventId,
    dispatchEventId: dispatch.dispatchEvent.eventId,
    referenceRunId: referenceRun.id,
    candidateRunId: candidateRun.id,
    referenceSessionId: referenceBinding.sessionId,
    candidateSessionId: candidateBinding.sessionId,
    referenceModelRef: `${referenceProviderId}/${referenceModelId}`,
    candidateModelRef: `${candidateProviderId}/${candidateModelId}`,
    referenceExecutionReference: dispatch.receipt.referenceExecutionReference,
    candidateExecutionReference: dispatch.receipt.candidateExecutionReference,
    referenceCompletionWaitMs: referenceCompletion.elapsedMs,
    candidateCompletionWaitMs: candidateCompletion.elapsedMs,
    candidateOutputExternallyVisible: dispatch.receipt.candidateOutputExternallyVisible,
    preparedAt: new Date().toISOString(),
  };
  await writeFile(manifestPath(), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  console.log(JSON.stringify({
    overall: "PASS",
    referenceSlice: "9router-end-to-end-shadow-executor-prepare",
    phase: "prepare",
    processId: process.pid,
    controlWorkflowPhase: authority.controlWorkflow.phase,
    controlWorkflowRiskClass: authority.controlWorkflow.riskClass,
    durableApprovalCount: authority.controlWorkflow.approvalIds.length,
    experimentAdmissionEligible: authority.admissionDecision.payload.experimentAdmissionEligible,
    authorizationDecision: authority.authorization.payload.decision,
    sampleReserved: true,
    sampleDispatched: true,
    sampleCompleted: false,
    referenceRuntimeStatus: referenceCompletion.status,
    candidateRuntimeStatus: candidateCompletion.status,
    referenceRuntimeBound: true,
    candidateRuntimeBound: true,
    zeroRuntimeTools: true,
    candidateOutputExternallyVisible: dispatch.receipt.candidateOutputExternallyVisible,
    automaticRedispatchAllowed: false,
    productionRoutingMutationAllowed: false,
    gitHeadUnchanged: true,
    workingTreeUnchanged: true,
    stateRoot,
    nextPhase: "recover",
  }, null, 2));
}

async function recover() {
  const authority = JSON.parse(await readFile(authorityPath(), "utf8"));
  const manifest = JSON.parse(await readFile(manifestPath(), "utf8"));
  assertAuthority(authority);
  assertManifest(manifest);
  if (resolve(manifest.projectDir) !== projectDir) throw new Error("End-to-end shadow project directory drifted between phases");
  if (manifest.prepareProcessId === process.pid) throw new Error("End-to-end shadow recovery requires a distinct control-plane process");

  const beforeHead = await gitOutput(["rev-parse", "HEAD"]);
  const beforeSnapshot = await workingTreeSnapshot();
  if (beforeHead !== manifest.originalHead || !sameArray(beforeSnapshot, manifest.originalSnapshot)) {
    throw new Error("Router repository drifted between end-to-end shadow phases");
  }

  const controlStore = openControlWorkflowStore();
  const controlWorkflow = controlStore.get(manifest.controlWorkflowRunId);
  if (!controlWorkflow || controlWorkflow.phase !== "publish" || controlWorkflow.status !== "running") {
    throw new Error("Durable approved control workflow did not survive restart in publish/running state");
  }

  let stores = openRuntimeStores();
  let integrity = new ExecutionIntegrityCoordinator({
    workflowStore: stores.workflowStore,
    bindingStore: stores.bindingStore,
    runLedger: stores.ledger,
    journal: stores.integrityJournal,
  });
  const referenceRun = requireRun(stores.workflowStore, manifest.referenceRunId, "reference");
  const candidateRun = requireRun(stores.workflowStore, manifest.candidateRunId, "candidate");
  const referenceBinding = requireBinding(stores.bindingStore, referenceRun.id, "reference");
  const candidateBinding = requireBinding(stores.bindingStore, candidateRun.id, "candidate");
  if (referenceBinding.sessionId !== manifest.referenceSessionId || candidateBinding.sessionId !== manifest.candidateSessionId) {
    throw new Error("Recovered runtime bindings do not match prepare manifest sessions");
  }

  const referencePreRecovery = integrity.inspect(referenceRun.id);
  const candidatePreRecovery = integrity.inspect(candidateRun.id);
  if (referencePreRecovery.disposition !== "reconcile_runtime" || candidatePreRecovery.disposition !== "reconcile_runtime") {
    throw new Error(`Expected reconcile_runtime after process restart: reference=${referencePreRecovery.disposition} candidate=${candidatePreRecovery.disposition}`);
  }
  const probe = new OpenCodeRuntimeReconciliationProbe({ baseUrl, username, password });
  const reconciliationCoordinator = new RuntimeReconciliationCoordinator();
  const referenceReconciliation = await reconciliationCoordinator.reconcile(referenceRun, referenceBinding, probe);
  const candidateReconciliation = await reconciliationCoordinator.reconcile(candidateRun, candidateBinding, probe);
  assertVerificationReady(referenceReconciliation, "reference");
  assertVerificationReady(candidateReconciliation, "candidate");

  const verificationCoordinator = new RuntimeVerificationCoordinator();
  const referenceVerification = await verifyRuntime(verificationCoordinator, referenceRun, referenceReconciliation, "reference", manifest);
  const candidateVerification = await verifyRuntime(verificationCoordinator, candidateRun, candidateReconciliation, "candidate", manifest);
  if (!referenceVerification.passed || !candidateVerification.passed) throw new Error("End-to-end shadow deterministic verification failed");
  integrity.recordVerification(referenceRun, referenceBinding, referenceVerification);
  integrity.recordVerification(candidateRun, candidateBinding, candidateVerification);

  stores = openRuntimeStores();
  integrity = new ExecutionIntegrityCoordinator({
    workflowStore: stores.workflowStore,
    bindingStore: stores.bindingStore,
    runLedger: stores.ledger,
    journal: stores.integrityJournal,
  });
  const recoveredReferenceVerification = integrity.recoverVerification(referenceRun.id, referenceRun.attempt);
  const recoveredCandidateVerification = integrity.recoverVerification(candidateRun.id, candidateRun.attempt);
  if (!recoveredReferenceVerification?.passed || !recoveredCandidateVerification?.passed) {
    throw new Error("End-to-end shadow verification evidence did not survive durable reopen");
  }
  finalizeRuntimeRun(
    stores,
    integrity,
    referenceRun.id,
    recoveredReferenceVerification,
    manifest.referenceModelRef,
    "reference",
    referenceReconciliation,
    manifest.referenceCompletionWaitMs,
  );
  finalizeRuntimeRun(
    stores,
    integrity,
    candidateRun.id,
    recoveredCandidateVerification,
    manifest.candidateModelRef,
    "candidate",
    candidateReconciliation,
    manifest.candidateCompletionWaitMs,
  );

  stores = openRuntimeStores();
  integrity = new ExecutionIntegrityCoordinator({
    workflowStore: stores.workflowStore,
    bindingStore: stores.bindingStore,
    runLedger: stores.ledger,
    journal: stores.integrityJournal,
  });
  const referenceLedger = stores.ledger.get(referenceRun.id);
  const candidateLedger = stores.ledger.get(candidateRun.id);
  if (!referenceLedger || !candidateLedger) throw new Error("Canonical runtime Run Ledger records are missing after finalization");
  if (integrity.inspect(referenceRun.id).disposition !== "consistent_terminal" || integrity.inspect(candidateRun.id).disposition !== "consistent_terminal") {
    throw new Error("Runtime integrity is not consistent_terminal after finalization");
  }

  const projector = new ExecutionMetricProjector({
    latencyMetricKey: LATENCY_METRIC_KEY,
    requireLatency: true,
    maxMetricKeyBytes: 256,
  });
  const referenceProjection = await projector.project(referenceLedger);
  const candidateProjection = await projector.project(candidateLedger);
  const evalHistory = await openEvalHistory();
  const referenceObservation = await evalHistory.append({
    observedAt: new Date().toISOString(),
    report: authority.referenceReport,
    baseline: authority.referenceBaseline,
    measurement: await executionProjectionToEvalMeasurement(referenceProjection),
  });
  const candidateObservation = await evalHistory.append({
    observedAt: new Date(Date.now() + 1).toISOString(),
    report: authority.candidateReport,
    baseline: authority.candidateBaseline,
    measurement: await executionProjectionToEvalMeasurement(candidateProjection),
  });

  let experimentJournal = await openExperimentJournal(authority.experiment.experimentId);
  const completionAdapter = {
    id: manifest.adapterId,
    async dispatch() { throw new Error("Completion-only adapter cannot dispatch"); },
  };
  const executor = new BoundedExperimentExecutor(experimentJournal, completionAdapter, { maxStringBytes: 2048 });
  const completion = await executor.recordCompletion({
    experiment: authority.experiment,
    authorization: authority.authorization,
    admissionDecision: authority.admissionDecision,
    workflow: controlWorkflow,
    sampleId: manifest.sampleId,
    completedAt: new Date().toISOString(),
    referenceObservationId: referenceObservation.observationId,
    candidateObservationId: candidateObservation.observationId,
  });

  experimentJournal = await openExperimentJournal(authority.experiment.experimentId);
  const journalState = experimentJournal.inspect();
  if (journalState.completedSampleCount !== 1 || journalState.completedShadowSamples !== 1 || journalState.unresolvedSampleIds.length !== 0) {
    throw new Error("End-to-end shadow journal did not reopen as one completed shadow sample");
  }
  const reopenedEvalHistory = await openEvalHistory();
  const durableReferenceObservation = reopenedEvalHistory.get(referenceObservation.observationId);
  const durableCandidateObservation = reopenedEvalHistory.get(candidateObservation.observationId);
  if (!durableReferenceObservation || !durableCandidateObservation) throw new Error("Actual runtime Eval observations did not survive durable reopen");

  const provenanceSources = {
    experiment: authority.experiment,
    authorization: authority.authorization,
    admissionDecision: authority.admissionDecision,
    workflow: controlWorkflow,
    journal: experimentJournal,
    sampleId: manifest.sampleId,
    referenceRun: referenceLedger,
    candidateRun: candidateLedger,
    referenceProjection,
    candidateProjection,
    referenceObservation: durableReferenceObservation,
    candidateObservation: durableCandidateObservation,
  };
  const provenance = await prepareShadowExperimentSampleProvenance(provenanceSources);
  await writeFile(provenancePath(), `${JSON.stringify(provenance, null, 2)}\n`, "utf8");
  const durableProvenance = JSON.parse(await readFile(provenancePath(), "utf8"));
  await verifyShadowExperimentSampleProvenance(durableProvenance, provenanceSources);

  const client = new OpenCodeHttpClient({ baseUrl, username, password });
  await client.request({ method: "DELETE", path: `/session/${encodeURIComponent(manifest.referenceSessionId)}`, directory: referenceBinding.workspace });
  await client.request({ method: "DELETE", path: `/session/${encodeURIComponent(manifest.candidateSessionId)}`, directory: candidateBinding.workspace });

  const afterHead = await gitOutput(["rev-parse", "HEAD"]);
  const afterSnapshot = await workingTreeSnapshot();
  if (afterHead !== manifest.originalHead || !sameArray(afterSnapshot, manifest.originalSnapshot)) {
    throw new Error("Router repository changed during end-to-end shadow recovery");
  }

  const hashes = {};
  for (const name of [
    "authority.json",
    "control-workflow.jsonl",
    "runtime-workflow.jsonl",
    "binding.jsonl",
    "integrity.jsonl",
    "ledger.jsonl",
    "eval-history.jsonl",
    "experiment-execution.jsonl",
    "manifest.json",
    "provenance.json",
  ]) hashes[name] = await sha256File(join(stateRoot, name));

  console.log(JSON.stringify({
    overall: "PASS",
    referenceSlice: "9router-end-to-end-shadow-executor-provenance",
    phase: "recover",
    prepareProcessId: manifest.prepareProcessId,
    recoverProcessId: process.pid,
    processRestartProven: manifest.prepareProcessId !== process.pid,
    providerRestarted: false,
    controlWorkflowPhase: controlWorkflow.phase,
    controlWorkflowRiskClass: controlWorkflow.riskClass,
    durableApprovalCount: controlWorkflow.approvalIds.length,
    experimentAdmissionEligible: authority.admissionDecision.payload.experimentAdmissionEligible,
    authorizationDecision: authority.authorization.payload.decision,
    journalReservationEventId: manifest.reservationEventId,
    journalDispatchEventId: manifest.dispatchEventId,
    journalCompletionEventId: completion.completionEvent.eventId,
    completedSampleCount: journalState.completedSampleCount,
    completedShadowSamples: journalState.completedShadowSamples,
    unresolvedSampleCount: journalState.unresolvedSampleIds.length,
    referencePreRecoveryDisposition: referencePreRecovery.disposition,
    candidatePreRecoveryDisposition: candidatePreRecovery.disposition,
    referenceRuntimeReconciliationDisposition: referenceReconciliation.disposition,
    candidateRuntimeReconciliationDisposition: candidateReconciliation.disposition,
    referenceVerificationPassed: recoveredReferenceVerification.passed,
    candidateVerificationPassed: recoveredCandidateVerification.passed,
    referenceRunLedgerOutcome: referenceLedger.outcome,
    candidateRunLedgerOutcome: candidateLedger.outcome,
    referenceProjectionId: referenceProjection.projectionId,
    candidateProjectionId: candidateProjection.projectionId,
    referenceObservationId: durableReferenceObservation.observationId,
    candidateObservationId: durableCandidateObservation.observationId,
    referenceObservationRunLedgerBound: durableReferenceObservation.payload.measurement.sourceReferences.includes(`run-ledger:${referenceLedger.runId}`),
    candidateObservationRunLedgerBound: durableCandidateObservation.payload.measurement.sourceReferences.includes(`run-ledger:${candidateLedger.runId}`),
    provenanceId: durableProvenance.provenanceId,
    provenanceVerified: true,
    candidateOutputExternallyVisible: false,
    productionRoutingMutationAllowed: false,
    automaticRedispatchAllowed: false,
    rawProviderOutputPersisted: false,
    rawProviderPatchPersisted: false,
    gitHeadUnchanged: true,
    workingTreeUnchanged: true,
    stateRoot,
    durableHashes: hashes,
    nextGate: "INDEPENDENT_END_TO_END_SHADOW_PROVENANCE_REVIEW",
  }, null, 2));
}

async function prepareAuthority(referenceSubjectId, candidateSubjectId) {
  const suite = await prepareGoldenTaskSuite({
    schemaVersion: 1,
    suiteId: "end-to-end-shadow-provenance-suite",
    description: "Deterministic M5 authority fixture for a real shadow runtime provenance proof.",
    tasks: [{
      id: "authority-route",
      kind: "routing",
      prompt: "Route this deterministic end-to-end shadow authority fixture.",
      critical: true,
      minimumScore: 1,
      assertions: [
        { id: "model", kind: "primary_model_equals", weight: 1, expected: "evaluation-pass-route" },
        { id: "verify", kind: "requires_verification_equals", weight: 1, expected: true },
      ],
    }],
  }, {
    maxTasks: 8,
    maxAssertionsPerTask: 8,
    maxPromptBytes: 4096,
    maxStringBytes: 2048,
    maxSuiteBytes: 64 * 1024,
  });
  const plane = new RoutingEvalPlane({ maxReportBytes: 64 * 1024, maxSubjectIdBytes: 2048 });
  const passingSubject = (id) => ({
    id,
    async route() {
      return {
        primaryModel: { candidate: { id: "evaluation-pass-route" } },
        selectedSkills: [],
        analysis: { requiresVerification: true },
      };
    },
  });
  const referenceReport = await plane.evaluate(suite, passingSubject(referenceSubjectId));
  const candidateReport = await plane.evaluate(suite, passingSubject(candidateSubjectId));
  const referenceBaseline = baselineFor(referenceReport, referenceSubjectId);
  const candidateBaseline = baselineFor(candidateReport, candidateSubjectId);
  const history = await openEvalHistory();
  const taxonomy = await buildCanonicalMetricTaxonomy();
  const policy = await prepareM5AdmissionPolicy(taxonomy, {
    name: "end-to-end-shadow-provenance-admission",
    minimumObservationCount: 2,
    requireExecutionReliability: true,
    requireFullExecutionProvenance: true,
    minimumExecutionSampleCount: 2,
    minimumDecidedExecutionSampleCount: 2,
    minimumLatencyCoverageRatio: 1,
    minimumCostCoverageRatio: 1,
    maximumCoverageRegressionRatio: 0.1,
    maximumWeightedScoreMeanRegression: 0.05,
    maximumTaskPassRateMeanRegression: 0.05,
    maximumCriticalPassRateMeanRegression: 0.05,
    maximumBaselinePassRateRegression: 0.05,
    maximumExecutionSuccessRateRegression: 0.05,
    maximumCancellationRateIncrease: 0.1,
    maximumLatencyMeanIncreaseMs: 25,
    maximumCostMeanIncreaseUsd: 0.02,
  });
  const reference = await buildAdmissionCohort(history, referenceReport, referenceBaseline, "admission-reference", 2, 150, 0.08, 0);
  const candidate = await buildAdmissionCohort(history, candidateReport, candidateBaseline, "admission-candidate", 2, 120, 0.06, 10);
  const admissionDecision = await assessM5ControlledExperimentAdmission({ taxonomy, policy, reference, candidate });
  if (!admissionDecision.payload.experimentAdmissionEligible) throw new Error(`Live authority fixture is not M5-eligible: ${admissionDecision.payload.classification}`);

  const experiment = await prepareControlledExperimentDefinition(admissionDecision, {
    name: "end-to-end-real-shadow-provenance",
    projectId: PROJECT_ID,
    riskClass: "R3",
    exposureMode: "shadow_only",
    budget: {
      maxTotalSamples: 1,
      minimumShadowSamplesBeforeLive: 1,
      maxLiveSamples: 0,
      maxCandidateLiveSamples: 0,
      maxCandidateTrafficBasisPoints: 0,
    },
    stopConditions: {
      maxFailedExecutions: 0,
      maximumCancellationRate: 0.1,
      maximumWeightedScoreMeanRegression: 0.05,
      maximumTaskPassRateMeanRegression: 0.05,
      maximumCriticalPassRateMeanRegression: 0.05,
      maximumBaselinePassRateRegression: 0.05,
      maximumExecutionSuccessRateRegression: 0.05,
      maximumLatencyMeanIncreaseMs: 25,
      maximumCostMeanIncreaseUsd: 0.02,
    },
    rollbackPolicyReference: "policy:end-to-end-shadow-reference-restore-v1",
  });
  if (experiment.payload.referenceSubjectId !== referenceSubjectId || experiment.payload.candidateSubjectId !== candidateSubjectId) {
    throw new Error("Controlled experiment subject IDs do not match requested real runtime model targets");
  }

  const controlStore = openControlWorkflowStore();
  const controlMachine = new DurableWorkflowStateMachine(controlStore);
  let controlWorkflow = controlMachine.create({
    id: `shadow-control-${Date.now()}`,
    projectId: PROJECT_ID,
    riskClass: "R3",
  });
  controlWorkflow = controlMachine.start(controlWorkflow);
  controlWorkflow = controlMachine.advance(controlWorkflow);
  controlWorkflow = controlMachine.advance(controlWorkflow);
  controlWorkflow = controlMachine.advance(controlWorkflow);
  controlWorkflow = controlMachine.advance(controlWorkflow);
  controlWorkflow = controlMachine.requestApproval(controlWorkflow);
  controlWorkflow = controlMachine.approve(controlWorkflow, "approval:end-to-end-shadow-provenance");
  if (controlWorkflow.phase !== "publish" || controlWorkflow.status !== "running" || controlWorkflow.approvalIds.length !== 1) {
    throw new Error(`Unexpected approved experiment workflow state: ${controlWorkflow.phase}/${controlWorkflow.status}`);
  }
  const authorization = await prepareControlledExperimentAuthorization(experiment, admissionDecision, controlWorkflow, {
    decision: "allow",
    actor: "operator:end-to-end-shadow-provenance",
    decidedAt: new Date().toISOString(),
    policyReferences: ["policy:end-to-end-shadow-authorization-v1"],
    approvalIds: ["approval:end-to-end-shadow-provenance"],
  });
  return {
    schemaVersion: 1,
    referenceReport,
    candidateReport,
    referenceBaseline,
    candidateBaseline,
    admissionDecision,
    experiment,
    authorization,
    controlWorkflow,
  };
}

function baselineFor(report, subjectId) {
  return {
    schemaVersion: 1,
    baselineId: "end-to-end-shadow-provenance-baseline",
    suiteId: report.payload.suiteId,
    suiteSha256: report.payload.suiteSha256,
    subjectId,
    minimumWeightedScore: 1,
    minimumTaskPassRate: 1,
    minimumCriticalPassRate: 1,
    maximumFailedTasks: 0,
  };
}

async function buildAdmissionCohort(history, report, baseline, prefix, count, latencyBase, costBase, minuteBase) {
  const observations = [];
  const projections = [];
  const records = [];
  for (let index = 0; index < count; index += 1) {
    const record = syntheticAdmissionRun(`${prefix}-${index}`, latencyBase + index, costBase + (index * 0.001));
    records.push(record);
    const projector = new ExecutionMetricProjector({
      latencyMetricKey: "runtime.total_ms",
      costMetricKey: "billing.usd",
      requireLatency: true,
      requireCost: true,
      maxMetricKeyBytes: 256,
    });
    const projection = await projector.project(record);
    const observation = await history.append({
      observedAt: new Date(Date.UTC(2026, 7, 19, 1, minuteBase + index, 0)).toISOString(),
      report,
      baseline,
      measurement: await executionProjectionToEvalMeasurement(projection),
    });
    observations.push(observation);
    projections.push(projection);
  }
  return {
    evalSummary: await buildEvalCohortSummary(observations),
    executionSummary: await buildExecutionReliabilitySummary(observations, projections, records),
  };
}

function syntheticAdmissionRun(runId, latencyMs, costUsd) {
  return {
    runId,
    projectId: PROJECT_ID,
    task: "Synthetic pre-admission evidence only",
    riskClass: "R0",
    runtimeId: "fixture",
    modelRoute: ["fixture:admission"],
    contextCompilerVersion: "fixture/v1",
    skills: [],
    toolsets: [],
    workspace: "fixture:/admission",
    policyDecisions: ["fixture:policy"],
    approvalIds: [],
    changeReferences: [],
    evidence: [{
      kind: "policy",
      status: "passed",
      reference: `policy:${runId}`,
      producer: "end-to-end-shadow-authority-fixture",
      collectedAt: "2026-08-19T01:00:00.000Z",
    }],
    resourceMetrics: { "runtime.total_ms": latencyMs, "billing.usd": costUsd },
    traceId: `fixture:${runId}`,
    outcome: "succeeded",
    createdAt: "2026-08-19T00:59:00.000Z",
  };
}

function createExecuteRun(machine, id) {
  let run = machine.create({ id, projectId: PROJECT_ID, riskClass: "R0" });
  run = machine.start(run);
  run = machine.advance(run);
  run = machine.advance(run);
  if (run.phase !== "execute" || run.status !== "running" || run.attempt !== 1) {
    throw new Error(`Unexpected shadow runtime workflow state: ${run.id} ${run.phase}/${run.status}/attempt=${run.attempt}`);
  }
  return run;
}

async function verifyRuntime(coordinator, run, reconciliation, role, manifest) {
  return coordinator.verify(run, reconciliation, {
    id: `shadow-e2e-${role}-verifier`,
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
        candidateOutputContained: manifest.candidateOutputExternallyVisible === false,
      };
      return {
        passed: Object.values(checks).every(Boolean),
        reference: `shadow-e2e:${role}:${run.id}:deterministic-proof`,
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

function finalizeRuntimeRun(stores, integrity, runId, verification, modelRef, role, reconciliation, completionWaitMs) {
  let run = requireRun(stores.workflowStore, runId, role);
  const machine = new DurableWorkflowStateMachine(stores.workflowStore);
  run = machine.advance(run);
  run = machine.advance(run);
  run = machine.skipApproval(run);
  run = machine.succeed(run, true);
  integrity.recordWorkflowTerminal(run);
  const binding = requireBinding(stores.bindingStore, run.id, role);
  new RuntimeRunLedgerFinalizer().appendTerminal({
    run,
    binding,
    ledger: stores.ledger,
    task: `live OpenCode ${role} end-to-end shadow experiment sample`,
    modelRoute: [`opencode:${modelRef}`],
    contextCompilerVersion: "end-to-end-shadow-provenance/v1",
    skills: ["experiment.authorization", "experiment.execution_journal", "runtime.binding", "runtime.reconciliation", "deterministic.verification"],
    toolsets: [],
    policyDecisions: ["R0 shadow-only runtime", "zero runtime tools", "no external candidate output", "no automatic redispatch"],
    changeReferences: [],
    evidence: [{
      kind: "policy",
      status: "passed",
      reference: `policy:end-to-end-shadow-runtime-${role}`,
      producer: "end-to-end-shadow-provenance-harness",
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
      [LATENCY_METRIC_KEY]: completionWaitMs,
      runtimeEventCount: reconciliation.observation.events.count,
      runtimeFilesChanged: reconciliation.observation.diff.filesChanged.length,
    },
    traceId: `shadow-e2e:${role}:${run.id}`,
  });
  integrity.recordLedgerFinalized(run);
}

async function waitForCompletion(runtime, sessionId, timeoutMs, role, startedAt) {
  while (Date.now() - startedAt < timeoutMs) {
    const events = await runtime.getEvents(sessionId);
    const approval = events.find((event) => event.type === "approval_requested");
    if (approval) {
      const approvalId = typeof approval.metadata?.approvalId === "string" ? approval.metadata.approvalId : undefined;
      if (approvalId) {
        try { await runtime.respondToApproval(sessionId, { approvalId, decision: "denied", actor: "end-to-end-shadow-policy" }); } catch {}
      }
      throw new Error(`${role} end-to-end shadow runtime requested approval; request denied`);
    }
    const status = await runtime.getStatus(sessionId);
    if (["completed", "failed", "aborted", "destroyed", "interrupted"].includes(status)) {
      return { status, elapsedMs: Math.max(0, Date.now() - startedAt) };
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
  }
  try { await runtime.abort(sessionId, `${role} end-to-end shadow runtime timeout`); } catch {}
  throw new Error(`${role} end-to-end shadow runtime exceeded ${Math.round(timeoutMs / 1000)} seconds`);
}

function openRuntimeStores() {
  return {
    workflowStore: new JsonlWorkflowCheckpointStore({
      filePath: join(stateRoot, "runtime-workflow.jsonl"),
      maxFileBytes: STORE_LIMITS.maxFileBytes,
      maxCheckpointBytes: STORE_LIMITS.maxRecordBytes,
    }),
    bindingStore: new JsonlRuntimeBindingStore({
      filePath: join(stateRoot, "binding.jsonl"),
      maxFileBytes: STORE_LIMITS.maxFileBytes,
      maxBindingBytes: STORE_LIMITS.maxRecordBytes,
    }),
    integrityJournal: new JsonlExecutionIntegrityJournal({
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

function openControlWorkflowStore() {
  return new JsonlWorkflowCheckpointStore({
    filePath: join(stateRoot, "control-workflow.jsonl"),
    maxFileBytes: STORE_LIMITS.maxFileBytes,
    maxCheckpointBytes: STORE_LIMITS.maxRecordBytes,
  });
}

async function openExperimentJournal(experimentId) {
  return JsonlControlledExperimentExecutionJournal.open({
    filePath: join(stateRoot, "experiment-execution.jsonl"),
    experimentId,
    maxFileBytes: STORE_LIMITS.maxFileBytes,
    maxEventBytes: 64 * 1024,
    maxStringBytes: 2048,
  });
}

async function openEvalHistory() {
  return JsonlEvalHistory.open({
    filePath: join(stateRoot, "eval-history.jsonl"),
    maxFileBytes: STORE_LIMITS.maxFileBytes,
    maxObservationBytes: 128 * 1024,
    maxReportBytes: 64 * 1024,
    maxStringBytes: 2048,
    maxSourceReferences: 8,
  });
}

function requireRun(store, runId, role) {
  const run = store.get(runId);
  if (!run) throw new Error(`Durable ${role} runtime workflow is missing: ${runId}`);
  return run;
}

function requireBinding(store, runId, role) {
  const binding = store.get(runId);
  if (!binding) throw new Error(`Durable ${role} runtime binding is missing: ${runId}`);
  return binding;
}

function assertNoRuntimeMutation(diff, role) {
  if (diff.filesChanged.length > 0 || Boolean(diff.patch) || Boolean(diff.commitSha)) {
    throw new Error(`${role} end-to-end shadow runtime reported a mutation`);
  }
}

function assertVerificationReady(reconciliation, role) {
  if (reconciliation.disposition !== "verify_runtime_result" || reconciliation.observation?.status !== "completed") {
    throw new Error(`${role} runtime is not verification-ready: disposition=${reconciliation.disposition} status=${reconciliation.observation?.status ?? "missing"}`);
  }
}

function assertAuthority(value) {
  if (!value || typeof value !== "object" || value.schemaVersion !== 1) throw new Error("End-to-end shadow authority artifact is invalid");
  for (const field of ["referenceReport", "candidateReport", "referenceBaseline", "candidateBaseline", "admissionDecision", "experiment", "authorization", "controlWorkflow"]) {
    if (!value[field] || typeof value[field] !== "object") throw new Error(`End-to-end shadow authority.${field} is missing`);
  }
}

function assertManifest(value) {
  if (!value || typeof value !== "object" || value.schemaVersion !== 1) throw new Error("End-to-end shadow manifest is invalid");
  for (const field of [
    "projectDir", "originalHead", "controlWorkflowRunId", "experimentId", "authorizationId", "sampleId", "adapterId",
    "reservationEventId", "dispatchEventId", "referenceRunId", "candidateRunId", "referenceSessionId", "candidateSessionId",
    "referenceModelRef", "candidateModelRef", "referenceExecutionReference", "candidateExecutionReference",
  ]) if (typeof value[field] !== "string" || !value[field].trim()) throw new Error(`End-to-end shadow manifest.${field} is invalid`);
  if (!Number.isInteger(value.prepareProcessId) || value.prepareProcessId <= 0) throw new Error("End-to-end shadow manifest prepareProcessId is invalid");
  for (const field of ["referenceCompletionWaitMs", "candidateCompletionWaitMs"]) if (typeof value[field] !== "number" || !Number.isFinite(value[field]) || value[field] < 0) throw new Error(`End-to-end shadow manifest.${field} is invalid`);
  if (!Array.isArray(value.originalSnapshot) || value.originalSnapshot.some((item) => typeof item !== "string")) throw new Error("End-to-end shadow manifest originalSnapshot is invalid");
  if (value.candidateOutputExternallyVisible !== false) throw new Error("End-to-end shadow manifest cannot expose candidate output");
}

async function assertRouterRepository() {
  const packageJson = JSON.parse(await readFile(join(projectDir, "package.json"), "utf8"));
  if (packageJson?.name !== "intelligent-agent-router") throw new Error(`Proof must target intelligent-agent-router; received=${String(packageJson?.name ?? "unknown")}`);
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
