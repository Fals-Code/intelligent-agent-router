import assert from "node:assert/strict";
import test from "node:test";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import {
  JsonFileLocalProductionRehearsalTarget,
  JsonlLocalProductionRehearsalJournal,
  LocalProductionAdapterRehearsalCoordinator,
  prepareLocalProductionRoutingReadinessSourceSnapshot,
  verifyLocalProductionAdapterRehearsalReceipt,
} from "../dist/index.js";
import { buildLocalProductionAdapterRehearsalFixture } from "./local-production-adapter-rehearsal-fixture.mjs";

function candidateTimes(offset = 0) {
  return {
    reservedAt: `2026-08-21T03:18:${String(offset).padStart(2, "0")}.000Z`,
    appliedAt: `2026-08-21T03:18:${String(offset + 1).padStart(2, "0")}.000Z`,
    committedAt: `2026-08-21T03:18:${String(offset + 2).padStart(2, "0")}.000Z`,
  };
}

function restoreTimes(offset = 0) {
  return {
    reservedAt: `2026-08-21T03:19:${String(offset).padStart(2, "0")}.000Z`,
    restoredAt: `2026-08-21T03:19:${String(offset + 1).padStart(2, "0")}.000Z`,
    committedAt: `2026-08-21T03:19:${String(offset + 2).padStart(2, "0")}.000Z`,
  };
}

function coordinator(ready, journal = ready.rehearsalJournal, faultInjector) {
  return new LocalProductionAdapterRehearsalCoordinator(
    ready.productionTarget,
    ready.rehearsalTarget,
    journal,
    faultInjector,
  );
}

async function completeRehearsal(ready) {
  const pre = await ready.productionTarget.fingerprint("2026-08-21T03:17:30.000Z");
  const c = coordinator(ready);
  await c.applyCandidate({ authority: ready.authority, ...candidateTimes() });
  await c.restoreReference({ authority: ready.authority, ...restoreTimes() });
  const receipt = await c.finalize({ authority: ready.authority, productionPreFingerprint: pre, completedAt: "2026-08-21T03:20:00.000Z" });
  return { pre, receipt };
}

async function sha256Canonical(value) {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(sortJson(value))),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, sortJson(child)]));
}

test("rehearsal mutates and restores clone while production remains byte-for-byte unchanged", async (t) => {
  const ready = await buildLocalProductionAdapterRehearsalFixture(t, "happy");
  const rawBefore = readFileSync(ready.productionPath, "utf8");
  const { pre, receipt } = await completeRehearsal(ready);
  const rawAfter = readFileSync(ready.productionPath, "utf8");
  assert.equal(rawAfter, rawBefore);
  assert.equal(receipt.payload.classification, "REHEARSAL_PASSED");
  assert.equal(receipt.payload.productionRouteMutated, false);
  assert.equal(receipt.payload.productionRoutingMutationAuthorized, false);
  assert.equal(receipt.payload.automaticRetryAllowed, false);
  assert.equal(receipt.payload.automaticRollbackAllowed, false);
  assert.equal(receipt.payload.automaticRedispatchAllowed, false);
  const restored = await ready.rehearsalTarget.read();
  assert.equal(restored.payload.currentSubjectId, ready.targetSnapshot.payload.currentSubjectId);
  assert.equal(restored.payload.routeRevision, ready.targetSnapshot.payload.routeRevision);
  await verifyLocalProductionAdapterRehearsalReceipt(receipt, ready.authority, pre, ready.productionTarget, ready.rehearsalTarget, ready.rehearsalJournal);
});

test("production descriptor cannot be used as rehearsal writer and clone cannot alias production path", async (t) => {
  const ready = await buildLocalProductionAdapterRehearsalFixture(t, "descriptor-reject");
  await assert.rejects(
    JsonFileLocalProductionRehearsalTarget.initialize({
      descriptor: { ...ready.rehearsalDescriptor, targetKind: "local_production_router" },
      productionTarget: ready.productionTarget,
      initializedAt: "2026-08-21T03:17:10.000Z",
      maxStateBytes: 128 * 1024,
    }),
    /rehearsal-only/,
  );
  await assert.rejects(
    JsonFileLocalProductionRehearsalTarget.initialize({
      descriptor: { ...ready.rehearsalDescriptor, targetId: "rehearsal:alias-path", stateFilePath: ready.productionPath },
      productionTarget: ready.productionTarget,
      initializedAt: "2026-08-21T03:17:10.000Z",
      maxStateBytes: 128 * 1024,
    }),
    /aliases production path/,
  );
});

test("candidate crash after reservation reconciles NOT_APPLIED_SAFE without blind retry", async (t) => {
  const ready = await buildLocalProductionAdapterRehearsalFixture(t, "candidate-reservation-crash");
  const fault = { hit(point) { if (point === "after_candidate_reservation") throw new Error("simulated candidate reservation crash"); } };
  await assert.rejects(coordinator(ready, ready.rehearsalJournal, fault).applyCandidate({ authority: ready.authority, ...candidateTimes() }), /simulated candidate reservation crash/);
  const reopenedJournal = await JsonlLocalProductionRehearsalJournal.open(ready.rehearsalJournalOptions);
  const reopenedTarget = JsonFileLocalProductionRehearsalTarget.open({ descriptor: ready.rehearsalDescriptor, maxStateBytes: 128 * 1024 });
  const reopened = new LocalProductionAdapterRehearsalCoordinator(ready.productionTarget, reopenedTarget, reopenedJournal);
  const report = await reopened.reconcile({ authority: ready.authority, phase: "candidate", observedAt: "2026-08-21T03:18:10.000Z" });
  assert.equal(report.classification, "NOT_APPLIED_SAFE");
  assert.equal(report.explicitOperatorActionRequired, true);
  await assert.rejects(reopened.applyCandidate({ authority: ready.authority, ...candidateTimes(20) }), /already exists/);
});

test("candidate crash after clone apply reconciles durable commit without duplicate write", async (t) => {
  const ready = await buildLocalProductionAdapterRehearsalFixture(t, "candidate-apply-crash");
  const fault = { hit(point) { if (point === "after_candidate_apply_before_commit") throw new Error("simulated candidate apply crash"); } };
  await assert.rejects(coordinator(ready, ready.rehearsalJournal, fault).applyCandidate({ authority: ready.authority, ...candidateTimes() }), /simulated candidate apply crash/);
  const stateAfterCrash = await ready.rehearsalTarget.read();
  const reopenedJournal = await JsonlLocalProductionRehearsalJournal.open(ready.rehearsalJournalOptions);
  const reopenedTarget = JsonFileLocalProductionRehearsalTarget.open({ descriptor: ready.rehearsalDescriptor, maxStateBytes: 128 * 1024 });
  const reopened = new LocalProductionAdapterRehearsalCoordinator(ready.productionTarget, reopenedTarget, reopenedJournal);
  const report = await reopened.reconcile({ authority: ready.authority, phase: "candidate", observedAt: "2026-08-21T03:18:10.000Z" });
  assert.equal(report.classification, "COMMITTED");
  assert.equal((await reopenedTarget.read()).stateId, stateAfterCrash.stateId);
  await assert.rejects(reopened.applyCandidate({ authority: ready.authority, ...candidateTimes(20) }), /already exists/);
  await reopened.restoreReference({ authority: ready.authority, ...restoreTimes() });
});

test("restore crash after apply reconciles commit and final receipt without duplicate restore", async (t) => {
  const ready = await buildLocalProductionAdapterRehearsalFixture(t, "restore-apply-crash");
  const pre = await ready.productionTarget.fingerprint("2026-08-21T03:17:30.000Z");
  await coordinator(ready).applyCandidate({ authority: ready.authority, ...candidateTimes() });
  const fault = { hit(point) { if (point === "after_restore_apply_before_commit") throw new Error("simulated restore apply crash"); } };
  await assert.rejects(coordinator(ready, ready.rehearsalJournal, fault).restoreReference({ authority: ready.authority, ...restoreTimes() }), /simulated restore apply crash/);
  const restoredAfterCrash = await ready.rehearsalTarget.read();
  const reopenedJournal = await JsonlLocalProductionRehearsalJournal.open(ready.rehearsalJournalOptions);
  const reopenedTarget = JsonFileLocalProductionRehearsalTarget.open({ descriptor: ready.rehearsalDescriptor, maxStateBytes: 128 * 1024 });
  const reopened = new LocalProductionAdapterRehearsalCoordinator(ready.productionTarget, reopenedTarget, reopenedJournal);
  const report = await reopened.reconcile({ authority: ready.authority, phase: "restore", observedAt: "2026-08-21T03:19:10.000Z" });
  assert.equal(report.classification, "COMMITTED");
  assert.equal((await reopenedTarget.read()).stateId, restoredAfterCrash.stateId);
  await assert.rejects(reopened.restoreReference({ authority: ready.authority, ...restoreTimes(20) }), /already exists/);
  const receipt = await reopened.finalize({ authority: ready.authority, productionPreFingerprint: pre, completedAt: "2026-08-21T03:20:00.000Z" });
  assert.equal(receipt.payload.restoreRecoveredAfterRestart, true);
});

test("restore reservation crash is NOT_APPLIED_SAFE and never automatic rollback", async (t) => {
  const ready = await buildLocalProductionAdapterRehearsalFixture(t, "restore-reservation-crash");
  await coordinator(ready).applyCandidate({ authority: ready.authority, ...candidateTimes() });
  const fault = { hit(point) { if (point === "after_restore_reservation") throw new Error("simulated restore reservation crash"); } };
  await assert.rejects(coordinator(ready, ready.rehearsalJournal, fault).restoreReference({ authority: ready.authority, ...restoreTimes() }), /simulated restore reservation crash/);
  const reopenedJournal = await JsonlLocalProductionRehearsalJournal.open(ready.rehearsalJournalOptions);
  const reopened = new LocalProductionAdapterRehearsalCoordinator(ready.productionTarget, ready.rehearsalTarget, reopenedJournal);
  const report = await reopened.reconcile({ authority: ready.authority, phase: "restore", observedAt: "2026-08-21T03:19:10.000Z" });
  assert.equal(report.classification, "NOT_APPLIED_SAFE");
  assert.equal(report.automaticRollbackAllowed, false);
});

test("stale journal reader fails closed after a second writer changes durable state", async (t) => {
  const ready = await buildLocalProductionAdapterRehearsalFixture(t, "stale-journal");
  const staleReader = ready.rehearsalJournal;
  const writer = await JsonlLocalProductionRehearsalJournal.open(ready.rehearsalJournalOptions);
  const fault = { hit(point) { if (point === "after_candidate_reservation") throw new Error("stop after writer reservation"); } };
  await assert.rejects(coordinator(ready, writer, fault).applyCandidate({ authority: ready.authority, ...candidateTimes() }), /stop after writer reservation/);
  await assert.rejects(staleReader.assertFreshRead(), /durable state changed/);
});

test("truncated journal fails closed on reopen", async (t) => {
  const ready = await buildLocalProductionAdapterRehearsalFixture(t, "truncated-journal");
  const fault = { hit(point) { if (point === "after_candidate_reservation") throw new Error("stop"); } };
  await assert.rejects(coordinator(ready, ready.rehearsalJournal, fault).applyCandidate({ authority: ready.authority, ...candidateTimes() }), /stop/);
  const raw = readFileSync(ready.rehearsalJournalOptions.filePath, "utf8");
  writeFileSync(ready.rehearsalJournalOptions.filePath, raw.slice(0, -2), "utf8");
  await assert.rejects(JsonlLocalProductionRehearsalJournal.open(ready.rehearsalJournalOptions), /truncated or partial/);
});

test("stale adapter or main source authority rejects before rehearsal write", async (t) => {
  const ready = await buildLocalProductionAdapterRehearsalFixture(t, "source-drift");
  const source = ready.sourceSnapshot.payload;
  const driftedSource = await prepareLocalProductionRoutingReadinessSourceSnapshot({
    adapterId: source.adapterId,
    adapterVersion: source.adapterVersion,
    adapterSourceSha256: "D".repeat(64),
    mainSourceSha256: source.mainSourceSha256,
    evidenceReferences: source.evidenceReferences,
    adapterSourceVerified: source.adapterSourceVerified,
    mainSourceVerified: source.mainSourceVerified,
    observedAt: source.observedAt,
  });
  const driftedAuthority = { ...ready.authority, currentSourceSnapshot: driftedSource };
  await assert.rejects(coordinator(ready).applyCandidate({ authority: driftedAuthority, ...candidateTimes() }), /source|drift/i);
  assert.equal((await ready.rehearsalTarget.read()).payload.mutationCount, 0);
});

test("provider-specific or secret-bearing unknown production state fields fail closed", async (t) => {
  const ready = await buildLocalProductionAdapterRehearsalFixture(t, "unknown-field");
  const forged = {
    ...ready.productionState,
    payload: { ...ready.productionState.payload, providerToken: "not-a-real-secret" },
  };
  writeFileSync(ready.productionPath, `${JSON.stringify(forged)}\n`, "utf8");
  await assert.rejects(ready.productionTarget.read(), /unknown, missing, or provider-specific fields/);
});

test("production raw-byte drift at any point prevents successful finalization", async (t) => {
  const ready = await buildLocalProductionAdapterRehearsalFixture(t, "production-drift");
  const pre = await ready.productionTarget.fingerprint("2026-08-21T03:17:30.000Z");
  await coordinator(ready).applyCandidate({ authority: ready.authority, ...candidateTimes() });
  appendFileSync(ready.productionPath, "  \n", "utf8");
  await coordinator(ready).restoreReference({ authority: ready.authority, ...restoreTimes() });
  await assert.rejects(coordinator(ready).finalize({ authority: ready.authority, productionPreFingerprint: pre, completedAt: "2026-08-21T03:20:00.000Z" }), /fingerprint drift/);
});

test("self-consistent rehashed receipt cannot forge operation identity or production authority", async (t) => {
  const ready = await buildLocalProductionAdapterRehearsalFixture(t, "receipt-forgery");
  const { pre, receipt } = await completeRehearsal(ready);
  for (const payloadPatch of [
    { operationId: "local-production-rehearsal:forged" },
    { productionRoutingMutationAuthorized: true },
  ]) {
    const payload = { ...receipt.payload, ...payloadPatch };
    const sha = await sha256Canonical(payload);
    const forged = {
      ...receipt,
      receiptSha256: sha,
      receiptId: `m5localprodrehearsal:${sha.slice(0, 32).toLowerCase()}`,
      payload,
    };
    await assert.rejects(
      verifyLocalProductionAdapterRehearsalReceipt(forged, ready.authority, pre, ready.productionTarget, ready.rehearsalTarget, ready.rehearsalJournal),
      /authority|operation|safety/i,
    );
  }
});

test("rehash with provider-specific receipt field is rejected by exact-field boundary", async (t) => {
  const ready = await buildLocalProductionAdapterRehearsalFixture(t, "receipt-extra-field");
  const { pre, receipt } = await completeRehearsal(ready);
  const payload = { ...receipt.payload, providerSchema: { endpoint: "opaque-provider-field" } };
  const sha = await sha256Canonical(payload);
  const forged = {
    ...receipt,
    receiptSha256: sha,
    receiptId: `m5localprodrehearsal:${sha.slice(0, 32).toLowerCase()}`,
    payload,
  };
  await assert.rejects(
    verifyLocalProductionAdapterRehearsalReceipt(forged, ready.authority, pre, ready.productionTarget, ready.rehearsalTarget, ready.rehearsalJournal),
    /unknown, missing, or provider-specific fields/,
  );
});
