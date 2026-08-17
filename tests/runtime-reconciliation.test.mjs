import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  JsonlRuntimeBindingStore,
  RuntimeReconciliationCoordinator,
  WorkflowStateMachine,
} from "../dist/index.js";

const MAX_FILE_BYTES = 64 * 1024;
const MAX_BINDING_BYTES = 8 * 1024;

async function withTempBindingFile(t) {
  const dir = await mkdtemp(join(tmpdir(), "9router-runtime-binding-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  return join(dir, "runtime-bindings.jsonl");
}

function binding(run, overrides = {}) {
  return {
    workflowRunId: run.id,
    projectId: run.projectId,
    workflowAttempt: run.attempt,
    runtimeId: "opencode",
    sessionId: `session-${run.attempt}`,
    workspace: "/tmp/project-1",
    boundAt: run.updatedAt,
    ...overrides,
  };
}

function observation(bindingValue, status, overrides = {}) {
  return {
    runtimeId: bindingValue.runtimeId,
    sessionId: bindingValue.sessionId,
    status,
    observedAt: "2026-08-18T01:00:10.000Z",
    events: { count: 2, types: ["task_started", "task_completed"], lastEventId: "event-2" },
    diff: { filesChanged: ["src/example.ts"], patchObserved: true },
    ...overrides,
  };
}

function runningWorkflow() {
  const machine = new WorkflowStateMachine();
  let run = machine.create({
    id: "run-1",
    projectId: "project-1",
    riskClass: "R2",
    now: "2026-08-18T01:00:00.000Z",
  });
  run = machine.start(run, "2026-08-18T01:00:01.000Z");
  run = machine.advance(run, "2026-08-18T01:00:02.000Z");
  run = machine.advance(run, "2026-08-18T01:00:03.000Z");
  assert.equal(run.phase, "execute");
  assert.equal(run.status, "running");
  return run;
}

test("JsonlRuntimeBindingStore persists one runtime binding per workflow attempt and reloads", async (t) => {
  const filePath = await withTempBindingFile(t);
  const run = runningWorkflow();
  const store = new JsonlRuntimeBindingStore({
    filePath,
    maxFileBytes: MAX_FILE_BYTES,
    maxBindingBytes: MAX_BINDING_BYTES,
  });
  store.bind(binding(run));

  const raw = await readFile(filePath, "utf8");
  assert.ok(raw.endsWith("\n"));
  assert.equal(JSON.parse(raw.trim()).schemaVersion, 1);

  const reloaded = new JsonlRuntimeBindingStore({
    filePath,
    maxFileBytes: MAX_FILE_BYTES,
    maxBindingBytes: MAX_BINDING_BYTES,
  });
  assert.deepEqual(reloaded.get(run.id), binding(run));
  assert.equal(reloaded.history(run.id).length, 1);
});

test("JsonlRuntimeBindingStore rejects duplicate binding for the same workflow attempt", async (t) => {
  const filePath = await withTempBindingFile(t);
  const run = runningWorkflow();
  const store = new JsonlRuntimeBindingStore({
    filePath,
    maxFileBytes: MAX_FILE_BYTES,
    maxBindingBytes: MAX_BINDING_BYTES,
  });
  store.bind(binding(run));
  const before = await readFile(filePath, "utf8");
  assert.throws(() => store.bind(binding(run, { sessionId: "replacement-session" })), /workflowAttempt must increase/);
  assert.equal(await readFile(filePath, "utf8"), before);
});

test("RuntimeReconciliationCoordinator never auto-redispatches an active runtime", async () => {
  const run = runningWorkflow();
  const bindingValue = binding(run);
  const coordinator = new RuntimeReconciliationCoordinator();
  const probe = {
    runtimeId: "opencode",
    async inspect(value) {
      assert.equal(value.sessionId, bindingValue.sessionId);
      return observation(bindingValue, "running");
    },
  };

  const report = await coordinator.reconcile(run, bindingValue, probe);
  assert.equal(report.disposition, "wait_runtime");
  assert.equal(report.automaticRedispatchAllowed, false);
  assert.equal(report.verificationRequired, false);
});

test("RuntimeReconciliationCoordinator treats completed provider state as evidence requiring verification", async () => {
  const run = runningWorkflow();
  const bindingValue = binding(run);
  const coordinator = new RuntimeReconciliationCoordinator();
  const probe = {
    runtimeId: "opencode",
    async inspect() {
      return observation(bindingValue, "completed");
    },
  };

  const report = await coordinator.reconcile(run, bindingValue, probe);
  assert.equal(report.disposition, "verify_runtime_result");
  assert.equal(report.automaticRedispatchAllowed, false);
  assert.equal(report.verificationRequired, true);
  assert.deepEqual(report.observation.diff.filesChanged, ["src/example.ts"]);
  assert.equal("patch" in report.observation.diff, false);
});

test("RuntimeReconciliationCoordinator preserves runtime approval and terminal failure boundaries", async () => {
  const run = runningWorkflow();
  const bindingValue = binding(run);
  const coordinator = new RuntimeReconciliationCoordinator();

  for (const [status, expected] of [
    ["waiting_approval", "await_runtime_approval"],
    ["interrupted", "explicit_resume_or_retry"],
    ["failed", "explicit_failure_or_retry"],
    ["aborted", "explicit_failure_or_retry"],
    ["destroyed", "explicit_failure_or_retry"],
    ["created", "manual_intervention"],
  ]) {
    const report = await coordinator.reconcile(run, bindingValue, {
      runtimeId: "opencode",
      async inspect() {
        return observation(bindingValue, status);
      },
    });
    assert.equal(report.disposition, expected, status);
    assert.equal(report.automaticRedispatchAllowed, false, status);
  }
});

test("RuntimeReconciliationCoordinator fails closed on missing binding, probe failure, and identity mismatch", async () => {
  const run = runningWorkflow();
  const bindingValue = binding(run);
  const coordinator = new RuntimeReconciliationCoordinator();

  const noBinding = await coordinator.reconcile(run, undefined, undefined);
  assert.equal(noBinding.disposition, "manual_intervention");

  const failedProbe = await coordinator.reconcile(run, bindingValue, {
    runtimeId: "opencode",
    async inspect() {
      throw new Error("Authorization: Bearer should-not-leak");
    },
  });
  assert.equal(failedProbe.disposition, "observation_failed");
  assert.equal(failedProbe.observationError.includes("should-not-leak"), false);
  assert.match(failedProbe.observationError, /Authorization=\[redacted\]/);

  await assert.rejects(
    coordinator.reconcile(run, bindingValue, {
      runtimeId: "opencode",
      async inspect() {
        return observation(bindingValue, "running", { sessionId: "wrong-session" });
      },
    }),
    /sessionId mismatch/,
  );
});
