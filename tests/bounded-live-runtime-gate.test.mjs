import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  BoundedLivePublicationCoordinator,
  BoundedLiveReferenceRestoreCoordinator,
  DurableWorkflowStateMachine,
  JsonlWorkflowCheckpointStore,
  evaluateControlledExperimentGuardrails,
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
  buildExperimentCohort,
  controlledExperimentFixture,
  durableApprovedExperimentWorkflow,
  experimentDefinitionInput,
} from "./controlled-experiment-fixture.mjs";

let liveWorkflowSequence = 0;

async function authorityContext(t, overrides = {}) {
  const fixture = await controlledExperimentFixture(t);
  const experiment = await prepareControlledExperimentDefinition(
    fixture.admissionDecision,
    experimentDefinitionInput(overrides),
  );
  const { run: experimentWorkflow } = await durableApprovedExperimentWorkflow(fixture.root, { riskClass: experiment.payload.riskClass });
  const experimentAuthorization = await prepareControlledExperimentAuthorization(
    experiment,
    fixture.admissionDecision,
    experimentWorkflow,
    authorizationInput(),
  );
  return { ...fixture, experiment, experimentWorkflow, experimentAuthorization };
}

async function approvedWorkflow(root, projectId, riskClass, approvalId, prefix) {
  liveWorkflowSequence += 1;
  const store = new JsonlWorkflowCheckpointStore({
    filePath: join(root, `${prefix}-${liveWorkflowSequence}.jsonl`),
    maxFileBytes: 512 * 1024,
    maxCheckpointBytes: 32 * 1024,
  });
  const machine = new DurableWorkflowStateMachine(store);
  let run = machine.create({
    id: `${prefix}-${liveWorkflowSequence}`,
    projectId,
    riskClass,
    now: "2026-08-19T06:30:00.000Z",
  });
  run = machine.start(run, "2026-08-19T06:30:01.000Z");
  run = machine.advance(run, "2026-08-19T06:30:02.000Z");
  run = machine.advance(run, "2026-08-19T06:30:03.000Z");
  run = machine.advance(run, "2026-08-19T06:30:04.000Z");
  run = machine.advance(run, "2026-08-19T06:30:05.000Z");
  run = machine.requestApproval(run, "2026-08-19T06:30:06.000Z");
  run = machine.approve(run, approvalId, "2026-08-19T06:31:00.000Z");
  return run;
}

async function eligibleGuardrail(ctx) {
  return evaluateControlledExperimentGuardrails({
    experiment: ctx.experiment,
    authorization: ctx.experimentAuthorization,
    admissionDecision: ctx.admissionDecision,
    workflow: ctx.experimentWorkflow,
    progress: {
      observedAt: "2026-08-19T06:32:00.000Z",
      shadowSamples: 3,
      liveSamples: 0,
      candidateLiveSamples: 0,
      referenceEvalSummary: ctx.reference.evalSummary,
      candidateEvalSummary: ctx.candidate.evalSummary,
      referenceExecutionSummary: ctx.reference.executionSummary,
      candidateExecutionSummary: ctx.candidate.executionSummary,
    },
  });
}

function liveAuthorizationInput(workflow, assignment = "candidate") {
  return {
    sampleId: `live-sample-${assignment}`,
    inputReference: "live-input:bounded-gate-v1",
    liveAssignment: assignment,
    actor: "operator:bounded-live-test",
    approvedAt: "2026-08-19T06:33:00.000Z",
    policyReferences: ["policy:bounded-live-single-sample-v1"],
    approvalIds: workflow.approvalIds,
  };
}

test("bounded-live sample authorization is single-sample, R3/R4, shadow-first, and traffic-ceiling aware", async (t) => {
  const ctx = await authorityContext(t, {
    budget: {
      maxTotalSamples: 5,
      minimumShadowSamplesBeforeLive: 3,
      maxLiveSamples: 2,
      maxCandidateLiveSamples: 1,
      maxCandidateTrafficBasisPoints: 5000,
    },
  });
  const guardrail = await eligibleGuardrail(ctx);
  assert.equal(guardrail.payload.classification, "ELIGIBLE_FOR_BOUNDED_LIVE");
  const liveWorkflow = await approvedWorkflow(
    ctx.root,
    ctx.experiment.payload.projectId,
    ctx.experiment.payload.riskClass,
    "approval:bounded-live-sample-1",
    "live-workflow",
  );

  await assert.rejects(
    () => prepareBoundedLiveSampleAuthorization({
      experiment: ctx.experiment,
      experimentAuthorization: ctx.experimentAuthorization,
      admissionDecision: ctx.admissionDecision,
      experimentWorkflow: ctx.experimentWorkflow,
      guardrailDecision: guardrail,
      liveWorkflow,
      authorization: liveAuthorizationInput(liveWorkflow, "candidate"),
    }),
    /traffic basis-point ceiling/,
  );

  const authorizationInput = liveAuthorizationInput(liveWorkflow, "reference");
  const authorization = await prepareBoundedLiveSampleAuthorization({
    experiment: ctx.experiment,
    experimentAuthorization: ctx.experimentAuthorization,
    admissionDecision: ctx.admissionDecision,
    experimentWorkflow: ctx.experimentWorkflow,
    guardrailDecision: guardrail,
    liveWorkflow,
    authorization: authorizationInput,
  });
  assert.match(authorization.authorizationId, /^m5liveauth:[a-f0-9]{32}$/);
  assert.equal(authorization.payload.riskClass, "R3");
  assert.equal(authorization.payload.liveAssignment, "reference");
  assert.equal(authorization.payload.candidateTrafficAfterDispatchBasisPoints, 0);
  assert.equal(authorization.payload.singleSampleAuthority, true);
  assert.equal(authorization.payload.automaticDispatchAllowed, false);
  await assert.doesNotReject(() => verifyBoundedLiveSampleAuthorization(authorization, {
    experiment: ctx.experiment,
    experimentAuthorization: ctx.experimentAuthorization,
    admissionDecision: ctx.admissionDecision,
    experimentWorkflow: ctx.experimentWorkflow,
    guardrailDecision: guardrail,
    liveWorkflow,
    authorization: authorizationInput,
  }));
});

test("bounded-live publication requires verified succeeded Run Ledger, exact binding, and matching ephemeral output hash", async (t) => {
  const ctx = await authorityContext(t);
  const guardrail = await eligibleGuardrail(ctx);
  const liveWorkflow = await approvedWorkflow(
    ctx.root,
    ctx.experiment.payload.projectId,
    ctx.experiment.payload.riskClass,
    "approval:bounded-live-candidate-1",
    "candidate-live-workflow",
  );
  const authorizationInput = liveAuthorizationInput(liveWorkflow, "candidate");
  const authorization = await prepareBoundedLiveSampleAuthorization({
    experiment: ctx.experiment,
    experimentAuthorization: ctx.experimentAuthorization,
    admissionDecision: ctx.admissionDecision,
    experimentWorkflow: ctx.experimentWorkflow,
    guardrailDecision: guardrail,
    liveWorkflow,
    authorization: authorizationInput,
  });

  const output = "verified candidate output";
  const outputSha256 = createHash("sha256").update(output).digest("hex").toUpperCase();
  const verificationReference = "verify:bounded-live-candidate-run";
  const run = {
    runId: "bounded-live-candidate-run",
    projectId: ctx.experiment.payload.projectId,
    task: "Bounded live candidate execution",
    riskClass: "R0",
    runtimeId: "opencode",
    modelRoute: [ctx.experiment.payload.candidateSubjectId],
    contextCompilerVersion: "bounded-live/v1",
    skills: ["runtime.binding", "deterministic.verification"],
    toolsets: [],
    workspace: "C:/isolated/bounded-live",
    policyDecisions: ["R0 zero-tool verified live candidate"],
    approvalIds: [],
    changeReferences: [],
    evidence: [{
      kind: "deterministic_check",
      status: "passed",
      reference: verificationReference,
      producer: "bounded-live-verifier",
      collectedAt: "2026-08-19T06:34:00.000Z",
    }],
    resourceMetrics: { "runtime.total_ms": 100 },
    traceId: "trace:bounded-live-candidate-run",
    outcome: "succeeded",
    createdAt: "2026-08-19T06:33:30.000Z",
  };
  const binding = {
    workflowRunId: run.runId,
    projectId: run.projectId,
    workflowAttempt: 1,
    runtimeId: run.runtimeId,
    sessionId: "ses_bounded_live_candidate",
    workspace: run.workspace,
    boundAt: "2026-08-19T06:33:31.000Z",
  };
  const runtimeResult = await prepareVerifiedBoundedLiveRuntimeResult({
    role: "candidate",
    authorization,
    run,
    binding,
    verificationReference,
    outputSha256,
    outputBytes: Buffer.byteLength(output),
    verifiedAt: "2026-08-19T06:34:01.000Z",
  });

  const published = [];
  const coordinator = new BoundedLivePublicationCoordinator(
    { async read() { return output; } },
    {
      id: "sink:bounded-live-test",
      async publish(input) {
        published.push(input);
        return {
          sinkId: "sink:bounded-live-test",
          idempotencyKey: input.idempotencyKey,
          publicationReference: "publication:bounded-live-candidate-1",
          publishedAt: "2026-08-19T06:35:00.000Z",
          selectedRole: input.selectedRole,
          outputSha256: input.outputSha256,
          externallyVisible: true,
        };
      },
    },
  );
  const receipt = await coordinator.publish({ authorization, runtimeResult });
  assert.equal(published.length, 1);
  assert.equal(receipt.payload.candidateOutputExternallyVisible, true);
  assert.equal(receipt.payload.rawOutputPersisted, false);
  assert.equal(receipt.payload.automaticRetryAllowed, false);
  assert.equal(receipt.payload.productionRoutingMutationAllowed, false);
  await assert.doesNotReject(() => verifyBoundedLivePublicationReceipt(receipt));

  const badCoordinator = new BoundedLivePublicationCoordinator(
    { async read() { return `${output}-drift`; } },
    { id: "sink:bounded-live-test", async publish() { throw new Error("must not publish"); } },
  );
  await assert.rejects(
    () => badCoordinator.publish({ authorization, runtimeResult }),
    /does not match verified runtime result hash\/size/,
  );
});

test("reference restore requires ROLLBACK_REQUIRED plus separate durable R3/R4 approval", async (t) => {
  const ctx = await authorityContext(t, {
    budget: {
      maxTotalSamples: 6,
      minimumShadowSamplesBeforeLive: 2,
      maxLiveSamples: 3,
      maxCandidateLiveSamples: 2,
      maxCandidateTrafficBasisPoints: 10000,
    },
  });
  const badCandidate = await buildExperimentCohort({
    history: ctx.history,
    report: ctx.failReport,
    baseline: ctx.baseline,
    prefix: "rollback-bad-candidate",
    count: 3,
    latencyBase: 200,
    costBase: 0.1,
    minuteBase: 30,
  });
  const rollbackGuardrail = await evaluateControlledExperimentGuardrails({
    experiment: ctx.experiment,
    authorization: ctx.experimentAuthorization,
    admissionDecision: ctx.admissionDecision,
    workflow: ctx.experimentWorkflow,
    progress: {
      observedAt: "2026-08-19T06:40:00.000Z",
      shadowSamples: 2,
      liveSamples: 1,
      candidateLiveSamples: 1,
      referenceEvalSummary: ctx.reference.evalSummary,
      candidateEvalSummary: badCandidate.evalSummary,
      referenceExecutionSummary: ctx.reference.executionSummary,
      candidateExecutionSummary: badCandidate.executionSummary,
    },
  });
  assert.equal(rollbackGuardrail.payload.classification, "ROLLBACK_REQUIRED");

  const rollbackWorkflow = await approvedWorkflow(
    ctx.root,
    ctx.experiment.payload.projectId,
    ctx.experiment.payload.riskClass,
    "approval:reference-restore-1",
    "rollback-workflow",
  );
  const rollbackInput = {
    actor: "operator:rollback-test",
    approvedAt: "2026-08-19T06:41:00.000Z",
    policyReferences: [ctx.experiment.payload.rollback.policyReference],
    approvalIds: rollbackWorkflow.approvalIds,
  };
  const rollbackAuthorization = await prepareBoundedLiveRollbackAuthorization({
    experiment: ctx.experiment,
    experimentAuthorization: ctx.experimentAuthorization,
    admissionDecision: ctx.admissionDecision,
    experimentWorkflow: ctx.experimentWorkflow,
    guardrailDecision: rollbackGuardrail,
    rollbackWorkflow,
    authorization: rollbackInput,
  });
  await assert.doesNotReject(() => verifyBoundedLiveRollbackAuthorization(rollbackAuthorization, {
    experiment: ctx.experiment,
    experimentAuthorization: ctx.experimentAuthorization,
    admissionDecision: ctx.admissionDecision,
    experimentWorkflow: ctx.experimentWorkflow,
    guardrailDecision: rollbackGuardrail,
    rollbackWorkflow,
    authorization: rollbackInput,
  }));

  const restoreCalls = [];
  const coordinator = new BoundedLiveReferenceRestoreCoordinator({
    id: "sink:reference-restore-test",
    async restore(input) {
      restoreCalls.push(input);
      return {
        sinkId: "sink:reference-restore-test",
        idempotencyKey: input.idempotencyKey,
        restoreReference: "restore:reference-subject-1",
        restoredAt: "2026-08-19T06:42:00.000Z",
        activeSubjectId: input.targetSubjectId,
      };
    },
  });
  const receipt = await coordinator.restore(rollbackAuthorization);
  assert.equal(restoreCalls.length, 1);
  assert.equal(receipt.payload.targetSubjectId, ctx.experiment.payload.referenceSubjectId);
  assert.equal(receipt.payload.referenceSubjectRestored, true);
  assert.equal(receipt.payload.automaticRollbackAllowed, false);
  assert.equal(receipt.payload.generalProductionRoutingMutationAllowed, false);
  await assert.doesNotReject(() => verifyBoundedLiveReferenceRestoreReceipt(receipt));
});
