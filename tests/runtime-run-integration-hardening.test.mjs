import test from "node:test";
import assert from "node:assert/strict";
import {
  InMemoryRunLedger,
  RuntimeRunLedgerFinalizer,
  RuntimeVerificationCoordinator,
} from "../dist/index.js";

function runningRun() {
  return {
    id: "run-hardening",
    projectId: "project-1",
    riskClass: "R2",
    phase: "execute",
    status: "running",
    attempt: 1,
    approvalIds: [],
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:03.000Z",
  };
}

function binding() {
  return {
    workflowRunId: "run-hardening",
    projectId: "project-1",
    workflowAttempt: 1,
    runtimeId: "opencode",
    sessionId: "session-canonical",
    workspace: "C:/tmp/worktree",
    boundAt: "2026-08-18T00:00:03.100Z",
  };
}

function report(status = "completed") {
  const run = runningRun();
  const bound = binding();
  return {
    workflowRunId: run.id,
    recovery: {
      runId: run.id,
      status: run.status,
      phase: run.phase,
      disposition: "reconcile_runtime",
      automaticResumeAllowed: false,
      runtimeReconciliationRequired: true,
      reason: "test",
    },
    binding: bound,
    observation: {
      runtimeId: bound.runtimeId,
      sessionId: bound.sessionId,
      status,
      observedAt: "2026-08-18T00:00:04.000Z",
      events: { count: 1, types: ["task_completed"] },
      diff: { filesChanged: ["src/example.ts"], patchObserved: true },
    },
    disposition: "verify_runtime_result",
    automaticRedispatchAllowed: false,
    verificationRequired: true,
    reason: "provider appears complete",
  };
}

function requiredR2Evidence() {
  return ["policy", "test", "review"].map((kind) => ({
    kind,
    status: "passed",
    reference: `${kind}:hardening`,
    producer: "hardening-test",
    collectedAt: "2026-08-18T00:00:05.000Z",
  }));
}

test("verification refuses a forged verify disposition when runtime observation is not completed", async () => {
  let verifierCalled = false;
  await assert.rejects(
    new RuntimeVerificationCoordinator().verify(runningRun(), report("running"), {
      id: "deterministic-node",
      async verify() {
        verifierCalled = true;
        return {
          passed: true,
          reference: "should-not-run",
          collectedAt: "2026-08-18T00:00:04.500Z",
        };
      },
    }),
    /requires completed runtime observation/,
  );
  assert.equal(verifierCalled, false);
});

test("canonical runtime identity overrides verifier metadata spoofing", async () => {
  const outcome = await new RuntimeVerificationCoordinator().verify(runningRun(), report(), {
    id: "deterministic-node",
    async verify() {
      return {
        passed: true,
        reference: "command:hardening",
        collectedAt: "2026-08-18T00:00:04.500Z",
        metadata: {
          runtimeId: "spoof-runtime",
          sessionId: "spoof-session",
          checks: 2,
        },
      };
    },
  });

  const deterministic = outcome.evidence.find((item) => item.kind === "deterministic_check");
  assert.equal(deterministic.metadata.runtimeId, "opencode");
  assert.equal(deterministic.metadata.sessionId, "session-canonical");
  assert.equal(JSON.stringify(deterministic).includes("spoof-runtime"), false);
  assert.equal(JSON.stringify(deterministic).includes("spoof-session"), false);
});

test("successful finalization requires matching runtime reconciliation evidence as well as deterministic PASS", () => {
  const run = {
    ...runningRun(),
    phase: "publish",
    status: "succeeded",
    updatedAt: "2026-08-18T00:00:08.000Z",
  };
  const bound = binding();
  const verification = {
    workflowRunId: run.id,
    runtimeId: bound.runtimeId,
    sessionId: bound.sessionId,
    verifierId: "deterministic-node",
    passed: true,
    evidence: [
      {
        kind: "deterministic_check",
        status: "passed",
        reference: "command:hardening",
        producer: "deterministic-node",
        collectedAt: "2026-08-18T00:00:04.500Z",
      },
    ],
  };

  assert.throws(
    () =>
      new RuntimeRunLedgerFinalizer().appendTerminal({
        run,
        binding: bound,
        ledger: new InMemoryRunLedger(),
        task: "hardening",
        modelRoute: ["9router/hemat"],
        contextCompilerVersion: "v1",
        skills: ["code.interactive"],
        toolsets: [],
        policyDecisions: [],
        changeReferences: [],
        evidence: requiredR2Evidence(),
        verification,
        resourceMetrics: {},
        traceId: "trace-hardening",
      }),
    /missing matching runtime reconciliation evidence/,
  );
});
