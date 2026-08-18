import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  JsonlEvalHistory,
  RoutingEvalPlane,
  buildEvalCohortSummary,
  compareEvalCohorts,
  prepareGoldenTaskSuite,
  verifyEvalCohortComparison,
  verifyEvalCohortSummary,
} from "../dist/index.js";

const limits = { maxTasks: 10, maxAssertionsPerTask: 10, maxPromptBytes: 4096, maxStringBytes: 2048, maxSuiteBytes: 64 * 1024 };
const options = (filePath) => ({ filePath, maxFileBytes: 1024 * 1024, maxObservationBytes: 128 * 1024, maxReportBytes: 64 * 1024, maxStringBytes: 2048, maxSourceReferences: 8 });

async function buildFixture() {
  const suite = await prepareGoldenTaskSuite({ schemaVersion: 1, suiteId: "stats-v1", description: "stats fixture", tasks: [{ id: "route", kind: "routing", prompt: "Use GitHub and verify the result.", critical: true, minimumScore: 1, assertions: [{ id: "model", kind: "primary_model_equals", weight: 1, expected: "model-a" }, { id: "skill", kind: "selected_skills_include", weight: 1, expected: ["github"] }, { id: "verify", kind: "requires_verification_equals", weight: 1, expected: true }] }] }, limits);
  const plane = new RoutingEvalPlane({ maxReportBytes: 64 * 1024, maxSubjectIdBytes: 2048 });
  const subject = (model, verification = true) => ({ id: "router-stats", async route() { return { primaryModel: { candidate: { id: model } }, selectedSkills: [{ candidate: { id: "github" } }], analysis: { requiresVerification: verification } }; } });
  const passReport = await plane.evaluate(suite, subject("model-a"));
  const failReport = await plane.evaluate(suite, subject("model-b"));
  const baseline = { schemaVersion: 1, baselineId: "stats-baseline", suiteId: suite.suiteId, suiteSha256: suite.suiteSha256, subjectId: "router-stats", minimumWeightedScore: 1, minimumTaskPassRate: 1, minimumCriticalPassRate: 1, maximumFailedTasks: 0 };
  return { passReport, failReport, baseline };
}

async function historyFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "9router-eval-stats-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return JsonlEvalHistory.open(options(join(root, "history.jsonl")));
}

test("cohort summary computes deterministic quality/reliability distributions without treating missing cost or latency as zero", async (t) => {
  const history = await historyFixture(t); const { passReport, failReport, baseline } = await buildFixture();
  const first = await history.append({ observedAt: "2026-08-18T07:00:00.000Z", report: passReport, baseline, measurement: { latencyMs: 200, costUsd: 0.08, sourceReferences: ["ci:1"] } });
  const second = await history.append({ observedAt: "2026-08-18T07:05:00.000Z", report: failReport, baseline });
  const summary = await buildEvalCohortSummary([first, second]);
  await verifyEvalCohortSummary(summary);
  assert.equal(summary.payload.observationCount, 2);
  assert.equal(summary.payload.reliability.baselinePassRate, 0.5);
  assert.equal(summary.payload.latencyMs.sampleCount, 1); assert.equal(summary.payload.latencyMs.mean, 200);
  assert.equal(summary.payload.costUsd.sampleCount, 1); assert.equal(summary.payload.costUsd.mean, 0.08);
  assert.equal(summary.payload.quality.weightedScore.mean, (1 + (2 / 3)) / 2);
  const repeat = await buildEvalCohortSummary([second, first]);
  assert.deepEqual(repeat, summary);
});

test("cohort comparison emits descriptive candidate-minus-reference deltas and preserves unavailable dimensions", async (t) => {
  const history = await historyFixture(t); const { passReport, baseline } = await buildFixture();
  const referenceObs = await history.append({ observedAt: "2026-08-18T08:00:00.000Z", report: passReport, baseline, measurement: { latencyMs: 250, costUsd: 0.12, sourceReferences: ["timer:ref"] } });
  const candidateObs = await history.append({ observedAt: "2026-08-18T08:05:00.000Z", report: passReport, baseline, measurement: { latencyMs: 150, sourceReferences: ["timer:candidate"] } });
  const reference = await buildEvalCohortSummary([referenceObs]); const candidate = await buildEvalCohortSummary([candidateObs]);
  const comparison = await compareEvalCohorts(reference, candidate); await verifyEvalCohortComparison(comparison);
  assert.equal(comparison.payload.deltas.weightedScoreMean, 0);
  assert.equal(comparison.payload.deltas.latencyMeanMs, -100);
  assert.equal(comparison.payload.deltas.costMeanUsd, null);
});

test("cohort summary and comparison fail closed on mixed identities and tampering", async (t) => {
  const history = await historyFixture(t); const { passReport, baseline } = await buildFixture();
  const first = await history.append({ observedAt: "2026-08-18T09:00:00.000Z", report: passReport, baseline });
  const summary = await buildEvalCohortSummary([first]);
  await assert.rejects(() => verifyEvalCohortSummary({ ...summary, summarySha256: "0".repeat(64) }), /digest does not match/);
  const foreignReport = { ...passReport, payload: { ...passReport.payload, subjectId: "other-subject" } };
  const foreignBaseline = { ...baseline, subjectId: "other-subject" };
  await assert.rejects(() => history.append({ observedAt: "2026-08-18T09:05:00.000Z", report: foreignReport, baseline: foreignBaseline }), /digest does not match/);
});
