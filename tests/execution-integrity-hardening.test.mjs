import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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

function fixture(id) {
  const root = mkdtempSync(join(tmpdir(), "9router-integrity-hardening-"));
  const workflowStore = new JsonlWorkflowCheckpointStore({ filePath: join(root, "workflow.jsonl"), maxFileBytes: 1_000_000, maxCheckpointBytes: 32_000 });
  const bindingStore = new JsonlRuntimeBindingStore({ filePath: join(root, "binding.jsonl"), maxFileBytes: 1_000_000, maxBindingBytes: 32_000 });
  const journal = new JsonlExecutionIntegrityJournal({ filePath: join(root, "integrity.jsonl"), maxFileBytes: 1_000_000, maxEntryBytes: 64_000 });
  const runLedger = new InMemoryRunLedger();
  const machine = new WorkflowStateMachine();
  let run = machine.create({ id, projectId: "project-1", riskClass: "R2", now: "2026-08-18T00:00:00.000Z" });
  workflowStore.checkpoint(run);
  run = machine.start(run, "2026-08-18T00:00:01.000Z"); workflowStore.checkpoint(run);
  run = machine.advance(run, "2026-08-18T00:00:02.000Z"); workflowStore.checkpoint(run);
  run = machine.advance(run, "2026-08-18T00:00:03.000Z"); workflowStore.checkpoint(run);
  const executeRun = run;
  const binding = { workflowRunId: id, projectId: "project-1", workflowAttempt: 1, runtimeId: "runtime-a", sessionId: `session-${id}`, workspace: "C:/tmp/integrity", boundAt: "2026-08-18T00:00:03.100Z" };
  bindingStore.bind(binding);
  run = machine.advance(run, "2026-08-18T00:00:05.000Z"); workflowStore.checkpoint(run);
  run = machine.advance(run, "2026-08-18T00:00:06.000Z"); workflowStore.checkpoint(run);
  run = machine.requestApproval(run, "2026-08-18T00:00:07.000Z"); workflowStore.checkpoint(run);
  run = machine.approve(run, "approval-1", "2026-08-18T00:00:08.000Z"); workflowStore.checkpoint(run);
  run = machine.succeed(run, true, "2026-08-18T00:00:09.000Z"); workflowStore.checkpoint(run);
  const terminal = run;
  const verification = {
    workflowRunId: id,
    runtimeId: "runtime-a",
    sessionId: binding.sessionId,
    verifierId: "deterministic-node",
    passed: true,
    evidence: [
      { kind: "other", status: "passed", reference: `runtime:runtime-a:${binding.sessionId}`, producer: "runtime-reconciliation:runtime-a", collectedAt: "2026-08-18T00:00:04.000Z" },
      { kind: "deterministic_check", status: "passed", reference: "command:pass", producer: "deterministic-node", collectedAt: "2026-08-18T00:00:04.100Z" },
    ],
  };
  new RuntimeRunLedgerFinalizer().appendTerminal({
    run: terminal,
    binding,
    ledger: runLedger,
    task: "integrity crash window",
    modelRoute: ["9router/hemat"],
    contextCompilerVersion: "v1",
    skills: ["code.interactive"],
    toolsets: ["read", "edit"],
    policyDecisions: ["R2"],
    changeReferences: ["git:src/example.ts"],
    evidence: [
      { kind: "policy", status: "passed", reference: "policy:R2", producer: "policy", collectedAt: "2026-08-18T00:00:08.500Z" },
      { kind: "test", status: "passed", reference: "test:R2", producer: "test", collectedAt: "2026-08-18T00:00:08.500Z" },
      { kind: "review", status: "passed", reference: "review:R2", producer: "review", collectedAt: "2026-08-18T00:00:08.500Z" },
    ],
    verification,
    resourceMetrics: {},
    traceId: `trace-${id}`,
  });
  const coordinator = new ExecutionIntegrityCoordinator({ workflowStore, bindingStore, runLedger, journal, now: () => "2026-08-18T00:00:10.000Z" });
  return { root, executeRun, terminal, binding, verification, coordinator };
}

test("ledger present with no integrity history requests runtime binding milestone first", () => {
  const state = fixture("run-ledger-no-journal");
  try {
    const report = state.coordinator.inspect(state.terminal.id);
    assert.equal(report.disposition, "record_runtime_binding_milestone");
    assert.equal(report.automaticMutationAllowed, false);
  } finally {
    rmSync(state.root, { recursive: true, force: true });
  }
});

test("ledger present after runtime milestone but without durable verification fails closed", () => {
  const state = fixture("run-ledger-no-verification-journal");
  try {
    state.coordinator.recordRuntimeBound(state.executeRun, state.binding);
    const report = state.coordinator.inspect(state.terminal.id);
    assert.equal(report.disposition, "manual_intervention");
    assert.match(report.reason, /verification/i);
  } finally {
    rmSync(state.root, { recursive: true, force: true });
  }
});
