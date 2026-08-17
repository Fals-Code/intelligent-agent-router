import test from "node:test";
import assert from "node:assert/strict";
import { validatePrepareProof, validateRecoveryProof } from "../scripts/restart-recovery-slice-policy.mjs";

test("restart/recovery prepare policy requires a completed provider task with active execute workflow", () => {
  assert.deepEqual(
    validatePrepareProof({
      phase: "prepare",
      runtimeStatus: "completed",
      workflowStatus: "running",
      workflowPhase: "execute",
      integrityDisposition: "reconcile_runtime",
      runtimeBound: true,
      gitHeadUnchanged: true,
      workingTreeUnchanged: true,
      processId: 101,
    }),
    { passed: true },
  );

  assert.throws(
    () => validatePrepareProof({
      phase: "prepare",
      runtimeStatus: "completed",
      workflowStatus: "succeeded",
      workflowPhase: "publish",
      integrityDisposition: "consistent_terminal",
      runtimeBound: true,
      gitHeadUnchanged: true,
      workingTreeUnchanged: true,
      processId: 101,
    }),
    /workflow must remain running/,
  );
});

test("restart/recovery final policy requires distinct processes and consistent durable terminal state", () => {
  assert.deepEqual(
    validateRecoveryProof({
      phase: "recover",
      processRestartProven: true,
      providerRestarted: false,
      preRecoveryDisposition: "reconcile_runtime",
      runtimeReconciliationDisposition: "verify_runtime_result",
      runtimeObservationStatus: "completed",
      verificationPassed: true,
      verificationRecoveredFromDisk: true,
      finalIntegrityDisposition: "consistent_terminal",
      runLedgerOutcome: "succeeded",
      sessionDestroyed: true,
      gitHeadUnchanged: true,
      workingTreeUnchanged: true,
      prepareProcessId: 101,
      recoverProcessId: 202,
    }),
    { passed: true },
  );

  assert.throws(
    () => validateRecoveryProof({
      phase: "recover",
      processRestartProven: true,
      providerRestarted: false,
      preRecoveryDisposition: "reconcile_runtime",
      runtimeReconciliationDisposition: "verify_runtime_result",
      runtimeObservationStatus: "completed",
      verificationPassed: true,
      verificationRecoveredFromDisk: true,
      finalIntegrityDisposition: "consistent_terminal",
      runLedgerOutcome: "succeeded",
      sessionDestroyed: true,
      gitHeadUnchanged: true,
      workingTreeUnchanged: true,
      prepareProcessId: 101,
      recoverProcessId: 101,
    }),
    /process IDs must differ/,
  );
});
