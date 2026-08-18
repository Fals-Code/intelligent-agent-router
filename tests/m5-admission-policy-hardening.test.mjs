import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  JsonlEvalHistory,
  RoutingEvalPlane,
  assessM5ControlledExperimentAdmission,
  buildCanonicalMetricTaxonomy,
  buildEvalCohortSummary,
  prepareGoldenTaskSuite,
  prepareM5AdmissionPolicy,
} from "../dist/index.js";

const suiteLimits = { maxTasks: 4, maxAssertionsPerTask: 4, maxPromptBytes: 2048, maxStringBytes: 1024, maxSuiteBytes: 32 * 1024 };
const historyOptions = (filePath) => ({ filePath, maxFileBytes: 1024 * 1024, maxObservationBytes: 64 * 1024, maxReportBytes: 32 * 1024, maxStringBytes: 1024, maxSourceReferences: 8 });

async function qualityOnlyFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "9router-m5-quality-only-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const suite = await prepareGoldenTaskSuite({
    schemaVersion: 1,
    suiteId: "m5-quality-only-suite",
    description: "Quality-only M5 admission fixture.",
    tasks: [{
      id: "route",
      kind: "routing",
      prompt: "Route this bounded synthetic task.",
      critical: true,
      minimumScore: 1,
      assertions: [{ id: "verify", kind: "requires_verification_equals", weight: 1, expected: true }],
    }],
  }, suiteLimits);
  const plane = new RoutingEvalPlane({ maxReportBytes: 32 * 1024, maxSubjectIdBytes: 1024 });
  const report = await plane.evaluate(suite, {
    id: "router-m5-quality-only",
    async route() {
      return { primaryModel: { candidate: { id: "model-a" } }, selectedSkills: [], analysis: { requiresVerification: true } };
    },
  });
  const baseline = {
    schemaVersion: 1,
    baselineId: "m5-quality-only-baseline",
    suiteId: suite.suiteId,
    suiteSha256: suite.suiteSha256,
    subjectId: "router-m5-quality-only",
    minimumWeightedScore: 1,
    minimumTaskPassRate: 1,
    minimumCriticalPassRate: 1,
    maximumFailedTasks: 0,
  };
  const history = await JsonlEvalHistory.open(historyOptions(join(root, "history.jsonl")));
  const makeSummary = async (minuteBase) => {
    const observations = [];
    for (let index = 0; index < 2; index += 1) {
      observations.push(await history.append({
        observedAt: new Date(Date.UTC(2026, 7, 18, 10, minuteBase + index, 0)).toISOString(),
        report,
        baseline,
      }));
    }
    return buildEvalCohortSummary(observations);
  };
  return {
    taxonomy: await buildCanonicalMetricTaxonomy(),
    reference: { evalSummary: await makeSummary(0) },
    candidate: { evalSummary: await makeSummary(10) },
  };
}

function qualityOnlyPolicyInput(overrides = {}) {
  return {
    name: "m5-quality-only-policy",
    minimumObservationCount: 2,
    requireExecutionReliability: false,
    requireFullExecutionProvenance: false,
    minimumExecutionSampleCount: 0,
    minimumDecidedExecutionSampleCount: 0,
    minimumLatencyCoverageRatio: 0,
    minimumCostCoverageRatio: 0,
    maximumCoverageRegressionRatio: 0.1,
    maximumWeightedScoreMeanRegression: 0.05,
    maximumTaskPassRateMeanRegression: 0.05,
    maximumCriticalPassRateMeanRegression: 0.05,
    maximumBaselinePassRateRegression: 0.05,
    maximumExecutionSuccessRateRegression: 0.05,
    maximumCancellationRateIncrease: 0.1,
    maximumLatencyMeanIncreaseMs: undefined,
    maximumCostMeanIncreaseUsd: undefined,
    ...overrides,
  };
}

test("quality-only M5 admission does not silently require execution evidence", async (t) => {
  const { taxonomy, reference, candidate } = await qualityOnlyFixture(t);
  const policy = await prepareM5AdmissionPolicy(taxonomy, qualityOnlyPolicyInput());
  const decision = await assessM5ControlledExperimentAdmission({ taxonomy, policy, reference, candidate });
  assert.equal(decision.payload.classification, "ELIGIBLE_FOR_CONTROLLED_EXPERIMENT");
  assert.equal(decision.payload.referenceExecutionSummaryId, undefined);
  assert.equal(decision.payload.candidateExecutionSummaryId, undefined);
  assert.equal(decision.payload.controlledExperimentAutomaticallyAuthorized, false);
});

test("efficiency admission metrics require full canonical execution provenance", async () => {
  const taxonomy = await buildCanonicalMetricTaxonomy();
  await assert.rejects(
    () => prepareM5AdmissionPolicy(taxonomy, qualityOnlyPolicyInput({ minimumLatencyCoverageRatio: 0.5 })),
    /Efficiency admission metrics require full canonical execution provenance/,
  );
  await assert.rejects(
    () => prepareM5AdmissionPolicy(taxonomy, qualityOnlyPolicyInput({ maximumCostMeanIncreaseUsd: 0.01 })),
    /Efficiency admission metrics require full canonical execution provenance/,
  );
});

test("M5 admission policy rejects unknown fields before content addressing", async () => {
  const taxonomy = await buildCanonicalMetricTaxonomy();
  await assert.rejects(
    () => prepareM5AdmissionPolicy(taxonomy, { ...qualityOnlyPolicyInput(), unexpectedAuthority: true }),
    /contains unknown field: unexpectedAuthority/,
  );
});
