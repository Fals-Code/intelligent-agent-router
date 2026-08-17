import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import {
  RoutingEvalPlane,
  prepareEvalBaseline,
  prepareGoldenTaskSuite,
  verifyRoutingEvalReport,
} from "../dist/index.js";

const LIMITS = {
  maxTasks: 64,
  maxAssertionsPerTask: 16,
  maxPromptBytes: 16 * 1024,
  maxStringBytes: 2048,
  maxSuiteBytes: 256 * 1024,
};
const EXPECTED_SUITE_SHA = "DB2C3C264FEF0F7731B1BDBB0BBD12A2ADD782001D9356576AE0C6F342343E46";

async function loadSuite() {
  const raw = JSON.parse(await fs.readFile(new URL("../evals/golden-routing-v1.json", import.meta.url), "utf8"));
  return prepareGoldenTaskSuite(raw, LIMITS);
}

function fakeDecision({ model = "openai-fast", skills = [], verification = false } = {}) {
  return {
    primaryModel: { candidate: { id: model } },
    selectedSkills: skills.map((id) => ({ candidate: { id } })),
    analysis: { requiresVerification: verification },
    traceId: crypto.randomUUID(),
  };
}

test("golden routing suite is bounded, deterministic, and bound to the committed M4 digest", async () => {
  const first = await loadSuite();
  const second = await loadSuite();
  assert.deepEqual(first, second);
  assert.equal(first.suiteSha256, EXPECTED_SUITE_SHA);
  assert.equal(first.tasks.length, 6);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.tasks[0]), true);
});

test("Eval Plane reports normalized routing facts without prompt or random trace identity", async () => {
  const suite = await prepareGoldenTaskSuite({
    schemaVersion: 1,
    suiteId: "unit-suite",
    description: "Small deterministic unit suite.",
    tasks: [{
      id: "unit-task",
      kind: "routing",
      prompt: "Summarize this synthetic paragraph.",
      critical: true,
      minimumScore: 1,
      assertions: [
        { id: "model", kind: "primary_model_equals", weight: 2, expected: "openai-fast" },
        { id: "verify", kind: "requires_verification_equals", weight: 1, expected: false },
      ],
    }],
  }, LIMITS);
  const plane = new RoutingEvalPlane({ maxReportBytes: 128 * 1024, maxSubjectIdBytes: 2048 });
  const subject = { id: "fake-router", async route() { return fakeDecision(); } };
  const first = await plane.evaluate(suite, subject);
  const second = await plane.evaluate(suite, subject);
  assert.deepEqual(first, second);
  assert.equal(first.payload.metrics.weightedScore, 1);
  assert.equal(first.payload.metrics.criticalPassRate, 1);
  const serialized = JSON.stringify(first);
  assert.doesNotMatch(serialized, /Summarize this synthetic paragraph/);
  assert.doesNotMatch(serialized, /traceId/);
  await verifyRoutingEvalReport(first, 128 * 1024, 2048);
});

test("baseline comparison fails closed on a critical routing regression", async () => {
  const suite = await prepareGoldenTaskSuite({
    schemaVersion: 1,
    suiteId: "regression-suite",
    description: "Regression gate fixture.",
    tasks: [{
      id: "critical-task",
      kind: "routing",
      prompt: "Use a strong model for this synthetic critical task.",
      critical: true,
      minimumScore: 1,
      assertions: [{ id: "model", kind: "primary_model_equals", weight: 1, expected: "openai-frontier" }],
    }],
  }, LIMITS);
  const plane = new RoutingEvalPlane({ maxReportBytes: 128 * 1024, maxSubjectIdBytes: 2048 });
  const report = await plane.evaluate(suite, { id: "fake-router", async route() { return fakeDecision({ model: "openai-fast" }); } });
  const baseline = prepareEvalBaseline({
    schemaVersion: 1,
    baselineId: "strict-baseline",
    suiteId: suite.suiteId,
    suiteSha256: suite.suiteSha256,
    subjectId: "fake-router",
    minimumWeightedScore: 1,
    minimumTaskPassRate: 1,
    minimumCriticalPassRate: 1,
    maximumFailedTasks: 0,
  });
  const comparison = await plane.compare(report, baseline);
  assert.equal(comparison.passed, false);
  assert.equal(comparison.regressions.length, 4);
  assert.match(comparison.regressions.join("\n"), /criticalPassRate/);
});

test("suite and baseline identities reject secrets, duplicates, drift, and tampered reports", async () => {
  await assert.rejects(() => prepareGoldenTaskSuite({
    schemaVersion: 1,
    suiteId: "bad-suite",
    description: "Bad fixture.",
    tasks: [{
      id: "bad-task",
      kind: "routing",
      prompt: "authorization=Bearer top-secret",
      critical: false,
      minimumScore: 1,
      assertions: [{ id: "model", kind: "primary_model_equals", weight: 1, expected: "openai-fast" }],
    }],
  }, LIMITS), /secret-like material/);

  const suite = await loadSuite();
  const baselineRaw = JSON.parse(await fs.readFile(new URL("../evals/baselines/routing-m4-v1.json", import.meta.url), "utf8"));
  const baseline = prepareEvalBaseline(baselineRaw);
  assert.equal(baseline.suiteSha256, suite.suiteSha256);

  const plane = new RoutingEvalPlane({ maxReportBytes: 256 * 1024, maxSubjectIdBytes: 2048 });
  const expected = new Map([
    ["simple-summary", fakeDecision({ model: "openai-fast", verification: false })],
    ["fresh-public-research", fakeDecision({ model: "openai-balanced", skills: ["web-search"], verification: true })],
    ["github-security-remediation", fakeDecision({ model: "openai-frontier", skills: ["github", "human-approval"], verification: true })],
    ["spreadsheet-artifact", fakeDecision({ model: "openai-balanced", skills: ["spreadsheet-builder"], verification: false })],
    ["image-generation", fakeDecision({ model: "openai-balanced", skills: ["image-generation"], verification: false })],
    ["document-research", fakeDecision({ model: "openai-balanced", skills: ["document-builder"], verification: false })],
  ]);
  let cursor = 0;
  const taskIds = suite.tasks.map((task) => task.id);
  const report = await plane.evaluate(suite, {
    id: "intelligent-agent-router",
    async route() { const result = expected.get(taskIds[cursor]); cursor += 1; return result; },
  });
  const comparison = await plane.compare(report, baseline);
  assert.equal(comparison.passed, true);
  await assert.rejects(() => verifyRoutingEvalReport({ ...report, reportId: "eval:00000000000000000000000000000000" }), /reportId does not match/);
  await assert.rejects(() => plane.compare(report, { ...baseline, suiteSha256: "A".repeat(64) }), /suiteSha256 does not match/);
});
