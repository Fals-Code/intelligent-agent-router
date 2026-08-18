import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ExecutionMetricProjector,
  JsonlEvalHistory,
  RoutingEvalPlane,
  assessM5ControlledExperimentAdmission,
  buildCanonicalMetricTaxonomy,
  buildEvalCohortSummary,
  buildExecutionReliabilitySummary,
  executionProjectionToEvalMeasurement,
  prepareGoldenTaskSuite,
  prepareM5AdmissionPolicy,
  verifyM5AdmissionDecision,
} from "../dist/index.js";

const suiteLimits = {
  maxTasks: 8,
  maxAssertionsPerTask: 8,
  maxPromptBytes: 4096,
  maxStringBytes: 2048,
  maxSuiteBytes: 64 * 1024,
};
const historyOptions = (filePath) => ({
  filePath,
  maxFileBytes: 2 * 1024 * 1024,
  maxObservationBytes: 128 * 1024,
  maxReportBytes: 64 * 1024,
  maxStringBytes: 2048,
  maxSourceReferences: 8,
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "9router-m5-admission-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const suite = await prepareGoldenTaskSuite({
    schemaVersion: 1,
    suiteId: "m5-admission-suite",
    description: "M5 admission fixture.",
    tasks: [{
      id: "route",
      kind: "routing",
      prompt: "Route this synthetic task with deterministic verification.",
      critical: true,
      minimumScore: 1,
      assertions: [
        { id: "model", kind: "primary_model_equals", weight: 1, expected: "model-a" },
        { id: "verify", kind: "requires_verification_equals", weight: 1, expected: true },
      ],
    }],
  }, suiteLimits);
  const plane = new RoutingEvalPlane({ maxReportBytes: 64 * 1024, maxSubjectIdBytes: 2048 });
  const subject = (model) => ({
    id: "router-m5",
    async route() {
      return {
        primaryModel: { candidate: { id: model } },
        selectedSkills: [],
        analysis: { requiresVerification: true },
      };
    },
  });
  const passReport = await plane.evaluate(suite, subject("model-a"));
  const failReport = await plane.evaluate(suite, subject("model-b"));
  const baseline = {
    schemaVersion: 1,
    baselineId: "m5-admission-baseline",
    suiteId: suite.suiteId,
    suiteSha256: suite.suiteSha256,
    subjectId: "router-m5",
    minimumWeightedScore: 1,
    minimumTaskPassRate: 1,
    minimumCriticalPassRate: 1,
    maximumFailedTasks: 0,
  };
  const history = await JsonlEvalHistory.open(historyOptions(join(root, "history.jsonl")));
  const taxonomy = await buildCanonicalMetricTaxonomy();
  return { history, taxonomy, passReport, failReport, baseline };
}

function runRecord(runId, outcome, latencyMs, costUsd) {
  return {
    runId,
    projectId: "project-m5",
    task: "Synthetic M5 admission execution",
    riskClass: "R0",
    runtimeId: "opencode",
    modelRoute: ["openai-balanced"],
    contextCompilerVersion: "v1",
    skills: [],
    toolsets: [],
    workspace: "C:/isolated/m5",
    policyDecisions: ["policy:allow"],
    approvalIds: [],
    changeReferences: [],
    evidence: [{
      kind: "policy",
      status: "passed",
      reference: `policy:${runId}`,
      producer: "policy-engine",
      collectedAt: "2026-08-18T07:00:00.000Z",
    }],
    resourceMetrics: { "runtime.total_ms": latencyMs, "billing.usd": costUsd },
    traceId: `trace:${runId}`,
    outcome,
    failureReason: outcome === "failed" ? "synthetic failure" : undefined,
    createdAt: "2026-08-18T06:59:00.000Z",
  };
}

async function buildCohort({ history, report, baseline, prefix, count = 3, costSamples = count, outcomes, latencyBase = 100, costBase = 0.05, minuteBase = 0 }) {
  const observations = [];
  const projections = [];
  const records = [];
  for (let index = 0; index < count; index += 1) {
    const record = runRecord(`${prefix}-${index}`, outcomes?.[index] ?? "succeeded", latencyBase + index, costBase + (index * 0.001));
    records.push(record);
    const includeCost = index < costSamples;
    const projector = new ExecutionMetricProjector({
      latencyMetricKey: "runtime.total_ms",
      costMetricKey: includeCost ? "billing.usd" : undefined,
      requireLatency: true,
      requireCost: includeCost,
      maxMetricKeyBytes: 256,
    });
    const projection = await projector.project(record);
    const measurement = await executionProjectionToEvalMeasurement(projection);
    const observedAt = new Date(Date.UTC(2026, 7, 18, 8, minuteBase + index, 0)).toISOString();
    const observation = await history.append({ observedAt, report, baseline, measurement });
    observations.push(observation);
    projections.push(projection);
  }
  return {
    evalSummary: await buildEvalCohortSummary(observations),
    executionSummary: await buildExecutionReliabilitySummary(observations, projections, records),
  };
}

async function policy(taxonomy, overrides = {}) {
  return prepareM5AdmissionPolicy(taxonomy, {
    name: "m5-controlled-experiment-default",
    minimumObservationCount: 3,
    requireExecutionReliability: true,
    requireFullExecutionProvenance: true,
    minimumExecutionSampleCount: 3,
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
    ...overrides,
  });
}

test("M5 admission marks sufficient non-regressing canonical evidence eligible without granting automatic authority", async (t) => {
  const { history, taxonomy, passReport, baseline } = await fixture(t);
  const reference = await buildCohort({ history, report: passReport, baseline, prefix: "ref-eligible", latencyBase: 150, costBase: 0.08, minuteBase: 0 });
  const candidate = await buildCohort({ history, report: passReport, baseline, prefix: "cand-eligible", latencyBase: 120, costBase: 0.06, minuteBase: 10 });
  const decision = await assessM5ControlledExperimentAdmission({ taxonomy, policy: await policy(taxonomy), reference, candidate });
  await verifyM5AdmissionDecision(decision);
  assert.equal(decision.payload.classification, "ELIGIBLE_FOR_CONTROLLED_EXPERIMENT");
  assert.equal(decision.payload.experimentAdmissionEligible, true);
  assert.equal(decision.payload.controlledExperimentAutomaticallyAuthorized, false);
  assert.equal(decision.payload.productionRoutingMutationAllowed, false);
  assert.equal(decision.payload.automaticDispatchAllowed, false);
  assert.equal(decision.payload.facts.referenceExecutionCoverageRatio, 1);
  assert.equal(decision.payload.facts.candidateCostCoverageRatio, 1);
});

test("M5 admission distinguishes insufficient evidence from measurement coverage drift", async (t) => {
  const { history, taxonomy, passReport, baseline } = await fixture(t);
  const reference = await buildCohort({ history, report: passReport, baseline, prefix: "ref-count", minuteBase: 20 });
  const candidate = await buildCohort({ history, report: passReport, baseline, prefix: "cand-count", minuteBase: 30 });
  const insufficient = await assessM5ControlledExperimentAdmission({
    taxonomy,
    policy: await policy(taxonomy, { minimumObservationCount: 5 }),
    reference,
    candidate,
  });
  assert.equal(insufficient.payload.classification, "INSUFFICIENT_EVIDENCE");
  assert.ok(insufficient.payload.reasons.includes("candidate_observation_count_below_minimum"));

  const driftReference = await buildCohort({ history, report: passReport, baseline, prefix: "ref-drift", count: 4, costSamples: 4, minuteBase: 40 });
  const driftCandidate = await buildCohort({ history, report: passReport, baseline, prefix: "cand-drift", count: 4, costSamples: 1, minuteBase: 50 });
  const drift = await assessM5ControlledExperimentAdmission({
    taxonomy,
    policy: await policy(taxonomy, {
      minimumObservationCount: 4,
      minimumExecutionSampleCount: 4,
      minimumCostCoverageRatio: 0.25,
      maximumCoverageRegressionRatio: 0.2,
      maximumCostMeanIncreaseUsd: undefined,
    }),
    reference: driftReference,
    candidate: driftCandidate,
  });
  assert.equal(drift.payload.classification, "MEASUREMENT_DRIFT");
  assert.ok(drift.payload.reasons.includes("cost_measurement_coverage_regressed"));
});

test("M5 admission rejects sufficient evidence when quality or cancellation guardrails regress", async (t) => {
  const { history, taxonomy, passReport, failReport, baseline } = await fixture(t);
  const qualityReference = await buildCohort({ history, report: passReport, baseline, prefix: "ref-quality", minuteBase: 60 });
  const qualityCandidate = await buildCohort({ history, report: failReport, baseline, prefix: "cand-quality", minuteBase: 70 });
  const qualityDecision = await assessM5ControlledExperimentAdmission({ taxonomy, policy: await policy(taxonomy), reference: qualityReference, candidate: qualityCandidate });
  assert.equal(qualityDecision.payload.classification, "NOT_ELIGIBLE_FOR_CONTROLLED_EXPERIMENT");
  assert.ok(qualityDecision.payload.reasons.some((item) => item.includes("weighted_score") || item.includes("critical_pass_rate") || item.includes("baseline_pass_rate")));

  const cancelReference = await buildCohort({ history, report: passReport, baseline, prefix: "ref-cancel", outcomes: ["succeeded", "succeeded", "succeeded"], minuteBase: 80 });
  const cancelCandidate = await buildCohort({ history, report: passReport, baseline, prefix: "cand-cancel", outcomes: ["succeeded", "succeeded", "cancelled"], minuteBase: 90 });
  const cancelDecision = await assessM5ControlledExperimentAdmission({ taxonomy, policy: await policy(taxonomy), reference: cancelReference, candidate: cancelCandidate });
  assert.equal(cancelDecision.payload.classification, "NOT_ELIGIBLE_FOR_CONTROLLED_EXPERIMENT");
  assert.ok(cancelDecision.payload.reasons.includes("cancellation_rate_increased_beyond_guardrail"));
});

test("M5 admission fails closed when execution provenance does not belong to the eval cohort", async (t) => {
  const { history, taxonomy, passReport, baseline } = await fixture(t);
  const reference = await buildCohort({ history, report: passReport, baseline, prefix: "ref-id", minuteBase: 100 });
  const candidate = await buildCohort({ history, report: passReport, baseline, prefix: "cand-id", minuteBase: 110 });
  const admissionPolicy = await policy(taxonomy);
  await assert.rejects(
    () => assessM5ControlledExperimentAdmission({
      taxonomy,
      policy: admissionPolicy,
      reference,
      candidate: { evalSummary: candidate.evalSummary, executionSummary: reference.executionSummary },
    }),
    /execution summary references observations outside eval cohort/,
  );
});
