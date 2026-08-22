import assert from "node:assert/strict";
import test from "node:test";
import { appendFileSync, readFileSync } from "node:fs";
import {
  prepareLocalProductionRoutingApplyAuthorization,
  prepareLocalProductionRoutingApplyBackupEvidence,
  prepareLocalProductionRoutingApplyExecutionApproval,
  prepareLocalProductionRoutingApplyPrewriteSeal,
  prepareLocalProductionRoutingApplyProposal,
  prepareLocalProductionRoutingReadinessSourceSnapshot,
  verifyLocalProductionRoutingApplyAuthorization,
} from "../dist/index.js";
import { buildLocalProductionRoutingApplyFixture } from "./local-production-routing-apply-fixture.mjs";

async function proposal(r, overrides = {}) {
  return prepareLocalProductionRoutingApplyProposal({
    context: r.context,
    proposal: {
      candidateSubjectId: "subject:local-production-candidate-v1",
      candidateRouteRevision: "revision:local-production-candidate-v1",
      proposedAt: "2026-08-21T04:01:40.000Z",
      policyReferences: ["policy:r4-production-apply-v1"],
      runLedgerReferences: ["run-ledger:local-production-apply-preflight"],
      traceReferences: ["trace:local-production-apply-preflight"],
      ...overrides,
    },
  });
}

async function authorization(r, p, overrides = {}) {
  return prepareLocalProductionRoutingApplyAuthorization({
    proposal: p,
    context: r.context,
    workflow: r.workflow,
    authorization: {
      decision: "allow",
      actor: "operator:local-production-apply-r4",
      decidedAt: "2026-08-21T04:02:00.000Z",
      approvalIds: r.workflow.approvalIds,
      policyReferences: ["policy:r4-production-apply-authorization-v1"],
      ...overrides,
    },
  });
}

async function executionApproval(r, p, a, overrides = {}) {
  return prepareLocalProductionRoutingApplyExecutionApproval({
    proposal: p,
    authorization: a,
    context: r.context,
    workflow: r.workflow,
    approval: {
      actor: "operator:explicit-production-apply-now",
      approvedAt: "2026-08-21T04:03:00.000Z",
      explicitApplyNow: true,
      policyReferences: ["policy:explicit-production-execution-v1"],
      ...overrides,
    },
  });
}

async function hash(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(sort(value)));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sort(v)]));
}

// INITIAL ISSUE #48 SAFETY BOUNDARY: authority + pre-write seal only, no production writer is invoked.
test("PREWRITE ONLY: exact R4 authorization and explicit apply-now approval produce a seal without mutating production", async (t) => {
  const r = await buildLocalProductionRoutingApplyFixture(t, "prewrite-success");
  const before = readFileSync(r.productionPath, "utf8");
  const p = await proposal(r);
  const a = await authorization(r, p);
  const e = await executionApproval(r, p, a);
  const seal = await prepareLocalProductionRoutingApplyPrewriteSeal({
    proposal: p,
    authorization: a,
    executionApproval: e,
    context: r.context,
    workflow: r.workflow,
    observedAt: "2026-08-21T04:04:00.000Z",
  });

  assert.equal(readFileSync(r.productionPath, "utf8"), before);
  assert.equal(p.payload.productionRoutingMutationAuthorized, false);
  assert.equal(a.payload.productionRoutingMutationAuthorized, true);
  assert.equal(a.payload.oneShotAuthorization, true);
  assert.equal(e.payload.oneShotExecutionApproval, true);
  assert.equal(seal.payload.productionWritePerformed, false);
  assert.equal(seal.payload.productionRoutingMutationAuthorized, true);
  assert.equal(seal.payload.automaticRoutingMutationAllowed, false);
  assert.equal(seal.payload.automaticRetryAllowed, false);
  assert.equal(seal.payload.automaticRollbackAllowed, false);
  assert.equal(seal.payload.automaticRedispatchAllowed, false);
  assert.equal(seal.payload.automaticPromotionAllowed, false);
});

test("AUTHORITY: deny authorization cannot produce an execution approval", async (t) => {
  const r = await buildLocalProductionRoutingApplyFixture(t, "deny");
  const p = await proposal(r);
  const a = await authorization(r, p, { decision: "deny", actor: "operator:deny-production-apply" });
  assert.equal(a.payload.productionRoutingMutationAuthorized, false);
  await assert.rejects(executionApproval(r, p, a), /requires an allowed exact production-apply authorization/i);
});

test("FRESHNESS: R4 authorization must be later than the final proposal snapshot", async (t) => {
  const r = await buildLocalProductionRoutingApplyFixture(t, "stale-r4");
  const p = await proposal(r);
  await assert.rejects(authorization(r, p, { decidedAt: "2026-08-21T04:01:00.000Z" }), /after the final proposal snapshot/i);
});

test("EXECUTION APPROVAL: explicitApplyNow=false is rejected", async (t) => {
  const r = await buildLocalProductionRoutingApplyFixture(t, "no-apply-now");
  const p = await proposal(r);
  const a = await authorization(r, p);
  await assert.rejects(executionApproval(r, p, a, { explicitApplyNow: false }), /explicitly authorize apply now/i);
});

test("PREWRITE DRIFT: raw-byte production drift after authorization fails closed before any write", async (t) => {
  const r = await buildLocalProductionRoutingApplyFixture(t, "raw-drift");
  const p = await proposal(r);
  const a = await authorization(r, p);
  const e = await executionApproval(r, p, a);
  const semanticBefore = await r.productionTarget.read();
  appendFileSync(r.productionPath, "  \n", "utf8");
  await assert.rejects(prepareLocalProductionRoutingApplyPrewriteSeal({
    proposal: p,
    authorization: a,
    executionApproval: e,
    context: r.context,
    workflow: r.workflow,
    observedAt: "2026-08-21T04:04:00.000Z",
  }), /stale|drift|changed/i);
  assert.equal((await r.productionTarget.read()).stateId, semanticBefore.stateId);
});

test("BACKUP: unknown/provider-specific fields and automatic rollback authority are rejected", async (t) => {
  const r = await buildLocalProductionRoutingApplyFixture(t, "backup-guard");
  await assert.rejects(prepareLocalProductionRoutingApplyBackupEvidence({
    ...r.backupEvidence.payload,
    providerToken: "redacted",
  }), /unknown|provider-specific/i);
  await assert.rejects(prepareLocalProductionRoutingApplyBackupEvidence({
    ...r.backupEvidence.payload,
    automaticRollbackAllowed: true,
  }), /automatic rollback/i);
});

test("SOURCE: unverified current adapter/main source cannot enter the production-apply proposal", async (t) => {
  const r = await buildLocalProductionRoutingApplyFixture(t, "source-unverified");
  const source = await prepareLocalProductionRoutingReadinessSourceSnapshot({
    adapterId: r.currentSourceSnapshot.payload.adapterId,
    adapterVersion: r.currentSourceSnapshot.payload.adapterVersion,
    adapterSourceSha256: r.currentSourceSnapshot.payload.adapterSourceSha256,
    mainSourceSha256: r.currentSourceSnapshot.payload.mainSourceSha256,
    evidenceReferences: ["evidence:source-unverified"],
    adapterSourceVerified: false,
    mainSourceVerified: true,
    observedAt: "2026-08-21T04:00:10.000Z",
  });
  const context = { ...r.context, currentSourceSnapshot: source };
  await assert.rejects(prepareLocalProductionRoutingApplyProposal({
    context,
    proposal: {
      candidateSubjectId: "subject:local-production-candidate-v1",
      candidateRouteRevision: "revision:local-production-candidate-v1",
      proposedAt: "2026-08-21T04:01:40.000Z",
      policyReferences: ["policy:r4-production-apply-v1"],
      runLedgerReferences: ["run-ledger:local-production-apply-preflight"],
      traceReferences: ["trace:local-production-apply-preflight"],
    },
  }), /source snapshot is not independently verified/i);
});

test("FORGERY: re-hashed automatic retry authority cannot convert an exact one-shot authorization", async (t) => {
  const r = await buildLocalProductionRoutingApplyFixture(t, "forged-auto-retry");
  const p = await proposal(r);
  const a = await authorization(r, p);
  const payload = { ...a.payload, automaticRetryAllowed: true };
  const authorizationSha256 = await hash(payload);
  const forged = {
    ...a,
    authorizationSha256,
    authorizationId: `m5localprodapplyauth:${authorizationSha256.slice(0, 32)}`,
    payload,
  };
  await assert.rejects(verifyLocalProductionRoutingApplyAuthorization(forged, p, r.context, r.workflow), /canonical binding drift|automatic/i);
});
