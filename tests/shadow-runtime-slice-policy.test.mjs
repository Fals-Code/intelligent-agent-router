import test from "node:test";
import assert from "node:assert/strict";
import {
  validateShadowRuntimePrepareProof,
  validateShadowRuntimeRecoveryProof,
} from "../scripts/shadow-runtime-slice-policy.mjs";

const prepareProof = () => ({
  phase: "prepare",
  processId: 101,
  referenceRunId: "shadow-reference-run",
  candidateRunId: "shadow-candidate-run",
  referenceSessionId: "reference-session",
  candidateSessionId: "candidate-session",
  referenceRuntimeStatus: "completed",
  candidateRuntimeStatus: "completed",
  referenceRuntimeBound: true,
  candidateRuntimeBound: true,
  identicalPromptAndContext: true,
  zeroRuntimeTools: true,
  candidateOutputMayBeExternallyVisible: false,
  candidateOutputExternallyVisible: false,
  productionRoutingMutationAllowed: false,
  automaticRedispatchAllowed: false,
  gitHeadUnchanged: true,
  workingTreeUnchanged: true,
});

const recoveryProof = () => ({
  phase: "recover",
  prepareProcessId: 101,
  recoverProcessId: 202,
  processRestartProven: true,
  providerRestarted: false,
  referencePreRecoveryDisposition: "reconcile_runtime",
  candidatePreRecoveryDisposition: "reconcile_runtime",
  referenceRuntimeReconciliationDisposition: "verify_runtime_result",
  candidateRuntimeReconciliationDisposition: "verify_runtime_result",
  referenceRuntimeObservationStatus: "completed",
  candidateRuntimeObservationStatus: "completed",
  referenceVerificationPassed: true,
  candidateVerificationPassed: true,
  referenceVerificationRecoveredFromDisk: true,
  candidateVerificationRecoveredFromDisk: true,
  referenceFinalIntegrityDisposition: "consistent_terminal",
  candidateFinalIntegrityDisposition: "consistent_terminal",
  referenceRunLedgerOutcome: "succeeded",
  candidateRunLedgerOutcome: "succeeded",
  referenceSessionDestroyed: true,
  candidateSessionDestroyed: true,
  candidateOutputExternallyVisible: false,
  productionRoutingMutationAllowed: false,
  automaticRedispatchAllowed: false,
  gitHeadUnchanged: true,
  workingTreeUnchanged: true,
});

test("shadow runtime prepare policy accepts exact safe proof", () => {
  assert.doesNotThrow(() => validateShadowRuntimePrepareProof(prepareProof()));
});

test("shadow runtime prepare policy fails closed on visibility, mutation, redispatch, or shared identities", () => {
  for (const patch of [
    { candidateOutputExternallyVisible: true },
    { candidateOutputMayBeExternallyVisible: true },
    { productionRoutingMutationAllowed: true },
    { automaticRedispatchAllowed: true },
    { candidateRunId: "shadow-reference-run" },
    { candidateSessionId: "reference-session" },
    { zeroRuntimeTools: false },
  ]) {
    assert.throws(() => validateShadowRuntimePrepareProof({ ...prepareProof(), ...patch }));
  }
});

test("shadow runtime recovery policy requires two verified terminal runtimes after a distinct control-plane process", () => {
  assert.doesNotThrow(() => validateShadowRuntimeRecoveryProof(recoveryProof()));
});

test("shadow runtime recovery policy fails closed on redispatch, provider restart, missing verification, or non-terminal integrity", () => {
  for (const patch of [
    { recoverProcessId: 101 },
    { processRestartProven: false },
    { providerRestarted: true },
    { candidateVerificationPassed: false },
    { referenceVerificationRecoveredFromDisk: false },
    { candidateFinalIntegrityDisposition: "reconcile_runtime" },
    { candidateRunLedgerOutcome: "failed" },
    { candidateOutputExternallyVisible: true },
    { productionRoutingMutationAllowed: true },
    { automaticRedispatchAllowed: true },
  ]) {
    assert.throws(() => validateShadowRuntimeRecoveryProof({ ...recoveryProof(), ...patch }));
  }
});
