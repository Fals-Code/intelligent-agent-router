import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  JsonlEvalHistory,
  RoutingEvalPlane,
  prepareGoldenTaskSuite,
  verifyEvalHistoryObservation,
} from "../dist/index.js";

const NOW = "2026-08-18T06:00:00.000Z";
const LATER = "2026-08-18T06:05:00.000Z";
const limits = { maxTasks: 10, maxAssertionsPerTask: 10, maxPromptBytes: 4096, maxStringBytes: 2048, maxSuiteBytes: 64 * 1024 };
const historyOptions = (filePath) => ({ filePath, maxFileBytes: 1024 * 1024, maxObservationBytes: 128 * 1024, maxReportBytes: 64 * 1024, maxStringBytes: 2048, maxSourceReferences: 8 });

async function fixture() {
  const suite = await prepareGoldenTaskSuite({ schemaVersion: 1, suiteId: "routing-history-v1", description: "history fixture", tasks: [{ id: "route", kind: "routing", prompt: "Route this coding task through GitHub.", critical: true, minimumScore: 1, assertions: [{ id: "model", kind: "primary_model_equals", weight: 1, expected: "model-a" }, { id: "skill", kind: "selected_skills_include", weight: 1, expected: ["github"] }, { id: "verify", kind: "requires_verification_equals", weight: 1, expected: true }] }] }, limits);
  const plane = new RoutingEvalPlane({ maxReportBytes: 64 * 1024, maxSubjectIdBytes: 2048 });
  const subject = { id: "router-a", async route() { return { primaryModel: { candidate: { id: "model-a" } }, selectedSkills: [{ candidate: { id: "github" } }], analysis: { requiresVerification: true } }; } };
  const report = await plane.evaluate(suite, subject);
  const baseline = { schemaVersion: 1, baselineId: "baseline-a", suiteId: suite.suiteId, suiteSha256: suite.suiteSha256, subjectId: subject.id, minimumWeightedScore: 1, minimumTaskPassRate: 1, minimumCriticalPassRate: 1, maximumFailedTasks: 0 };
  return { suite, report, baseline };
}

async function tempHistory(t) {
  const root = await mkdtemp(join(tmpdir(), "9router-eval-history-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, "history.jsonl");
}

test("durable eval history fsyncs verified observations and reloads them after restart", async (t) => {
  const filePath = await tempHistory(t); const { report, baseline } = await fixture();
  const history = await JsonlEvalHistory.open(historyOptions(filePath));
  const first = await history.append({ observedAt: NOW, report, baseline, measurement: { latencyMs: 1250, costUsd: 0.04, sourceReferences: ["ci:run:100", "ledger:run:100"] } });
  await verifyEvalHistoryObservation(first);
  assert.equal(first.payload.comparison.passed, true); assert.equal(first.payload.measurement.latencyMs, 1250);
  const reopened = await JsonlEvalHistory.open(historyOptions(filePath));
  assert.deepEqual(reopened.list(), [first]);
  const second = await reopened.append({ observedAt: LATER, report, baseline });
  assert.notEqual(second.observationId, first.observationId); assert.equal(reopened.list().length, 2);
});

test("eval history rejects duplicate observations, unreferenced measurements and tampered reports", async (t) => {
  const filePath = await tempHistory(t); const { report, baseline } = await fixture();
  const history = await JsonlEvalHistory.open(historyOptions(filePath));
  const input = { observedAt: NOW, report, baseline, measurement: { latencyMs: 5, sourceReferences: ["timer:fixture"] } };
  await history.append(input);
  await assert.rejects(() => history.append(input), /already exists/);
  await assert.rejects(() => history.append({ observedAt: LATER, report, baseline, measurement: { costUsd: 0.1, sourceReferences: [] } }), /source reference/);
  const tampered = { ...report, payload: { ...report.payload, metrics: { ...report.payload.metrics, weightedScore: 0 } } };
  await assert.rejects(() => history.append({ observedAt: LATER, report: tampered, baseline }), /digest does not match/);
});

test("eval history reload fails closed on truncated data and stale writers", async (t) => {
  const filePath = await tempHistory(t); const { report, baseline } = await fixture();
  const firstWriter = await JsonlEvalHistory.open(historyOptions(filePath));
  const staleWriter = await JsonlEvalHistory.open(historyOptions(filePath));
  await firstWriter.append({ observedAt: NOW, report, baseline });
  await assert.rejects(() => staleWriter.append({ observedAt: LATER, report, baseline }), /changed outside this writer/);
  await appendFile(filePath, "{", "utf8");
  await assert.rejects(() => JsonlEvalHistory.open(historyOptions(filePath)), /not newline-terminated/);
});

test("eval history requires the baseline to match the verified report", async (t) => {
  const filePath = await tempHistory(t); const { report, baseline } = await fixture();
  const history = await JsonlEvalHistory.open(historyOptions(filePath));
  await assert.rejects(() => history.append({ observedAt: NOW, report, baseline: { ...baseline, suiteSha256: "A".repeat(64) } }), /suiteSha256 does not match/);
});
