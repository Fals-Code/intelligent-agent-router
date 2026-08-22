import assert from "node:assert/strict";
import test from "node:test";
import { appendFileSync, linkSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import {
  JsonFileLocalProductionRehearsalTarget,
  JsonlLocalProductionRehearsalJournal,
  LocalProductionAdapterRehearsalCoordinator,
  prepareLocalProductionRoutingReadinessAuthorization,
  prepareLocalProductionRoutingReadinessSourceSnapshot,
  verifyLocalProductionAdapterRehearsalReceipt,
} from "../dist/index.js";
import { buildLocalProductionAdapterRehearsalFixture } from "./local-production-adapter-rehearsal-fixture.mjs";

const candidateTimes = (n = 0) => ({
  reservedAt: `2026-08-21T03:18:${String(n).padStart(2, "0")}.000Z`,
  appliedAt: `2026-08-21T03:18:${String(n + 1).padStart(2, "0")}.000Z`,
  committedAt: `2026-08-21T03:18:${String(n + 2).padStart(2, "0")}.000Z`,
});
const restoreTimes = (n = 0) => ({
  reservedAt: `2026-08-21T03:19:${String(n).padStart(2, "0")}.000Z`,
  restoredAt: `2026-08-21T03:19:${String(n + 1).padStart(2, "0")}.000Z`,
  committedAt: `2026-08-21T03:19:${String(n + 2).padStart(2, "0")}.000Z`,
});

function context(r, authority = r.authority, pre = r.productionPreFingerprint) {
  return { authority, productionPreFingerprint: pre, productionTargetId: r.productionTarget.descriptor.targetId, rehearsalTargetId: r.rehearsalTarget.descriptor.targetId };
}
function coord(r, journal = r.rehearsalJournal, faultInjector, pre = r.productionPreFingerprint) {
  return new LocalProductionAdapterRehearsalCoordinator(r.productionTarget, r.rehearsalTarget, journal, pre, faultInjector);
}
const reopen = (r, authority = r.authority, pre = r.productionPreFingerprint, observedAt = "2026-08-21T03:20:30.000Z") => JsonlLocalProductionRehearsalJournal.open(
  r.rehearsalJournalOptions,
  context(r, authority, pre),
  { productionTarget: r.productionTarget, observedAt },
);
async function complete(r) {
  const c = coord(r);
  await c.applyCandidate({ authority: r.authority, ...candidateTimes() });
  await c.restoreReference({ authority: r.authority, ...restoreTimes() });
  return c.finalize({ authority: r.authority, productionPreFingerprint: r.productionPreFingerprint, completedAt: "2026-08-21T03:20:00.000Z" });
}
async function hash(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(sort(value)));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}
function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sort(v)]));
}
function prefix(id) { return id.slice(0, id.lastIndexOf(":") + 1); }
async function rehash(envelope, patch, idKey, shaKey) {
  const payload = { ...envelope.payload, ...patch };
  const sha = await hash(payload);
  return { ...envelope, [shaKey]: sha, [idKey]: `${prefix(envelope[idKey])}${sha.slice(0, 32).toLowerCase()}`, payload };
}
const rehashEvent = (e, p = {}) => rehash(e, p, "eventId", "eventSha256");
const rehashReceipt = (e, p = {}) => rehash(e, p, "receiptId", "receiptSha256");
const rehashState = (e, p = {}) => rehash(e, p, "stateId", "stateSha256");
const rehashProposal = (e, p = {}) => rehash(e, p, "proposalId", "proposalSha256");
const rehashAuthorization = (e, p = {}) => rehash(e, p, "authorizationId", "authorizationSha256");
const rehashSnapshot = (e, p = {}) => rehash(e, p, "snapshotId", "snapshotSha256");
function entries(r) { return readFileSync(r.rehearsalJournalOptions.filePath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse); }
function writeEntries(r, list) { writeFileSync(r.rehearsalJournalOptions.filePath, `${list.map((e, i) => JSON.stringify({ ...e, sequence: i + 1 })).join("\n")}\n`, "utf8"); }
function writeClone(r, state) { writeFileSync(r.rehearsalDescriptor.stateFilePath, `${JSON.stringify(state)}\n`, "utf8"); }
function driftRaw(r) { appendFileSync(r.productionPath, "  \n", "utf8"); }
async function rejectApply(r, authority, pattern = /readiness|authorization|scope|source|target|drift|context|canonical/i) {
  const before = await r.rehearsalTarget.read();
  await assert.rejects(coord(r).applyCandidate({ authority, ...candidateTimes() }), pattern);
  assert.equal((await r.rehearsalTarget.read()).stateId, before.stateId);
}
async function manualLatest(r, phase) {
  const operationId = `local-production-rehearsal:${r.readinessAuthorization.authorizationId}:${phase}`;
  const e = entries(r).map(({ event }) => event).filter((event) => event.payload.operationId === operationId).at(-1);
  assert.equal(e?.payload.eventType, "rehearsal_manual_reconciliation_required");
  assert.equal(e?.payload.productionRouteMutated, false);
  assert.equal(e?.payload.automaticRetryAllowed, false);
  assert.equal(e?.payload.automaticRollbackAllowed, false);
  assert.equal(e?.payload.automaticRedispatchAllowed, false);
  assert.equal(e?.payload.productionRoutingMutationAuthorized, false);
}
async function unexpectedClone(r, patch = {}) {
  const current = await r.rehearsalTarget.read();
  const forged = await rehashState(current, { currentSubjectId: "subject:unexpected", routeRevision: "revision:unexpected", updatedAt: "2026-08-21T03:18:59.000Z", ...patch });
  writeClone(r, forged);
  return forged;
}
async function mutateEventState(event, side, statePatch) {
  const key = side === "before" ? "beforeState" : "afterState";
  const state = await rehashState(event.payload[key], statePatch);
  return rehashEvent(event, {
    [key]: state,
    [`${side}StateId`]: state.stateId,
    [`${side}StateSha256`]: state.stateSha256,
    [`${side}SubjectId`]: state.payload.currentSubjectId,
    [`${side}RouteRevision`]: state.payload.routeRevision,
  });
}

// SUCCESS BOUNDARY
test("SUCCESS BOUNDARY: REHEARSAL_PASSED is clone-only and never production authority", async (t) => {
  const r = await buildLocalProductionAdapterRehearsalFixture(t, "success-boundary");
  const raw = readFileSync(r.productionPath, "utf8");
  const receipt = await complete(r);
  assert.equal(readFileSync(r.productionPath, "utf8"), raw);
  assert.equal(receipt.payload.classification, "REHEARSAL_PASSED");
  assert.equal(receipt.payload.productionRouteMutated, false);
  assert.equal(receipt.payload.productionRoutingMutationAuthorized, false);
  assert.equal(receipt.payload.automaticRetryAllowed, false);
  assert.equal(receipt.payload.automaticRollbackAllowed, false);
  assert.equal(receipt.payload.automaticRedispatchAllowed, false);
  assert.equal(typeof r.productionTarget.write, "undefined");
  assert.deepEqual(entries(r).map((e) => `${e.event.payload.phase}:${e.event.payload.eventType}`), [
    "candidate:rehearsal_reserved", "candidate:rehearsal_committed", "restore:rehearsal_reserved", "restore:rehearsal_committed",
  ]);
  for (const { event } of entries(r)) {
    assert.equal(event.payload.productionPreFingerprintId, r.productionPreFingerprint.fingerprintId);
    assert.equal(event.payload.productionPreFingerprintSha256, r.productionPreFingerprint.fingerprintSha256);
    assert.equal(event.payload.productionPreRawFileSha256, r.productionPreFingerprint.payload.rawFileSha256);
    assert.equal(event.payload.productionPreStateId, r.productionPreFingerprint.payload.stateId);
    assert.equal(event.payload.productionPreStateSha256, r.productionPreFingerprint.payload.stateSha256);
  }
});

// AUTHORITY MATRIX
test("AUTHORITY: missing/deny/stale/wrong scope/source artifacts fail before clone mutation", async (t) => {
  await t.test("missing readiness authority/context", async (s) => {
    const r = await buildLocalProductionAdapterRehearsalFixture(s, "auth-missing");
    await rejectApply(r, { ...r.authority, readinessContext: undefined }, /context.*required|must be an object/i);
  });
  await t.test("deny readiness authorization", async (s) => {
    const r = await buildLocalProductionAdapterRehearsalFixture(s, "auth-deny");
    const deny = await prepareLocalProductionRoutingReadinessAuthorization({
      proposal: r.readinessProposal, context: r.readinessContext, currentTargetSnapshot: r.targetSnapshot, currentSourceSnapshot: r.sourceSnapshot, workflow: r.workflow,
      authorization: { decision: "deny", actor: "operator:deny", decidedAt: "2026-08-21T03:16:30.000Z", approvalIds: r.workflow.approvalIds, policyReferences: ["policy:deny"] },
    });
    await rejectApply(r, { ...r.authority, readinessAuthorization: deny }, /allowed|allow|readiness/i);
  });
  await t.test("stale readiness authorization", async (s) => {
    const r = await buildLocalProductionAdapterRehearsalFixture(s, "auth-stale");
    const stale = await rehashAuthorization(r.readinessAuthorization, { decidedAt: "2026-08-21T03:00:00.000Z" });
    await rejectApply(r, { ...r.authority, readinessAuthorization: stale }, /predates|stale|authorization/i);
  });
  await t.test("wrong readiness proposal", async (s) => {
    const r = await buildLocalProductionAdapterRehearsalFixture(s, "auth-proposal");
    const proposal = await rehashProposal(r.readinessProposal, { policyReferences: [...r.readinessProposal.payload.policyReferences, "policy:wrong-proposal"] });
    await rejectApply(r, { ...r.authority, readinessProposal: proposal }, /proposal|authorization|scope/i);
  });
  for (const [name, patch] of [
    ["wrong project", { projectId: "project:wrong" }],
    ["wrong route", { routeId: "route:wrong" }],
    ["wrong capability", { capability: "browser.verify" }],
    ["wrong reference", { referenceSubjectId: "subject:wrong-reference" }],
    ["wrong candidate", { candidateSubjectId: "subject:wrong-candidate" }],
  ]) await t.test(name, async (s) => {
    const r = await buildLocalProductionAdapterRehearsalFixture(s, `auth-${name.replaceAll(" ", "-")}`);
    const proposal = await rehashProposal(r.readinessProposal, patch);
    await rejectApply(r, { ...r.authority, readinessProposal: proposal }, /canonical|scope|proposal|readiness/i);
  });
  await t.test("stale target snapshot", async (s) => {
    const r = await buildLocalProductionAdapterRehearsalFixture(s, "auth-target-snapshot");
    const snapshot = await rehashSnapshot(r.targetSnapshot, { capturedAt: "2026-08-21T03:08:01.000Z" });
    await rejectApply(r, { ...r.authority, currentTargetSnapshot: snapshot }, /target snapshot|stale|drift/i);
  });
  await t.test("stale route revision", async (s) => {
    const r = await buildLocalProductionAdapterRehearsalFixture(s, "auth-route-revision");
    const snapshot = await rehashSnapshot(r.targetSnapshot, { routeRevision: "revision:stale" });
    await rejectApply(r, { ...r.authority, currentTargetSnapshot: snapshot }, /target snapshot|stale|drift/i);
  });
  for (const [name, patch] of [["stale adapter SHA", { adapterSourceSha256: "D".repeat(64) }], ["stale main SHA", { mainSourceSha256: "E".repeat(64) }]]) await t.test(name, async (s) => {
    const r = await buildLocalProductionAdapterRehearsalFixture(s, `auth-${name.replaceAll(" ", "-")}`);
    const src = r.sourceSnapshot.payload;
    const snapshot = await prepareLocalProductionRoutingReadinessSourceSnapshot({
      adapterId: src.adapterId, adapterVersion: src.adapterVersion, adapterSourceSha256: patch.adapterSourceSha256 ?? src.adapterSourceSha256,
      mainSourceSha256: patch.mainSourceSha256 ?? src.mainSourceSha256, evidenceReferences: src.evidenceReferences,
      adapterSourceVerified: true, mainSourceVerified: true, observedAt: src.observedAt,
    });
    await rejectApply(r, { ...r.authority, currentSourceSnapshot: snapshot }, /source|stale|drift/i);
  });
});

// TARGET / ISOLATION MATRIX
test("TARGET / ISOLATION: live descriptor, aliases, mismatch, broadened scope, and secret fields are rejected", async (t) => {
  const r = await buildLocalProductionAdapterRehearsalFixture(t, "target-matrix");
  const base = { productionTarget: r.productionTarget, initializedAt: "2026-08-21T03:17:10.000Z", maxStateBytes: 128 * 1024 };
  await assert.rejects(JsonFileLocalProductionRehearsalTarget.initialize({ ...base, descriptor: { ...r.rehearsalDescriptor, targetKind: "local_production_router" } }), /rehearsal-only|descriptor/i);
  await assert.rejects(JsonFileLocalProductionRehearsalTarget.initialize({ ...base, descriptor: { ...r.rehearsalDescriptor, stateFilePath: r.productionPath } }), /aliases production path/i);
  await assert.rejects(JsonFileLocalProductionRehearsalTarget.initialize({ ...base, descriptor: { ...r.rehearsalDescriptor, targetId: r.productionTarget.descriptor.targetId } }), /aliases production identity/i);
  await assert.rejects(JsonFileLocalProductionRehearsalTarget.initialize({ ...base, descriptor: { ...r.rehearsalDescriptor, sourceProductionTargetId: "production:wrong" } }), /sourceProductionTargetId/i);
  await assert.rejects(JsonFileLocalProductionRehearsalTarget.initialize({ ...base, descriptor: { ...r.rehearsalDescriptor, writeScope: "filesystem:any" } }), /unknown, missing, or provider-specific fields/i);
  await assert.rejects(JsonFileLocalProductionRehearsalTarget.initialize({ ...base, descriptor: { ...r.rehearsalDescriptor, providerToken: "not-a-real-secret" } }), /unknown, missing, or provider-specific fields/i);

  const productionRaw = readFileSync(r.productionPath, "utf8");
  const hardlinkPath = `${r.productionPath}.hardlink-alias`;
  linkSync(r.productionPath, hardlinkPath);
  await assert.rejects(
    JsonFileLocalProductionRehearsalTarget.initialize({ ...base, descriptor: { ...r.rehearsalDescriptor, stateFilePath: hardlinkPath } }),
    /physical path aliases|file identity aliases|aliases production/i,
  );
  assert.equal(readFileSync(r.productionPath, "utf8"), productionRaw);
});

// INTERRUPTION MATRIX
test("INTERRUPTION: candidate reservation crash => NOT_APPLIED_SAFE", async (t) => {
  const r = await buildLocalProductionAdapterRehearsalFixture(t, "candidate-reservation-crash");
  const fault = { hit(p) { if (p === "after_candidate_reservation") throw new Error("candidate reservation crash"); } };
  await assert.rejects(coord(r, r.rehearsalJournal, fault).applyCandidate({ authority: r.authority, ...candidateTimes() }), /reservation crash/);
  const j = await reopen(r); const c = new LocalProductionAdapterRehearsalCoordinator(r.productionTarget, r.rehearsalTarget, j, r.productionPreFingerprint);
  const report = await c.reconcile({ authority: r.authority, phase: "candidate", observedAt: "2026-08-21T03:18:10.000Z" });
  assert.equal(report.classification, "NOT_APPLIED_SAFE"); assert.equal(report.automaticRetryAllowed, false);
});

test("INTERRUPTION: candidate apply crash => recovered COMMITTED without duplicate write", async (t) => {
  const r = await buildLocalProductionAdapterRehearsalFixture(t, "candidate-apply-crash");
  const fault = { hit(p) { if (p === "after_candidate_apply_before_commit") throw new Error("candidate apply crash"); } };
  await assert.rejects(coord(r, r.rehearsalJournal, fault).applyCandidate({ authority: r.authority, ...candidateTimes() }), /apply crash/);
  const applied = await r.rehearsalTarget.read(); const j = await reopen(r); const c = new LocalProductionAdapterRehearsalCoordinator(r.productionTarget, r.rehearsalTarget, j, r.productionPreFingerprint);
  const report = await c.reconcile({ authority: r.authority, phase: "candidate", observedAt: "2026-08-21T03:18:10.000Z" });
  assert.equal(report.classification, "COMMITTED"); assert.equal((await r.rehearsalTarget.read()).stateId, applied.stateId); assert.equal((await r.rehearsalTarget.read()).payload.mutationCount, 1);
});

test("INTERRUPTION: restart from durable candidate commit never duplicate-applies", async (t) => {
  const r = await buildLocalProductionAdapterRehearsalFixture(t, "candidate-durable-restart"); await coord(r).applyCandidate({ authority: r.authority, ...candidateTimes() });
  const before = await r.rehearsalTarget.read(); const j = await reopen(r); const c = new LocalProductionAdapterRehearsalCoordinator(r.productionTarget, r.rehearsalTarget, j, r.productionPreFingerprint);
  assert.equal((await c.reconcile({ authority: r.authority, phase: "candidate", observedAt: "2026-08-21T03:18:10.000Z" })).classification, "COMMITTED");
  await assert.rejects(c.applyCandidate({ authority: r.authority, ...candidateTimes(20) }), /already exists|retry is forbidden/i); assert.equal((await r.rehearsalTarget.read()).stateId, before.stateId);
});

test("INTERRUPTION: restore reservation crash => NOT_APPLIED_SAFE and no automatic rollback", async (t) => {
  const r = await buildLocalProductionAdapterRehearsalFixture(t, "restore-reservation-crash"); await coord(r).applyCandidate({ authority: r.authority, ...candidateTimes() });
  const fault = { hit(p) { if (p === "after_restore_reservation") throw new Error("restore reservation crash"); } };
  await assert.rejects(coord(r, r.rehearsalJournal, fault).restoreReference({ authority: r.authority, ...restoreTimes() }), /reservation crash/);
  const j = await reopen(r); const c = new LocalProductionAdapterRehearsalCoordinator(r.productionTarget, r.rehearsalTarget, j, r.productionPreFingerprint);
  const report = await c.reconcile({ authority: r.authority, phase: "restore", observedAt: "2026-08-21T03:19:10.000Z" }); assert.equal(report.classification, "NOT_APPLIED_SAFE"); assert.equal(report.automaticRollbackAllowed, false);
});

test("INTERRUPTION: restore apply crash => recovered COMMITTED without duplicate restore", async (t) => {
  const r = await buildLocalProductionAdapterRehearsalFixture(t, "restore-apply-crash"); await coord(r).applyCandidate({ authority: r.authority, ...candidateTimes() });
  const fault = { hit(p) { if (p === "after_restore_apply_before_commit") throw new Error("restore apply crash"); } };
  await assert.rejects(coord(r, r.rehearsalJournal, fault).restoreReference({ authority: r.authority, ...restoreTimes() }), /apply crash/);
  const restored = await r.rehearsalTarget.read(); const j = await reopen(r); const c = new LocalProductionAdapterRehearsalCoordinator(r.productionTarget, r.rehearsalTarget, j, r.productionPreFingerprint);
  assert.equal((await c.reconcile({ authority: r.authority, phase: "restore", observedAt: "2026-08-21T03:19:10.000Z" })).classification, "COMMITTED"); assert.equal((await r.rehearsalTarget.read()).stateId, restored.stateId); assert.equal((await r.rehearsalTarget.read()).payload.mutationCount, 2);
});

test("INTERRUPTION: unexpected candidate recovery state => MANUAL_RECONCILIATION_REQUIRED", async (t) => {
  const r = await buildLocalProductionAdapterRehearsalFixture(t, "unexpected-candidate"); const fault = { hit(p) { if (p === "after_candidate_reservation") throw new Error("stop"); } };
  await assert.rejects(coord(r, r.rehearsalJournal, fault).applyCandidate({ authority: r.authority, ...candidateTimes() }), /stop/); await unexpectedClone(r);
  const j = await reopen(r); const c = new LocalProductionAdapterRehearsalCoordinator(r.productionTarget, r.rehearsalTarget, j, r.productionPreFingerprint);
  assert.equal((await c.reconcile({ authority: r.authority, phase: "candidate", observedAt: "2026-08-21T03:18:10.000Z" })).classification, "MANUAL_RECONCILIATION_REQUIRED"); await manualLatest(r, "candidate");
});

test("INTERRUPTION: unexpected restore recovery state => MANUAL_RECONCILIATION_REQUIRED", async (t) => {
  const r = await buildLocalProductionAdapterRehearsalFixture(t, "unexpected-restore"); await coord(r).applyCandidate({ authority: r.authority, ...candidateTimes() });
  const fault = { hit(p) { if (p === "after_restore_reservation") throw new Error("stop"); } }; await assert.rejects(coord(r, r.rehearsalJournal, fault).restoreReference({ authority: r.authority, ...restoreTimes() }), /stop/); await unexpectedClone(r);
  const j = await reopen(r); const c = new LocalProductionAdapterRehearsalCoordinator(r.productionTarget, r.rehearsalTarget, j, r.productionPreFingerprint);
  assert.equal((await c.reconcile({ authority: r.authority, phase: "restore", observedAt: "2026-08-21T03:19:10.000Z" })).classification, "MANUAL_RECONCILIATION_REQUIRED"); await manualLatest(r, "restore");
});

// JOURNAL STRUCTURAL MATRIX
test("DURABLE JOURNAL: stale reader, truncation, and event hash tamper fail closed", async (t) => {
  await t.test("second writer / stale reader", async (s) => {
    const r = await buildLocalProductionAdapterRehearsalFixture(s, "journal-stale-reader"); const stale = r.rehearsalJournal; const writer = await JsonlLocalProductionRehearsalJournal.open(r.rehearsalJournalOptions);
    const fault = { hit(p) { if (p === "after_candidate_reservation") throw new Error("stop"); } }; await assert.rejects(coord(r, writer, fault).applyCandidate({ authority: r.authority, ...candidateTimes() }), /stop/); await assert.rejects(stale.assertFreshRead(), /durable state changed/i);
  });
  await t.test("partial/truncated journal", async (s) => {
    const r = await buildLocalProductionAdapterRehearsalFixture(s, "journal-truncated"); const fault = { hit(p) { if (p === "after_candidate_reservation") throw new Error("stop"); } }; await assert.rejects(coord(r, r.rehearsalJournal, fault).applyCandidate({ authority: r.authority, ...candidateTimes() }), /stop/);
    const raw = readFileSync(r.rehearsalJournalOptions.filePath, "utf8"); writeFileSync(r.rehearsalJournalOptions.filePath, raw.slice(0, -2)); await assert.rejects(reopen(r), /truncated|partial/i);
  });
  await t.test("tampered event hash", async (s) => {
    const r = await buildLocalProductionAdapterRehearsalFixture(s, "journal-hash"); const fault = { hit(p) { if (p === "after_candidate_reservation") throw new Error("stop"); } }; await assert.rejects(coord(r, r.rehearsalJournal, fault).applyCandidate({ authority: r.authority, ...candidateTimes() }), /stop/);
    const list = entries(r); list[0].event.eventSha256 = "0".repeat(64); writeEntries(r, list); await assert.rejects(reopen(r), /content address/i);
  });
  await t.test("non-empty reopen requires live production proof", async (s) => {
    const r = await buildLocalProductionAdapterRehearsalFixture(s, "journal-reopen-proof"); await reservationOnly(r, "candidate");
    await assert.rejects(JsonlLocalProductionRehearsalJournal.open(r.rehearsalJournalOptions, context(r)), /live production proof/i);
    await reopen(r);
  });
});

async function reservationOnly(r, phase) {
  if (phase === "restore") await coord(r).applyCandidate({ authority: r.authority, ...candidateTimes() });
  const point = phase === "candidate" ? "after_candidate_reservation" : "after_restore_reservation";
  const fault = { hit(p) { if (p === point) throw new Error("stop"); } };
  if (phase === "candidate") await assert.rejects(coord(r, r.rehearsalJournal, fault).applyCandidate({ authority: r.authority, ...candidateTimes() }), /stop/);
  else await assert.rejects(coord(r, r.rehearsalJournal, fault).restoreReference({ authority: r.authority, ...restoreTimes() }), /stop/);
}

test("DURABLE JOURNAL: orphan/duplicate/invalid phase progression is rejected on reopen", async (t) => {
  await t.test("rehashed orphan candidate commit", async (s) => {
    const r = await buildLocalProductionAdapterRehearsalFixture(s, "orphan-candidate"); await reservationOnly(r, "candidate"); const list = entries(r); list[0].event = await rehashEvent(list[0].event, { eventType: "rehearsal_committed" }); writeEntries(r, list); await assert.rejects(reopen(r), /orphan|candidate commit/i);
  });
  await t.test("rehashed orphan restore commit", async (s) => {
    const r = await buildLocalProductionAdapterRehearsalFixture(s, "orphan-restore"); await reservationOnly(r, "restore"); const list = entries(r); list[2].event = await rehashEvent(list[2].event, { eventType: "rehearsal_committed" }); writeEntries(r, list); await assert.rejects(reopen(r), /orphan|restore commit/i);
  });
  for (const [name, phase, index] of [["duplicate candidate reservation", "candidate", 0], ["duplicate candidate commit", "candidate-full", 1], ["duplicate restore reservation", "restore", 2], ["duplicate restore commit", "full", 3]]) await t.test(name, async (s) => {
    const r = await buildLocalProductionAdapterRehearsalFixture(s, `journal-${name.replaceAll(" ", "-")}`);
    if (phase === "candidate") await reservationOnly(r, "candidate"); else if (phase === "candidate-full") await coord(r).applyCandidate({ authority: r.authority, ...candidateTimes() }); else if (phase === "restore") await reservationOnly(r, "restore"); else { await coord(r).applyCandidate({ authority: r.authority, ...candidateTimes() }); await coord(r).restoreReference({ authority: r.authority, ...restoreTimes() }); }
    const list = entries(r); list.splice(index + 1, 0, structuredClone(list[index])); writeEntries(r, list); await assert.rejects(reopen(r), /duplicate|invalid|orphan/i);
  });
  await t.test("invalid phase progression", async (s) => {
    const r = await buildLocalProductionAdapterRehearsalFixture(s, "invalid-phase"); await reservationOnly(r, "candidate"); const list = entries(r);
    const op = `local-production-rehearsal:${r.readinessAuthorization.authorizationId}:restore`; list[0].event = await rehashEvent(list[0].event, { phase: "restore", operationId: op, idempotencyKey: op }); writeEntries(r, list); await assert.rejects(reopen(r), /restore progression requires/i);
  });
});

test("DURABLE JOURNAL: continuity, candidate/restore authority, timestamp, and fingerprint provenance forgeries are rejected", async (t) => {
  await t.test("before/after continuity drift", async (s) => {
    const r = await buildLocalProductionAdapterRehearsalFixture(s, "continuity"); await reservationOnly(r, "restore"); const list = entries(r); list[2].event = await mutateEventState(list[2].event, "before", { updatedAt: "2026-08-21T03:18:58.000Z" }); writeEntries(r, list); await assert.rejects(reopen(r), /continue exact candidate|before-state/i);
  });
  for (const [name, patch] of [["forged candidate subject", { currentSubjectId: "subject:forged" }], ["forged candidate route revision", { routeRevision: "revision:forged" }]]) await t.test(name, async (s) => {
    const r = await buildLocalProductionAdapterRehearsalFixture(s, `journal-${name.replaceAll(" ", "-")}`); await reservationOnly(r, "candidate"); const list = entries(r); list[0].event = await mutateEventState(list[0].event, "after", patch); writeEntries(r, list); await assert.rejects(reopen(r), /candidate state is not deterministically derived/i);
  });
  for (const [name, patch] of [["forged restore subject", { currentSubjectId: "subject:forged-restore" }], ["forged restore revision", { routeRevision: "revision:forged-restore" }]]) await t.test(name, async (s) => {
    const r = await buildLocalProductionAdapterRehearsalFixture(s, `journal-${name.replaceAll(" ", "-")}`); await reservationOnly(r, "restore"); const list = entries(r); list[2].event = await mutateEventState(list[2].event, "after", patch); writeEntries(r, list); await assert.rejects(reopen(r), /restore after-state|reference state/i);
  });
  await t.test("changed timestamp/provenance", async (s) => {
    const r = await buildLocalProductionAdapterRehearsalFixture(s, "journal-time"); await coord(r).applyCandidate({ authority: r.authority, ...candidateTimes() }); const list = entries(r); list[1].event = await rehashEvent(list[1].event, { observedAt: "2026-08-21T03:17:00.000Z" }); writeEntries(r, list); await assert.rejects(reopen(r), /timestamp predates|commit timestamp/i);
  });
  await t.test("production pre-fingerprint changed", async (s) => {
    const r = await buildLocalProductionAdapterRehearsalFixture(s, "journal-fingerprint"); await reservationOnly(r, "candidate"); const list = entries(r); list[0].event = await rehashEvent(list[0].event, { productionPreRawFileSha256: "F".repeat(64) }); writeEntries(r, list); await assert.rejects(reopen(r), /pre-fingerprint provenance/i);
  });
});

// PRODUCTION IMMUTABILITY MATRIX
async function assertApplyDrift(r, fault) {
  await assert.rejects(coord(r, r.rehearsalJournal, fault).applyCandidate({ authority: r.authority, ...candidateTimes() }), /manual|fingerprint drift/i);
  assert.equal((await r.rehearsalTarget.read()).payload.mutationCount <= 1, true);
}
test("PRODUCTION IMMUTABILITY: raw-byte drift before candidate reservation fails closed", async (t) => {
  const r = await buildLocalProductionAdapterRehearsalFixture(t, "drift-before-candidate"); driftRaw(r); await assertApplyDrift(r); await manualLatest(r, "candidate");
});
test("PRODUCTION IMMUTABILITY: drift after candidate reservation before apply blocks clone write", async (t) => {
  const r = await buildLocalProductionAdapterRehearsalFixture(t, "drift-after-reservation"); const fault = { hit(p) { if (p === "after_candidate_reservation") driftRaw(r); } }; await assertApplyDrift(r, fault); assert.equal((await r.rehearsalTarget.read()).payload.mutationCount, 0); await manualLatest(r, "candidate");
});
test("PRODUCTION IMMUTABILITY: malformed production after candidate reservation is durable MANUAL", async (t) => {
  const r = await buildLocalProductionAdapterRehearsalFixture(t, "proof-loss-after-reservation");
  const productionRaw = readFileSync(r.productionPath, "utf8");
  const fault = { hit(p) { if (p === "after_candidate_reservation") writeFileSync(r.productionPath, "{\n", "utf8"); } };
  await assert.rejects(coord(r, r.rehearsalJournal, fault).applyCandidate({ authority: r.authority, ...candidateTimes() }), /unreadable|unverifiable|manual/i);
  assert.equal((await r.rehearsalTarget.read()).payload.mutationCount, 0);
  assert.deepEqual(entries(r).map((e) => e.event.payload.eventType), ["rehearsal_reserved", "rehearsal_manual_reconciliation_required"]);
  await manualLatest(r, "candidate");
  writeFileSync(r.productionPath, productionRaw, "utf8");
  const j = await reopen(r, r.authority, r.productionPreFingerprint, "2026-08-21T03:20:31.000Z");
  const c = new LocalProductionAdapterRehearsalCoordinator(r.productionTarget, r.rehearsalTarget, j, r.productionPreFingerprint);
  assert.equal((await c.reconcile({ authority: r.authority, phase: "candidate", observedAt: "2026-08-21T03:20:32.000Z" })).classification, "MANUAL_RECONCILIATION_REQUIRED");
});
test("PRODUCTION IMMUTABILITY: drift after candidate apply before commit blocks success commit", async (t) => {
  const r = await buildLocalProductionAdapterRehearsalFixture(t, "drift-after-apply"); const fault = { hit(p) { if (p === "after_candidate_apply_before_commit") driftRaw(r); } }; await assertApplyDrift(r, fault); assert.equal((await r.rehearsalTarget.read()).payload.mutationCount, 1); assert.deepEqual(entries(r).map((e) => e.event.payload.eventType), ["rehearsal_reserved", "rehearsal_manual_reconciliation_required"]);
});
test("PRODUCTION IMMUTABILITY: deleted production after candidate apply is durable MANUAL with no commit", async (t) => {
  const r = await buildLocalProductionAdapterRehearsalFixture(t, "proof-loss-after-apply");
  const productionRaw = readFileSync(r.productionPath, "utf8");
  const fault = { hit(p) { if (p === "after_candidate_apply_before_commit") unlinkSync(r.productionPath); } };
  await assert.rejects(coord(r, r.rehearsalJournal, fault).applyCandidate({ authority: r.authority, ...candidateTimes() }), /unreadable|unverifiable|manual/i);
  assert.equal((await r.rehearsalTarget.read()).payload.mutationCount, 1);
  assert.deepEqual(entries(r).map((e) => e.event.payload.eventType), ["rehearsal_reserved", "rehearsal_manual_reconciliation_required"]);
  await manualLatest(r, "candidate");
  writeFileSync(r.productionPath, productionRaw, "utf8");
  const j = await reopen(r, r.authority, r.productionPreFingerprint, "2026-08-21T03:20:31.000Z");
  const c = new LocalProductionAdapterRehearsalCoordinator(r.productionTarget, r.rehearsalTarget, j, r.productionPreFingerprint);
  assert.equal((await c.reconcile({ authority: r.authority, phase: "candidate", observedAt: "2026-08-21T03:20:32.000Z" })).classification, "MANUAL_RECONCILIATION_REQUIRED");
});
test("PRODUCTION IMMUTABILITY: drift is blocked at reopen and cannot silently recover after restoration", async (t) => {
  const r = await buildLocalProductionAdapterRehearsalFixture(t, "drift-reopen");
  const productionRaw = readFileSync(r.productionPath, "utf8");
  await reservationOnly(r, "candidate");
  driftRaw(r);
  await assert.rejects(reopen(r, r.authority, r.productionPreFingerprint, "2026-08-21T03:20:30.000Z"), /manual|could not be proven|drift/i);
  await manualLatest(r, "candidate");
  writeFileSync(r.productionPath, productionRaw, "utf8");
  const j = await reopen(r, r.authority, r.productionPreFingerprint, "2026-08-21T03:20:31.000Z");
  const c = new LocalProductionAdapterRehearsalCoordinator(r.productionTarget, r.rehearsalTarget, j, r.productionPreFingerprint);
  assert.equal((await c.reconcile({ authority: r.authority, phase: "candidate", observedAt: "2026-08-21T03:20:32.000Z" })).classification, "MANUAL_RECONCILIATION_REQUIRED");
});
test("PRODUCTION IMMUTABILITY: drift before restore blocks clone restore", async (t) => {
  const r = await buildLocalProductionAdapterRehearsalFixture(t, "drift-before-restore"); await coord(r).applyCandidate({ authority: r.authority, ...candidateTimes() }); const candidate = await r.rehearsalTarget.read(); driftRaw(r); await assert.rejects(coord(r).restoreReference({ authority: r.authority, ...restoreTimes() }), /manual|fingerprint drift/i); assert.equal((await r.rehearsalTarget.read()).stateId, candidate.stateId); await manualLatest(r, "restore");
});
test("PRODUCTION IMMUTABILITY: drift after restore write before commit blocks restore success commit", async (t) => {
  const r = await buildLocalProductionAdapterRehearsalFixture(t, "drift-after-restore"); await coord(r).applyCandidate({ authority: r.authority, ...candidateTimes() }); const fault = { hit(p) { if (p === "after_restore_apply_before_commit") driftRaw(r); } }; await assert.rejects(coord(r, r.rehearsalJournal, fault).restoreReference({ authority: r.authority, ...restoreTimes() }), /manual|fingerprint drift/i); assert.deepEqual(entries(r).slice(-2).map((e) => e.event.payload.eventType), ["rehearsal_reserved", "rehearsal_manual_reconciliation_required"]);
});
test("PRODUCTION IMMUTABILITY: drift at finalize => MANUAL and no REHEARSAL_PASSED", async (t) => {
  const r = await buildLocalProductionAdapterRehearsalFixture(t, "drift-finalize"); await coord(r).applyCandidate({ authority: r.authority, ...candidateTimes() }); await coord(r).restoreReference({ authority: r.authority, ...restoreTimes() }); driftRaw(r); await assert.rejects(coord(r).finalize({ authority: r.authority, productionPreFingerprint: r.productionPreFingerprint, completedAt: "2026-08-21T03:20:00.000Z" }), /manual|fingerprint drift/i); await manualLatest(r, "restore");
});
test("PRODUCTION IMMUTABILITY: semantically same JSON with changed raw bytes fails closed", async (t) => {
  const r = await buildLocalProductionAdapterRehearsalFixture(t, "drift-semantic-same"); const parsed = JSON.parse(readFileSync(r.productionPath, "utf8")); writeFileSync(r.productionPath, `  ${JSON.stringify(parsed)}\n`); await assertApplyDrift(r); assert.equal((await r.productionTarget.read()).stateId, r.productionState.stateId);
});
test("PRODUCTION IMMUTABILITY: drift at receipt verification fails closed", async (t) => {
  const r = await buildLocalProductionAdapterRehearsalFixture(t, "drift-receipt"); const receipt = await complete(r); driftRaw(r); await assert.rejects(verifyLocalProductionAdapterRehearsalReceipt(receipt, r.authority, r.productionPreFingerprint, r.productionTarget, r.rehearsalTarget, r.rehearsalJournal), /fingerprint drift/i);
});

// RECEIPT / PROGRESSION FORGERY MATRIX
test("FORGERY: rehashed receipt operation/authority/automatic/state/event/fingerprint/timestamp changes fail", async (t) => {
  const r = await buildLocalProductionAdapterRehearsalFixture(t, "receipt-forgery"); const receipt = await complete(r);
  const cases = [
    ["operation identity", { operationId: "local-production-rehearsal:forged" }],
    ["production authority flag", { productionRoutingMutationAuthorized: true }],
    ["automaticRetryAllowed", { automaticRetryAllowed: true }],
    ["automaticRollbackAllowed", { automaticRollbackAllowed: true }],
    ["automaticRedispatchAllowed", { automaticRedispatchAllowed: true }],
    ["candidate state identity", { candidateStateId: "m5localprodrehearsalstate:forged" }],
    ["candidate event identity", { candidateCommitEventId: "m5localprodrehearsalevent:forged" }],
    ["restore state identity", { restoredStateId: "m5localprodrehearsalstate:forged" }],
    ["restore event identity", { restoreCommitEventId: "m5localprodrehearsalevent:forged" }],
    ["production fingerprint", { productionPreFingerprintSha256: "A".repeat(64) }],
    ["timestamp/provenance", { completedAt: "2026-08-21T03:00:00.000Z" }],
  ];
  for (const [name, patch] of cases) await t.test(name, async () => {
    const forged = await rehashReceipt(receipt, patch); await assert.rejects(verifyLocalProductionAdapterRehearsalReceipt(forged, r.authority, r.productionPreFingerprint, r.productionTarget, r.rehearsalTarget, r.rehearsalJournal), /authority|operation|safety|provenance|journal|timestamp|fingerprint|state/i);
  });
});

test("FORGERY: provider-specific extra receipt field is rejected after rehash", async (t) => {
  const r = await buildLocalProductionAdapterRehearsalFixture(t, "receipt-provider-field"); const receipt = await complete(r); const payload = { ...receipt.payload, providerSchema: { endpoint: "opaque-provider-field" } }; const sha = await hash(payload); const forged = { ...receipt, payload, receiptSha256: sha, receiptId: `m5localprodrehearsal:${sha.slice(0, 32).toLowerCase()}` }; await assert.rejects(verifyLocalProductionAdapterRehearsalReceipt(forged, r.authority, r.productionPreFingerprint, r.productionTarget, r.rehearsalTarget, r.rehearsalJournal), /unknown, missing, or provider-specific fields/i);
});

test("FORGERY: matching rehashed journal + receipt cannot bypass canonical candidate authority", async (t) => {
  const r = await buildLocalProductionAdapterRehearsalFixture(t, "journal-rehash"); const receipt = await complete(r); const list = entries(r);
  const forgedCandidate = await rehashState(list[0].event.payload.afterState, { currentSubjectId: "subject:unauthorized-self-consistent" });
  list[0].event = await rehashEvent(list[0].event, { afterState: forgedCandidate, afterStateId: forgedCandidate.stateId, afterStateSha256: forgedCandidate.stateSha256, afterSubjectId: forgedCandidate.payload.currentSubjectId });
  list[1].event = await rehashEvent(list[1].event, { afterState: forgedCandidate, afterStateId: forgedCandidate.stateId, afterStateSha256: forgedCandidate.stateSha256, afterSubjectId: forgedCandidate.payload.currentSubjectId });
  list[2].event = await rehashEvent(list[2].event, { beforeState: forgedCandidate, beforeStateId: forgedCandidate.stateId, beforeStateSha256: forgedCandidate.stateSha256, beforeSubjectId: forgedCandidate.payload.currentSubjectId });
  list[3].event = await rehashEvent(list[3].event, { beforeState: forgedCandidate, beforeStateId: forgedCandidate.stateId, beforeStateSha256: forgedCandidate.stateSha256, beforeSubjectId: forgedCandidate.payload.currentSubjectId });
  writeEntries(r, list);
  const progression = await hash(list.map((e, i) => ({ eventId: e.event.eventId, eventSha256: e.event.eventSha256, sequence: i + 1 })));
  const forgedReceipt = await rehashReceipt(receipt, { candidateStateId: forgedCandidate.stateId, candidateStateSha256: forgedCandidate.stateSha256, candidateReservationEventId: list[0].event.eventId, candidateReservationEventSha256: list[0].event.eventSha256, candidateCommitEventId: list[1].event.eventId, candidateCommitEventSha256: list[1].event.eventSha256, restoreReservationEventId: list[2].event.eventId, restoreReservationEventSha256: list[2].event.eventSha256, restoreCommitEventId: list[3].event.eventId, restoreCommitEventSha256: list[3].event.eventSha256, journalProgressionSha256: progression });
  assert.notEqual(forgedReceipt.receiptSha256, receipt.receiptSha256);
  await assert.rejects(reopen(r), /candidate state is not deterministically derived/i);
});
