export function validateShadowRuntimePrepareProof(proof) {
  assertObject(proof, "Shadow runtime prepare proof");
  assertEqual(proof.phase, "prepare", "prepare phase");
  assertPositiveInteger(proof.processId, "prepare processId");
  assertIdentity(proof.referenceRunId, "prepare referenceRunId");
  assertIdentity(proof.candidateRunId, "prepare candidateRunId");
  assertIdentity(proof.referenceSessionId, "prepare referenceSessionId");
  assertIdentity(proof.candidateSessionId, "prepare candidateSessionId");
  if (proof.referenceRunId === proof.candidateRunId) throw new Error("Shadow runtime prepare requires distinct workflow runs");
  if (proof.referenceSessionId === proof.candidateSessionId) throw new Error("Shadow runtime prepare requires distinct runtime sessions");
  assertEqual(proof.referenceRuntimeStatus, "completed", "prepare referenceRuntimeStatus");
  assertEqual(proof.candidateRuntimeStatus, "completed", "prepare candidateRuntimeStatus");
  assertTrue(proof.referenceRuntimeBound, "prepare referenceRuntimeBound");
  assertTrue(proof.candidateRuntimeBound, "prepare candidateRuntimeBound");
  assertTrue(proof.identicalPromptAndContext, "prepare identicalPromptAndContext");
  assertTrue(proof.zeroRuntimeTools, "prepare zeroRuntimeTools");
  assertFalse(proof.candidateOutputMayBeExternallyVisible, "prepare candidateOutputMayBeExternallyVisible");
  assertFalse(proof.candidateOutputExternallyVisible, "prepare candidateOutputExternallyVisible");
  assertFalse(proof.productionRoutingMutationAllowed, "prepare productionRoutingMutationAllowed");
  assertFalse(proof.automaticRedispatchAllowed, "prepare automaticRedispatchAllowed");
  assertTrue(proof.gitHeadUnchanged, "prepare gitHeadUnchanged");
  assertTrue(proof.workingTreeUnchanged, "prepare workingTreeUnchanged");
}

export function validateShadowRuntimeRecoveryProof(proof) {
  assertObject(proof, "Shadow runtime recovery proof");
  assertEqual(proof.phase, "recover", "recover phase");
  assertPositiveInteger(proof.prepareProcessId, "recover prepareProcessId");
  assertPositiveInteger(proof.recoverProcessId, "recover recoverProcessId");
  if (proof.prepareProcessId === proof.recoverProcessId) throw new Error("Shadow runtime recovery requires distinct control-plane processes");
  assertTrue(proof.processRestartProven, "recover processRestartProven");
  assertFalse(proof.providerRestarted, "recover providerRestarted");
  for (const role of ["reference", "candidate"]) {
    assertEqual(proof[`${role}PreRecoveryDisposition`], "reconcile_runtime", `recover ${role}PreRecoveryDisposition`);
    assertEqual(proof[`${role}RuntimeReconciliationDisposition`], "verify_runtime_result", `recover ${role}RuntimeReconciliationDisposition`);
    assertEqual(proof[`${role}RuntimeObservationStatus`], "completed", `recover ${role}RuntimeObservationStatus`);
    assertTrue(proof[`${role}VerificationPassed`], `recover ${role}VerificationPassed`);
    assertTrue(proof[`${role}VerificationRecoveredFromDisk`], `recover ${role}VerificationRecoveredFromDisk`);
    assertEqual(proof[`${role}FinalIntegrityDisposition`], "consistent_terminal", `recover ${role}FinalIntegrityDisposition`);
    assertEqual(proof[`${role}RunLedgerOutcome`], "succeeded", `recover ${role}RunLedgerOutcome`);
    assertTrue(proof[`${role}SessionDestroyed`], `recover ${role}SessionDestroyed`);
  }
  assertFalse(proof.candidateOutputExternallyVisible, "recover candidateOutputExternallyVisible");
  assertFalse(proof.productionRoutingMutationAllowed, "recover productionRoutingMutationAllowed");
  assertFalse(proof.automaticRedispatchAllowed, "recover automaticRedispatchAllowed");
  assertTrue(proof.gitHeadUnchanged, "recover gitHeadUnchanged");
  assertTrue(proof.workingTreeUnchanged, "recover workingTreeUnchanged");
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
}

function assertIdentity(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must not be empty`);
}

function assertPositiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
}

function assertTrue(value, label) {
  if (value !== true) throw new Error(`${label} must be true`);
}

function assertFalse(value, label) {
  if (value !== false) throw new Error(`${label} must be false`);
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label} must equal ${expected}; received ${String(actual)}`);
}
