import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DurableWorkflowStateMachine,
  JsonlWorkflowCheckpointStore,
  WORKFLOW_CHECKPOINT_SCHEMA_VERSION,
  planWorkflowRecovery,
} from "../dist/control-plane/index.js";

const MAX_FILE_BYTES = 128 * 1024;
const MAX_CHECKPOINT_BYTES = 16 * 1024;
const T0 = "2026-08-18T00:00:00.000Z";
const T1 = "2026-08-18T00:00:01.000Z";
const T2 = "2026-08-18T00:00:02.000Z";
const T3 = "2026-08-18T00:00:03.000Z";
const T4 = "2026-08-18T00:00:04.000Z";
const T5 = "2026-08-18T00:00:05.000Z";
const T6 = "2026-08-18T00:00:06.000Z";
const T7 = "2026-08-18T00:00:07.000Z";

function openStore(filePath, overrides = {}) {
  return new JsonlWorkflowCheckpointStore({
    filePath,
    maxFileBytes: MAX_FILE_BYTES,
    maxCheckpointBytes: MAX_CHECKPOINT_BYTES,
    ...overrides,
  });
}

async function withTempStore(t) {
  const dir = await mkdtemp(join(tmpdir(), "9router-workflow-store-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return join(dir, "workflows.jsonl");
}

function queuedRun(id = "wf-1", overrides = {}) {
  return {
    id,
    projectId: "project-1",
    riskClass: "R2",
    phase: "start",
    status: "queued",
    attempt: 0,
    approvalIds: [],
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

async function moveToReview(machine, run) {
  run = machine.start(run, T1);
  run = machine.advance(run, T2);
  run = machine.advance(run, T3);
  run = machine.advance(run, T4);
  run = machine.advance(run, T5);
  return run;
}

test("DurableWorkflowStateMachine checkpoints transitions and reloads current state after restart", async (t) => {
  const filePath = await withTempStore(t);
  const store = openStore(filePath);
  const machine = new DurableWorkflowStateMachine(store);

  let run = machine.create({ id: "wf-1", projectId: "project-1", riskClass: "R2", now: T0 });
  run = machine.start(run, T1);
  run = machine.advance(run, T2);

  assert.equal(run.status, "running");
  assert.equal(run.phase, "compile_context");
  assert.equal(store.history("wf-1").length, 3);

  const raw = await readFile(filePath, "utf8");
  const lines = raw.trimEnd().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((entry) => entry.sequence), [1, 2, 3]);
  assert.ok(lines.every((entry) => entry.schemaVersion === WORKFLOW_CHECKPOINT_SCHEMA_VERSION));

  const reloaded = openStore(filePath);
  assert.equal(reloaded.get("wf-1")?.phase, "compile_context");
  assert.equal(reloaded.get("wf-1")?.attempt, 1);
  assert.equal(reloaded.history("wf-1").length, 3);
  assert.ok(Object.isFrozen(reloaded.get("wf-1")));
  assert.ok(Object.isFrozen(reloaded.get("wf-1")?.approvalIds));
});

test("waiting approval survives restart and approval IDs remain durable append-only state", async (t) => {
  const filePath = await withTempStore(t);
  let store = openStore(filePath);
  let machine = new DurableWorkflowStateMachine(store);

  let run = machine.create({ id: "wf-approval", projectId: "project-1", riskClass: "R3", now: T0 });
  run = await moveToReview(machine, run);
  run = machine.requestApproval(run, T6);

  store = openStore(filePath);
  const waiting = store.get("wf-approval");
  assert.equal(waiting?.status, "waiting_approval");
  assert.equal(waiting?.phase, "approval");
  const decision = planWorkflowRecovery(waiting);
  assert.equal(decision.disposition, "await_approval");
  assert.equal(decision.automaticResumeAllowed, false);

  machine = new DurableWorkflowStateMachine(store);
  run = machine.approve(waiting, "approval-1", T7);
  assert.equal(run.phase, "publish");
  assert.deepEqual(run.approvalIds, ["approval-1"]);

  const afterRestart = openStore(filePath).get("wf-approval");
  assert.deepEqual(afterRestart?.approvalIds, ["approval-1"]);
  assert.equal(afterRestart?.phase, "publish");
});

test("restart recovery never silently resumes active or retrying work", async (t) => {
  const filePath = await withTempStore(t);
  const store = openStore(filePath);
  const machine = new DurableWorkflowStateMachine(store);

  let active = machine.create({ id: "wf-active", projectId: "project-1", riskClass: "R2", now: T0 });
  active = machine.start(active, T1);
  const activeDecision = planWorkflowRecovery(openStore(filePath).get("wf-active"));
  assert.equal(activeDecision.disposition, "reconcile_runtime");
  assert.equal(activeDecision.automaticResumeAllowed, false);
  assert.equal(activeDecision.runtimeReconciliationRequired, true);

  let failed = machine.create({ id: "wf-retry", projectId: "project-1", riskClass: "R2", now: T2 });
  failed = machine.start(failed, T3);
  failed = machine.fail(failed, "provider disconnected", T4);
  const failedDecision = planWorkflowRecovery(failed);
  assert.equal(failedDecision.disposition, "explicit_retry");
  assert.equal(failedDecision.automaticResumeAllowed, false);

  const retrying = machine.retry(failed, T5);
  const retryDecision = planWorkflowRecovery(openStore(filePath).get("wf-retry"));
  assert.equal(retrying.status, "retrying");
  assert.equal(retryDecision.disposition, "reconcile_retry");
  assert.equal(retryDecision.runtimeReconciliationRequired, true);
});

test("only a never-started queued run is classified safe to start automatically", () => {
  const decision = planWorkflowRecovery(queuedRun("wf-queued"));
  assert.equal(decision.disposition, "safe_to_start");
  assert.equal(decision.automaticResumeAllowed, true);
  assert.equal(decision.runtimeReconciliationRequired, false);
});

test("terminal workflow remains terminal and cannot accept later checkpoints", async (t) => {
  const filePath = await withTempStore(t);
  const store = openStore(filePath);
  const machine = new DurableWorkflowStateMachine(store);

  let run = machine.create({ id: "wf-cancelled", projectId: "project-1", riskClass: "R1", now: T0 });
  run = machine.cancel(run, T1);
  assert.equal(planWorkflowRecovery(run).disposition, "terminal");
  assert.throws(
    () => store.checkpoint({ ...run, updatedAt: T2 }),
    /terminal and cannot accept another checkpoint/,
  );
});

test("workflow checkpoint reload fails closed on truncated, unsupported, and sequence-gapped data", async (t) => {
  const filePath = await withTempStore(t);
  const run = queuedRun("wf-corrupt");

  await writeFile(
    filePath,
    JSON.stringify({ schemaVersion: WORKFLOW_CHECKPOINT_SCHEMA_VERSION, sequence: 1, run }),
    "utf8",
  );
  assert.throws(() => openStore(filePath), /not newline-terminated; possible partial write/);

  await writeFile(filePath, `${JSON.stringify({ schemaVersion: 99, sequence: 1, run })}\n`, "utf8");
  assert.throws(() => openStore(filePath), /Unsupported workflow checkpoint schema version/);

  await writeFile(
    filePath,
    `${JSON.stringify({ schemaVersion: WORKFLOW_CHECKPOINT_SCHEMA_VERSION, sequence: 2, run })}\n`,
    "utf8",
  );
  assert.throws(() => openStore(filePath), /sequence mismatch at line 1: expected=1 actual=2/);
});

test("workflow checkpoint store enforces immutable identity and monotonic approval history", async (t) => {
  const filePath = await withTempStore(t);
  const store = openStore(filePath);
  store.checkpoint(queuedRun("wf-identity"));

  assert.throws(
    () => store.checkpoint(queuedRun("wf-identity", { projectId: "other-project", updatedAt: T1 })),
    /projectId is immutable/,
  );

  const running = {
    ...queuedRun("wf-approval-history"),
    phase: "publish",
    status: "running",
    attempt: 1,
    approvalIds: ["approval-1"],
    updatedAt: T1,
  };
  store.checkpoint(running);
  assert.throws(
    () => store.checkpoint({ ...running, approvalIds: [], updatedAt: T2 }),
    /approvalIds are append-only/,
  );
});

test("workflow checkpoint store detects stale second writers before append", async (t) => {
  const filePath = await withTempStore(t);
  const writerA = openStore(filePath);
  const writerB = openStore(filePath);

  writerA.checkpoint(queuedRun("wf-a"));
  assert.throws(
    () => writerB.checkpoint(queuedRun("wf-b")),
    /changed outside this writer; reopen before checkpointing/,
  );

  assert.deepEqual(openStore(filePath).list().map((run) => run.id), ["wf-a"]);
});

test("workflow checkpoint byte bounds reject oversized checkpoints and full files without partial writes", async (t) => {
  const filePath = await withTempStore(t);
  const tiny = new JsonlWorkflowCheckpointStore({
    filePath,
    maxFileBytes: 4 * 1024,
    maxCheckpointBytes: 96,
  });
  assert.throws(
    () => tiny.checkpoint(queuedRun("wf-too-large")),
    /exceeds maxCheckpointBytes/,
  );
  assert.equal(existsSync(filePath), false);

  const normal = openStore(filePath);
  normal.checkpoint(queuedRun("wf-one"));
  const before = await readFile(filePath, "utf8");
  const exactBytes = new TextEncoder().encode(before).byteLength;
  const capped = new JsonlWorkflowCheckpointStore({
    filePath,
    maxFileBytes: exactBytes,
    maxCheckpointBytes: exactBytes,
  });
  assert.throws(() => capped.checkpoint(queuedRun("wf-two", { createdAt: T1, updatedAt: T1 })), /would exceed maxFileBytes/);
  assert.equal(await readFile(filePath, "utf8"), before);
});

test("workflow checkpoint store requires explicit valid byte bounds", async (t) => {
  const filePath = await withTempStore(t);
  assert.throws(
    () => new JsonlWorkflowCheckpointStore({ filePath, maxFileBytes: 0, maxCheckpointBytes: 1 }),
    /maxFileBytes must be a positive integer/,
  );
  assert.throws(
    () => new JsonlWorkflowCheckpointStore({ filePath, maxFileBytes: 100, maxCheckpointBytes: 101 }),
    /maxCheckpointBytes must not exceed maxFileBytes/,
  );
});
