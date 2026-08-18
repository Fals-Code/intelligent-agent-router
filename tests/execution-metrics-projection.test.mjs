import test from "node:test";
import assert from "node:assert/strict";
import {
  ExecutionMetricProjector,
  InternalObservabilityEventBuilder,
  executionProjectionToEvalMeasurement,
  verifyExecutionMetricProjection,
} from "../dist/index.js";

function record({
  runId = "run-metrics-1",
  traceId = "trace-metrics-1",
  outcome = "succeeded",
  latencyMs = 420,
  costUsd = 0.12,
} = {}) {
  return {
    runId,
    projectId: "project-metrics",
    task: "Synthetic bounded task",
    riskClass: "R0",
    runtimeId: "opencode",
    modelRoute: ["openai-balanced"],
    contextCompilerVersion: "v1",
    skills: [],
    toolsets: [],
    workspace: "C:/isolated/worktree",
    policyDecisions: ["policy:allow"],
    approvalIds: [],
    changeReferences: [],
    evidence: [{
      kind: "policy",
      status: "passed",
      reference: `policy:${runId}`,
      producer: "policy-engine",
      collectedAt: "2026-08-18T06:00:00.000Z",
    }],
    resourceMetrics: {
      "runtime.total_ms": latencyMs,
      "billing.usd": costUsd,
    },
    traceId,
    outcome,
    createdAt: "2026-08-18T05:59:00.000Z",
  };
}

async function terminalEventFor(recordValue) {
  const builder = new InternalObservabilityEventBuilder({
    maxEventBytes: 64 * 1024,
    maxAttributes: 32,
    maxLinks: 8,
    maxStringBytes: 2048,
  });
  return builder.create({
    name: "9router.run.terminal",
    occurredAt: "2026-08-18T06:01:00.000Z",
    traceId: recordValue.traceId,
    runId: recordValue.runId,
    projectId: recordValue.projectId,
    attributes: {
      "router.run.outcome": recordValue.outcome,
      "router.risk.class": recordValue.riskClass,
      "router.runtime.id": recordValue.runtimeId,
      "router.run.evidence_count": recordValue.evidence.length,
      "router.run.approval_count": recordValue.approvalIds.length,
      "router.run.change_reference_count": recordValue.changeReferences.length,
    },
    links: [],
  });
}

test("execution metric projector maps explicit Run Ledger metric keys and verified terminal observability evidence", async () => {
  const ledgerRecord = record();
  const terminalEvent = await terminalEventFor(ledgerRecord);
  const projector = new ExecutionMetricProjector({
    latencyMetricKey: "runtime.total_ms",
    costMetricKey: "billing.usd",
    requireLatency: true,
    requireCost: true,
    requireTerminalObservabilityEvent: true,
    maxMetricKeyBytes: 256,
  });

  const projection = await projector.project(ledgerRecord, terminalEvent);
  await verifyExecutionMetricProjection(projection);
  assert.equal(projection.payload.latencyMs, 420);
  assert.equal(projection.payload.costUsd, 0.12);
  assert.equal(projection.payload.outcome, "succeeded");
  assert.deepEqual(projection.payload.metricKeys, { latency: "runtime.total_ms", cost: "billing.usd" });
  assert.ok(projection.payload.sourceReferences.includes(`run-ledger:${ledgerRecord.runId}`));
  assert.ok(projection.payload.sourceReferences.includes(`observability:${terminalEvent.eventId}`));

  const measurement = await executionProjectionToEvalMeasurement(projection);
  assert.equal(measurement.latencyMs, 420);
  assert.equal(measurement.costUsd, 0.12);
  assert.ok(measurement.sourceReferences.includes(`execution-metric:${projection.projectionId}`));
  assert.doesNotMatch(JSON.stringify(projection), /Synthetic bounded task|isolated\/worktree/);
});

test("execution metric projector fails closed on missing required metrics, negative values, and terminal identity drift", async () => {
  const projector = new ExecutionMetricProjector({
    latencyMetricKey: "runtime.total_ms",
    costMetricKey: "billing.usd",
    requireLatency: true,
    requireCost: true,
    requireTerminalObservabilityEvent: true,
    maxMetricKeyBytes: 256,
  });
  const ledgerRecord = record();
  await assert.rejects(() => projector.project(ledgerRecord), /requires terminal observability evidence/);

  const missingCost = { ...ledgerRecord, resourceMetrics: { "runtime.total_ms": 420 } };
  await assert.rejects(() => projector.project(missingCost, terminalEventFor(missingCost)), /missing required cost metric/);

  const negativeCost = record({ costUsd: -0.01 });
  await assert.rejects(() => projector.project(negativeCost, await terminalEventFor(negativeCost)), /must be finite and non-negative/);

  const mismatched = await terminalEventFor({ ...ledgerRecord, runId: "other-run" });
  await assert.rejects(() => projector.project(ledgerRecord, mismatched), /runId does not match/);
});

test("metric policy never guesses canonical cost or latency keys", async () => {
  assert.throws(() => new ExecutionMetricProjector({ requireLatency: true, maxMetricKeyBytes: 256 }), /needs latencyMetricKey/);
  const projector = new ExecutionMetricProjector({ maxMetricKeyBytes: 256 });
  await assert.rejects(() => projector.project(record()), /no configured execution metric sample/);
  assert.throws(() => new ExecutionMetricProjector({ latencyMetricKey: "authorization.token", maxMetricKeyBytes: 256 }), /sensitive/);
});
