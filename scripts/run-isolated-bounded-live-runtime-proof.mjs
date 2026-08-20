import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  BoundedLivePublicationCoordinator,
  BoundedLiveReferenceRestoreCoordinator,
  DeferredBoundedLiveExecutor,
  DurableWorkflowStateMachine,
  ExecutionMetricProjector,
  IsolatedLoopbackBoundedLiveSinkClient,
  JsonlBoundedLiveSideEffectJournal,
  JsonlControlledExperimentExecutionJournal,
  JsonlEvalHistory,
  JsonlRunLedger,
  JsonlRuntimeBindingStore,
  JsonlWorkflowCheckpointStore,
  OpenCodeBoundedLiveOutputReader,
  OpenCodeRuntimeAdapter,
  OpenCodeRuntimeReconciliationProbe,
  RoutingEvalPlane,
  RuntimeBackedDeferredBoundedLiveExecutionCoordinator,
  RuntimeReconciliationCoordinator,
  RuntimeRunLedgerFinalizer,
  RuntimeVerificationCoordinator,
  assessM5ControlledExperimentAdmission,
  buildCanonicalMetricTaxonomy,
  buildEvalCohortSummary,
  buildExecutionReliabilitySummary,
  evaluateControlledExperimentGuardrails,
  executionProjectionToEvalMeasurement,
  prepareBoundedLiveRollbackAuthorization,
  prepareBoundedLiveSampleAuthorization,
  prepareControlledExperimentAuthorization,
  prepareControlledExperimentDefinition,
  prepareGoldenTaskSuite,
  prepareM5AdmissionPolicy,
  prepareVerifiedBoundedLivePairedExecution,
  prepareVerifiedBoundedLiveRuntimeResult,
  verifyBoundedLivePublicationReceipt,
  verifyBoundedLiveReferenceRestoreReceipt,
  verifyDeferredBoundedLiveRuntimeDispatchEnvelope,
  verifyVerifiedBoundedLivePairedExecutionEnvelope,
} from "../dist/index.js";

const execFile = promisify(execFileCallback);
const projectDir = resolve(process.env.ROUTER_BOUNDED_LIVE_PROJECT_DIR?.trim() || process.cwd());
const stateRootInput = process.env.ROUTER_BOUNDED_LIVE_STATE_ROOT?.trim();
const openCodeBaseUrl = process.env.OPENCODE_BASE_URL?.trim() || "http://127.0.0.1:4096";
const sinkBaseUrl = process.env.ROUTER_BOUNDED_LIVE_SINK_BASE_URL?.trim() || "http://127.0.0.1:4097";
const username = process.env.OPENCODE_SERVER_USERNAME?.trim() || "opencode";
const password = process.env.OPENCODE_SERVER_PASSWORD;
const referenceProviderId = requiredEnv("ROUTER_BOUNDED_LIVE_REFERENCE_PROVIDER_ID");
const referenceModelId = requiredEnv("ROUTER_BOUNDED_LIVE_REFERENCE_MODEL_ID");
const candidateProviderId = requiredEnv("ROUTER_BOUNDED_LIVE_CANDIDATE_PROVIDER_ID");
const candidateModelId = requiredEnv("ROUTER_BOUNDED_LIVE_CANDIDATE_MODEL_ID");
if (!stateRootInput) throw new Error("ROUTER_BOUNDED_LIVE_STATE_ROOT is required");
if (referenceProviderId === candidateProviderId && referenceModelId === candidateModelId) throw new Error("Reference and candidate model targets must be distinct");

const stateRoot = resolve(stateRootInput);
const PROJECT_ID = "9router-isolated-bounded-live-proof";
const LATENCY_KEY = "runtime.total_ms";
const referenceSubjectId = `opencode:${referenceProviderId}/${referenceModelId}`;
const candidateSubjectId = `opencode:${candidateProviderId}/${candidateModelId}`;
const baseTime = Date.now() - 10 * 60_000;
const at = (seconds) => new Date(baseTime + seconds * 1000).toISOString();
const HISTORY_OPTIONS = (filePath) => ({ filePath, maxFileBytes: 4 * 1024 * 1024, maxObservationBytes: 128 * 1024, maxReportBytes: 64 * 1024, maxStringBytes: 2048, maxSourceReferences: 8 });

try {
  await mkdir(stateRoot, { recursive: true });
  const existing = await readdir(stateRoot);
  if (existing.some((name) => name !== "sink-state.json")) throw new Error(`Bounded-live state root is not clean: ${stateRoot}`);
  const originalHead = await gitOutput(["rev-parse", "HEAD"]);
  const originalSnapshot = await workingTreeSnapshot();
  if (originalSnapshot.length > 0) throw new Error("Bounded-live proof requires a clean router worktree");

  const sink = new IsolatedLoopbackBoundedLiveSinkClient({ baseUrl: sinkBaseUrl, timeoutMs: 10_000 });
  await sink.health();
  const authority = await buildAuthority();
  await writeFile(join(stateRoot, "authority.json"), `${JSON.stringify(authority.persisted, null, 2)}\n`, "utf8");

  const executionJournal = await JsonlControlledExperimentExecutionJournal.open({ filePath: join(stateRoot, "experiment-execution.jsonl"), experimentId: authority.experiment.experimentId, maxFileBytes: 4 * 1024 * 1024, maxEventBytes: 64 * 1024, maxStringBytes: 2048 });
  const sideEffects = await JsonlBoundedLiveSideEffectJournal.open({ filePath: join(stateRoot, "side-effects.jsonl"), maxFileBytes: 4 * 1024 * 1024, maxEventBytes: 64 * 1024, maxStringBytes: 2048 });
  const deferred = new DeferredBoundedLiveExecutor(executionJournal, sideEffects);
  const progress = emptyProgress();

  await seedShadow(executionJournal, authority, progress);
  let guardrail = await guardrailFor(authority, progress, { shadowSamples: 1, liveSamples: 0, candidateLiveSamples: 0, observedAt: at(90) });
  if (guardrail.payload.classification !== "ELIGIBLE_FOR_BOUNDED_LIVE") throw new Error(`Expected ELIGIBLE_FOR_BOUNDED_LIVE; received ${guardrail.payload.classification}`);

  const fixtureReferenceWorkflow = approvedWorkflow(join(stateRoot, "fixture-reference-live-workflow.jsonl"), "fixture-reference-live", "approval:fixture-reference-live", at(95));
  const fixtureReferenceAuthorization = await prepareBoundedLiveSampleAuthorization({ experiment: authority.experiment, experimentAuthorization: authority.experimentAuthorization, admissionDecision: authority.admissionDecision, experimentWorkflow: authority.experimentWorkflow, guardrailDecision: guardrail, liveWorkflow: fixtureReferenceWorkflow.run, authorization: { sampleId: "fixture-reference-live-1", inputReference: "fixture:prior-reference-live", liveAssignment: "reference", actor: "operator:bounded-live-proof-fixture", approvedAt: at(110), policyReferences: ["policy:isolated-bounded-live-v1"], approvalIds: ["approval:fixture-reference-live"] } });
  await deferred.reserve({ experiment: authority.experiment, authorization: fixtureReferenceAuthorization, requestedAt: at(111) });
  const fixtureReference = await appendSyntheticPair(authority, progress, "fixture-reference-live", 105, 103, at(112));
  await executionJournal.recordDispatch({ sampleId: fixtureReferenceAuthorization.payload.sampleId, adapterId: "deterministic-prior-reference-live-fixture", acceptedAt: at(113), referenceExecutionReference: "fixture-live:reference", candidateExecutionReference: "fixture-live:candidate", candidateOutputExternallyVisible: false });
  await executionJournal.recordCompletion({ sampleId: fixtureReferenceAuthorization.payload.sampleId, completedAt: at(114), referenceObservationId: fixtureReference.referenceObservation.observationId, candidateObservationId: fixtureReference.candidateObservation.observationId });

  guardrail = await guardrailFor(authority, progress, { shadowSamples: 1, liveSamples: 1, candidateLiveSamples: 0, observedAt: at(120) });
  if (guardrail.payload.classification !== "CONTINUE_BOUNDED_LIVE") throw new Error(`Expected CONTINUE_BOUNDED_LIVE; received ${guardrail.payload.classification}`);

  const candidateWorkflow = approvedWorkflow(join(stateRoot, "candidate-live-workflow.jsonl"), "candidate-live", "approval:candidate-live", at(125));
  const candidateAuthorization = await prepareBoundedLiveSampleAuthorization({ experiment: authority.experiment, experimentAuthorization: authority.experimentAuthorization, admissionDecision: authority.admissionDecision, experimentWorkflow: authority.experimentWorkflow, guardrailDecision: guardrail, liveWorkflow: candidateWorkflow.run, authorization: { sampleId: "candidate-live-1", inputReference: "isolated:real-candidate-live", liveAssignment: "candidate", actor: "operator:isolated-bounded-live-proof", approvedAt: at(140), policyReferences: ["policy:isolated-bounded-live-v1"], approvalIds: ["approval:candidate-live"] } });
  if (candidateAuthorization.payload.candidateTrafficAfterDispatchBasisPoints !== 5000) throw new Error("Candidate traffic authorization must equal 5000 basis points");
  await deferred.reserve({ experiment: authority.experiment, authorization: candidateAuthorization, requestedAt: at(141) });

  const runtimeState = openRuntimeState();
  const realCandidate = await executeCandidateSample({ authority, authorization: candidateAuthorization, runtimeState, sideEffects, deferred, sink });
  pushProgress(progress, realCandidate.progress);

  const finalGuardrail = await guardrailFor(authority, progress, { shadowSamples: 1, liveSamples: 2, candidateLiveSamples: 1, observedAt: new Date().toISOString() });
  if (finalGuardrail.payload.classification !== "COMPLETE") throw new Error(`Expected COMPLETE after bounded sample budget; received ${finalGuardrail.payload.classification}`);

  const rollbackDrill = await rollbackSafetyDrill(authority, sideEffects, sink);
  const sinkState = await fetchJson(`${sinkBaseUrl}/state`);
  if (sinkState.activeSubjectId !== referenceSubjectId) throw new Error("Reference subject was not active after rollback safety drill");
  if (sinkState.rawOutputPersisted !== false || JSON.stringify(sinkState).includes('"output"')) throw new Error("Isolated sink persisted raw output");
  if (!Array.isArray(sinkState.publications) || sinkState.publications.length !== 1) throw new Error("Isolated sink must contain exactly one real candidate publication");

  const finalHead = await gitOutput(["rev-parse", "HEAD"]);
  const finalSnapshot = await workingTreeSnapshot();
  if (finalHead !== originalHead || !sameArray(finalSnapshot, originalSnapshot)) throw new Error("Router Git state changed during bounded-live proof");

  const result = {
    overall: "PASS",
    referenceSlice: "9router-isolated-bounded-live-runtime-proof",
    stateRoot,
    experimentId: authority.experiment.experimentId,
    referenceModel: `${referenceProviderId}/${referenceModelId}`,
    candidateModel: `${candidateProviderId}/${candidateModelId}`,
    priorBudgetEvidenceMode: "deterministic_authorized_fixture_shadow_plus_reference_live",
    priorReferenceLiveAuthorizationId: fixtureReferenceAuthorization.authorizationId,
    realLiveAssignment: "candidate",
    candidateLiveAuthorizationId: candidateAuthorization.authorizationId,
    candidateTrafficBasisPoints: candidateAuthorization.payload.candidateTrafficAfterDispatchBasisPoints,
    runtimeDispatchId: realCandidate.runtimeDispatch.dispatchId,
    pairedExecutionId: realCandidate.paired.executionId,
    candidatePublicationReceiptId: realCandidate.publication.receiptId,
    candidateOutputSha256: realCandidate.publication.payload.outputSha256,
    candidateOutputBytes: realCandidate.publication.payload.outputBytes,
    candidateOutputExternallyVisibleBeforePublication: false,
    candidateOutputExternallyVisibleAfterVerifiedPublication: realCandidate.publication.payload.candidateOutputExternallyVisible,
    rawProviderOutputPersisted: false,
    automaticRedispatchAllowed: false,
    automaticRetryAllowed: false,
    productionRoutingMutationAllowed: false,
    finalGuardrailClassification: finalGuardrail.payload.classification,
    rollbackProofMode: "deterministic_safety_drill_not_observed_live_regression",
    rollbackGuardrailClassification: rollbackDrill.guardrail.payload.classification,
    restoreReceiptId: rollbackDrill.receipt.receiptId,
    referenceSubjectRestored: rollbackDrill.receipt.payload.referenceSubjectRestored,
    finalActiveSubjectId: sinkState.activeSubjectId,
    gitHeadUnchanged: true,
    workingTreeUnchanged: true,
    durableHashes: await hashes([
      "authority.json", "admission-history.jsonl", "progress-history.jsonl", "experiment-workflow.jsonl", "fixture-reference-live-workflow.jsonl", "candidate-live-workflow.jsonl", "runtime-workflow.jsonl", "binding.jsonl", "ledger.jsonl", "experiment-execution.jsonl", "side-effects.jsonl", "sink-state.json", "rollback-drill-workflow.jsonl"
    ]),
    nextGate: "INDEPENDENT_BOUNDED_LIVE_RUNTIME_REVIEW",
  };
  await writeFile(join(stateRoot, "proof-result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(JSON.stringify({ overall: "FAIL", stateRoot, error: safeError(error) }, null, 2));
  process.exitCode = 1;
}

async function buildAuthority() {
  const suite = await prepareGoldenTaskSuite({ schemaVersion: 1, suiteId: "isolated-bounded-live-suite", description: "Authority fixture for isolated bounded-live runtime proof.", tasks: [{ id: "route", kind: "routing", prompt: "Route isolated bounded-live fixture.", critical: true, minimumScore: 1, assertions: [{ id: "model", kind: "primary_model_equals", weight: 1, expected: "model-a" }, { id: "verification", kind: "requires_verification_equals", weight: 1, expected: true }] }] }, { maxTasks: 8, maxAssertionsPerTask: 8, maxPromptBytes: 4096, maxStringBytes: 2048, maxSuiteBytes: 64 * 1024 });
  const plane = new RoutingEvalPlane({ maxReportBytes: 64 * 1024, maxSubjectIdBytes: 2048 });
  const subject = (id) => ({ id, async route() { return { primaryModel: { candidate: { id: "model-a" } }, selectedSkills: [], analysis: { requiresVerification: true } }; } });
  const referenceReport = await plane.evaluate(suite, subject(referenceSubjectId));
  const candidateReport = await plane.evaluate(suite, subject(candidateSubjectId));
  const baseline = (subjectId) => ({ schemaVersion: 1, baselineId: "isolated-bounded-live-baseline", suiteId: suite.suiteId, suiteSha256: suite.suiteSha256, subjectId, minimumWeightedScore: 1, minimumTaskPassRate: 1, minimumCriticalPassRate: 1, maximumFailedTasks: 0 });
  const referenceBaseline = baseline(referenceSubjectId), candidateBaseline = baseline(candidateSubjectId);
  const admissionHistory = await JsonlEvalHistory.open(HISTORY_OPTIONS(join(stateRoot, "admission-history.jsonl")));
  const referenceAdmission = await admissionHistory.append({ observedAt: at(5), report: referenceReport, baseline: referenceBaseline });
  const candidateAdmission = await admissionHistory.append({ observedAt: at(6), report: candidateReport, baseline: candidateBaseline });
  const taxonomy = await buildCanonicalMetricTaxonomy();
  const policy = await prepareM5AdmissionPolicy(taxonomy, { name: "isolated-bounded-live-admission", minimumObservationCount: 1, requireExecutionReliability: false, requireFullExecutionProvenance: false, minimumExecutionSampleCount: 0, minimumDecidedExecutionSampleCount: 0, minimumLatencyCoverageRatio: 0, minimumCostCoverageRatio: 0, maximumCoverageRegressionRatio: 1, maximumWeightedScoreMeanRegression: 0.1, maximumTaskPassRateMeanRegression: 0.1, maximumCriticalPassRateMeanRegression: 0.1, maximumBaselinePassRateRegression: 0.1, maximumExecutionSuccessRateRegression: 0.1, maximumCancellationRateIncrease: 0.1 });
  const admissionDecision = await assessM5ControlledExperimentAdmission({ taxonomy, policy, reference: { evalSummary: await buildEvalCohortSummary([referenceAdmission]) }, candidate: { evalSummary: await buildEvalCohortSummary([candidateAdmission]) } });
  if (!admissionDecision.payload.experimentAdmissionEligible) throw new Error("Admission fixture is not eligible");
  const experiment = await prepareControlledExperimentDefinition(admissionDecision, { name: "isolated-bounded-live-proof", projectId: PROJECT_ID, riskClass: "R3", exposureMode: "shadow_then_bounded_live", budget: { maxTotalSamples: 3, minimumShadowSamplesBeforeLive: 1, maxLiveSamples: 2, maxCandidateLiveSamples: 1, maxCandidateTrafficBasisPoints: 5000 }, stopConditions: { maxFailedExecutions: 0, maximumCancellationRate: 0.1, maximumWeightedScoreMeanRegression: 0.1, maximumTaskPassRateMeanRegression: 0.1, maximumCriticalPassRateMeanRegression: 0.1, maximumBaselinePassRateRegression: 0.1, maximumExecutionSuccessRateRegression: 0.1, maximumLatencyMeanIncreaseMs: 1_000_000 }, rollbackPolicyReference: "policy:isolated-reference-restore-v1" });
  const experimentWorkflow = approvedWorkflow(join(stateRoot, "experiment-workflow.jsonl"), "bounded-live-experiment", "approval:bounded-live-experiment", at(10));
  const experimentAuthorization = await prepareControlledExperimentAuthorization(experiment, admissionDecision, experimentWorkflow.run, { decision: "allow", actor: "operator:isolated-bounded-live-proof", decidedAt: at(25), policyReferences: ["policy:isolated-bounded-live-experiment-v1"], approvalIds: ["approval:bounded-live-experiment"] });
  const progressHistory = await JsonlEvalHistory.open(HISTORY_OPTIONS(join(stateRoot, "progress-history.jsonl")));
  return { referenceReport, candidateReport, referenceBaseline, candidateBaseline, admissionDecision, experiment, experimentWorkflow: experimentWorkflow.run, experimentAuthorization, progressHistory, persisted: { admissionDecision, experiment, experimentWorkflow: experimentWorkflow.run, experimentAuthorization, referenceSubjectId, candidateSubjectId } };
}

async function seedShadow(journal, authority, progress) {
  const pair = await appendSyntheticPair(authority, progress, "shadow-seed", 100, 95, at(60));
  await journal.reserveSample({ sampleId: "shadow-seed-1", exposure: "shadow", liveAssignment: "none", inputReference: "fixture:shadow-seed", reservedAt: at(62) });
  await journal.recordDispatch({ sampleId: "shadow-seed-1", adapterId: "deterministic-shadow-fixture", acceptedAt: at(63), referenceExecutionReference: "fixture-shadow:reference", candidateExecutionReference: "fixture-shadow:candidate", candidateOutputExternallyVisible: false });
  await journal.recordCompletion({ sampleId: "shadow-seed-1", completedAt: at(64), referenceObservationId: pair.referenceObservation.observationId, candidateObservationId: pair.candidateObservation.observationId });
}

async function executeCandidateSample({ authority, authorization, runtimeState, sideEffects, deferred, sink }) {
  const referenceRun = executeRun(runtimeState.machine, `candidate-proof-reference-${Date.now()}`);
  const candidateRun = executeRun(runtimeState.machine, `candidate-proof-candidate-${Date.now() + 1}`);
  const referenceRuntime = new OpenCodeRuntimeAdapter({ baseUrl: openCodeBaseUrl, username, password, model: { providerID: referenceProviderId, modelID: referenceModelId } });
  const candidateRuntime = new OpenCodeRuntimeAdapter({ baseUrl: openCodeBaseUrl, username, password, model: { providerID: candidateProviderId, modelID: candidateModelId } });
  const common = { prompt: "Isolated bounded-live candidate proof. Reply with one concise acknowledgement only. Do not modify files, call tools, access the network, install packages, commit, push, deploy, or request approval.", context: ["9Router isolated bounded-live proof.", "No runtime tools are exposed.", "Candidate output is forbidden from visibility until deterministic verification and explicit publication."], toolIds: [] };
  const resolver = { async resolve({ role, subjectId }) { return role === "reference" ? { subjectId, run: referenceRun, workspace: projectDir, adapter: referenceRuntime, bindingStore: runtimeState.bindingStore, task: { taskId: "candidate-proof-reference-task", ...common } } : { subjectId, run: candidateRun, workspace: projectDir, adapter: candidateRuntime, bindingStore: runtimeState.bindingStore, task: { taskId: "candidate-proof-candidate-task", ...common } }; } };
  const runtimeCoordinator = new RuntimeBackedDeferredBoundedLiveExecutionCoordinator(resolver);
  const started = Date.now();
  const runtimeDispatch = await runtimeCoordinator.dispatch({ experiment: authority.experiment, authorization });
  await verifyDeferredBoundedLiveRuntimeDispatchEnvelope(runtimeDispatch);
  if (runtimeDispatch.payload.candidateOutputExternallyVisible !== false) throw new Error("Candidate became visible during runtime dispatch");
  const referenceBinding = requireBinding(runtimeState.bindingStore, referenceRun.id), candidateBinding = requireBinding(runtimeState.bindingStore, candidateRun.id);
  await Promise.all([waitComplete(referenceRuntime, referenceBinding.sessionId, "reference"), waitComplete(candidateRuntime, candidateBinding.sessionId, "candidate")]);
  const probe = new OpenCodeRuntimeReconciliationProbe({ baseUrl: openCodeBaseUrl, username, password });
  const reconciliation = new RuntimeReconciliationCoordinator();
  const referenceReport = await reconciliation.reconcile(referenceRun, referenceBinding, probe), candidateReport = await reconciliation.reconcile(candidateRun, candidateBinding, probe);
  requireVerificationReady(referenceReport, "reference"); requireVerificationReady(candidateReport, "candidate");
  const verification = new RuntimeVerificationCoordinator();
  const referenceVerification = await verifyRuntime(verification, referenceRun, referenceReport, referenceRuntime, "reference");
  const candidateVerification = await verifyRuntime(verification, candidateRun, candidateReport, candidateRuntime, "candidate");
  if (!referenceVerification.passed || !candidateVerification.passed) throw new Error("Paired runtime deterministic verification failed");
  const referenceTerminal = terminalize(runtimeState, referenceRun.id), candidateTerminal = terminalize(runtimeState, candidateRun.id);
  const elapsed = Date.now() - started;
  const referenceLedger = finalize(runtimeState.ledger, referenceTerminal, referenceBinding, referenceVerification, referenceSubjectId, "reference", elapsed);
  const candidateLedger = finalize(runtimeState.ledger, candidateTerminal, candidateBinding, candidateVerification, candidateSubjectId, "candidate", elapsed);
  const referenceVerificationReference = verificationReference(referenceVerification), candidateVerificationReference = verificationReference(candidateVerification);
  const paired = await prepareVerifiedBoundedLivePairedExecution({ experiment: authority.experiment, authorization, referenceRun: referenceLedger, candidateRun: candidateLedger, referenceBinding, candidateBinding, referenceVerificationReference, candidateVerificationReference, verifiedAt: new Date().toISOString() });
  await verifyVerifiedBoundedLivePairedExecutionEnvelope(paired);

  const reader = new OpenCodeBoundedLiveOutputReader({ baseUrl: openCodeBaseUrl, username, password, workspace: projectDir, maxOutputBytes: 64 * 1024 });
  const candidateOutput = await reader.read({ runtimeId: candidateBinding.runtimeId, sessionId: candidateBinding.sessionId, runId: candidateLedger.runId });
  const outputSha256 = createHash("sha256").update(candidateOutput, "utf8").digest("hex").toUpperCase();
  const runtimeResult = await prepareVerifiedBoundedLiveRuntimeResult({ role: "candidate", authorization, run: candidateLedger, binding: candidateBinding, verificationReference: candidateVerificationReference, outputSha256, outputBytes: Buffer.byteLength(candidateOutput, "utf8"), verifiedAt: paired.payload.verifiedAt });
  const publisher = new BoundedLivePublicationCoordinator(reader, sink, sideEffects);
  const publication = await publisher.publish({ authorization, runtimeResult });
  await verifyBoundedLivePublicationReceipt(publication);
  await deferred.recordPublishedDispatch({ authorization, pairedExecution: paired, selectedRuntimeResult: runtimeResult, publicationReceipt: publication });
  const realProgress = await appendActualPair(authority, referenceLedger, candidateLedger);
  await deferred.recordCompletion({ authorization, completedAt: new Date().toISOString(), referenceObservationId: realProgress.referenceObservation.observationId, candidateObservationId: realProgress.candidateObservation.observationId });
  await Promise.allSettled([referenceRuntime.destroy(referenceBinding.sessionId), candidateRuntime.destroy(candidateBinding.sessionId)]);
  return { runtimeDispatch, paired, publication, progress: realProgress };
}

async function rollbackSafetyDrill(authority, sideEffects, sink) {
  const drill = emptyProgress();
  for (let i = 0; i < 3; i += 1) {
    const referenceRecord = syntheticRecord(`rollback-reference-${i}`, referenceSubjectId, "succeeded", 100 + i);
    const candidateRecord = syntheticRecord(`rollback-candidate-${i}`, candidateSubjectId, i === 2 ? "failed" : "succeeded", 100 + i);
    pushProgress(drill, await appendPair(authority, referenceRecord, candidateRecord, at(200 + i * 2)));
  }
  const guardrail = await guardrailFor(authority, drill, { shadowSamples: 1, liveSamples: 2, candidateLiveSamples: 1, observedAt: at(220) });
  if (guardrail.payload.classification !== "ROLLBACK_REQUIRED") throw new Error(`Rollback safety drill expected ROLLBACK_REQUIRED; received ${guardrail.payload.classification}`);
  const workflow = approvedWorkflow(join(stateRoot, "rollback-drill-workflow.jsonl"), "rollback-drill", "approval:rollback-drill", at(225));
  const rollbackAuthorization = await prepareBoundedLiveRollbackAuthorization({ experiment: authority.experiment, experimentAuthorization: authority.experimentAuthorization, admissionDecision: authority.admissionDecision, experimentWorkflow: authority.experimentWorkflow, guardrailDecision: guardrail, rollbackWorkflow: workflow.run, authorization: { actor: "operator:rollback-safety-drill", approvedAt: at(240), policyReferences: ["policy:isolated-reference-restore-v1"], approvalIds: ["approval:rollback-drill"] } });
  const receipt = await new BoundedLiveReferenceRestoreCoordinator(sink, sideEffects).restore(rollbackAuthorization);
  await verifyBoundedLiveReferenceRestoreReceipt(receipt);
  return { guardrail, receipt };
}

async function appendSyntheticPair(authority, progress, prefix, referenceLatency, candidateLatency, observedAt) {
  const pair = await appendPair(authority, syntheticRecord(`${prefix}-reference`, referenceSubjectId, "succeeded", referenceLatency), syntheticRecord(`${prefix}-candidate`, candidateSubjectId, "succeeded", candidateLatency), observedAt);
  pushProgress(progress, pair); return pair;
}
async function appendActualPair(authority, referenceRecord, candidateRecord) { return appendPair(authority, referenceRecord, candidateRecord, new Date().toISOString()); }
async function appendPair(authority, referenceRecord, candidateRecord, observedAt) {
  const projector = new ExecutionMetricProjector({ latencyMetricKey: LATENCY_KEY, requireLatency: true, maxMetricKeyBytes: 256 });
  const referenceProjection = await projector.project(referenceRecord), candidateProjection = await projector.project(candidateRecord);
  const referenceObservation = await authority.progressHistory.append({ observedAt, report: authority.referenceReport, baseline: authority.referenceBaseline, measurement: await executionProjectionToEvalMeasurement(referenceProjection) });
  const candidateObservation = await authority.progressHistory.append({ observedAt: new Date(Date.parse(observedAt) + 1).toISOString(), report: authority.candidateReport, baseline: authority.candidateBaseline, measurement: await executionProjectionToEvalMeasurement(candidateProjection) });
  return { referenceObservation, candidateObservation, referenceProjection, candidateProjection, referenceRecord, candidateRecord };
}
function emptyProgress() { return { referenceObservations: [], candidateObservations: [], referenceProjections: [], candidateProjections: [], referenceRecords: [], candidateRecords: [] }; }
function pushProgress(progress, pair) { progress.referenceObservations.push(pair.referenceObservation); progress.candidateObservations.push(pair.candidateObservation); progress.referenceProjections.push(pair.referenceProjection); progress.candidateProjections.push(pair.candidateProjection); progress.referenceRecords.push(pair.referenceRecord); progress.candidateRecords.push(pair.candidateRecord); }
async function guardrailFor(authority, progress, counters) { return evaluateControlledExperimentGuardrails({ experiment: authority.experiment, authorization: authority.experimentAuthorization, admissionDecision: authority.admissionDecision, workflow: authority.experimentWorkflow, progress: { ...counters, referenceEvalSummary: await buildEvalCohortSummary(progress.referenceObservations), candidateEvalSummary: await buildEvalCohortSummary(progress.candidateObservations), referenceExecutionSummary: await buildExecutionReliabilitySummary(progress.referenceObservations, progress.referenceProjections, progress.referenceRecords), candidateExecutionSummary: await buildExecutionReliabilitySummary(progress.candidateObservations, progress.candidateProjections, progress.candidateRecords) } }); }

function openRuntimeState() { const workflowStore = new JsonlWorkflowCheckpointStore({ filePath: join(stateRoot, "runtime-workflow.jsonl"), maxFileBytes: 4 * 1024 * 1024, maxCheckpointBytes: 64 * 1024 }); return { workflowStore, machine: new DurableWorkflowStateMachine(workflowStore), bindingStore: new JsonlRuntimeBindingStore({ filePath: join(stateRoot, "binding.jsonl"), maxFileBytes: 4 * 1024 * 1024, maxBindingBytes: 64 * 1024 }), ledger: new JsonlRunLedger({ filePath: join(stateRoot, "ledger.jsonl"), maxFileBytes: 4 * 1024 * 1024, maxRecordBytes: 256 * 1024 }) }; }
function approvedWorkflow(filePath, id, approvalId, startAt) { const store = new JsonlWorkflowCheckpointStore({ filePath, maxFileBytes: 512 * 1024, maxCheckpointBytes: 64 * 1024 }); const machine = new DurableWorkflowStateMachine(store); const base = Date.parse(startAt), t = (s) => new Date(base + s * 1000).toISOString(); let run = machine.create({ id, projectId: PROJECT_ID, riskClass: "R3", now: t(0) }); run = machine.start(run, t(1)); run = machine.advance(run, t(2)); run = machine.advance(run, t(3)); run = machine.advance(run, t(4)); run = machine.advance(run, t(5)); run = machine.requestApproval(run, t(6)); run = machine.approve(run, approvalId, t(7)); if (run.phase !== "publish" || run.status !== "running") throw new Error(`${id} did not reach approved publish/running`); return { run, store }; }
function executeRun(machine, id) { let run = machine.create({ id, projectId: PROJECT_ID, riskClass: "R0", now: new Date().toISOString() }); run = machine.start(run); run = machine.advance(run); run = machine.advance(run); if (run.phase !== "execute") throw new Error(`${id} did not reach execute`); return run; }
function terminalize(state, runId) { let run = state.workflowStore.get(runId); if (!run) throw new Error(`Missing runtime workflow ${runId}`); run = state.machine.advance(run); run = state.machine.advance(run); run = state.machine.skipApproval(run); return state.machine.succeed(run, true); }
function finalize(ledger, run, binding, verification, subjectId, role, elapsedMs) { return new RuntimeRunLedgerFinalizer().appendTerminal({ run, binding, ledger, task: `Isolated bounded-live ${role}`, modelRoute: [subjectId], contextCompilerVersion: "isolated-bounded-live/v1", skills: ["runtime.binding", "runtime.reconciliation", "deterministic.verification", "bounded-live.deferred-publication"], toolsets: [], policyDecisions: ["R0 paired runtime", "zero tools", "verify before visibility"], changeReferences: [], evidence: [{ kind: "policy", status: "passed", reference: `policy:${run.id}`, producer: "isolated-bounded-live-proof", collectedAt: new Date().toISOString() }], verification, resourceMetrics: { [LATENCY_KEY]: Math.max(0, elapsedMs) }, traceId: `bounded-live:${run.id}` }); }
async function verifyRuntime(coordinator, run, report, runtime, role) { return coordinator.verify(run, report, { id: `isolated-bounded-live-${role}-verifier`, async verify({ binding, observation }) { const diff = await runtime.getDiff(binding.sessionId); const passed = observation.status === "completed" && diff.filesChanged.length === 0 && !diff.patch; return { passed, reference: `verifier:isolated-bounded-live:${role}:${passed ? "pass" : "fail"}`, collectedAt: new Date().toISOString(), metadata: { filesChanged: diff.filesChanged.length, patchObserved: Boolean(diff.patch) } }; } }); }
async function waitComplete(runtime, sessionId, role) { const started = Date.now(); while (Date.now() - started <= 300_000) { const events = await runtime.getEvents(sessionId); if (events.some((e) => e.type === "approval_requested")) throw new Error(`${role} requested approval in zero-tool proof`); const status = await runtime.getStatus(sessionId); if (status === "completed") return; if (["failed", "aborted", "destroyed", "interrupted"].includes(status)) throw new Error(`${role} runtime failed: ${status}`); await new Promise((resolve) => setTimeout(resolve, 1000)); } try { await runtime.abort(sessionId, "isolated bounded-live timeout"); } catch {} throw new Error(`${role} runtime exceeded 300 seconds`); }
function requireVerificationReady(report, role) { if (report.disposition !== "verify_runtime_result" || report.observation?.status !== "completed") throw new Error(`${role} reconciliation not verification-ready`); }
function requireBinding(store, runId) { const value = store.get(runId); if (!value) throw new Error(`Missing RuntimeBinding for ${runId}`); return value; }
function verificationReference(outcome) { const item = outcome.evidence.find((e) => e.kind === "deterministic_check" && e.status === "passed" && e.producer === outcome.verifierId); if (!item) throw new Error(`Missing deterministic verification reference for ${outcome.workflowRunId}`); return item.reference; }
function syntheticRecord(runId, subjectId, outcome, latencyMs) { return { runId, projectId: PROJECT_ID, task: "Deterministic bounded-live evidence fixture", riskClass: "R0", runtimeId: "opencode", modelRoute: [subjectId], contextCompilerVersion: "isolated-bounded-live-fixture/v1", skills: [], toolsets: [], workspace: projectDir, policyDecisions: ["fixture:evidence-only"], approvalIds: [], changeReferences: [], evidence: [{ kind: "policy", status: "passed", reference: `policy:${runId}`, producer: "bounded-live-proof-fixture", collectedAt: at(0) }], resourceMetrics: { [LATENCY_KEY]: latencyMs }, traceId: `trace:${runId}`, outcome, failureReason: outcome === "failed" ? "deterministic rollback safety drill" : undefined, createdAt: at(0) }; }
async function fetchJson(url) { const response = await fetch(url, { cache: "no-store" }); if (!response.ok) throw new Error(`GET ${url} failed HTTP ${response.status}`); return response.json(); }
async function gitOutput(args) { const { stdout } = await execFile("git", args, { cwd: projectDir, windowsHide: true }); return stdout.trim(); }
async function workingTreeSnapshot() { const raw = await gitOutput(["status", "--porcelain=v1", "--untracked-files=all"]); return raw ? raw.split(/\r?\n/).filter(Boolean) : []; }
async function hashes(names) { const result = {}; for (const name of names) { try { result[name] = createHash("sha256").update(await readFile(join(stateRoot, name))).digest("hex").toUpperCase(); } catch {} } return result; }
function sameArray(a, b) { return a.length === b.length && a.every((value, index) => value === b[index]); }
function requiredEnv(name) { const value = process.env[name]?.trim(); if (!value) throw new Error(`${name} is required`); return value; }
function safeError(error) { return (error instanceof Error ? error.message : String(error)).replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [redacted]").replace(/(authorization|api[_-]?key|access[_-]?token|password|secret|credential)\s*[:=]\s*(Bearer\s+)?[^\s,;]+/gi, "$1=[redacted]"); }
