import test from "node:test";
import assert from "node:assert/strict";
import {
  InMemoryAgentRuntimeAdapter,
  InMemoryRunLedger,
  RuntimeReconciliationCoordinator,
  RuntimeRunLedgerFinalizer,
  RuntimeSessionBindingCoordinator,
  RuntimeVerificationCoordinator,
  WorkflowStateMachine,
} from "../dist/index.js";

class MemoryBindingStore {
  constructor({ failBind = false } = {}) {
    this.failBind = failBind;
    this.latest = new Map();
    this.histories = new Map();
  }

  bind(binding) {
    if (this.failBind) throw new Error("binding persistence failed");
    const previous = this.latest.get(binding.workflowRunId);
    const history = this.histories.get(binding.workflowRunId) ?? [];
    if (previous && binding.workflowAttempt <= previous.workflowAttempt) {
      throw new Error("attempt must increase");
    }
    this.latest.set(binding.workflowRunId, binding);
    history.push(binding);
    this.histories.set(binding.workflowRunId, history);
  }

  get(workflowRunId) {
    return this.latest.get(workflowRunId);
  }

  history(workflowRunId) {
    return [...(this.histories.get(workflowRunId) ?? [])];
  }
}

class RecordingRuntime extends InMemoryAgentRuntimeAdapter {
  constructor(options = {}) {
    super(options);
    this.createRequests = [];
  }

  async createSession(request) {
    this.createRequests.push(request);
    return await super.createSession(request);
  }
}

function executeWorkflow(id = "run-1") {
  const machine = new WorkflowStateMachine();
  let run = machine.create({
    id,
    projectId: "project-1",
    riskClass: "R2",
    now: "2026-08-18T00:00:00.000Z",
  });
  run = machine.start(run, "2026-08-18T00:00:01.000Z");
  run = machine.advance(run, "2026-08-18T00:00:02.000Z");
  run = machine.advance(run, "2026-08-18T00:00:03.000Z");
  assert.equal(run.phase, "execute");
  return { machine, run };
}

function succeedWorkflow(machine, executeRun) {
  let run = machine.advance(executeRun, "2026-08-18T00:00:04.000Z");
  run = machine.advance(run, "2026-08-18T00:00:05.000Z");
  run = machine.requestApproval(run, "2026-08-18T00:00:06.000Z");
  run = machine.approve(run, "approval-1", "2026-08-18T00:00:07.000Z");
  run = machine.succeed(run, true, "2026-08-18T00:00:08.000Z");
  return run;
}

function requiredR2Evidence() {
  return [
    {
      kind: "policy",
      status: "passed",
      reference: "policy:runtime-boundary",
      producer: "policy-test",
      collectedAt: "2026-08-18T00:00:05.000Z",
    },
    {
      kind: "test",
      status: "passed",
      reference: "test:runtime-integration",
      producer: "node-test",
      collectedAt: "2026-08-18T00:00:05.000Z",
    },
    {
      kind: "review",
      status: "passed",
      reference: "review:runtime-integration",
      producer: "reviewer",
      collectedAt: "2026-08-18T00:00:05.000Z",
    },
  ];
}

async function createBoundFixture(id = "run-bound") {
  const { machine, run } = executeWorkflow(id);
  const store = new MemoryBindingStore();
  const adapter = new RecordingRuntime({
    runtimeId: "runtime-a",
    now: () => "2026-08-18T00:00:03.100Z",
    createSessionId: () => `session-${id}`,
    createEventId: () => `event-${id}`,
  });
  const coordinator = new RuntimeSessionBindingCoordinator({
    now: () => "2026-08-18T00:00:03.200Z",
  });
  const bound = await coordinator.createBoundSession({
    run,
    workspace: "C:/tmp/runtime-worktree",
    adapter,
    bindingStore: store,
    metadata: {
      purpose: "integration-test",
      "9router.workflowRunId": "spoofed",
      "9router.workflowAttempt": 99,
    },
  });
  return { machine, run, store, adapter, bound };
}

async function completedReport(run, binding) {
  const coordinator = new RuntimeReconciliationCoordinator();
  return await coordinator.reconcile(
    run,
    binding,
    {
      runtimeId: binding.runtimeId,
      async inspect() {
        return Object.freeze({
          runtimeId: binding.runtimeId,
          sessionId: binding.sessionId,
          status: "completed",
          observedAt: "2026-08-18T00:00:04.000Z",
          events: Object.freeze({
            count: 2,
            types: Object.freeze(["task_started", "task_completed"]),
            lastEventId: "event-complete",
            lastEventAt: "2026-08-18T00:00:04.000Z",
          }),
          diff: Object.freeze({
            filesChanged: Object.freeze(["src/example.ts"]),
            patchObserved: true,
          }),
        });
      },
    },
  );
}

test("runtime session creation writes canonical workflow metadata and durable binding", async () => {
  const { run, store, adapter, bound } = await createBoundFixture("run-metadata");

  assert.equal(adapter.createRequests.length, 1);
  assert.equal(adapter.createRequests[0].metadata["9router.workflowRunId"], run.id);
  assert.equal(adapter.createRequests[0].metadata["9router.workflowAttempt"], run.attempt);
  assert.equal(bound.binding.workflowRunId, run.id);
  assert.equal(bound.binding.workflowAttempt, 1);
  assert.equal(bound.binding.runtimeId, "runtime-a");
  assert.equal(bound.binding.sessionId, "session-run-metadata");
  assert.equal(bound.binding.boundAt, "2026-08-18T00:00:03.200Z");
  assert.deepEqual(store.get(run.id), bound.binding);
});

test("runtime session creation refuses non-execute workflow before provider side effects", async () => {
  const machine = new WorkflowStateMachine();
  let run = machine.create({
    id: "run-not-execute",
    projectId: "project-1",
    riskClass: "R2",
    now: "2026-08-18T00:00:00.000Z",
  });
  run = machine.start(run, "2026-08-18T00:00:01.000Z");
  const adapter = new RecordingRuntime({ createSessionId: () => "should-not-exist" });

  await assert.rejects(
    new RuntimeSessionBindingCoordinator().createBoundSession({
      run,
      workspace: "C:/tmp/worktree",
      adapter,
      bindingStore: new MemoryBindingStore(),
    }),
    /execute phase/,
  );
  assert.equal(adapter.createRequests.length, 0);
});

test("binding persistence failure compensates by aborting and destroying the new runtime session", async () => {
  const { run } = executeWorkflow("run-cleanup");
  const adapter = new RecordingRuntime({
    createSessionId: () => "session-cleanup",
    createEventId: () => "event-cleanup",
  });

  await assert.rejects(
    new RuntimeSessionBindingCoordinator().createBoundSession({
      run,
      workspace: "C:/tmp/worktree",
      adapter,
      bindingStore: new MemoryBindingStore({ failBind: true }),
    }),
    /binding persistence failed/,
  );
  assert.equal(await adapter.getStatus("session-cleanup"), "destroyed");
});

test("runtime identity mismatch also triggers compensating cleanup", async () => {
  const { run } = executeWorkflow("run-identity");
  class WrongProjectRuntime extends RecordingRuntime {
    async createSession(request) {
      const session = await super.createSession(request);
      return Object.freeze({ ...session, projectId: "wrong-project" });
    }
  }
  const adapter = new WrongProjectRuntime({
    createSessionId: () => "session-identity",
    createEventId: () => "event-identity",
  });

  await assert.rejects(
    new RuntimeSessionBindingCoordinator().createBoundSession({
      run,
      workspace: "C:/tmp/worktree",
      adapter,
      bindingStore: new MemoryBindingStore(),
    }),
    /projectId mismatch/,
  );
  assert.equal(await adapter.getStatus("session-identity"), "destroyed");
});

test("completed runtime reconciliation becomes sanitized deterministic verification evidence", async () => {
  const { run, bound } = await createBoundFixture("run-verify");
  const report = await completedReport(run, bound.binding);
  assert.equal(report.disposition, "verify_runtime_result");

  const verification = await new RuntimeVerificationCoordinator({
    now: () => "2026-08-18T00:00:04.500Z",
  }).verify(run, report, {
    id: "deterministic-node",
    async verify() {
      return {
        passed: true,
        reference: "command:verify-runtime-result",
        collectedAt: "2026-08-18T00:00:04.400Z",
        metadata: {
          checks: 3,
          authorization: "Bearer should-not-survive",
          note: "password: should-not-survive",
        },
      };
    },
  });

  assert.equal(verification.passed, true);
  assert.equal(verification.evidence.length, 2);
  const deterministic = verification.evidence.find((item) => item.kind === "deterministic_check");
  assert.equal(deterministic.status, "passed");
  assert.equal(deterministic.producer, "deterministic-node");
  assert.equal(deterministic.metadata.authorization, "[redacted]");
  assert.equal(deterministic.metadata.note, "password=[redacted]");
  assert.equal(JSON.stringify(verification.evidence).includes("should-not-survive"), false);
  assert.equal(JSON.stringify(verification.evidence).includes("patch content"), false);
});

test("verifier execution failure is fail-closed evidence with sanitized error", async () => {
  const { run, bound } = await createBoundFixture("run-verifier-error");
  const report = await completedReport(run, bound.binding);
  const verification = await new RuntimeVerificationCoordinator({
    now: () => "2026-08-18T00:00:04.500Z",
  }).verify(run, report, {
    id: "deterministic-node",
    async verify() {
      throw new Error("Authorization: Bearer secret-verifier-token");
    },
  });

  assert.equal(verification.passed, false);
  const deterministic = verification.evidence.find((item) => item.kind === "deterministic_check");
  assert.equal(deterministic.status, "failed");
  assert.equal(deterministic.collectedAt, "2026-08-18T00:00:04.500Z");
  assert.equal(JSON.stringify(deterministic).includes("secret-verifier-token"), false);
});

test("successful runtime-backed workflow is rejected without verifier-owned deterministic PASS", async () => {
  const { machine, run, bound } = await createBoundFixture("run-no-verification");
  const succeeded = succeedWorkflow(machine, run);
  const ledger = new InMemoryRunLedger();

  assert.throws(
    () =>
      new RuntimeRunLedgerFinalizer().appendTerminal({
        run: succeeded,
        binding: bound.binding,
        ledger,
        task: "test runtime integration",
        modelRoute: ["9router/hemat"],
        contextCompilerVersion: "v1",
        skills: ["code.interactive"],
        toolsets: ["read", "edit"],
        policyDecisions: ["R2 isolated worktree"],
        changeReferences: ["git:src/example.ts"],
        evidence: requiredR2Evidence(),
        resourceMetrics: { runtimeMs: 100 },
        traceId: "trace-no-verification",
      }),
    /requires deterministic runtime verification PASS/,
  );
  assert.equal(ledger.get(succeeded.id), undefined);
});

test("verified successful runtime-backed workflow appends one immutable Run Ledger record", async () => {
  const { machine, run, bound } = await createBoundFixture("run-ledger-success");
  const report = await completedReport(run, bound.binding);
  const verification = await new RuntimeVerificationCoordinator().verify(run, report, {
    id: "deterministic-node",
    async verify() {
      return {
        passed: true,
        reference: "command:verified-success",
        collectedAt: "2026-08-18T00:00:04.400Z",
        metadata: { checks: 3 },
      };
    },
  });
  const succeeded = succeedWorkflow(machine, run);
  const ledger = new InMemoryRunLedger();

  const record = new RuntimeRunLedgerFinalizer().appendTerminal({
    run: succeeded,
    binding: bound.binding,
    ledger,
    task: "test runtime integration",
    modelRoute: ["9router/hemat", "9router/smart"],
    contextCompilerVersion: "v1",
    skills: ["code.interactive"],
    toolsets: ["read", "edit"],
    policyDecisions: ["R2 isolated worktree"],
    changeReferences: ["git:src/example.ts"],
    evidence: requiredR2Evidence(),
    verification,
    resourceMetrics: { runtimeMs: 100, toolCalls: 4 },
    traceId: "trace-ledger-success",
  });

  assert.equal(record.outcome, "succeeded");
  assert.equal(record.runtimeId, bound.binding.runtimeId);
  assert.equal(record.workspace, bound.binding.workspace);
  assert.deepEqual(record.approvalIds, ["approval-1"]);
  assert.ok(record.evidence.some((item) => item.kind === "deterministic_check" && item.status === "passed"));
  assert.deepEqual(ledger.get(succeeded.id), record);
  assert.throws(() =>
    new RuntimeRunLedgerFinalizer().appendTerminal({
      run: succeeded,
      binding: bound.binding,
      ledger,
      task: "duplicate",
      modelRoute: ["9router/hemat"],
      contextCompilerVersion: "v1",
      skills: [],
      toolsets: [],
      policyDecisions: [],
      changeReferences: [],
      evidence: requiredR2Evidence(),
      verification,
      resourceMetrics: {},
      traceId: "trace-duplicate",
    }),
  );
});

test("failed runtime-backed workflow may be recorded without claiming successful verification", async () => {
  const { machine, run, bound } = await createBoundFixture("run-ledger-failed");
  const failed = machine.fail(run, "runtime execution failed", "2026-08-18T00:00:04.000Z");
  const ledger = new InMemoryRunLedger();

  const record = new RuntimeRunLedgerFinalizer().appendTerminal({
    run: failed,
    binding: bound.binding,
    ledger,
    task: "failed runtime task",
    modelRoute: ["9router/hemat"],
    contextCompilerVersion: "v1",
    skills: ["code.interactive"],
    toolsets: [],
    policyDecisions: [],
    changeReferences: [],
    evidence: [],
    resourceMetrics: { runtimeMs: 25 },
    traceId: "trace-ledger-failed",
  });

  assert.equal(record.outcome, "failed");
  assert.equal(record.failureReason, "runtime execution failed");
  assert.equal(record.evidence.some((item) => item.kind === "deterministic_check" && item.status === "passed"), false);
});
