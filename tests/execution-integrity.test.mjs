import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ExecutionIntegrityCoordinator,
  InMemoryRunLedger,
  JsonlExecutionIntegrityJournal,
  JsonlRuntimeBindingStore,
  JsonlWorkflowCheckpointStore,
  RuntimeRunLedgerFinalizer,
  WorkflowStateMachine,
} from "../dist/index.js";

function tempRoot() {
  return mkdtempSync(join(tmpdir(), "9router-execution-integrity-"));
}

function stores(root) {
  const workflowStore = new JsonlWorkflowCheckpointStore({
    filePath: join(root, "workflow.jsonl"),
    maxFileBytes: 1024 * 1024,
    maxCheckpointBytes: 32 * 1024,
  });
  const bindingStore = new JsonlRuntimeBindingStore({
    filePath: join(root, "binding.jsonl"),
    maxFileBytes: 1024 * 1024,
    maxBindingBytes: 32 * 1024,
  });
  const journal = new JsonlExecutionIntegrityJournal({
    filePath: join(root, "integrity.jsonl"),
    maxFileBytes: 1024 * 1024,
    maxEntryBytes: 64 * 1024,
  });
  const runLedger = new InMemoryRunLedger();
  return { workflowStore, bindingStore, journal, runLedger };
}

function executeFixture(root, id = "run-integrity") {
  const state = stores(root);
  const machine = new WorkflowStateMachine();
  let run = machine.create({
    id,
    projectId: "project-1",
    riskClass: "R2",
    now: "2026-08-18T00:00:00.000Z",
  });
  state.workflowStore.checkpoint(run);
  run = machine.start(run, "2026-08-18T00:00:01.000Z");
  state.workflowStore.checkpoint(run);
  run = machine.advance(run, "2026-08-18T00:00:02.000Z");
  state.workflowStore.checkpoint(run);
  run = machine.advance(run, "2026-08-18T00:00:03.000Z");
  state.workflowStore.checkpoint(run);
  assert.equal(run.phase, "execute");

  const binding = Object.freeze({
    workflowRunId: run.id,
    projectId: run.projectId,
    workflowAttempt: run.attempt,
    runtimeId: "runtime-a",
    sessionId: `session-${id}`,
    workspace: "C:/tmp/isolated-worktree",
    boundAt: "2026-08-18T00:00:03.100Z",
  });
  state.bindingStore.bind(binding);
  const coordinator = new ExecutionIntegrityCoordinator({
    ...state,
    now: (() => {
      let tick = 200;
      return () => `2026-08-18T00:00:03.${String(tick++).padStart(3, "0")}Z`;
    })(),
  });
  return { ...state, machine, run, binding, coordinator };
}

function verificationFor(binding, passed = true) {
  return Object.freeze({
    workflowRunId: binding.workflowRunId,
    runtimeId: binding.runtimeId,
    sessionId: binding.sessionId,
    verifierId: "deterministic-node",
    passed,
    evidence: Object.freeze([
      Object.freeze({
        kind: "other",
        status: "passed",
        reference: `runtime:${binding.runtimeId}:${binding.sessionId}`,
        producer: `runtime-reconciliation:${binding.runtimeId}`,
        collectedAt: "2026-08-18T00:00:04.000Z",
        metadata: Object.freeze({ runtimeStatus: "completed", filesChangedCount: 1 }),
      }),
      Object.freeze({
        kind: "deterministic_check",
        status: passed ? "passed" : "failed",
        reference: passed ? "command:verify-pass" : "command:verify-fail",
        producer: "deterministic-node",
        collectedAt: "2026-08-18T00:00:04.100Z",
        metadata: Object.freeze({ checks: 3 }),
      }),
    ]),
  });
}

function succeedAndCheckpoint(fixture) {
  let run = fixture.machine.advance(fixture.run, "2026-08-18T00:00:05.000Z");
  fixture.workflowStore.checkpoint(run);
  run = fixture.machine.advance(run, "2026-08-18T00:00:06.000Z");
  fixture.workflowStore.checkpoint(run);
  run = fixture.machine.requestApproval(run, "2026-08-18T00:00:07.000Z");
  fixture.workflowStore.checkpoint(run);
  run = fixture.machine.approve(run, "approval-integrity", "2026-08-18T00:00:08.000Z");
  fixture.workflowStore.checkpoint(run);
  run = fixture.machine.succeed(run, true, "2026-08-18T00:00:09.000Z");
  fixture.workflowStore.checkpoint(run);
  return run;
}

function requiredR2Evidence() {
  return [
    {
      kind: "policy",
      status: "passed",
      reference: "policy:execution-integrity",
      producer: "policy-test",
      collectedAt: "2026-08-18T00:00:08.500Z",
    },
    {
      kind: "test",
      status: "passed",
      reference: "test:execution-integrity",
      producer: "node-test",
      collectedAt: "2026-08-18T00:00:08.500Z",
    },
    {
      kind: "review",
      status: "passed",
      reference: "review:execution-integrity",
      producer: "reviewer",
      collectedAt: "2026-08-18T00:00:08.500Z",
    },
  ];
}

test("durable integrity journal reloads runtime binding and full deterministic verification evidence", () => {
  const root = tempRoot();
  try {
    const { journal, run, binding, coordinator } = executeFixture(root, "run-reload");
    coordinator.recordRuntimeBound(run, binding);
    coordinator.recordVerification(run, binding, verificationFor(binding));

    const reopened = new JsonlExecutionIntegrityJournal({
      filePath: journal.filePath,
      maxFileBytes: 1024 * 1024,
      maxEntryBytes: 64 * 1024,
    });
    const history = reopened.history(run.id);
    assert.deepEqual(history.map((entry) => entry.stage), ["runtime_bound", "verification_recorded"]);
    assert.equal(history[1].verification.passed, true);
    assert.equal(history[1].verification.evidence[1].producer, "deterministic-node");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("integrity journal rejects partial writes on restart", () => {
  const root = tempRoot();
  try {
    const fixture = executeFixture(root, "run-partial");
    fixture.coordinator.recordRuntimeBound(fixture.run, fixture.binding);
    appendFileSync(fixture.journal.filePath, '{"schemaVersion":1', "utf8");
    assert.throws(
      () => new JsonlExecutionIntegrityJournal({
        filePath: fixture.journal.filePath,
        maxFileBytes: 1024 * 1024,
        maxEntryBytes: 64 * 1024,
      }),
      /not newline-terminated/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("binding without journal milestone is detected before runtime reconciliation", () => {
  const root = tempRoot();
  try {
    const fixture = executeFixture(root, "run-binding-gap");
    const report = fixture.coordinator.inspect(fixture.run.id);
    assert.equal(report.disposition, "record_runtime_binding_milestone");
    assert.equal(report.automaticMutationAllowed, false);

    fixture.coordinator.recordRuntimeBound(fixture.run, fixture.binding);
    const after = fixture.coordinator.inspect(fixture.run.id);
    assert.equal(after.disposition, "reconcile_runtime");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("durable verification survives restart and becomes explicit continuation evidence", () => {
  const root = tempRoot();
  try {
    const fixture = executeFixture(root, "run-verification-recovery");
    fixture.coordinator.recordRuntimeBound(fixture.run, fixture.binding);
    fixture.coordinator.recordVerification(fixture.run, fixture.binding, verificationFor(fixture.binding));

    const reopenedJournal = new JsonlExecutionIntegrityJournal({
      filePath: fixture.journal.filePath,
      maxFileBytes: 1024 * 1024,
      maxEntryBytes: 64 * 1024,
    });
    const coordinator = new ExecutionIntegrityCoordinator({
      workflowStore: fixture.workflowStore,
      bindingStore: fixture.bindingStore,
      runLedger: fixture.runLedger,
      journal: reopenedJournal,
    });
    const report = coordinator.inspect(fixture.run.id);
    assert.equal(report.disposition, "verification_available");
    assert.equal(report.automaticMutationAllowed, false);
    assert.equal(coordinator.recoverVerification(fixture.run.id).passed, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed durable verification remains fail-closed", () => {
  const root = tempRoot();
  try {
    const fixture = executeFixture(root, "run-verification-failed");
    fixture.coordinator.recordRuntimeBound(fixture.run, fixture.binding);
    fixture.coordinator.recordVerification(fixture.run, fixture.binding, verificationFor(fixture.binding, false));
    const report = fixture.coordinator.inspect(fixture.run.id);
    assert.equal(report.disposition, "verification_failed");
    assert.equal(report.automaticMutationAllowed, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("successful terminal checkpoint with durable verification exposes missing ledger as explicit finalization work", () => {
  const root = tempRoot();
  try {
    const fixture = executeFixture(root, "run-terminal-gap");
    fixture.coordinator.recordRuntimeBound(fixture.run, fixture.binding);
    fixture.coordinator.recordVerification(fixture.run, fixture.binding, verificationFor(fixture.binding));
    const terminal = succeedAndCheckpoint(fixture);

    let report = fixture.coordinator.inspect(terminal.id);
    assert.equal(report.disposition, "record_terminal_milestone");
    fixture.coordinator.recordWorkflowTerminal(terminal);
    report = fixture.coordinator.inspect(terminal.id);
    assert.equal(report.disposition, "finalize_run_ledger");
    assert.equal(report.verification.passed, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ledger append followed by missing integrity marker is distinguishable and repairable without provider mutation", () => {
  const root = tempRoot();
  try {
    const fixture = executeFixture(root, "run-ledger-marker-gap");
    fixture.coordinator.recordRuntimeBound(fixture.run, fixture.binding);
    fixture.coordinator.recordVerification(fixture.run, fixture.binding, verificationFor(fixture.binding));
    const terminal = succeedAndCheckpoint(fixture);
    fixture.coordinator.recordWorkflowTerminal(terminal);
    const verification = fixture.coordinator.recoverVerification(terminal.id);

    new RuntimeRunLedgerFinalizer().appendTerminal({
      run: terminal,
      binding: fixture.binding,
      ledger: fixture.runLedger,
      task: "execution integrity test",
      modelRoute: ["9router/hemat"],
      contextCompilerVersion: "v1",
      skills: ["code.interactive"],
      toolsets: ["read", "edit"],
      policyDecisions: ["R2 isolated worktree"],
      changeReferences: ["git:src/example.ts"],
      evidence: requiredR2Evidence(),
      verification,
      resourceMetrics: { runtimeMs: 100 },
      traceId: "trace-integrity-final",
    });

    let report = fixture.coordinator.inspect(terminal.id);
    assert.equal(report.disposition, "record_ledger_finalized_milestone");
    fixture.coordinator.recordLedgerFinalized(terminal);
    report = fixture.coordinator.inspect(terminal.id);
    assert.equal(report.disposition, "consistent_terminal");
    assert.equal(report.ledgerRecord.traceId, "trace-integrity-final");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("successful terminal integrity cannot be recorded without durable verification", () => {
  const root = tempRoot();
  try {
    const fixture = executeFixture(root, "run-success-without-verification");
    fixture.coordinator.recordRuntimeBound(fixture.run, fixture.binding);
    const terminal = succeedAndCheckpoint(fixture);
    assert.throws(
      () => fixture.coordinator.recordWorkflowTerminal(terminal),
      /requires durable deterministic verification/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("journal progression rejects ledger finalization before terminal milestone", () => {
  const root = tempRoot();
  try {
    const fixture = executeFixture(root, "run-stage-order");
    fixture.coordinator.recordRuntimeBound(fixture.run, fixture.binding);
    assert.throws(
      () => fixture.journal.append({
        runId: fixture.run.id,
        projectId: fixture.run.projectId,
        attempt: fixture.run.attempt,
        stage: "ledger_finalized",
        recordedAt: "2026-08-18T00:00:04.000Z",
        ledgerOutcome: "failed",
        traceId: "trace-too-early",
      }),
      /requires workflow_terminal/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("orphaned durable binding without workflow is manual intervention", () => {
  const root = tempRoot();
  try {
    const state = stores(root);
    state.bindingStore.bind({
      workflowRunId: "run-orphan",
      projectId: "project-1",
      workflowAttempt: 1,
      runtimeId: "runtime-a",
      sessionId: "session-orphan",
      workspace: "C:/tmp/orphan",
      boundAt: "2026-08-18T00:00:01.000Z",
    });
    const coordinator = new ExecutionIntegrityCoordinator(state);
    const report = coordinator.inspect("run-orphan");
    assert.equal(report.disposition, "manual_intervention");
    assert.equal(report.automaticMutationAllowed, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
