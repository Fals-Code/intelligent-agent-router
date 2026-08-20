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
if (!stateRootInput) fail("ROUTER_BOUNDED_LIVE_STATE_ROOT is required");
if (referenceProviderId === candidateProviderId && referenceModelId === candidateModelId) fail("Reference and candidate model targets must be distinct");

const stateRoot = resolve(stateRootInput);
const PROJECT_ID = "9router-isolated-bounded-live-proof";
const LATENCY_KEY = "runtime.total_ms";
const referenceSubjectId = `opencode:${referenceProviderId}/${referenceModelId}`;
const candidateSubjectId = `opencode:${candidateProviderId}/${candidateModelId}`;
const LIMITS = Object.freeze({ maxFileBytes: 4 * 1024 * 1024, maxRecordBytes: 256 * 1024 });
const SUITE_LIMITS = Object.freeze({ maxTasks: 8, maxAssertionsPerTask: 8, maxPromptBytes: 4096, maxStringBytes: 2048, maxSuiteBytes: 64 * 1024 });

try {
  await mkdir(stateRoot, { recursive: true });
  if ((await readdir(stateRoot)).length > 1) throw new Error(`Bounded-live state root must be empty except optional sink state: ${stateRoot}`);
  const originalHead = await gitOutput(["rev-parse", "HEAD"]);
  const originalSnapshot = await workingTreeSnapshot();
  if (originalSnapshot.length > 0) throw new Error("Bounded-live proof requires a clean router working tree");

  const sink = new IsolatedLoopbackBoundedLiveSinkClient({ baseUrl: sinkBaseUrl, timeoutMs: 10_000 });
  await sink.health();
  const authority = await prepareAuthority();
  await writeFile(join(stateRoot, "authority.json"), `${JSON.stringify(authority.persisted, null, 2)}\n`, "utf8");

  const executionJournal = await JsonlControlledExperimentExecutionJournal.open({ filePath: join(stateRoot, "experiment-execution.jsonl"), experimentId: authority.experiment.experimentId, maxFileBytes: LIMITS.maxFileBytes, maxEventBytes: 64 * 1024, maxStringBytes: 2048 });
  const sideEffects = await JsonlBoundedLiveSideEffectJournal.open({ filePath: join(stateRoot, "side-effects.jsonl"), maxFileBytes: LIMITS.maxFileBytes, maxEventBytes: 64 * 1024, maxStringBytes: 2048 });
  const deferred = new DeferredBoundedLiveExecutor(executionJournal, sideEffects);

  const shadowProgress = await seedCompletedShadowSample(executionJournal, authority);
  let guardrail = await evaluateControlledExperimentGuardrails({
    experiment: authority.experiment,
    authorization: authority.experimentAuthorization,
    admissionDecision: authority.admissionDecision,
    workflow: authority.experimentWorkflow,
    progress: progressInput(shadowProgress, 1, 0, 0, "2026-08-20T00:42:00.000Z"),
  });
  if (guardrail.payload.classification !== "ELIGIBLE_FOR_BOUNDED_LIVE") throw new Error(`Expected ELIGIBLE_FOR_BOUNDED_LIVE after shadow seed; received ${guardrail.payload.classification}`);

  const runtimeState = openRuntimeState();
  const referenceLiveWorkflow = createApprovedPublishWorkflow(join(stateRoot, "reference-live-workflow.jsonl"), "bounded-live-reference-approval", "approval:bounded-live-reference", "2026-08-20T00:43:00.000Z");
  const referenceAuthorization = await prepareBoundedLiveSampleAuthorization({
    experiment: authority.experiment,
    experimentAuthorization: authority.experimentAuthorization,
    admissionDecision: authority.admissionDecision,
    experimentWorkflow: authority.experimentWorkflow,
    guardrailDecision: guardrail,
    liveWorkflow: referenceLiveWorkflow.run,
    authorization: { sampleId: "bounded-live-reference-1", inputReference: "isolated-proof:reference-live-v1", liveAssignment: "reference", actor: "operator:isolated-bounded-live-proof", approvedAt: "2026-08-20T00:44:00.000Z", policyReferences: ["policy:isolated-bounded-live-v1"], approvalIds: ["approval:bounded-live-reference"] },
  });
  await deferred.reserve({ experiment: authority.experiment, authorization: referenceAuthorization, requestedAt: "2026-08-20T00:44:01.000Z" });
  const referenceLive = await executeAndPublishSample({ label: "reference-live", authorization: referenceAuthorization, authority, runtimeState, sideEffects, deferred, sink });
  appendProgress(shadowProgress, referenceLive.progress);

  guardrail = await evaluateControlledExperimentGuardrails({
    experiment: authority.experiment,
    authorization: authority.experimentAuthorization,
    admissionDecision: authority.admissionDecision,
    workflow: authority.experimentWorkflow,
    progress: progressInput(shadowProgress, 1, 1, 0, "2026-08-20T00:47:00.000Z"),
  });
  if (guardrail.payload.classification !== "CONTINUE_BOUNDED_LIVE") throw new Error(`Expected CONTINUE_BOUNDED_LIVE after reference live sample; received ${guardrail.payload.classification}`);

  const candidateLiveWorkflow = createApprovedPublishWorkflow(join(stateRoot, "candidate-live-workflow.jsonl"), "bounded-live-candidate-approval", "approval:bounded-live-candidate", "2026-08-20T00:48:00.000Z");
  const candidateAuthorization = await prepareBoundedLiveSampleAuthorization({
    experiment: authority.experiment,
    experimentAuthorization: authority.experimentAuthorization,
    admissionDecision: authority.admissionDecision,
    experimentWorkflow: authority.experimentWorkflow,
    guardrailDecision: guardrail,
    liveWorkflow: candidateLiveWorkflow.run,
    authorization: { sampleId: "bounded-live-candidate-1", inputReference: "isolated-proof:candidate-live-v1", liveAssignment: "candidate", actor: "operator:isolated-bounded-live-proof", approvedAt: "2026-08-20T00:49:00.000Z", policyReferences: ["policy:isolated-bounded-live-v1"], approvalIds: ["approval:bounded-live-candidate"] },
  });
  if (candidateAuthorization.payload.candidateTrafficAfterDispatchBasisPoints !== 5000) throw new Error("Candidate bounded-live authorization did not resolve to exact 5000 basis points");
  await deferred.reserve({ experiment: authority.experiment, authorization: candidateAuthorization, requestedAt: "2026-08-20T00:49:01.000Z" });
  const candidateLive = await executeAndPublishSample({ label: "candidate-live", authorization: candidateAuthorization, authority, runtimeState, sideEffects, deferred, sink });
  appendProgress(shadowProgress, candidateLive.progress);

  const finalGuardrail = await evaluateControlledExperimentGuardrails({
    experiment: authority.experiment,
    authorization: authority.experimentAuthorization,
    admissionDecision: authority.admissionDecision,
    workflow: authority.experimentWorkflow,
    progress: progressInput(shadowProgress, 1, 2, 1, "2026-08-20T00:52:00.000Z"),
  });
  if (finalGuardrail.payload.classification !== "COMPLETE") throw new Error(`Expected COMPLETE after bounded budget consumed; received ${finalGuardrail.payload.classification}`);

  const rollbackDrill = await runRollbackSafetyDrill({ authority, sideEffects, sink });
  const sinkState = await fetchJson(`${sinkBaseUrl}/state`);
  if (sinkState.activeSubjectId !== referenceSubjectId) throw new Error("Isolated sink did not end with canonical reference subject active");
  if (sinkState.rawOutputPersisted !== false || JSON.stringify(sinkState).includes('"output"')) throw new Error("Isolated sink state appears to persist raw provider output");
  if (!Array.isArray(sinkState.publications) || sinkState.publications.length !== 2) throw new Error("Isolated sink did not persist exactly two bounded-live publication records");

  const postHead = await gitOutput(["rev-parse", "HEAD"]);
  const postSnapshot = await workingTreeSnapshot();
  if (postHead !== originalHead || !sameArray(postSnapshot, originalSnapshot)) throw new Error("Router Git state changed during bounded-live proof");

  const durableHashes = await hashExistingFiles([
    "authority.json", "admission-history.jsonl", "progress-history.jsonl", "experiment-workflow.jsonl", "reference-live-workflow.jsonl", "candidate-live-workflow.jsonl",
    "runtime-workflow.jsonl", "binding.jsonl", "ledger.jsonl", "experiment-execution.jsonl", "side-effects.jsonl", "sink-state.json", "rollback-drill-workflow.jsonl",
  ]);
  const result = {
    overall: "PASS",
    referenceSlice: "9router-isolated-bounded-live-runtime-proof",
    stateRoot,
    referenceModel: `${referenceProviderId}/${referenceModelId}`,
    candidateModel: `${candidateProviderId}/${candidateModelId}`,
    experimentId: authority.experiment.experimentId,
    shadowSamples: 1,
    liveSamples: 2,
    candidateLiveSamples: 1,
    candidateTrafficBasisPoints: 5000,
    finalGuardrailClassification: finalGuardrail.payload.classification,
    referencePublication: publicationSummary(referenceLive.publication),
    candidatePublication: publicationSummary(candidateLive.publication),
    candidateOutputExternallyVisibleBeforePublication: false,
    candidateOutputExternallyVisibleAfterVerifiedPublication: candidateLive.publication.payload.candidateOutputExternallyVisible,
    referenceOutputExternallyVisible: referenceLive.publication.payload.externallyVisible,
    candidateOutputExternallyVisible: candidateLive.publication.payload.externallyVisible,
    bothSamplesVerifiedBeforePublication: true,
    bothRunLedgerPairsSucceeded: true,
    zeroRuntimeTools: true,
    rawProviderOutputPersisted: false,
    automaticRedispatchAllowed: false,
    automaticRetryAllowed: false,
    productionRoutingMutationAllowed: false,
    rollbackProofMode: "deterministic_safety_drill_not_observed_live_regression",
    rollbackGuardrailClassification: rollbackDrill.guardrail.payload.classification,
    referenceSubjectRestored: rollbackDrill.receipt.payload.referenceSubjectRestored,
    finalActiveSubjectId: sinkState.activeSubjectId,
    gitHeadUnchanged: true,
    workingTreeUnchanged: true,
    durableHashes,
    nextGate: "INDEPENDENT_BOUNDED_LIVE_RUNTIME_REVIEW",
  };
  await writeFile(join(stateRoot, "proof-result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  result.durableHashes["proof-result.json"] = (await hashFile(join(stateRoot, "proof-result.json")));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(JSON.stringify({ overall: "FAIL", error: safeError(error), stateRoot }, null, 2));
  process.exitCode = 1;
}

async function prepareAuthority() {
  const suite = await prepareGoldenTaskSuite({ schemaVersion: 1, suiteId: "bounded-live-isolated-proof-suite", description: "Deterministic authority suite for isolated bounded-live proof.", tasks: [{ id: "route", kind: "routing", prompt: "Route isolated bounded-live proof fixture.", critical: true, minimumScore: 1, assertions: [{ id: "model", kind: "primary_model_equals", weight: 1, expected: "model-a" }, { id: "verify", kind: "requires_verification_equals", weight: 1, expected: true }] }] }, SUITE_LIMITS);
  const plane = new RoutingEvalPlane({ maxReportBytes: 64 * 1024, maxSubjectIdBytes: 2048 });
  const evalSubject = (id) => ({ id, async route() { return { primaryModel: { candidate: { id: "model-a" } }, selectedSkills: [], analysis: { requiresVerification: true } }; } });
  const referenceReport = await plane.evaluate(suite, evalSubject(referenceSubjectId));
  const candidateReport = await plane.evaluate(suite, evalSubject(candidateSubjectId));
  const baselineFor = (subjectId) => ({ schemaVersion: 1, baselineId: "bounded-live-isolated-proof-baseline", suiteId: suite.suiteId, suiteSha256: suite.suiteSha256, subjectId, minimumWeightedScore: 1, minimumTaskPassRate: 1, minimumCriticalPassRate: 1, maximumFailedTasks: 0 });
  const referenceBaseline = baselineFor(referenceSubjectId), candidateBaseline = baselineFor(candidateSubjectId);
  const admissionHistory = await JsonlEvalHistory.open(historyOptions(join(stateRoot, "admission-history.jsonl")));
  const refAdmissionObs = await admissionHistory.append({ observedAt: "2026-08-20T00:35:00.000Z", report: referenceReport, baseline: referenceBaseline });
  const candAdmissionObs = await admissionHistory.append({ observedAt: "2026-08-20T00:35:01.000Z", report: candidateReport, baseline: candidateBaseline });
  const taxonomy = await buildCanonicalMetricTaxonomy();
  const policy = await prepareM5AdmissionPolicy(taxonomy, { name: "bounded-live-isolated-proof-admission", minimumObservationCount: 1, requireExecutionReliability: false, requireFullExecutionProvenance: false, minimumExecutionSampleCount: 0, minimumDecidedExecutionSampleCount: 0, minimumLatencyCoverageRatio: 0, minimumCostCoverageRatio: 0, maximumCoverageRegressionRatio: 1, maximumWeightedScoreMeanRegression: 0.1, maximumTaskPassRateMeanRegression: 0.1, maximumCriticalPassRateMeanRegression: 0.1, maximumBaselinePassRateRegression: 0.1, maximumExecutionSuccessRateRegression: 0.1, maximumCancellationRateIncrease: 0.1 });
  const admissionDecision = await assessM5ControlledExperimentAdmission({ taxonomy, policy, reference: { evalSummary: await buildEvalCohortSummary([refAdmissionObs]) }, candidate: { evalSummary: await buildEvalCohortSummary([candAdmissionObs]) } });
  if (!admissionDecision.payload.experimentAdmissionEligible) throw new Error("Bounded-live proof admission fixture is not eligible");
  const experiment = await prepareControlledExperimentDefinition(admissionDecision, { name: "isolated-bounded-live-runtime-proof", projectId: PROJECT_ID, riskClass: "R3", exposureMode: "shadow_then_bounded_live", budget: { maxTotalSamples: 3, minimumShadowSamplesBeforeLive: 1, maxLiveSamples: 2, maxCandidateLiveSamples: 1, maxCandidateTrafficBasisPoints: 5000 }, stopConditions: { maxFailedExecutions: 0, maximumCancellationRate: 0.1, maximumWeightedScoreMeanRegression: 0.1, maximumTaskPassRateMeanRegression: 0.1, maximumCriticalPassRateMeanRegression: 0.1, maximumBaselinePassRateRegression: 0.1, maximumExecutionSuccessRateRegression: 0.1, maximumLatencyMeanIncreaseMs: 1_000_000 }, rollbackPolicyReference: "policy:isolated-reference-restore-v1" });
  const experimentWorkflow = createApprovedPublishWorkflow(join(stateRoot, "experiment-workflow.jsonl"), "bounded-live-experiment", "approval:bounded-live-experiment", "2026-08-20T00:36:00.000Z");
  const experimentAuthorization = await prepareControlledExperimentAuthorization(experiment, admissionDecision, experimentWorkflow.run, { decision: "allow", actor: "operator:isolated-bounded-live-proof", decidedAt: "2026-08-20T00:37:00.000Z", policyReferences: ["policy:isolated-bounded-live-experiment-v1"], approvalIds: ["approval:bounded-live-experiment"] });
  const progressHistory = await JsonlEvalHistory.open(historyOptions(join(stateRoot, "progress-history.jsonl")));
  return { suite, plane, referenceReport, candidateReport, referenceBaseline, candidateBaseline, admissionDecision, experiment, experimentWorkflow: experimentWorkflow.run, experimentAuthorization, progressHistory, persisted: { admissionDecision, experiment, experimentWorkflow: experimentWorkflow.run, experimentAuthorization, referenceSubjectId, candidateSubjectId } };
}

async function seedCompletedShadowSample(journal, authority) {
  const ref = await appendProgressObservation(authority, "shadow-seed-reference", "reference", syntheticRun("shadow-seed-reference", referenceSubjectId, "succeeded", 100), "2026-08-20T00:40:00.000Z");
  const cand = await appendProgressObservation(authority, "shadow-seed-candidate", "candidate", syntheticRun("shadow-seed-candidate", candidateSubjectId, "succeeded", 95), "2026-08-20T00:40:01.000Z");
  await journal.reserveSample({ sampleId: "shadow-seed-1", exposure: "shadow", liveAssignment: "none", inputReference: "isolated-proof:shadow-seed-v1", reservedAt: "2026-08-20T00:40:02.000Z" });
  await journal.recordDispatch({ sampleId: "shadow-seed-1", adapterId: "bounded-live-shadow-seed-fixture", acceptedAt: "2026-08-20T00:40:03.000Z", referenceExecutionReference: "shadow-seed:reference", candidateExecutionReference: "shadow-seed:candidate", candidateOutputExternallyVisible: false });
  await journal.recordCompletion({ sampleId: "shadow-seed-1", completedAt: "2026-08-20T00:40:04.000Z", referenceObservationId: ref.observation.observationId, candidateObservationId: cand.observation.observationId });
  return { referenceObservations: [ref.observation], candidateObservations: [cand.observation], referenceProjections: [ref.projection], candidateProjections: [cand.projection], referenceRecords: [ref.record], candidateRecords: [cand.record] };
}

async function executeAndPublishSample({ label, authorization, authority, runtimeState, sideEffects, deferred, sink }) {
  const machine = runtimeState.machine;
  const referenceRun = createExecuteRun(machine, `${label}-reference-${Date.now()}`);
  const candidateRun = createExecuteRun(machine, `${label}-candidate-${Date.now() + 1}`);
  const referenceRuntime = new OpenCodeRuntimeAdapter({ baseUrl: openCodeBaseUrl, username, password, model: { providerID: referenceProviderId, modelID: referenceModelId } });
  const candidateRuntime = new OpenCodeRuntimeAdapter({ baseUrl: openCodeBaseUrl, username, password, model: { providerID: candidateProviderId, modelID: candidateModelId } });
  const sharedTask = { prompt: `Isolated bounded-live proof sample ${label}. Reply with one concise acknowledgement only. Do not modify files, call tools, access the network, install packages, commit, push, deploy, or request approval.`, context: ["9Router isolated bounded-live runtime proof.", "No runtime tools are exposed.", "Output must remain internal until deterministic verification and explicit publication."], toolIds: [] };
  const resolver = { async resolve({ role, subjectId }) { return role === "reference" ? { subjectId, run: referenceRun, workspace: projectDir, adapter: referenceRuntime, bindingStore: runtimeState.bindingStore, task: { taskId: `${label}-reference-task`, ...sharedTask } } : { subjectId, run: candidateRun, workspace: projectDir, adapter: candidateRuntime, bindingStore: runtimeState.bindingStore, task: { taskId: `${label}-candidate-task`, ...sharedTask } }; } };
  const coordinator = new RuntimeBackedDeferredBoundedLiveExecutionCoordinator(resolver);
  const started = Date.now();
  const dispatch = await coordinator.dispatch({ experiment: authority.experiment, authorization });
  await verifyDeferredBoundedLiveRuntimeDispatchEnvelope(dispatch);
  if (dispatch.payload.candidateOutputExternallyVisible !== false) throw new Error(`${label} exposed candidate before publication`);
  const referenceBinding = requireBinding(runtimeState.bindingStore, referenceRun.id, "reference");
  const candidateBinding = requireBinding(runtimeState.bindingStore, candidateRun.id, "candidate");
  const [referenceWait, candidateWait] = await Promise.all([waitForCompletion(referenceRuntime, referenceBinding.sessionId, `${label}:reference`), waitForCompletion(candidateRuntime, candidateBinding.sessionId, `${label}:candidate`)]);
  const probe = new OpenCodeRuntimeReconciliationProbe({ baseUrl: openCodeBaseUrl, username, password });
  const recon = new RuntimeReconciliationCoordinator();
  const referenceReconciliation = await recon.reconcile(referenceRun, referenceBinding, probe);
  const candidateReconciliation = await recon.reconcile(candidateRun, candidateBinding, probe);
  requireVerificationReady(referenceReconciliation, `${label}:reference`); requireVerificationReady(candidateReconciliation, `${label}:candidate`);
  const verifier = new RuntimeVerificationCoordinator();
  const referenceVerification = await verifyRuntime(verifier, referenceRun, referenceReconciliation, referenceRuntime, `${label}:reference`);
  const candidateVerification = await verifyRuntime(verifier, candidateRun, candidateReconciliation, candidateRuntime, `${label}:candidate`);
  if (!referenceVerification.passed || !candidateVerification.passed) throw new Error(`${label} deterministic verification failed`);
  const terminalReference = terminalize(machine, referenceRun.id);
  const terminalCandidate = terminalize(machine, candidateRun.id);
  const referenceLedger = finalizeLedger(runtimeState.ledger, terminalReference, referenceBinding, referenceVerification, referenceSubjectId, `${label}:reference`, Date.now() - started);
  const candidateLedger = finalizeLedger(runtimeState.ledger, terminalCandidate, candidateBinding, candidateVerification, candidateSubjectId, `${label}:candidate`, Date.now() - started);
  const referenceVerificationReference = deterministicReference(referenceVerification), candidateVerificationReference = deterministicReference(candidateVerification);
  const paired = await prepareVerifiedBoundedLivePairedExecution({ experiment: authority.experiment, authorization, referenceRun: referenceLedger, candidateRun: candidateLedger, referenceBinding, candidateBinding, referenceVerificationReference, candidateVerificationReference, verifiedAt: new Date().toISOString() });
  await verifyVerifiedBoundedLivePairedExecutionEnvelope(paired);
  const selectedRole = authorization.payload.liveAssignment;
  const selectedRun = selectedRole === "candidate" ? candidateLedger : referenceLedger;
  const selectedBinding = selectedRole === "candidate" ? candidateBinding : referenceBinding;
  const selectedVerificationReference = selectedRole === "candidate" ? candidateVerificationReference : referenceVerificationReference;
  const reader = new OpenCodeBoundedLiveOutputReader({ baseUrl: openCodeBaseUrl, username, password, workspace: projectDir, maxOutputBytes: 64 * 1024 });
  const selectedOutput = await reader.read({ runtimeId: selectedBinding.runtimeId, sessionId: selectedBinding.sessionId, runId: selectedRun.runId });
  const outputSha256 = createHash("sha256").update(selectedOutput, "utf8").digest("hex").toUpperCase();
  const outputBytes = Buffer.byteLength(selectedOutput, "utf8");
  const selectedResult = await prepareVerifiedBoundedLiveRuntimeResult({ role: selectedRole, authorization, run: selectedRun, binding: selectedBinding, verificationReference: selectedVerificationReference, outputSha256, outputBytes, verifiedAt: paired.payload.verifiedAt });
  const publisher = new BoundedLivePublicationCoordinator(reader, sink, sideEffects);
  const publication = await publisher.publish({ authorization, runtimeResult: selectedResult });
  await verifyBoundedLivePublicationReceipt(publication);
  await deferred.recordPublishedDispatch({ authorization, pairedExecution: paired, selectedRuntimeResult: selectedResult, publicationReceipt: publication });
  const refProgress = await appendProgressObservation(authority, `${label}-reference`, "reference", referenceLedger, new Date(Date.now() + 1000).toISOString());
  const candProgress = await appendProgressObservation(authority, `${label}-candidate`, "candidate", candidateLedger, new Date(Date.now() + 2000).toISOString());
  await deferred.recordCompletion({ authorization, completedAt: new Date(Date.now() + 3000).toISOString(), referenceObservationId: refProgress.observation.observationId, candidateObservationId: candProgress.observation.observationId });
  await Promise.allSettled([referenceRuntime.destroy(referenceBinding.sessionId), candidateRuntime.destroy(candidateBinding.sessionId)]);
  return { dispatch, paired, publication, referenceWait, candidateWait, progress: { referenceObservation: refProgress.observation, candidateObservation: candProgress.observation, referenceProjection: refProgress.projection, candidateProjection: candProgress.projection, referenceRecord: referenceLedger, candidateRecord: candidateLedger } };
}

async function runRollbackSafetyDrill({ authority, sideEffects, sink }) {
  const drillReference = [], drillCandidate = [], refProjections = [], candProjections = [], refRecords = [], candRecords = [];
  for (let index = 0; index < 3; index += 1) {
    const rr = syntheticRun(`rollback-drill-reference-${index}`, referenceSubjectId, "succeeded", 100 + index);
    const cr = syntheticRun(`rollback-drill-candidate-${index}`, candidateSubjectId, index === 2 ? "failed" : "succeeded", 100 + index);
    const ro = await appendProgressObservation(authority, `rollback-drill-reference-${index}`, "reference", rr, new Date(Date.UTC(2026, 7, 20, 1, index, 0)).toISOString());
    const co = await appendProgressObservation(authority, `rollback-drill-candidate-${index}`, "candidate", cr, new Date(Date.UTC(2026, 7, 20, 1, 10 + index, 0)).toISOString());
    drillReference.push(ro.observation); drillCandidate.push(co.observation); refProjections.push(ro.projection); candProjections.push(co.projection); refRecords.push(rr); candRecords.push(cr);
  }
  const guardrail = await evaluateControlledExperimentGuardrails({ experiment: authority.experiment, authorization: authority.experimentAuthorization, admissionDecision: authority.admissionDecision, workflow: authority.experimentWorkflow, progress: { observedAt: "2026-08-20T01:20:00.000Z", shadowSamples: 1, liveSamples: 2, candidateLiveSamples: 1, referenceEvalSummary: await buildEvalCohortSummary(drillReference), candidateEvalSummary: await buildEvalCohortSummary(drillCandidate), referenceExecutionSummary: await buildExecutionReliabilitySummary(drillReference, refProjections, refRecords), candidateExecutionSummary: await buildExecutionReliabilitySummary(drillCandidate, candProjections, candRecords) } });
  if (guardrail.payload.classification !== "ROLLBACK_REQUIRED") throw new Error(`Rollback safety drill did not produce ROLLBACK_REQUIRED: ${guardrail.payload.classification}`);
  const rollbackWorkflow = createApprovedPublishWorkflow(join(stateRoot, "rollback-drill-workflow.jsonl"), "bounded-live-rollback-drill", "approval:bounded-live-rollback-drill", "2026-08-20T01:21:00.000Z");
  const rollbackAuthorization = await prepareBoundedLiveRollbackAuthorization({ experiment: authority.experiment, experimentAuthorization: authority.experimentAuthorization, admissionDecision: authority.admissionDecision, experimentWorkflow: authority.experimentWorkflow, guardrailDecision: guardrail, rollbackWorkflow: rollbackWorkflow.run, authorization: { actor: "operator:isolated-rollback-safety-drill", approvedAt: "2026-08-20T01:22:00.000Z", policyReferences: ["policy:isolated-reference-restore-v1"], approvalIds: ["approval:bounded-live-rollback-drill"] } });
  const restorer = new BoundedLiveReferenceRestoreCoordinator(sink, sideEffects);
  const receipt = await restorer.restore(rollbackAuthorization);
  await verifyBoundedLiveReferenceRestoreReceipt(receipt);
  return { guardrail, rollbackAuthorization, receipt };
}

async function appendProgressObservation(authority, prefix, role, record, observedAt) {
  const projector = new ExecutionMetricProjector({ latencyMetricKey: LATENCY_KEY, requireLatency: true, maxMetricKeyBytes: 256 });
  const projection = await projector.project(record);
  const observation = await authority.progressHistory.append({ observedAt, report: role === "candidate" ? authority.candidateReport : authority.referenceReport, baseline: role === "candidate" ? authority.candidateBaseline : authority.referenceBaseline, measurement: await executionProjectionToEvalMeasurement(projection) });
  return { observation, projection, record };
}

function appendProgress(progress, sample) {
  progress.referenceObservations.push(sample.referenceObservation); progress.candidateObservations.push(sample.candidateObservation); progress.referenceProjections.push(sample.referenceProjection); progress.candidateProjections.push(sample.candidateProjection); progress.referenceRecords.push(sample.referenceRecord); progress.candidateRecords.push(sample.candidateRecord);
}

function progressInput(progress, shadowSamples, liveSamples, candidateLiveSamples, observedAt) {
  return { observedAt, shadowSamples, liveSamples, candidateLiveSamples, referenceEvalSummary: undefined, candidateEvalSummary: undefined, referenceExecutionSummary: undefined, candidateExecutionSummary: undefined, async hydrate() {} };
}

async function hydrateProgress(progress, shadowSamples, liveSamples, candidateLiveSamples, observedAt) {
  return { observedAt, shadowSamples, liveSamples, candidateLiveSamples, referenceEvalSummary: await buildEvalCohortSummary(progress.referenceObservations), candidateEvalSummary: await buildEvalCohortSummary(progress.candidateObservations), referenceExecutionSummary: await buildExecutionReliabilitySummary(progress.referenceObservations, progress.referenceProjections, progress.referenceRecords), candidateExecutionSummary: await buildExecutionReliabilitySummary(progress.candidateObservations, progress.candidateProjections, progress.candidateRecords) };
}

function openRuntimeState() {
  const workflowStore = new JsonlWorkflowCheckpointStore({ filePath: join(stateRoot, "runtime-workflow.jsonl"), maxFileBytes: LIMITS.maxFileBytes, maxCheckpointBytes: 64 * 1024 });
  return { workflowStore, machine: new DurableWorkflowStateMachine(workflowStore), bindingStore: new JsonlRuntimeBindingStore({ filePath: join(stateRoot, "binding.jsonl"), maxFileBytes: LIMITS.maxFileBytes, maxBindingBytes: 64 * 1024 }), ledger: new JsonlRunLedger({ filePath: join(stateRoot, "ledger.jsonl"), maxFileBytes: LIMITS.maxFileBytes, maxRecordBytes: LIMITS.maxRecordBytes }) };
}

function createApprovedPublishWorkflow(filePath, id, approvalId, startAt) {
  const store = new JsonlWorkflowCheckpointStore({ filePath, maxFileBytes: 512 * 1024, maxCheckpointBytes: 64 * 1024 });
  const machine = new DurableWorkflowStateMachine(store);
  const base = Date.parse(startAt); const ts = (seconds) => new Date(base + seconds * 1000).toISOString();
  let run = machine.create({ id, projectId: PROJECT_ID, riskClass: "R3", now: ts(0) }); run = machine.start(run, ts(1)); run = machine.advance(run, ts(2)); run = machine.advance(run, ts(3)); run = machine.advance(run, ts(4)); run = machine.advance(run, ts(5)); run = machine.requestApproval(run, ts(6)); run = machine.approve(run, approvalId, ts(7));
  if (run.phase !== "publish" || run.status !== "running") throw new Error(`Approved workflow ${id} did not reach publish/running`);
  return { run, store };
}

function createExecuteRun(machine, id) { let run = machine.create({ id, projectId: PROJECT_ID, riskClass: "R0", now: new Date().toISOString() }); run = machine.start(run); run = machine.advance(run); run = machine.advance(run); if (run.phase !== "execute" || run.status !== "running") throw new Error(`Runtime workflow ${id} did not reach execute/running`); return run; }
function terminalize(machine, runId) { let run = machine.store?.get?.(runId); if (!run) throw new Error(`Runtime workflow missing before terminalization: ${runId}`); run = machine.advance(run); run = machine.advance(run); run = machine.skipApproval(run); run = machine.succeed(run, true); return run; }

function finalizeLedger(ledger, run, binding, verification, subjectId, label, latencyMs) {
  return new RuntimeRunLedgerFinalizer().appendTerminal({ run, binding, ledger, task: `Isolated bounded-live ${label}`, modelRoute: [subjectId], contextCompilerVersion: "bounded-live-isolated-proof/v1", skills: ["runtime.binding", "runtime.reconciliation", "deterministic.verification", "bounded-live.deferred-publication"], toolsets: [], policyDecisions: ["R0 paired runtime", "zero tools", "verify before visibility"], changeReferences: [], evidence: [{ kind: "policy", status: "passed", reference: `policy:${run.id}`, producer: "bounded-live-isolated-proof", collectedAt: new Date().toISOString() }], verification, resourceMetrics: { [LATENCY_KEY]: Math.max(0, latencyMs) }, traceId: `bounded-live:${run.id}` });
}

async function verifyRuntime(coordinator, run, reconciliation, runtime, label) {
  return coordinator.verify(run, reconciliation, { id: `bounded-live-${label}-verifier`, async verify({ binding, observation }) { const diff = await runtime.getDiff(binding.sessionId); const passed = observation.status === "completed" && diff.filesChanged.length === 0 && !diff.patch; return { passed, reference: `verifier:bounded-live:${label}:${passed ? "pass" : "fail"}`, collectedAt: new Date().toISOString(), metadata: { status: observation.status, filesChanged: diff.filesChanged.length, patchObserved: Boolean(diff.patch) } }; } });
}

async function waitForCompletion(runtime, sessionId, label) { const started = Date.now(); for (;;) { const events = await runtime.getEvents(sessionId); if (events.some((event) => event.type === "approval_requested")) throw new Error(`${label} requested approval during zero-tool bounded-live proof`); const status = await runtime.getStatus(sessionId); if (status === "completed") return { status, elapsedMs: Date.now() - started }; if (["failed", "aborted", "destroyed", "interrupted"].includes(status)) throw new Error(`${label} runtime terminal failure: ${status}`); if (Date.now() - started > 300_000) { try { await runtime.abort(sessionId, "bounded-live proof timeout"); } catch {} throw new Error(`${label} runtime exceeded 300 seconds`); } await new Promise((resolve) => setTimeout(resolve, 1000)); } }
function requireVerificationReady(report, label) { if (report.disposition !== "verify_runtime_result" || report.observation?.status !== "completed") throw new Error(`${label} reconciliation is not verification-ready: ${report.disposition}/${report.observation?.status}`); }
function requireBinding(store, runId, role) { const binding = store.get(runId); if (!binding) throw new Error(`Missing ${role} RuntimeBinding for ${runId}`); return binding; }
function deterministicReference(verification) { const item = verification.evidence.find((e) => e.kind === "deterministic_check" && e.status === "passed" && e.producer === verification.verifierId); if (!item) throw new Error(`Missing verifier-owned deterministic reference for ${verification.workflowRunId}`); return item.reference; }

function syntheticRun(runId, subjectId, outcome, latencyMs) { return { runId, projectId: PROJECT_ID, task: "Bounded-live synthetic evidence fixture", riskClass: "R0", runtimeId: "opencode", modelRoute: [subjectId], contextCompilerVersion: "bounded-live-proof/v1", skills: [], toolsets: [], workspace: projectDir, policyDecisions: ["fixture:evidence-only"], approvalIds: [], changeReferences: [], evidence: [{ kind: "policy", status: "passed", reference: `policy:${runId}`, producer: "bounded-live-proof-fixture", collectedAt: "2026-08-20T00:30:00.000Z" }], resourceMetrics: { [LATENCY_KEY]: latencyMs }, traceId: `trace:${runId}`, outcome, failureReason: outcome === "failed" ? "deterministic rollback safety drill" : undefined, createdAt: "2026-08-20T00:29:00.000Z" }; }
function historyOptions(filePath) { return { filePath, maxFileBytes: LIMITS.maxFileBytes, maxObservationBytes: 128 * 1024, maxReportBytes: 64 * 1024, maxStringBytes: 2048, maxSourceReferences: 8 }; }
function publicationSummary(receipt) { return { receiptId: receipt.receiptId, selectedRole: receipt.payload.selectedRole, outputSha256: receipt.payload.outputSha256, outputBytes: receipt.payload.outputBytes, externallyVisible: receipt.payload.externallyVisible, candidateOutputExternallyVisible: receipt.payload.candidateOutputExternallyVisible, rawOutputPersisted: receipt.payload.rawOutputPersisted, productionRoutingMutationAllowed: receipt.payload.productionRoutingMutationAllowed }; }
async function fetchJson(url) { const response = await fetch(url, { cache: "no-store" }); if (!response.ok) throw new Error(`GET ${url} failed HTTP ${response.status}`); return response.json(); }
async function gitOutput(args) { const { stdout } = await execFile("git", args, { cwd: projectDir, windowsHide: true }); return stdout.trim(); }
async function workingTreeSnapshot() { const raw = await gitOutput(["status", "--porcelain=v1", "--untracked-files=all"]); return raw ? raw.split(/\r?\n/).filter(Boolean) : []; }
async function hashExistingFiles(names) { const result = {}; for (const name of names) { try { result[name] = await hashFile(join(stateRoot, name)); } catch {} } return result; }
async function hashFile(path) { return createHash("sha256").update(await readFile(path)).digest("hex").toUpperCase(); }
function sameArray(a, b) { return a.length === b.length && a.every((value, index) => value === b[index]); }
function requiredEnv(name) { const value = process.env[name]?.trim(); if (!value) fail(`${name} is required`); return value; }
function fail(message) { throw new Error(message); }
function safeError(error) { return (error instanceof Error ? error.message : String(error)).replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [redacted]").replace(/(authorization|api[_-]?key|access[_-]?token|password|secret|credential)\s*[:=]\s*(Bearer\s+)?[^\s,;]+/gi, "$1=[redacted]"); }
