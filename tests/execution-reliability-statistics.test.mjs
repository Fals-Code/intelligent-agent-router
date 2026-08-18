import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ExecutionMetricProjector,
  JsonlEvalHistory,
  RoutingEvalPlane,
  buildExecutionReliabilitySummary,
  compareExecutionReliabilitySummaries,
  executionProjectionToEvalMeasurement,
  prepareGoldenTaskSuite,
  verifyExecutionReliabilityComparison,
  verifyExecutionReliabilitySummary,
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
  maxFileBytes: 1024 * 1024,
  maxObservationBytes: 128 * 1024,
  maxReportBytes: 64 * 1024,
  maxStringBytes: 2048,
  maxSourceReferences: 8,
});

function runRecord(runId, outcome, latencyMs) {
  return {
    runId,
    projectId: "project-reliability",
    task: "Synthetic routing execution",
    riskClass: "R0",
    runtimeId: "opencode",
    modelRoute: ["openai-balanced"],
    contextCompilerVersion: "v1",
    skills: [],
    toolsets: [],
    workspace: "C:/isolated/reliability",
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
    resourceMetrics: { "runtime.total_ms": latencyMs },
    traceId: `trace:${runId}`,
    outcome,
    failureReason: outcome === "failed" ? "synthetic failure" : undefined,
    createdAt: "2026-08-18T06:59:00.000Z",
  };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "9router-exec-rel-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const suite = await prepareGoldenTaskSuite({
    schemaVersion: 1,
    suiteId: "execution-reliability-suite",
    description: "Execution reliability fixture.",
    tasks: [{
      id: "route",
      kind: "routing",
      prompt: "Route this synthetic task with verification.",
      critical: true,
      minimumScore: 1,
      assertions: [
        { id: "model", kind: "primary_model_equals", weight: 1, expected: "model-a" },
        { id: "verify", kind: "requires_verification_equals", weight: 1, expected: true },
      ],
    }],
  }, suiteLimits);
  const plane = new RoutingEvalPlane({ maxReportBytes: 64 * 1024, maxSubjectIdBytes: 2048 });
  const report = await plane.evaluate(suite, {
    id: "router-execution-reliability",
    async route() {
      return {
        primaryModel: { candidate: { id: "model-a" } },
        selectedSkills: [],
        analysis: { requiresVerification: true },
      };
    },
  });
  const baseline = {
    schemaVersion: 1,
    baselineId: "execution-reliability-baseline",
    suiteId: suite.suiteId,
    suiteSha256: suite.suiteSha256,
    subjectId: "router-execution-reliability",
    minimumWeightedScore: 1,
    minimumTaskPassRate: 1,
    minimumCriticalPassRate: 1,
    maximumFailedTasks: 0,
  };
  const history = await JsonlEvalHistory.open(historyOptions(join(root, "history.jsonl")));
  const projector = new ExecutionMetricProjector({
    latencyMetricKey: "runtime.total_ms",
    requireLatency: true,
    maxMetricKeyBytes: 256,
  });
  return { report, baseline, history, projector };
}

async function appendProjected(history, report, baseline, projector, record, observedAt) {
  const projection = await projector.project(record);
  const measurement = await executionProjectionToEvalMeasurement(projection);
  const observation = await history.append({ observedAt, report, baseline, measurement });
  return { observation, projection };
}

test("execution reliability summary resolves canonical Run Ledger outcomes without treating cancellation as failure", async (t) => {
  const { report, baseline, history, projector } = await fixture(t);
  const records = [
    runRecord("run-success", "succeeded", 100),
    runRecord("run-failed", "failed", 200),
    runRecord("run-cancelled", "cancelled", 150),
  ];
  const first = await appendProjected(history, report, baseline, projector, records[0], "2026-08-18T07:10:00.000Z");
  const second = await appendProjected(history, report, baseline, projector, records[1], "2026-08-18T07:11:00.000Z");
  const third = await appendProjected(history, report, baseline, projector, records[2], "2026-08-18T07:12:00.000Z");

  const summary = await buildExecutionReliabilitySummary(
    [third.observation, first.observation, second.observation],
    [second.projection, third.projection, first.projection],
    records,
  );
  await verifyExecutionReliabilitySummary(summary);
  assert.equal(summary.payload.sampleCount, 3);
  assert.equal(summary.payload.succeeded, 1);
  assert.equal(summary.payload.failed, 1);
  assert.equal(summary.payload.cancelled, 1);
  assert.equal(summary.payload.decidedSampleCount, 2);
  assert.equal(summary.payload.successRateExcludingCancelled, 0.5);
  assert.equal(summary.payload.failureRateExcludingCancelled, 0.5);
  assert.equal(summary.payload.cancellationRate, 1 / 3);

  const repeat = await buildExecutionReliabilitySummary(
    [first.observation, second.observation, third.observation],
    [first.projection, second.projection, third.projection],
    [...records].reverse(),
  );
  assert.deepEqual(repeat, summary);
});

test("execution reliability comparison emits descriptive candidate-minus-reference deltas", async (t) => {
  const { report, baseline, history, projector } = await fixture(t);
  const failedRecord = runRecord("run-reference-failed", "failed", 200);
  const successRecord = runRecord("run-candidate-success", "succeeded", 120);
  const reference = await appendProjected(history, report, baseline, projector, failedRecord, "2026-08-18T08:00:00.000Z");
  const candidate = await appendProjected(history, report, baseline, projector, successRecord, "2026-08-18T08:01:00.000Z");
  const referenceSummary = await buildExecutionReliabilitySummary([reference.observation], [reference.projection], [failedRecord]);
  const candidateSummary = await buildExecutionReliabilitySummary([candidate.observation], [candidate.projection], [successRecord]);
  const comparison = await compareExecutionReliabilitySummaries(referenceSummary, candidateSummary);
  await verifyExecutionReliabilityComparison(comparison);
  assert.equal(comparison.payload.deltas.successRateExcludingCancelled, 1);
  assert.equal(comparison.payload.deltas.failureRateExcludingCancelled, -1);
  assert.equal(comparison.payload.deltas.cancellationRate, 0);
});

test("execution reliability summary rejects projection/history/ledger identity drift", async (t) => {
  const { report, baseline, history, projector } = await fixture(t);
  const record = runRecord("run-drift", "succeeded", 100);
  const { observation, projection } = await appendProjected(history, report, baseline, projector, record, "2026-08-18T09:00:00.000Z");

  await assert.rejects(
    () => buildExecutionReliabilitySummary([observation], [projection], [{ ...record, traceId: "trace:other" }]),
    /does not match canonical Run Ledger identity\/outcome/,
  );
  const foreignMeasurement = {
    ...observation.payload.measurement,
    sourceReferences: observation.payload.measurement.sourceReferences.filter((item) => !item.startsWith("execution-metric:")),
  };
  const foreignObservation = { ...observation, payload: { ...observation.payload, measurement: foreignMeasurement } };
  await assert.rejects(
    () => buildExecutionReliabilitySummary([foreignObservation], [projection], [record]),
    /digest does not match canonical payload|must reference exactly one execution metric projection/,
  );
});
