function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function validatePrepareProof(proof) {
  assert(proof && typeof proof === "object", "prepare proof must be an object");
  assert(proof.phase === "prepare", "prepare proof phase must be prepare");
  assert(proof.runtimeStatus === "completed", "prepare runtime must be completed before process exit");
  assert(proof.workflowStatus === "running", "prepare workflow must remain running");
  assert(proof.workflowPhase === "execute", "prepare workflow must remain in execute phase");
  assert(proof.integrityDisposition === "reconcile_runtime", "prepare integrity disposition must require runtime reconciliation");
  assert(proof.runtimeBound === true, "prepare must persist runtime binding milestone");
  assert(proof.gitHeadUnchanged === true, "prepare must preserve router HEAD");
  assert(proof.workingTreeUnchanged === true, "prepare must preserve router working tree");
  assert(Number.isInteger(proof.processId) && proof.processId > 0, "prepare processId must be a positive integer");
  return Object.freeze({ passed: true });
}

export function validateRecoveryProof(proof) {
  assert(proof && typeof proof === "object", "recovery proof must be an object");
  assert(proof.phase === "recover", "recovery proof phase must be recover");
  assert(proof.processRestartProven === true, "recovery must prove a distinct control-plane process");
  assert(proof.providerRestarted === false, "reference slice must not misrepresent provider restart");
  assert(proof.preRecoveryDisposition === "reconcile_runtime", "recovery must begin from reconcile_runtime");
  assert(proof.runtimeReconciliationDisposition === "verify_runtime_result", "runtime reconciliation must require deterministic verification");
  assert(proof.runtimeObservationStatus === "completed", "recovered runtime observation must be completed");
  assert(proof.verificationPassed === true, "deterministic recovery verification must pass");
  assert(proof.verificationRecoveredFromDisk === true, "verification evidence must survive journal reopen");
  assert(proof.finalIntegrityDisposition === "consistent_terminal", "final durable state must be consistent_terminal");
  assert(proof.runLedgerOutcome === "succeeded", "Run Ledger outcome must be succeeded");
  assert(proof.sessionDestroyed === true, "live OpenCode session must be destroyed after proof completion");
  assert(proof.gitHeadUnchanged === true, "recovery must preserve router HEAD");
  assert(proof.workingTreeUnchanged === true, "recovery must preserve router working tree");
  assert(Number.isInteger(proof.prepareProcessId) && proof.prepareProcessId > 0, "prepareProcessId must be a positive integer");
  assert(Number.isInteger(proof.recoverProcessId) && proof.recoverProcessId > 0, "recoverProcessId must be a positive integer");
  assert(proof.prepareProcessId !== proof.recoverProcessId, "prepare and recover process IDs must differ");
  return Object.freeze({ passed: true });
}
