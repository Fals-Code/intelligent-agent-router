import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  BoundedLivePublicationCoordinator,
  BoundedLiveReferenceRestoreCoordinator,
  DurableWorkflowStateMachine,
  JsonlBoundedLiveSideEffectJournal,
  JsonlWorkflowCheckpointStore,
  prepareBoundedLiveRollbackAuthorization,
  prepareBoundedLiveSampleAuthorization,
  prepareControlledExperimentAuthorization,
  prepareControlledExperimentDefinition,
  prepareVerifiedBoundedLiveRuntimeResult,
  verifyBoundedLivePublicationReceipt,
  verifyBoundedLiveReferenceRestoreReceipt,
  verifyBoundedLiveRollbackAuthorization,
  verifyBoundedLiveSampleAuthorization,
} from "../dist/index.js";
import {
  authorizationInput,
  controlledExperimentFixture,
  durableApprovedExperimentWorkflow,
  experimentDefinitionInput,
} from "./controlled-experiment-fixture.mjs";

let workflowSequence = 0;
let sideEffectSequence = 0;

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, stable(child)]));
}
function sha256Canonical(value) { return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex").toUpperCase(); }
function distinctAdmissionDecision(source) {
  const payload = { ...source.payload, referenceSubjectId: "opencode:9router/hemat", candidateSubjectId: "opencode:9router/smart" };
  const decisionSha256 = sha256Canonical(payload);
  return { schemaVersion: source.schemaVersion, algorithm: "sha256", decisionId: `m5admit:${decisionSha256.slice(0, 32).toLowerCase()}`, decisionSha256, payload };
}
function guardrailDecision(ctx, { classification = "ELIGIBLE_FOR_BOUNDED_LIVE", shadowSamples = 3, liveSamples = 0, candidateLiveSamples = 0 } = {}) {
  const candidateTrafficBasisPoints = liveSamples === 0 ? 0 : (candidateLiveSamples / liveSamples) * 10000;
  const payload = {
    experimentId: ctx.experiment.experimentId,
    experimentSha256: ctx.experiment.experimentSha256,
    authorizationId: ctx.experimentAuthorization.authorizationId,
    authorizationSha256: ctx.experimentAuthorization.authorizationSha256,
    admissionDecisionId: ctx.admissionDecision.decisionId,
    admissionDecisionSha256: ctx.admissionDecision.decisionSha256,
    workflowRunId: ctx.experimentWorkflow.id,
    observedAt: classification === "ROLLBACK_REQUIRED" ? "2026-08-19T06:40:00.000Z" : "2026-08-19T06:32:00.000Z",
    referenceEvalSummaryId: "evalsummary:bounded-live-reference",
    candidateEvalSummaryId: "evalsummary:bounded-live-candidate",
    referenceExecutionSummaryId: "execrel:bounded-live-reference",
    candidateExecutionSummaryId: "execrel:bounded-live-candidate",
    completedSamples: shadowSamples + liveSamples,
    shadowSamples,
    liveSamples,
    candidateLiveSamples,
    candidateTrafficBasisPoints,
    evalDeltas: { weightedScoreMean: classification === "ROLLBACK_REQUIRED" ? -1 : 0, taskPassRateMean: classification === "ROLLBACK_REQUIRED" ? -1 : 0, criticalPassRateMean: classification === "ROLLBACK_REQUIRED" ? -1 : 0, baselinePassRate: classification === "ROLLBACK_REQUIRED" ? -1 : 0, latencyMeanMs: 0, costMeanUsd: 0 },
    executionDeltas: { successRateExcludingCancelled: classification === "ROLLBACK_REQUIRED" ? -1 : 0, failureRateExcludingCancelled: classification === "ROLLBACK_REQUIRED" ? 1 : 0, cancellationRate: 0 },
    classification,
    reasons: [classification === "ROLLBACK_REQUIRED" ? "bounded_live_regression_requires_reference_restore" : "shadow_evidence_clear_for_bounded_live"],
    guardrailActionRequired: classification === "ROLLBACK_REQUIRED",
    boundedLiveAdmissionEligible: classification === "ELIGIBLE_FOR_BOUNDED_LIVE",
    automaticDispatchAllowed: false,
    productionRoutingMutationAllowed: false,
    automaticRollbackAllowed: false,
  };
  const decisionSha256 = sha256Canonical(payload);
  return { schemaVersion: 1, algorithm: "sha256", decisionId: `m5expguard:${decisionSha256.slice(0, 32).toLowerCase()}`, decisionSha256, payload };
}
async function authorityContext(t, overrides = {}) {
  const fixture = await controlledExperimentFixture(t);
  const admissionDecision = distinctAdmissionDecision(fixture.admissionDecision);
  const experiment = await prepareControlledExperimentDefinition(admissionDecision, experimentDefinitionInput(overrides));
  const { run: experimentWorkflow } = await durableApprovedExperimentWorkflow(fixture.root, { riskClass: experiment.payload.riskClass });
  const experimentAuthorization = await prepareControlledExperimentAuthorization(experiment, admissionDecision, experimentWorkflow, authorizationInput());
  return { ...fixture, admissionDecision, experiment, experimentWorkflow, experimentAuthorization };
}
async function approvedWorkflow(root, projectId, riskClass, approvalId, prefix) {
  workflowSequence += 1;
  const store = new JsonlWorkflowCheckpointStore({ filePath: join(root, `${prefix}-${workflowSequence}.jsonl`), maxFileBytes: 512 * 1024, maxCheckpointBytes: 32 * 1024 });
  const machine = new DurableWorkflowStateMachine(store);
  let run = machine.create({ id: `${prefix}-${workflowSequence}`, projectId, riskClass, now: "2026-08-19T06:30:00.000Z" });
  run = machine.start(run, "2026-08-19T06:30:01.000Z"); run = machine.advance(run, "2026-08-19T06:30:02.000Z"); run = machine.advance(run, "2026-08-19T06:30:03.000Z"); run = machine.advance(run, "2026-08-19T06:30:04.000Z"); run = machine.advance(run, "2026-08-19T06:30:05.000Z"); run = machine.requestApproval(run, "2026-08-19T06:30:06.000Z"); run = machine.approve(run, approvalId, "2026-08-19T06:31:00.000Z");
  return run;
}
async function sideEffects(root, prefix) {
  sideEffectSequence += 1;
  return JsonlBoundedLiveSideEffectJournal.open({ filePath: join(root, `${prefix}-${sideEffectSequence}.jsonl`), maxFileBytes: 512 * 1024, maxEventBytes: 32 * 1024, maxStringBytes: 2048 });
}
function liveAuthorizationInput(workflow, assignment = "candidate") {
  return { sampleId: `live-sample-${assignment}`, inputReference: "live-input:bounded-gate-v1", liveAssignment: assignment, actor: "operator:bounded-live-test", approvedAt: "2026-08-19T06:33:00.000Z", policyReferences: ["policy:bounded-live-single-sample-v1"], approvalIds: workflow.approvalIds };
}

test("bounded-live sample authorization is single-sample, distinct-subject, shadow-first, and traffic-ceiling aware", async (t) => {
  const ctx = await authorityContext(t, { budget: { maxTotalSamples: 5, minimumShadowSamplesBeforeLive: 3, maxLiveSamples: 2, maxCandidateLiveSamples: 1, maxCandidateTrafficBasisPoints: 5000 } });
  const guardrail = guardrailDecision(ctx);
  const liveWorkflow = await approvedWorkflow(ctx.root, ctx.experiment.payload.projectId, ctx.experiment.payload.riskClass, "approval:bounded-live-sample-1", "live-workflow");
  await assert.rejects(() => prepareBoundedLiveSampleAuthorization({ experiment: ctx.experiment, experimentAuthorization: ctx.experimentAuthorization, admissionDecision: ctx.admissionDecision, experimentWorkflow: ctx.experimentWorkflow, guardrailDecision: guardrail, liveWorkflow, authorization: liveAuthorizationInput(liveWorkflow, "candidate") }), /traffic basis-point ceiling/);
  const authorizationInputValue = liveAuthorizationInput(liveWorkflow, "reference");
  const sources = { experiment: ctx.experiment, experimentAuthorization: ctx.experimentAuthorization, admissionDecision: ctx.admissionDecision, experimentWorkflow: ctx.experimentWorkflow, guardrailDecision: guardrail, liveWorkflow, authorization: authorizationInputValue };
  const authorization = await prepareBoundedLiveSampleAuthorization(sources);
  assert.match(authorization.authorizationId, /^m5liveauth:[a-f0-9]{32}$/);
  assert.equal(authorization.payload.selectedSubjectId, "opencode:9router/hemat");
  assert.equal(authorization.payload.candidateTrafficAfterDispatchBasisPoints, 0);
  assert.equal(authorization.payload.singleSampleAuthority, true);
  assert.equal(authorization.payload.automaticDispatchAllowed, false);
  await assert.doesNotReject(() => verifyBoundedLiveSampleAuthorization(authorization, sources));
  await assert.rejects(() => prepareBoundedLiveSampleAuthorization({ ...sources, authorization: { ...authorizationInputValue, approvedAt: "2026-08-19T06:20:00.000Z" } }), /cannot predate the guardrail evidence/);
});

test("bounded-live publication is durably reserved before sink and committed before receipt", async (t) => {
  const ctx = await authorityContext(t);
  const guardrail = guardrailDecision(ctx);
  const liveWorkflow = await approvedWorkflow(ctx.root, ctx.experiment.payload.projectId, ctx.experiment.payload.riskClass, "approval:bounded-live-candidate-1", "candidate-live-workflow");
  const authorization = await prepareBoundedLiveSampleAuthorization({ experiment: ctx.experiment, experimentAuthorization: ctx.experimentAuthorization, admissionDecision: ctx.admissionDecision, experimentWorkflow: ctx.experimentWorkflow, guardrailDecision: guardrail, liveWorkflow, authorization: liveAuthorizationInput(liveWorkflow, "candidate") });
  const output = "verified candidate output";
  const outputSha256 = createHash("sha256").update(output).digest("hex").toUpperCase();
  const verificationReference = "verify:bounded-live-candidate-run";
  const run = { runId: "bounded-live-candidate-run", projectId: ctx.experiment.payload.projectId, task: "Bounded live candidate execution", riskClass: "R0", runtimeId: "opencode", modelRoute: [ctx.experiment.payload.candidateSubjectId], contextCompilerVersion: "bounded-live/v1", skills: ["runtime.binding", "deterministic.verification"], toolsets: [], workspace: "C:/isolated/bounded-live", policyDecisions: ["R0 zero-tool verified live candidate"], approvalIds: [], changeReferences: [], evidence: [{ kind: "deterministic_check", status: "passed", reference: verificationReference, producer: "bounded-live-verifier", collectedAt: "2026-08-19T06:34:00.000Z" }], resourceMetrics: { "runtime.total_ms": 100 }, traceId: "trace:bounded-live-candidate-run", outcome: "succeeded", createdAt: "2026-08-19T06:33:30.000Z" };
  const binding = { workflowRunId: run.runId, projectId: run.projectId, workflowAttempt: 1, runtimeId: run.runtimeId, sessionId: "ses_bounded_live_candidate", workspace: run.workspace, boundAt: "2026-08-19T06:33:31.000Z" };
  const runtimeResult = await prepareVerifiedBoundedLiveRuntimeResult({ role: "candidate", authorization, run, binding, verificationReference, outputSha256, outputBytes: Buffer.byteLength(output), verifiedAt: "2026-08-19T06:34:01.000Z" });
  const journal = await sideEffects(ctx.root, "publication-effects");
  const published = [];
  const coordinator = new BoundedLivePublicationCoordinator(
    { async read() { return output; } },
    { id: "sink:bounded-live-test", async publish(input) { assert.equal(journal.inspect().unresolvedOperationIds.length, 1); published.push(input); return { sinkId: "sink:bounded-live-test", idempotencyKey: input.idempotencyKey, publicationReference: "publication:bounded-live-candidate-1", publishedAt: "2026-08-19T06:35:00.000Z", selectedRole: input.selectedRole, outputSha256: input.outputSha256, externallyVisible: true }; } },
    journal,
  );
  const receipt = await coordinator.publish({ authorization, runtimeResult });
  assert.equal(published.length, 1);
  assert.equal(receipt.payload.candidateOutputExternallyVisible, true);
  assert.match(receipt.payload.sideEffectCommitEventId, /^m5liveeffect:/);
  assert.deepEqual(journal.inspect().unresolvedOperationIds, []);
  assert.equal(journal.inspect().committedOperationIds.length, 1);
  await assert.doesNotReject(() => verifyBoundedLivePublicationReceipt(receipt));

  const driftJournal = await sideEffects(ctx.root, "publication-drift-effects");
  const badCoordinator = new BoundedLivePublicationCoordinator({ async read() { return `${output}-drift`; } }, { id: "sink:bounded-live-test", async publish() { throw new Error("must not publish"); } }, driftJournal);
  await assert.rejects(() => badCoordinator.publish({ authorization, runtimeResult }), /does not match verified runtime result hash\/size/);
  assert.equal(driftJournal.inspect().eventCount, 0);

  await assert.rejects(() => prepareVerifiedBoundedLiveRuntimeResult({ role: "candidate", authorization, run: { ...run, modelRoute: [ctx.experiment.payload.referenceSubjectId] }, binding, verificationReference, outputSha256, outputBytes: Buffer.byteLength(output), verifiedAt: "2026-08-19T06:34:01.000Z" }), /modelRoute does not contain the authorized selected subject/);
});

test("publication sink failure persists unknown side effect and blocks automatic retry", async (t) => {
  const ctx = await authorityContext(t);
  const guardrail = guardrailDecision(ctx);
  const liveWorkflow = await approvedWorkflow(ctx.root, ctx.experiment.payload.projectId, ctx.experiment.payload.riskClass, "approval:publication-failure", "publication-failure-workflow");
  const authorization = await prepareBoundedLiveSampleAuthorization({ experiment: ctx.experiment, experimentAuthorization: ctx.experimentAuthorization, admissionDecision: ctx.admissionDecision, experimentWorkflow: ctx.experimentWorkflow, guardrailDecision: guardrail, liveWorkflow, authorization: liveAuthorizationInput(liveWorkflow, "candidate") });
  const output = "candidate output failure fixture";
  const outputSha256 = createHash("sha256").update(output).digest("hex").toUpperCase();
  const verificationReference = "verify:publication-failure";
  const run = { runId: "publication-failure-run", projectId: ctx.experiment.payload.projectId, task: "fixture", riskClass: "R0", runtimeId: "opencode", modelRoute: [ctx.experiment.payload.candidateSubjectId], contextCompilerVersion: "v1", skills: [], toolsets: [], workspace: "C:/isolated/bounded-live", policyDecisions: [], approvalIds: [], changeReferences: [], evidence: [{ kind: "deterministic_check", status: "passed", reference: verificationReference, producer: "test", collectedAt: "2026-08-19T06:34:00.000Z" }], resourceMetrics: {}, traceId: "trace:publication-failure", outcome: "succeeded", createdAt: "2026-08-19T06:33:30.000Z" };
  const binding = { workflowRunId: run.runId, projectId: run.projectId, workflowAttempt: 1, runtimeId: run.runtimeId, sessionId: "ses_publication_failure", workspace: run.workspace, boundAt: "2026-08-19T06:33:31.000Z" };
  const runtimeResult = await prepareVerifiedBoundedLiveRuntimeResult({ role: "candidate", authorization, run, binding, verificationReference, outputSha256, outputBytes: Buffer.byteLength(output), verifiedAt: "2026-08-19T06:34:01.000Z" });
  const journal = await sideEffects(ctx.root, "publication-failure-effects");
  const coordinator = new BoundedLivePublicationCoordinator({ async read() { return output; } }, { id: "sink:failure", async publish() { throw new Error("synthetic sink failure api_key=top-secret"); } }, journal);
  await assert.rejects(() => coordinator.publish({ authorization, runtimeResult }), /manual reconciliation is required and automatic retry is forbidden/);
  assert.equal(journal.inspect().unknownSideEffectOperationIds.length, 1);
  assert.doesNotMatch(JSON.stringify(journal.list()), /top-secret/);
  await assert.rejects(() => coordinator.publish({ authorization, runtimeResult }), /already exists|unresolved operation/);
});

test("reference restore is durably reserved/committed and requires exact ROLLBACK_REQUIRED approval", async (t) => {
  const ctx = await authorityContext(t, { budget: { maxTotalSamples: 6, minimumShadowSamplesBeforeLive: 2, maxLiveSamples: 3, maxCandidateLiveSamples: 2, maxCandidateTrafficBasisPoints: 10000 } });
  const rollbackGuardrail = guardrailDecision(ctx, { classification: "ROLLBACK_REQUIRED", shadowSamples: 2, liveSamples: 1, candidateLiveSamples: 1 });
  const rollbackWorkflow = await approvedWorkflow(ctx.root, ctx.experiment.payload.projectId, ctx.experiment.payload.riskClass, "approval:reference-restore-1", "rollback-workflow");
  const rollbackInput = { actor: "operator:rollback-test", approvedAt: "2026-08-19T06:41:00.000Z", policyReferences: [ctx.experiment.payload.rollback.policyReference], approvalIds: rollbackWorkflow.approvalIds };
  const sources = { experiment: ctx.experiment, experimentAuthorization: ctx.experimentAuthorization, admissionDecision: ctx.admissionDecision, experimentWorkflow: ctx.experimentWorkflow, guardrailDecision: rollbackGuardrail, rollbackWorkflow, authorization: rollbackInput };
  const rollbackAuthorization = await prepareBoundedLiveRollbackAuthorization(sources);
  await assert.doesNotReject(() => verifyBoundedLiveRollbackAuthorization(rollbackAuthorization, sources));
  const journal = await sideEffects(ctx.root, "restore-effects");
  const restoreCalls = [];
  const coordinator = new BoundedLiveReferenceRestoreCoordinator({ id: "sink:reference-restore-test", async restore(input) { assert.equal(journal.inspect().unresolvedOperationIds.length, 1); restoreCalls.push(input); return { sinkId: "sink:reference-restore-test", idempotencyKey: input.idempotencyKey, restoreReference: "restore:reference-subject-1", restoredAt: "2026-08-19T06:42:00.000Z", activeSubjectId: input.targetSubjectId }; } }, journal);
  const receipt = await coordinator.restore(rollbackAuthorization);
  assert.equal(restoreCalls.length, 1);
  assert.equal(receipt.payload.targetSubjectId, "opencode:9router/hemat");
  assert.equal(receipt.payload.referenceSubjectRestored, true);
  assert.match(receipt.payload.sideEffectCommitEventId, /^m5liveeffect:/);
  assert.deepEqual(journal.inspect().unresolvedOperationIds, []);
  await assert.doesNotReject(() => verifyBoundedLiveReferenceRestoreReceipt(receipt));
  await assert.rejects(() => prepareBoundedLiveRollbackAuthorization({ ...sources, authorization: { ...rollbackInput, approvedAt: "2026-08-19T06:20:00.000Z" } }), /cannot predate ROLLBACK_REQUIRED evidence/);
});
