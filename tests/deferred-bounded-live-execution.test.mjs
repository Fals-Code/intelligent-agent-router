import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  BoundedLivePublicationCoordinator,
  DeferredBoundedLiveExecutor,
  JsonlBoundedLiveSideEffectJournal,
  JsonlControlledExperimentExecutionJournal,
  JsonlWorkflowCheckpointStore,
  DurableWorkflowStateMachine,
  prepareBoundedLiveSampleAuthorization,
  prepareControlledExperimentAuthorization,
  prepareControlledExperimentDefinition,
  prepareVerifiedBoundedLivePairedExecution,
  prepareVerifiedBoundedLiveRuntimeResult,
  verifyVerifiedBoundedLivePairedExecutionEnvelope,
} from "../dist/index.js";
import { authorizationInput, controlledExperimentFixture, durableApprovedExperimentWorkflow, experimentDefinitionInput } from "./controlled-experiment-fixture.mjs";

let sequence = 0;
function stable(value) { if (Array.isArray(value)) return value.map(stable); if (!value || typeof value !== "object") return value; return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, stable(child)])); }
function sha(value) { return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex").toUpperCase(); }
function distinctAdmission(source) { const payload = { ...source.payload, referenceSubjectId: "opencode:9router/hemat", candidateSubjectId: "opencode:9router/smart" }; const decisionSha256 = sha(payload); return { schemaVersion: source.schemaVersion, algorithm: "sha256", decisionId: `m5admit:${decisionSha256.slice(0, 32).toLowerCase()}`, decisionSha256, payload }; }
function eligibleGuardrail(ctx) {
  const payload = { experimentId: ctx.experiment.experimentId, experimentSha256: ctx.experiment.experimentSha256, authorizationId: ctx.experimentAuthorization.authorizationId, authorizationSha256: ctx.experimentAuthorization.authorizationSha256, admissionDecisionId: ctx.admissionDecision.decisionId, admissionDecisionSha256: ctx.admissionDecision.decisionSha256, workflowRunId: ctx.experimentWorkflow.id, observedAt: "2026-08-19T07:00:00.000Z", referenceEvalSummaryId: "evalsummary:deferred-reference", candidateEvalSummaryId: "evalsummary:deferred-candidate", referenceExecutionSummaryId: "execrel:deferred-reference", candidateExecutionSummaryId: "execrel:deferred-candidate", completedSamples: 3, shadowSamples: 3, liveSamples: 0, candidateLiveSamples: 0, candidateTrafficBasisPoints: 0, evalDeltas: { weightedScoreMean: 0, taskPassRateMean: 0, criticalPassRateMean: 0, baselinePassRate: 0, latencyMeanMs: 0, costMeanUsd: 0 }, executionDeltas: { successRateExcludingCancelled: 0, failureRateExcludingCancelled: 0, cancellationRate: 0 }, classification: "ELIGIBLE_FOR_BOUNDED_LIVE", reasons: ["shadow_evidence_clear_for_bounded_live"], guardrailActionRequired: false, boundedLiveAdmissionEligible: true, automaticDispatchAllowed: false, productionRoutingMutationAllowed: false, automaticRollbackAllowed: false };
  const decisionSha256 = sha(payload); return { schemaVersion: 1, algorithm: "sha256", decisionId: `m5expguard:${decisionSha256.slice(0, 32).toLowerCase()}`, decisionSha256, payload };
}
async function approvedWorkflow(root, projectId, riskClass, approvalId) {
  sequence += 1; const store = new JsonlWorkflowCheckpointStore({ filePath: join(root, `deferred-live-${sequence}.jsonl`), maxFileBytes: 512 * 1024, maxCheckpointBytes: 32 * 1024 }); const machine = new DurableWorkflowStateMachine(store);
  let run = machine.create({ id: `deferred-live-workflow-${sequence}`, projectId, riskClass, now: "2026-08-19T07:00:01.000Z" }); run = machine.start(run, "2026-08-19T07:00:02.000Z"); run = machine.advance(run, "2026-08-19T07:00:03.000Z"); run = machine.advance(run, "2026-08-19T07:00:04.000Z"); run = machine.advance(run, "2026-08-19T07:00:05.000Z"); run = machine.advance(run, "2026-08-19T07:00:06.000Z"); run = machine.requestApproval(run, "2026-08-19T07:00:07.000Z"); return machine.approve(run, approvalId, "2026-08-19T07:00:08.000Z");
}
async function context(t) {
  const fixture = await controlledExperimentFixture(t); const admissionDecision = distinctAdmission(fixture.admissionDecision);
  const experiment = await prepareControlledExperimentDefinition(admissionDecision, experimentDefinitionInput({ budget: { maxTotalSamples: 6, minimumShadowSamplesBeforeLive: 3, maxLiveSamples: 3, maxCandidateLiveSamples: 3, maxCandidateTrafficBasisPoints: 10000 } }));
  const { run: experimentWorkflow } = await durableApprovedExperimentWorkflow(fixture.root, { riskClass: experiment.payload.riskClass });
  const experimentAuthorization = await prepareControlledExperimentAuthorization(experiment, admissionDecision, experimentWorkflow, authorizationInput());
  const guardrailDecision = eligibleGuardrail({ experiment, experimentAuthorization, admissionDecision, experimentWorkflow });
  const liveWorkflow = await approvedWorkflow(fixture.root, experiment.payload.projectId, experiment.payload.riskClass, "approval:deferred-candidate-live");
  const sampleAuthorization = await prepareBoundedLiveSampleAuthorization({ experiment, experimentAuthorization, admissionDecision, experimentWorkflow, guardrailDecision, liveWorkflow, authorization: { sampleId: "deferred-candidate-live-1", inputReference: "live-input:deferred-1", liveAssignment: "candidate", actor: "operator:deferred-live-test", approvedAt: "2026-08-19T07:00:09.000Z", policyReferences: ["policy:deferred-live-v1"], approvalIds: liveWorkflow.approvalIds } });
  const journalOptions = { filePath: join(fixture.root, "deferred-execution.jsonl"), experimentId: experiment.experimentId, maxFileBytes: 2 * 1024 * 1024, maxEventBytes: 64 * 1024, maxStringBytes: 2048 };
  const journal = await JsonlControlledExperimentExecutionJournal.open(journalOptions);
  for (let index = 0; index < 3; index += 1) { const sampleId = `shadow-prelive-${index + 1}`; await journal.reserveSample({ sampleId, exposure: "shadow", liveAssignment: "none", inputReference: `fixture:${sampleId}`, reservedAt: `2026-08-19T06:5${index}:00.000Z` }); await journal.recordDispatch({ sampleId, adapterId: "shadow-fixture", acceptedAt: `2026-08-19T06:5${index}:01.000Z`, referenceExecutionReference: `shadow:reference:${index}`, candidateExecutionReference: `shadow:candidate:${index}`, candidateOutputExternallyVisible: false }); await journal.recordCompletion({ sampleId, completedAt: `2026-08-19T06:5${index}:02.000Z`, referenceObservationId: `evalobs:shadow-reference-${index}`, candidateObservationId: `evalobs:shadow-candidate-${index}` }); }
  const sideEffects = await JsonlBoundedLiveSideEffectJournal.open({ filePath: join(fixture.root, "deferred-side-effects.jsonl"), maxFileBytes: 512 * 1024, maxEventBytes: 32 * 1024, maxStringBytes: 2048 });
  return { ...fixture, admissionDecision, experiment, experimentWorkflow, experimentAuthorization, guardrailDecision, liveWorkflow, sampleAuthorization, journal, journalOptions, sideEffects };
}
function runRecord(runId, subjectId, verificationReference) { return { runId, projectId: "project-controlled-experiment", task: "Deferred bounded-live paired execution", riskClass: "R0", runtimeId: "opencode", modelRoute: [subjectId], contextCompilerVersion: "deferred-live/v1", skills: ["runtime.binding", "runtime.reconciliation", "deterministic.verification"], toolsets: [], workspace: "C:/isolated/deferred-live", policyDecisions: ["R0 zero-tool paired bounded-live execution"], approvalIds: [], changeReferences: [], evidence: [{ kind: "deterministic_check", status: "passed", reference: verificationReference, producer: "deferred-live-verifier", collectedAt: "2026-08-19T07:01:00.000Z" }], resourceMetrics: { "runtime.total_ms": 100 }, traceId: `trace:${runId}`, outcome: "succeeded", createdAt: "2026-08-19T07:00:10.000Z" }; }
function binding(runId, sessionId) { return { workflowRunId: runId, projectId: "project-controlled-experiment", workflowAttempt: 1, runtimeId: "opencode", sessionId, workspace: "C:/isolated/deferred-live", boundAt: "2026-08-19T07:00:11.000Z" }; }

test("deferred bounded-live keeps candidate invisible until paired verification and durably committed publication", async (t) => {
  const ctx = await context(t); const deferred = new DeferredBoundedLiveExecutor(ctx.journal);
  await deferred.reserve({ experiment: ctx.experiment, authorization: ctx.sampleAuthorization, requestedAt: "2026-08-19T07:00:12.000Z" });
  assert.equal(ctx.journal.latest(ctx.sampleAuthorization.payload.sampleId).payload.eventType, "sample_reserved");
  const referenceRun = runRecord("deferred-reference-run", ctx.experiment.payload.referenceSubjectId, "verify:deferred-reference"); const candidateRun = runRecord("deferred-candidate-run", ctx.experiment.payload.candidateSubjectId, "verify:deferred-candidate");
  const referenceBinding = binding(referenceRun.runId, "ses_deferred_reference"); const candidateBinding = binding(candidateRun.runId, "ses_deferred_candidate");
  const pair = await prepareVerifiedBoundedLivePairedExecution({ experiment: ctx.experiment, authorization: ctx.sampleAuthorization, referenceRun, candidateRun, referenceBinding, candidateBinding, referenceVerificationReference: "verify:deferred-reference", candidateVerificationReference: "verify:deferred-candidate", verifiedAt: "2026-08-19T07:01:01.000Z" });
  await assert.doesNotReject(() => verifyVerifiedBoundedLivePairedExecutionEnvelope(pair)); assert.equal(pair.payload.candidateOutputExternallyVisibleBeforePublication, false); assert.equal(ctx.journal.latest(ctx.sampleAuthorization.payload.sampleId).payload.eventType, "sample_reserved");
  const output = "candidate output after verification"; const outputSha256 = createHash("sha256").update(output).digest("hex").toUpperCase();
  const selectedRuntimeResult = await prepareVerifiedBoundedLiveRuntimeResult({ role: "candidate", authorization: ctx.sampleAuthorization, run: candidateRun, binding: candidateBinding, verificationReference: "verify:deferred-candidate", outputSha256, outputBytes: Buffer.byteLength(output), verifiedAt: "2026-08-19T07:01:01.000Z" });
  const publicationCoordinator = new BoundedLivePublicationCoordinator({ async read() { return output; } }, { id: "sink:deferred-live-test", async publish(input) { assert.equal(ctx.sideEffects.inspect().unresolvedOperationIds.length, 1); return { sinkId: "sink:deferred-live-test", idempotencyKey: input.idempotencyKey, publicationReference: "publication:deferred-candidate-1", publishedAt: "2026-08-19T07:01:02.000Z", selectedRole: input.selectedRole, outputSha256: input.outputSha256, externallyVisible: true }; } }, ctx.sideEffects);
  const publicationReceipt = await publicationCoordinator.publish({ authorization: ctx.sampleAuthorization, runtimeResult: selectedRuntimeResult });
  assert.deepEqual(ctx.sideEffects.inspect().unresolvedOperationIds, []);
  const dispatchEvent = await deferred.recordPublishedDispatch({ authorization: ctx.sampleAuthorization, pairedExecution: pair, selectedRuntimeResult, publicationReceipt });
  assert.equal(dispatchEvent.payload.candidateOutputExternallyVisible, true);
  await deferred.recordCompletion({ authorization: ctx.sampleAuthorization, completedAt: "2026-08-19T07:01:03.000Z", referenceObservationId: "evalobs:deferred-reference", candidateObservationId: "evalobs:deferred-candidate" });
  const reopened = await JsonlControlledExperimentExecutionJournal.open(ctx.journalOptions); assert.equal(reopened.inspect().completedLiveSamples, 1); assert.equal(reopened.inspect().completedCandidateLiveSamples, 1); assert.deepEqual(reopened.inspect().unresolvedSampleIds, []);
});

test("deferred bounded-live reservation fails when sample authorization counters drift from durable journal", async (t) => {
  const ctx = await context(t); const deferred = new DeferredBoundedLiveExecutor(ctx.journal); const badAuthorization = { ...ctx.sampleAuthorization, payload: { ...ctx.sampleAuthorization.payload, shadowSamplesBeforeLive: 2 } };
  await assert.rejects(() => deferred.reserve({ experiment: ctx.experiment, authorization: badAuthorization, requestedAt: "2026-08-19T07:00:12.000Z" }), /authorization digest is invalid|counters do not match durable completed journal state/);
});
