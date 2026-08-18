import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateControlledExperimentGuardrails,
  prepareControlledExperimentAuthorization,
  prepareControlledExperimentDefinition,
  verifiedControlledExperimentGuardrailDecisionToEvidence,
  verifyControlledExperimentGuardrailDecision,
} from "../dist/index.js";
import {
  authorizationInput,
  buildExperimentCohort,
  controlledExperimentFixture,
  durableApprovedExperimentWorkflow,
  experimentDefinitionInput,
} from "./controlled-experiment-fixture.mjs";

async function experimentContext(t, definitionOverrides = {}) {
  const fixture = await controlledExperimentFixture(t);
  const experiment = await prepareControlledExperimentDefinition(fixture.admissionDecision, experimentDefinitionInput(definitionOverrides));
  const { run: workflow } = await durableApprovedExperimentWorkflow(fixture.root, { riskClass: experiment.payload.riskClass });
  const authorization = await prepareControlledExperimentAuthorization(experiment, fixture.admissionDecision, workflow, authorizationInput());
  return { ...fixture, experiment, workflow, authorization };
}

async function progressCohorts(ctx, { count, candidateReport = ctx.passReport, outcomes, minuteBase = 40, referenceLatency = 150, candidateLatency = 120, referenceCost = 0.08, candidateCost = 0.06 }) {
  const reference = await buildExperimentCohort({
    history: ctx.history,
    report: ctx.passReport,
    baseline: ctx.baseline,
    prefix: `progress-reference-${minuteBase}`,
    count,
    latencyBase: referenceLatency,
    costBase: referenceCost,
    minuteBase,
  });
  const candidate = await buildExperimentCohort({
    history: ctx.history,
    report: candidateReport,
    baseline: ctx.baseline,
    prefix: `progress-candidate-${minuteBase}`,
    count,
    outcomes,
    latencyBase: candidateLatency,
    costBase: candidateCost,
    minuteBase: minuteBase + 10,
  });
  return { reference, candidate };
}

function evaluate(ctx, cohorts, counters, observedAt = "2026-08-18T10:30:00.000Z") {
  return evaluateControlledExperimentGuardrails({
    experiment: ctx.experiment,
    authorization: ctx.authorization,
    admissionDecision: ctx.admissionDecision,
    workflow: ctx.workflow,
    progress: {
      observedAt,
      shadowSamples: counters.shadowSamples,
      liveSamples: counters.liveSamples,
      candidateLiveSamples: counters.candidateLiveSamples,
      referenceEvalSummary: cohorts.reference.evalSummary,
      candidateEvalSummary: cohorts.candidate.evalSummary,
      referenceExecutionSummary: cohorts.reference.executionSummary,
      candidateExecutionSummary: cohorts.candidate.executionSummary,
    },
  });
}

test("controlled experiment remains shadow-first and only emits evidence eligibility for bounded live", async (t) => {
  const ctx = await experimentContext(t);
  const two = await progressCohorts(ctx, { count: 2, minuteBase: 40 });
  const shadow = await evaluate(ctx, two, { shadowSamples: 2, liveSamples: 0, candidateLiveSamples: 0 });
  assert.equal(shadow.payload.classification, "CONTINUE_SHADOW");
  assert.equal(shadow.payload.automaticDispatchAllowed, false);

  const three = await progressCohorts(ctx, { count: 3, minuteBase: 60 });
  const eligible = await evaluate(ctx, three, { shadowSamples: 3, liveSamples: 0, candidateLiveSamples: 0 });
  await verifyControlledExperimentGuardrailDecision(eligible);
  assert.equal(eligible.payload.classification, "ELIGIBLE_FOR_BOUNDED_LIVE");
  assert.equal(eligible.payload.boundedLiveAdmissionEligible, true);
  assert.equal(eligible.payload.automaticDispatchAllowed, false);
  assert.equal(eligible.payload.productionRoutingMutationAllowed, false);
  assert.equal(eligible.payload.automaticRollbackAllowed, false);
});

test("controlled experiment continues bounded live only inside explicit sample and traffic budgets", async (t) => {
  const ctx = await experimentContext(t);
  const four = await progressCohorts(ctx, { count: 4, minuteBase: 80 });
  const live = await evaluate(ctx, four, { shadowSamples: 3, liveSamples: 1, candidateLiveSamples: 1 });
  assert.equal(live.payload.classification, "CONTINUE_BOUNDED_LIVE");
  assert.equal(live.payload.candidateTrafficBasisPoints, 10000);

  const six = await progressCohorts(ctx, { count: 6, minuteBase: 100 });
  const complete = await evaluate(ctx, six, { shadowSamples: 3, liveSamples: 3, candidateLiveSamples: 3 });
  assert.equal(complete.payload.classification, "COMPLETE");
  assert.equal(complete.payload.guardrailActionRequired, false);
});

test("controlled experiment requires stop before live and rollback after live when deterministic guardrails breach", async (t) => {
  const ctx = await experimentContext(t);
  const badShadow = await progressCohorts(ctx, { count: 3, candidateReport: ctx.failReport, minuteBase: 120 });
  const stop = await evaluate(ctx, badShadow, { shadowSamples: 3, liveSamples: 0, candidateLiveSamples: 0 });
  assert.equal(stop.payload.classification, "STOP_REQUIRED");
  assert.equal(stop.payload.guardrailActionRequired, true);
  assert.ok(stop.payload.reasons.some((reason) => reason.includes("weighted_score") || reason.includes("critical_pass_rate")));

  const cancelledLive = await progressCohorts(ctx, { count: 4, outcomes: ["succeeded", "succeeded", "succeeded", "cancelled"], minuteBase: 140 });
  const rollback = await evaluate(ctx, cancelledLive, { shadowSamples: 3, liveSamples: 1, candidateLiveSamples: 1 });
  assert.equal(rollback.payload.classification, "ROLLBACK_REQUIRED");
  assert.equal(rollback.payload.automaticRollbackAllowed, false);
  assert.ok(rollback.payload.reasons.includes("cancellation_rate_exceeded_stop_condition"));
  const evidence = await verifiedControlledExperimentGuardrailDecisionToEvidence(rollback, "2026-08-18T10:31:00.000Z");
  assert.equal(evidence.kind, "deterministic_check");
  assert.equal(evidence.status, "failed");
});

test("controlled experiment fails closed on live exposure before shadow minimum and traffic allocation beyond contract", async (t) => {
  const ctx = await experimentContext(t, {
    budget: {
      maxTotalSamples: 6,
      minimumShadowSamplesBeforeLive: 3,
      maxLiveSamples: 3,
      maxCandidateLiveSamples: 2,
      maxCandidateTrafficBasisPoints: 5000,
    },
  });
  const three = await progressCohorts(ctx, { count: 3, minuteBase: 160 });
  const decision = await evaluate(ctx, three, { shadowSamples: 2, liveSamples: 1, candidateLiveSamples: 1 });
  assert.equal(decision.payload.classification, "ROLLBACK_REQUIRED");
  assert.ok(decision.payload.reasons.includes("live_exposure_started_before_minimum_shadow_samples"));
  assert.ok(decision.payload.reasons.includes("candidate_live_traffic_share_exceeded"));
});

test("controlled experiment guardrail decisions and evidence conversion are content-addressed and fail closed", async (t) => {
  const ctx = await experimentContext(t);
  const cohorts = await progressCohorts(ctx, { count: 3, minuteBase: 180 });
  const decision = await evaluate(ctx, cohorts, { shadowSamples: 3, liveSamples: 0, candidateLiveSamples: 0 });
  const tampered = { ...decision, payload: { ...decision.payload, automaticDispatchAllowed: true } };
  await assert.rejects(() => verifyControlledExperimentGuardrailDecision(tampered), /cannot grant automatic authority|digest does not match/);
  await assert.rejects(
    () => verifiedControlledExperimentGuardrailDecisionToEvidence(tampered, "2026-08-18T10:32:00.000Z"),
    /cannot grant automatic authority|digest does not match/,
  );
  const badCounters = { ...decision, payload: { ...decision.payload, liveSamples: 1 } };
  await assert.rejects(() => verifyControlledExperimentGuardrailDecision(badCounters), /sample counters are inconsistent|candidateTrafficBasisPoints mismatch|digest does not match/);
});
