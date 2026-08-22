import assert from "node:assert/strict";
import test from "node:test";
import {
  appendFileSync,
  linkSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  CanonicalLocalProductionRoutingWriter,
  JsonFileLocalProductionRoutingApplyBackupStore,
  JsonlLocalProductionRoutingApplyJournal,
  LocalProductionRoutingApplyCoordinator,
  LocalProductionRoutingSingleWriterBoundary,
  prepareLocalProductionRouterState,
  prepareLocalProductionRoutingApplyAuthorization,
  prepareLocalProductionRoutingApplyBackupEvidence,
  prepareLocalProductionRoutingApplyExecutionApproval,
  prepareLocalProductionRoutingApplyPrewriteSeal,
  prepareLocalProductionRoutingApplyProposal,
  prepareLocalProductionRoutingReadinessSourceSnapshot,
  prepareLocalProductionRoutingTargetSnapshot,
  verifyLocalProductionRoutingApplyAuthorization,
  verifyLocalProductionRoutingApplyExecutionApproval,
  verifyLocalProductionRoutingApplyProposal,
  verifyLocalProductionRoutingApplyReceipt,
} from "../dist/index.js";
import {
  buildLocalProductionRoutingApplyFixture,
  freshPrewriteSnapshots,
} from "./local-production-routing-apply-fixture.mjs";

async function proposal(r, overrides = {}, context = r.context) {
  return prepareLocalProductionRoutingApplyProposal({
    context,
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

async function authorization(r, p, overrides = {}, context = r.context, workflow = r.workflow) {
  return prepareLocalProductionRoutingApplyAuthorization({
    proposal: p,
    context,
    workflow,
    authorization: {
      decision: "allow",
      actor: "operator:local-production-apply-r4",
      decidedAt: "2026-08-21T04:02:00.000Z",
      approvalIds: workflow.approvalIds,
      policyReferences: ["policy:r4-production-apply-authorization-v1"],
      ...overrides,
    },
  });
}

async function executionApproval(r, p, a, overrides = {}, context = r.context, workflow = r.workflow) {
  return prepareLocalProductionRoutingApplyExecutionApproval({
    proposal: p,
    authorization: a,
    context,
    workflow,
    approval: {
      actor: "operator:explicit-production-apply-now",
      approvedAt: "2026-08-21T04:03:00.000Z",
      explicitApplyNow: true,
      policyReferences: ["policy:explicit-production-execution-v1"],
      ...overrides,
    },
  });
}

async function gate(r, overrides = {}) {
  const p = await proposal(r, overrides.proposal ?? {}, overrides.context ?? r.context);
  const a = await authorization(r, p, overrides.authorization ?? {}, overrides.context ?? r.context, overrides.workflow ?? r.workflow);
  const e = await executionApproval(r, p, a, overrides.executionApproval ?? {}, overrides.context ?? r.context, overrides.workflow ?? r.workflow);
  const fresh = overrides.fresh ?? await freshPrewriteSnapshots(r, overrides.freshOverrides ?? {});
  const seal = await prepareLocalProductionRoutingApplyPrewriteSeal({
    proposal: p,
    authorization: a,
    executionApproval: e,
    context: overrides.context ?? r.context,
    workflow: overrides.workflow ?? r.workflow,
    currentTargetSnapshot: fresh.currentTargetSnapshot,
    currentSourceSnapshot: fresh.currentSourceSnapshot,
    observedAt: overrides.sealObservedAt ?? "2026-08-21T04:03:30.000Z",
  });
  return { proposal: p, authorization: a, executionApproval: e, prewriteSeal: seal, ...fresh };
}

function executeInput(r, g, overrides = {}) {
  return {
    proposal: g.proposal,
    authorization: g.authorization,
    executionApproval: g.executionApproval,
    prewriteSeal: g.prewriteSeal,
    context: r.context,
    workflow: r.workflow,
    currentTargetSnapshot: g.currentTargetSnapshot,
    currentSourceSnapshot: g.currentSourceSnapshot,
    reservedAt: "2026-08-21T04:04:00.000Z",
    appliedAt: "2026-08-21T04:04:01.000Z",
    committedAt: "2026-08-21T04:04:02.000Z",
    completedAt: "2026-08-21T04:04:03.000Z",
    ...overrides,
  };
}

function recoveryInput(r, g, overrides = {}) {
  return {
    proposal: g.proposal,
    authorization: g.authorization,
    executionApproval: g.executionApproval,
    prewriteSeal: g.prewriteSeal,
    context: r.context,
    workflow: r.workflow,
    currentTargetSnapshot: g.currentTargetSnapshot,
    currentSourceSnapshot: g.currentSourceSnapshot,
    observedAt: "2026-08-21T04:05:00.000Z",
    completedAt: "2026-08-21T04:05:01.000Z",
    ...overrides,
  };
}

function reopenedCoordinator(r, journal) {
  return new LocalProductionRoutingApplyCoordinator(
    r.productionTarget,
    r.canonicalWriter,
    r.singleWriterBoundary,
    journal,
  );
}

async function canonicalHash(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(sort(value))));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}
function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sort(v)]));
}
async function rehashEnvelope(envelope, payload, prefix, idField, shaField) {
  const sha = await canonicalHash(payload);
  return { ...envelope, [idField]: `${prefix}:${sha.slice(0, 32).toLowerCase()}`, [shaField]: sha, payload };
}

function assertAllAutomaticFalse(value) {
  assert.equal(value.automaticRoutingMutationAllowed, false);
  assert.equal(value.automaticRetryAllowed, false);
  assert.equal(value.automaticRollbackAllowed, false);
  assert.equal(value.automaticRedispatchAllowed, false);
  assert.equal(value.automaticPromotionAllowed, false);
}

// ---------------------------------------------------------------------------
// Negative-first authority, freshness, backup, writer and pre-write boundary.
// ---------------------------------------------------------------------------

test("NEGATIVE AUTHORITY: missing, deny, stale, and pre-proposal production apply authorization cannot reach execution approval", async (t) => {
  const r = await buildLocalProductionRoutingApplyFixture(t, "authority-negative");
  const p = await proposal(r);

  await assert.rejects(
    prepareLocalProductionRoutingApplyExecutionApproval({ proposal: p, authorization: undefined, context: r.context, workflow: r.workflow, approval: { actor: "operator:missing", approvedAt: "2026-08-21T04:03:00.000Z", explicitApplyNow: true, policyReferences: ["policy:explicit-production-execution-v1"] } }),
    /authorization|undefined|null|object/i,
  );

  const deny = await authorization(r, p, { decision: "deny", actor: "operator:deny" });
  assert.equal(deny.payload.productionRoutingMutationAuthorized, false);
  await assert.rejects(executionApproval(r, p, deny), /allowed exact production-apply authorization/i);

  await assert.rejects(authorization(r, p, { decidedAt: "2026-08-21T04:01:00.000Z" }), /after final proposal|after.*proposal/i);
  await assert.rejects(authorization(r, p, { decidedAt: p.payload.proposedAt }), /after final proposal|after.*proposal/i);
});

test("NEGATIVE SCOPE: rehashed wrong project/route/capability/reference/candidate/revision proposal cannot escape exact context", async (t) => {
  const r = await buildLocalProductionRoutingApplyFixture(t, "scope-negative");
  const p = await proposal(r);
  const cases = [
    ["projectId", "project:other"],
    ["routeId", "route:other"],
    ["capability", "code.review"],
    ["referenceSubjectId", "subject:other-reference"],
    ["referenceRouteRevision", "revision:other-reference"],
    ["productionTargetId", "target:other"],
    ["backupEvidenceId", "backup:evidence:other"],
    ["canonicalWriterId", "writer:other"],
  ];
  for (const [field, value] of cases) {
    const forged = await rehashEnvelope(p, { ...p.payload, [field]: value }, "m5localprodapplyproposal", "proposalId", "proposalSha256");
    await assert.rejects(verifyLocalProductionRoutingApplyProposal(forged, r.context), /binding drift|target|backup|writer|authority/i, field);
  }

  await assert.rejects(proposal(r, { candidateSubjectId: r.productionPreFingerprint.payload.currentSubjectId }), /candidate.*differ/i);
  await assert.rejects(proposal(r, { candidateRouteRevision: r.productionPreFingerprint.payload.routeRevision }), /candidate.*differ/i);
});

test("NEGATIVE HISTORICAL AUTHORITY: stale Issue #44 readiness authority and wrong Issue #46 rehearsal receipt fail closed", async (t) => {
  const r = await buildLocalProductionRoutingApplyFixture(t, "historical-negative");
  const staleReadiness = {
    ...r.authority.readinessAuthorization,
    payload: { ...r.authority.readinessAuthorization.payload, mainSourceSha256: "9".repeat(64) },
  };
  const staleContext = {
    ...r.context,
    rehearsalAuthority: { ...r.authority, readinessAuthorization: staleReadiness },
  };
  await assert.rejects(proposal(r, {}, staleContext), /readiness|content|source|drift|authorization/i);

  const other = await buildLocalProductionRoutingApplyFixture(t, "other-rehearsal");
  const wrongReceiptContext = { ...r.context, rehearsalReceipt: other.rehearsalReceipt };
  await assert.rejects(proposal(r, {}, wrongReceiptContext), /rehearsal|receipt|provenance|binding|target/i);

  const invalidReceiptContext = { ...r.context, rehearsalReceipt: { ...r.rehearsalReceipt, receiptSha256: "0".repeat(64) } };
  await assert.rejects(proposal(r, {}, invalidReceiptContext), /rehearsal|receipt|content/i);
});

test("NEGATIVE SOURCE: unverified or changed adapter/main source cannot enter proposal or final pre-write seal", async (t) => {
  const r = await buildLocalProductionRoutingApplyFixture(t, "source-negative");
  const unverified = await prepareLocalProductionRoutingReadinessSourceSnapshot({
    adapterId: r.currentSourceSnapshot.payload.adapterId,
    adapterVersion: r.currentSourceSnapshot.payload.adapterVersion,
    adapterSourceSha256: r.currentSourceSnapshot.payload.adapterSourceSha256,
    mainSourceSha256: r.currentSourceSnapshot.payload.mainSourceSha256,
    evidenceReferences: ["evidence:unverified-source"],
    adapterSourceVerified: false,
    mainSourceVerified: true,
    observedAt: "2026-08-21T04:00:10.000Z",
  });
  await assert.rejects(proposal(r, {}, { ...r.context, currentSourceSnapshot: unverified }), /source snapshot|source.*verified|unverified/i);

  const p = await proposal(r);
  const a = await authorization(r, p);
  const e = await executionApproval(r, p, a);
  const fresh = await freshPrewriteSnapshots(r, {
    source: { mainSourceSha256: "7".repeat(64) },
  });
  await assert.rejects(prepareLocalProductionRoutingApplyPrewriteSeal({
    proposal: p,
    authorization: a,
    executionApproval: e,
    context: r.context,
    workflow: r.workflow,
    currentTargetSnapshot: fresh.currentTargetSnapshot,
    currentSourceSnapshot: fresh.currentSourceSnapshot,
    observedAt: "2026-08-21T04:03:30.000Z",
  }), /source drift|mainSourceSha256|source/i);
});

test("NEGATIVE PREWRITE: semantic drift, raw-byte drift, and drift after seal all stop before reservation/write", async (t) => {
  await t.test("semantic drift before prewrite", async (t) => {
    const r = await buildLocalProductionRoutingApplyFixture(t, "semantic-drift");
    const p = await proposal(r); const a = await authorization(r, p); const e = await executionApproval(r, p, a); const fresh = await freshPrewriteSnapshots(r);
    const drift = await prepareLocalProductionRouterState({
      targetId: r.productionPreFingerprint.payload.targetId,
      installationId: r.productionPreFingerprint.payload.installationId,
      projectId: r.productionPreFingerprint.payload.projectId,
      routeId: r.productionPreFingerprint.payload.routeId,
      capability: r.productionPreFingerprint.payload.capability,
      currentSubjectId: "subject:external-drift",
      routeRevision: "revision:external-drift",
      updatedAt: "2026-08-21T04:03:25.000Z",
    });
    writeFileSync(r.productionPath, JSON.stringify(drift), "utf8");
    await assert.rejects(prepareLocalProductionRoutingApplyPrewriteSeal({ proposal: p, authorization: a, executionApproval: e, context: r.context, workflow: r.workflow, ...fresh, observedAt: "2026-08-21T04:03:30.000Z" }), /production.*changed|stale|drift/i);
    assert.equal((await r.applyJournal.events()).length, 0);
    assert.equal(r.canonicalWriter.writeCount, 0);
  });

  await t.test("raw-byte-only drift before prewrite", async (t) => {
    const r = await buildLocalProductionRoutingApplyFixture(t, "raw-drift");
    const p = await proposal(r); const a = await authorization(r, p); const e = await executionApproval(r, p, a); const fresh = await freshPrewriteSnapshots(r);
    appendFileSync(r.productionPath, "  \n", "utf8");
    await assert.rejects(prepareLocalProductionRoutingApplyPrewriteSeal({ proposal: p, authorization: a, executionApproval: e, context: r.context, workflow: r.workflow, ...fresh, observedAt: "2026-08-21T04:03:30.000Z" }), /production.*changed|stale|drift/i);
    assert.equal((await r.applyJournal.events()).length, 0);
    assert.equal(r.canonicalWriter.writeCount, 0);
  });

  await t.test("drift between seal and reservation/write", async (t) => {
    const r = await buildLocalProductionRoutingApplyFixture(t, "post-seal-drift");
    const g = await gate(r);
    appendFileSync(r.productionPath, " \n", "utf8");
    await assert.rejects(r.applyCoordinator.execute(executeInput(r, g)), /production.*changed|prewrite|stale|drift/i);
    assert.equal((await r.applyJournal.events()).length, 0);
    assert.equal(r.canonicalWriter.writeCount, 0);
  });
});

test("NEGATIVE BACKUP: stale, mismatched, missing, or tampered backup proof fails before reservation", async (t) => {
  await t.test("stale backup timestamp", async (t) => {
    const r = await buildLocalProductionRoutingApplyFixture(t, "backup-stale");
    const stale = await prepareLocalProductionRoutingApplyBackupEvidence({
      ...r.backupEvidence.payload,
      capturedAt: "2026-08-21T04:00:00.000Z",
    });
    await assert.rejects(proposal(r, {}, { ...r.context, backupEvidence: stale }), /backup.*stale|backup.*fingerprint/i);
  });

  await t.test("backup target identity mismatch", async (t) => {
    const r = await buildLocalProductionRoutingApplyFixture(t, "backup-target-mismatch");
    const mismatch = await prepareLocalProductionRoutingApplyBackupEvidence({
      ...r.backupEvidence.payload,
      productionTargetId: "local-production-router:other:route",
    });
    await assert.rejects(proposal(r, {}, { ...r.context, backupEvidence: mismatch }), /backup.*target|store\/target|binding drift/i);
  });

  await t.test("tampered backup bytes", async (t) => {
    const r = await buildLocalProductionRoutingApplyFixture(t, "backup-tamper");
    const backupPath = join(r.backupStore.descriptor.directoryPath, r.backupEvidence.payload.backupObjectKey);
    writeFileSync(backupPath, "{}", "utf8");
    await assert.rejects(proposal(r), /backup.*integrity|backup.*bytes|size|semantic/i);
  });

  await t.test("missing backup object", async (t) => {
    const r = await buildLocalProductionRoutingApplyFixture(t, "backup-missing");
    const backupPath = join(r.backupStore.descriptor.directoryPath, r.backupEvidence.payload.backupObjectKey);
    unlinkSync(backupPath);
    await assert.rejects(proposal(r), /backup.*missing/i);
  });
});

test("NEGATIVE SINGLE WRITER: second writer, broadened write path/scope, and physical backup alias are rejected", async (t) => {
  const r = await buildLocalProductionRoutingApplyFixture(t, "writer-negative");
  const second = new CanonicalLocalProductionRoutingWriter({
    descriptor: { ...r.canonicalWriter.descriptor, writerId: "writer:second" },
    productionTarget: r.productionTarget,
  });
  assert.throws(() => r.singleWriterBoundary.register(second), /second|co-primary/i);

  assert.throws(() => new CanonicalLocalProductionRoutingWriter({
    descriptor: { ...r.canonicalWriter.descriptor, stateFilePath: join(r.root, "other-production.json") },
    productionTarget: r.productionTarget,
  }), /broadens|mismatch|target/i);

  const aliasPath = join(r.root, "production-hardlink-backup.json");
  linkSync(r.productionPath, aliasPath);
  const aliasStore = new JsonFileLocalProductionRoutingApplyBackupStore({
    storeKind: "local_production_apply_backup_store",
    backupStoreId: "backup-store:alias-test",
    directoryPath: r.root,
    productionTargetId: r.productionPreFingerprint.payload.targetId,
    exactTargetOnly: true,
  });
  const rawSha = r.productionPreFingerprint.payload.rawFileSha256.toLowerCase();
  const expectedObjectPath = join(r.root, `${rawSha}.json`);
  try {
    linkSync(r.productionPath, expectedObjectPath);
    await assert.rejects(aliasStore.capture({
      productionTarget: r.productionTarget,
      retentionPolicyReference: "policy:retention",
      restoreProcedureReference: "procedure:restore",
      evidenceReferences: ["evidence:restore"],
      restoreProcedureRehearsed: true,
      capturedAt: "2026-08-21T04:00:31.000Z",
    }), /alias/i);
  } finally {
    if (readFileSync(aliasPath, "utf8")) unlinkSync(aliasPath);
    try { unlinkSync(expectedObjectPath); } catch {}
  }
});

test("NEGATIVE FIELDS/AUTHORITY: provider-specific extras, secret-like material, and forged automatic flags fail closed", async (t) => {
  const r = await buildLocalProductionRoutingApplyFixture(t, "fields-negative");
  await assert.rejects(prepareLocalProductionRoutingApplyBackupEvidence({ ...r.backupEvidence.payload, providerToken: "redacted" }), /unknown|provider-specific|missing/i);
  await assert.rejects(proposal(r, { policyReferences: ["Authorization: Bearer secret-value"] }), /secret|invalid/i);
  await assert.rejects(prepareLocalProductionRoutingApplyBackupEvidence({ ...r.backupEvidence.payload, automaticRollbackAllowed: true }), /automatic rollback|incomplete/i);

  const p = await proposal(r);
  const a = await authorization(r, p);
  for (const field of ["automaticRoutingMutationAllowed", "automaticRetryAllowed", "automaticRollbackAllowed", "automaticRedispatchAllowed", "automaticPromotionAllowed"]) {
    const forged = await rehashEnvelope(a, { ...a.payload, [field]: true }, "m5localprodapplyauth", "authorizationId", "authorizationSha256");
    await assert.rejects(verifyLocalProductionRoutingApplyAuthorization(forged, p, r.context, r.workflow), /automatic|binding drift/i, field);
  }
});

test("NEGATIVE OPERATION AUTHORITY: a rehashed execution approval cannot transfer production authority to another operation", async (t) => {
  const r = await buildLocalProductionRoutingApplyFixture(t, "operation-forgery");
  const p = await proposal(r); const a = await authorization(r, p); const e = await executionApproval(r, p, a);
  const forged = await rehashEnvelope(e, { ...e.payload, operationId: "m5localprodapplyop:anotheroperation000000000000" }, "m5localprodapplyexec", "approvalId", "approvalSha256");
  await assert.rejects(verifyLocalProductionRoutingApplyExecutionApproval(forged, p, a, r.context, r.workflow), /operation|binding drift/i);
});

// ---------------------------------------------------------------------------
// Durable reservation, isolated one-write execution and restart reconciliation.
// ---------------------------------------------------------------------------

test("SUCCESS: isolated exact one-shot apply is reserved before write, read-back verified, committed, and classified APPLIED_VERIFIED", async (t) => {
  const r = await buildLocalProductionRoutingApplyFixture(t, "applied-success");
  const before = readFileSync(r.productionPath, "utf8");
  const g = await gate(r);
  const receipt = await r.applyCoordinator.execute(executeInput(r, g));

  assert.equal(receipt.payload.classification, "APPLIED_VERIFIED");
  assert.equal(receipt.payload.productionRouteMutated, true);
  assert.equal(receipt.payload.futureProductionMutationAuthorized, false);
  assert.equal(receipt.payload.oneShotConsumed, true);
  assertAllAutomaticFalse(receipt.payload);
  assert.equal(r.canonicalWriter.writeCount, 1);
  assert.notEqual(readFileSync(r.productionPath, "utf8"), before);
  const state = await r.productionTarget.read();
  assert.equal(state.payload.currentSubjectId, g.proposal.payload.candidateSubjectId);
  assert.equal(state.payload.routeRevision, g.proposal.payload.candidateRouteRevision);

  const events = await r.applyJournal.events();
  assert.equal(events.length, 2);
  assert.equal(events[0].payload.eventType, "apply_reserved");
  assert.equal(events[0].payload.productionWriteObserved, "NO");
  assert.equal(events[1].payload.eventType, "apply_committed");
  assert.equal(events[1].payload.productionWriteObserved, "YES");
  assertAllAutomaticFalse(events[0].payload);
  assertAllAutomaticFalse(events[1].payload);
  await verifyLocalProductionRoutingApplyReceipt(receipt, { ...executeInput(r, g), journal: r.applyJournal });
});

test("INTERRUPTION: crash after durable reservation but before write recovers NOT_APPLIED_SAFE without invoking writer", async (t) => {
  const crash = { hit(point) { if (point === "after_reservation_before_write") throw new Error("simulated crash after reservation"); } };
  const r = await buildLocalProductionRoutingApplyFixture(t, "crash-reservation", { faultInjector: crash });
  const g = await gate(r);
  await assert.rejects(r.applyCoordinator.execute(executeInput(r, g)), /simulated crash/i);
  assert.equal(r.canonicalWriter.writeCount, 0);
  assert.equal((await r.applyJournal.events()).length, 1);
  const reopened = await JsonlLocalProductionRoutingApplyJournal.open(r.journalOptions);
  const receipt = await reopenedCoordinator(r, reopened).recover(recoveryInput(r, g));
  assert.equal(receipt.payload.classification, "NOT_APPLIED_SAFE");
  assert.equal(receipt.payload.productionRouteMutated, false);
  assert.equal(receipt.payload.recoveredAfterRestart, true);
  assert.equal(r.canonicalWriter.writeCount, 0);
  assertAllAutomaticFalse(receipt.payload);
});

test("INTERRUPTION: crash after one production write before commit recovers exact candidate as committed with no duplicate write", async (t) => {
  const crash = { hit(point) { if (point === "after_write_before_commit") throw new Error("simulated crash after write"); } };
  const r = await buildLocalProductionRoutingApplyFixture(t, "crash-post-write", { faultInjector: crash });
  const g = await gate(r);
  await assert.rejects(r.applyCoordinator.execute(executeInput(r, g)), /simulated crash/i);
  assert.equal(r.canonicalWriter.writeCount, 1);
  assert.equal((await r.applyJournal.events()).length, 1);

  const reopened = await JsonlLocalProductionRoutingApplyJournal.open(r.journalOptions);
  const receipt = await reopenedCoordinator(r, reopened).recover(recoveryInput(r, g));
  assert.equal(receipt.payload.classification, "APPLIED_VERIFIED");
  assert.equal(receipt.payload.recoveredAfterRestart, true);
  assert.equal(r.canonicalWriter.writeCount, 1);
  assert.equal((await reopened.events()).filter((e) => e.payload.eventType === "apply_committed").length, 1);
});

test("RECOVERY: durable commit + exact candidate remains APPLIED_VERIFIED and never replays writer", async (t) => {
  const r = await buildLocalProductionRoutingApplyFixture(t, "stable-commit");
  const g = await gate(r);
  const first = await r.applyCoordinator.execute(executeInput(r, g));
  assert.equal(first.payload.classification, "APPLIED_VERIFIED");
  assert.equal(r.canonicalWriter.writeCount, 1);
  const reopened = await JsonlLocalProductionRoutingApplyJournal.open(r.journalOptions);
  const recovered = await reopenedCoordinator(r, reopened).recover(recoveryInput(r, g));
  assert.equal(recovered.payload.classification, "APPLIED_VERIFIED");
  assert.equal(r.canonicalWriter.writeCount, 1);
});

test("RECOVERY: unexpected, malformed, or deleted production after reservation becomes durable MANUAL with no automatic action", async (t) => {
  for (const mode of ["unexpected", "malformed", "deleted"]) {
    await t.test(mode, async (t) => {
      const crash = { hit(point) { if (point === "after_reservation_before_write") throw new Error("reservation crash"); } };
      const r = await buildLocalProductionRoutingApplyFixture(t, `manual-${mode}`, { faultInjector: crash });
      const g = await gate(r);
      await assert.rejects(r.applyCoordinator.execute(executeInput(r, g)), /reservation crash/i);
      assert.equal(r.canonicalWriter.writeCount, 0);

      if (mode === "unexpected") {
        const unexpected = await prepareLocalProductionRouterState({
          targetId: r.productionPreFingerprint.payload.targetId,
          installationId: r.productionPreFingerprint.payload.installationId,
          projectId: r.productionPreFingerprint.payload.projectId,
          routeId: r.productionPreFingerprint.payload.routeId,
          capability: r.productionPreFingerprint.payload.capability,
          currentSubjectId: "subject:unexpected-external-state",
          routeRevision: "revision:unexpected-external-state",
          updatedAt: "2026-08-21T04:04:30.000Z",
        });
        writeFileSync(r.productionPath, JSON.stringify(unexpected), "utf8");
      } else if (mode === "malformed") {
        writeFileSync(r.productionPath, "{malformed", "utf8");
      } else {
        unlinkSync(r.productionPath);
      }

      const reopened = await JsonlLocalProductionRoutingApplyJournal.open(r.journalOptions);
      const receipt = await reopenedCoordinator(r, reopened).recover(recoveryInput(r, g));
      assert.equal(receipt.payload.classification, "MANUAL_RECONCILIATION_REQUIRED");
      assert.equal(receipt.payload.productionRouteMutated, false);
      assert.equal(r.canonicalWriter.writeCount, 0);
      assertAllAutomaticFalse(receipt.payload);
      const events = await reopened.events();
      assert.equal(events.at(-1).payload.eventType, "manual_reconciliation_required");
    });
  }
});

test("RECOVERY: production drift after durable commit degrades to MANUAL and never performs automatic rollback", async (t) => {
  const r = await buildLocalProductionRoutingApplyFixture(t, "post-commit-drift");
  const g = await gate(r);
  const applied = await r.applyCoordinator.execute(executeInput(r, g));
  assert.equal(applied.payload.classification, "APPLIED_VERIFIED");
  assert.equal(r.canonicalWriter.writeCount, 1);

  writeFileSync(r.productionPath, "{unreadable-after-commit", "utf8");
  const reopened = await JsonlLocalProductionRoutingApplyJournal.open(r.journalOptions);
  const receipt = await reopenedCoordinator(r, reopened).recover(recoveryInput(r, g));
  assert.equal(receipt.payload.classification, "MANUAL_RECONCILIATION_REQUIRED");
  assert.equal(r.canonicalWriter.writeCount, 1);
  assert.equal((await reopened.events()).at(-1).payload.eventType, "manual_reconciliation_required");
  assertAllAutomaticFalse(receipt.payload);
});

// ---------------------------------------------------------------------------
// Durable journal integrity and stale-writer negative matrix.
// ---------------------------------------------------------------------------

test("DURABLE JOURNAL: stale reader / second writer drift fails closed", async (t) => {
  const crash = { hit(point) { if (point === "after_reservation_before_write") throw new Error("stop after reservation"); } };
  const r = await buildLocalProductionRoutingApplyFixture(t, "journal-stale", { faultInjector: crash });
  const stale = await JsonlLocalProductionRoutingApplyJournal.open(r.journalOptions);
  const g = await gate(r);
  await assert.rejects(r.applyCoordinator.execute(executeInput(r, g)), /stop after reservation/i);
  await assert.rejects(stale.events(), /stale reader|second-writer|drift/i);
});

test("DURABLE JOURNAL: partial, truncated, and rehashed/tampered progression fail closed on reopen", async (t) => {
  await t.test("partial final record", async (t) => {
    const crash = { hit(point) { if (point === "after_reservation_before_write") throw new Error("stop"); } };
    const r = await buildLocalProductionRoutingApplyFixture(t, "journal-partial", { faultInjector: crash });
    const g = await gate(r); await assert.rejects(r.applyCoordinator.execute(executeInput(r, g)), /stop/i);
    appendFileSync(r.journalOptions.filePath, "{\"partial\"", "utf8");
    await assert.rejects(JsonlLocalProductionRoutingApplyJournal.open(r.journalOptions), /partial|truncated/i);
  });

  await t.test("event hash tamper", async (t) => {
    const crash = { hit(point) { if (point === "after_reservation_before_write") throw new Error("stop"); } };
    const r = await buildLocalProductionRoutingApplyFixture(t, "journal-tamper", { faultInjector: crash });
    const g = await gate(r); await assert.rejects(r.applyCoordinator.execute(executeInput(r, g)), /stop/i);
    const raw = readFileSync(r.journalOptions.filePath, "utf8");
    writeFileSync(r.journalOptions.filePath, raw.replace("production apply durably reserved before side effect", "tampered durable reservation"), "utf8");
    await assert.rejects(JsonlLocalProductionRoutingApplyJournal.open(r.journalOptions), /hash|tamper|content-address/i);
  });

  await t.test("truncated bytes", async (t) => {
    const crash = { hit(point) { if (point === "after_reservation_before_write") throw new Error("stop"); } };
    const r = await buildLocalProductionRoutingApplyFixture(t, "journal-truncate", { faultInjector: crash });
    const g = await gate(r); await assert.rejects(r.applyCoordinator.execute(executeInput(r, g)), /stop/i);
    const raw = readFileSync(r.journalOptions.filePath, "utf8");
    writeFileSync(r.journalOptions.filePath, raw.slice(0, -8), "utf8");
    await assert.rejects(JsonlLocalProductionRoutingApplyJournal.open(r.journalOptions), /partial|truncated|json|hash/i);
  });
});

// ---------------------------------------------------------------------------
// Receipt provenance, no-future-authority, and automatic-action invariants.
// ---------------------------------------------------------------------------

test("RECEIPT: exact successful receipt is context-bound to current durable journal and current production state", async (t) => {
  const r = await buildLocalProductionRoutingApplyFixture(t, "receipt-context");
  const g = await gate(r);
  const receipt = await r.applyCoordinator.execute(executeInput(r, g));
  await verifyLocalProductionRoutingApplyReceipt(receipt, { ...executeInput(r, g), journal: r.applyJournal });

  const forgedContext = { ...r.context, backupEvidence: { ...r.backupEvidence, evidenceSha256: "0".repeat(64) } };
  await assert.rejects(verifyLocalProductionRoutingApplyReceipt(receipt, { ...executeInput(r, g), context: forgedContext, journal: r.applyJournal }), /backup|content|binding/i);
});

test("RECEIPT FORGERY: rehashed operation/state/event/timestamp/approval/backup/fingerprint provenance changes are rejected", async (t) => {
  const r = await buildLocalProductionRoutingApplyFixture(t, "receipt-forgery");
  const g = await gate(r);
  const receipt = await r.applyCoordinator.execute(executeInput(r, g));
  const cases = [
    ["operationId", "m5localprodapplyop:forgedoperation000000000000"],
    ["candidateStateId", "m5localprodstate:forgedstate000000000000"],
    ["reservationEventId", "m5localprodapplyevent:forged000000000000"],
    ["completedAt", "2026-08-21T04:06:00.000Z"],
    ["authorizationActor", "operator:forged"],
    ["backupEvidenceId", "m5localprodapplybackup:forged000000000000"],
    ["productionPostRawFileSha256", "1".repeat(64)],
  ];
  for (const [field, value] of cases) {
    const forged = await rehashEnvelope(receipt, { ...receipt.payload, [field]: value }, "m5localprodapplyreceipt", "receiptId", "receiptSha256");
    await assert.rejects(verifyLocalProductionRoutingApplyReceipt(forged, { ...executeInput(r, g), journal: r.applyJournal }), /receipt|provenance|binding|fingerprint|operation|journal/i, field);
  }
});

test("ONE-SHOT: successful apply cannot authorize a second/future production mutation", async (t) => {
  const r = await buildLocalProductionRoutingApplyFixture(t, "one-shot");
  const g = await gate(r);
  const receipt = await r.applyCoordinator.execute(executeInput(r, g));
  assert.equal(receipt.payload.futureProductionMutationAuthorized, false);
  assert.equal(r.canonicalWriter.writeCount, 1);
  await assert.rejects(r.applyCoordinator.execute(executeInput(r, g, { reservedAt: "2026-08-21T04:10:00.000Z", appliedAt: "2026-08-21T04:10:01.000Z", committedAt: "2026-08-21T04:10:02.000Z", completedAt: "2026-08-21T04:10:03.000Z" })), /one-shot|already|journal|prewrite|production.*changed|semantic state drift|rehearsal|drift/i);
  assert.equal(r.canonicalWriter.writeCount, 1);
});

test("AUTOMATIC ACTIONS: retry, rollback, redispatch, promotion, and automatic routing mutation remain false across all successful authority/evidence layers", async (t) => {
  const r = await buildLocalProductionRoutingApplyFixture(t, "automatic-invariants");
  const g = await gate(r);
  const receipt = await r.applyCoordinator.execute(executeInput(r, g));
  assertAllAutomaticFalse(g.proposal.payload);
  assertAllAutomaticFalse(g.authorization.payload);
  assertAllAutomaticFalse(g.executionApproval.payload);
  assertAllAutomaticFalse(g.prewriteSeal.payload);
  assert.equal(r.backupEvidence.payload.automaticRollbackAllowed, false);
  assertAllAutomaticFalse(receipt.payload);
  for (const event of await r.applyJournal.events()) assertAllAutomaticFalse(event.payload);
});

test("ISOLATION PROOF: every apply writer path in this suite remains under the temporary fixture root", async (t) => {
  const r = await buildLocalProductionRoutingApplyFixture(t, "isolation-proof");
  const normalizedRoot = r.root.replaceAll("\\", "/");
  assert.ok(r.productionPath.replaceAll("\\", "/").startsWith(`${normalizedRoot}/`));
  assert.ok(r.journalOptions.filePath.replaceAll("\\", "/").startsWith(`${normalizedRoot}/`));
  assert.ok(r.backupStore.descriptor.directoryPath.replaceAll("\\", "/").startsWith(`${normalizedRoot}/`));
  assert.equal(r.canonicalWriter.descriptor.stateFilePath.replaceAll("\\", "/"), r.productionPath.replaceAll("\\", "/"));
  assert.equal(r.canonicalWriter.writeCount, 0);
});
