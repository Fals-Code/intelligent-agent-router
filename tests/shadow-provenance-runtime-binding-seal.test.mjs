import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  prepareShadowProvenanceRuntimeBindingSeal,
  verifyShadowProvenanceRuntimeBindingSeal,
} from "../dist/index.js";

function stableStringify(value) {
  if (Array.isArray(value)) return JSON.stringify(value.map((item) => JSON.parse(stableStringify(item))));
  if (!value || typeof value !== "object") return JSON.stringify(value);
  const normalized = Object.fromEntries(Object.entries(value)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, JSON.parse(stableStringify(child))]));
  return JSON.stringify(normalized);
}

function sha256(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex").toUpperCase();
}

function provenance() {
  const payload = {
    experimentId: "m5experiment:fixture",
    experimentSha256: "A".repeat(64),
    authorizationId: "m5expauth:fixture",
    authorizationSha256: "B".repeat(64),
    controlWorkflowRunId: "control-run",
    sampleId: "sample-1",
    reservationEventId: "reserve-1",
    dispatchEventId: "dispatch-1",
    completionEventId: "complete-1",
    adapterId: "runtime-backed-shadow-experiment",
    referenceExecutionReference: "shadow-runtime:reference:opencode:reference-run:1:ses_reference",
    candidateExecutionReference: "shadow-runtime:candidate:opencode:candidate-run:1:ses_candidate",
    referenceRunId: "reference-run",
    candidateRunId: "candidate-run",
    referenceProjectionId: "execmetric:reference",
    candidateProjectionId: "execmetric:candidate",
    referenceObservationId: "evalobs:reference",
    candidateObservationId: "evalobs:candidate",
    referenceObservationSha256: "C".repeat(64),
    candidateObservationSha256: "D".repeat(64),
    exposure: "shadow",
    liveAssignment: "none",
    candidateOutputExternallyVisible: false,
    automaticRedispatchAllowed: false,
    productionRoutingMutationAllowed: false,
  };
  const provenanceSha256 = sha256(payload);
  return {
    schemaVersion: 1,
    algorithm: "sha256",
    provenanceId: `m5shadowprov:${provenanceSha256.slice(0, 32).toLowerCase()}`,
    provenanceSha256,
    payload,
  };
}

function binding(runId, sessionId) {
  return {
    workflowRunId: runId,
    projectId: "project-shadow",
    workflowAttempt: 1,
    runtimeId: "opencode",
    sessionId,
    workspace: "C:/isolated/shadow",
    boundAt: "2026-08-19T06:00:00.000Z",
  };
}

test("runtime binding seal exactly binds shadow provenance to durable attempts and sessions", async () => {
  const p = provenance();
  const sources = {
    provenance: p,
    referenceBinding: binding("reference-run", "ses_reference"),
    candidateBinding: binding("candidate-run", "ses_candidate"),
  };
  const seal = await prepareShadowProvenanceRuntimeBindingSeal(sources);
  assert.match(seal.sealId, /^m5shadowbind:[a-f0-9]{32}$/);
  assert.equal(seal.payload.referenceWorkflowAttempt, 1);
  assert.equal(seal.payload.candidateWorkflowAttempt, 1);
  assert.equal(seal.payload.referenceSessionId, "ses_reference");
  assert.equal(seal.payload.candidateSessionId, "ses_candidate");
  assert.equal(seal.payload.candidateOutputExternallyVisible, false);
  await assert.doesNotReject(() => verifyShadowProvenanceRuntimeBindingSeal(seal, sources));
});

test("runtime binding seal fails closed on session, attempt, run, workspace, or provenance drift", async () => {
  const p = provenance();
  const referenceBinding = binding("reference-run", "ses_reference");
  const candidateBinding = binding("candidate-run", "ses_candidate");
  await assert.rejects(
    () => prepareShadowProvenanceRuntimeBindingSeal({ provenance: p, referenceBinding, candidateBinding: { ...candidateBinding, sessionId: "ses_wrong" } }),
    /candidate execution reference does not exactly match durable RuntimeBinding/,
  );
  await assert.rejects(
    () => prepareShadowProvenanceRuntimeBindingSeal({ provenance: p, referenceBinding, candidateBinding: { ...candidateBinding, workflowAttempt: 2 } }),
    /candidate execution reference does not exactly match durable RuntimeBinding/,
  );
  await assert.rejects(
    () => prepareShadowProvenanceRuntimeBindingSeal({ provenance: p, referenceBinding, candidateBinding: { ...candidateBinding, workflowRunId: "wrong-run" } }),
    /workflowRunId does not match shadow provenance/,
  );
  await assert.rejects(
    () => prepareShadowProvenanceRuntimeBindingSeal({ provenance: p, referenceBinding, candidateBinding: { ...candidateBinding, workspace: "D:/other" } }),
    /same workspace/,
  );
  await assert.rejects(
    () => prepareShadowProvenanceRuntimeBindingSeal({ provenance: { ...p, provenanceSha256: "0".repeat(64) }, referenceBinding, candidateBinding }),
    /provenance digest is invalid/,
  );
});
