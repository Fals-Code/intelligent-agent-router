import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { appendFile, writeFile } from "node:fs/promises";
import {
  IsolatedRoutingMutationCoordinator,
  JsonFileIsolatedRoutingTarget,
  JsonlRoutingMutationJournal,
  prepareIsolatedRoutingTargetState,
  verifiedIsolatedRoutingMutationReceiptToEvidence,
  verifyIsolatedRoutingMutationReceipt,
  verifyRoutingMutationRecoveryReport,
} from "../dist/index.js";
import { buildAuthorizedRoutingPromotionFixture } from "./isolated-routing-mutation-fixture.mjs";

const targetOptions = (root, authority, suffix = "primary") => ({
  descriptor: {
    targetKind: "isolated_local_test_router",
    targetId: `isolated-router:${authority.authorization.payload.projectId}:${authority.authorization.payload.routeId}`,
    stateFilePath: join(root, `isolated-router-${suffix}.json`),
  },
  maxStateBytes: 128 * 1024,
  maxStringBytes: 4096,
});

const journalOptions = (root, suffix = "primary") => ({
  filePath: join(root, `routing-mutation-${suffix}.jsonl`),
  maxFileBytes: 2 * 1024 * 1024,
  maxEventBytes: 256 * 1024,
  maxStringBytes: 4096,
});

async function initializedTarget(root, authority, suffix = "primary", overrides = {}) {
  const options = targetOptions(root, authority, suffix);
  return JsonFileIsolatedRoutingTarget.initialize({
    ...options,
    state: {
      targetId: options.descriptor.targetId,
      projectId: authority.authorization.payload.projectId,
      routeId: authority.authorization.payload.routeId,
      capability: authority.authorization.payload.capability,
      currentSubjectId: authority.authorization.payload.referenceSubjectId,
      routeRevision: authority.authorization.payload.routeRevision,
      mutationCount: 0,
      updatedAt: "2026-08-21T03:01:00.000Z",
      ...overrides,
    },
  });
}

async function reopenedTarget(root, authority, suffix = "primary") {
  return JsonFileIsolatedRoutingTarget.open(targetOptions(root, authority, suffix));
}

async function openJournal(root, suffix = "primary") {
  return JsonlRoutingMutationJournal.open(journalOptions(root, suffix));
}

test("isolated authorized route mutation persists exact durable receipt and never grants production authority", async (t) => {
  const fixture = await buildAuthorizedRoutingPromotionFixture(t);
  const target = await initializedTarget(fixture.root, fixture.authority);
  const journal = await openJournal(fixture.root);
  const coordinator = new IsolatedRoutingMutationCoordinator(target, journal);

  const receipt = await coordinator.apply({
    authority: fixture.authority,
    mutatedAt: "2026-08-21T03:07:00.000Z",
    committedAt: "2026-08-21T03:07:01.000Z",
  });

  assert.equal(receipt.payload.targetKind, "isolated_local_test_router");
  assert.equal(receipt.payload.beforeSubjectId, fixture.authorization.payload.referenceSubjectId);
  assert.equal(receipt.payload.afterSubjectId, fixture.authorization.payload.candidateSubjectId);
  assert.equal(receipt.payload.automaticRetryAllowed, false);
  assert.equal(receipt.payload.automaticRollbackAllowed, false);
  assert.equal(receipt.payload.productionRoutingMutationAllowed, false);
  assert.equal(receipt.payload.recoveredAfterRestart, false);

  const state = await target.read();
  assert.equal(state.payload.currentSubjectId, fixture.authorization.payload.candidateSubjectId);
  assert.equal(state.payload.mutationCount, 1);
  assert.equal(state.payload.productionRouter, false);

  await verifyIsolatedRoutingMutationReceipt(receipt, fixture.authority, target, journal);
  const evidence = await verifiedIsolatedRoutingMutationReceiptToEvidence(
    receipt,
    fixture.authority,
    target,
    journal,
    "2026-08-21T03:08:00.000Z",
  );
  assert.equal(evidence.status, "passed");
  assert.match(evidence.reference, /^isolated-routing-mutation:m5routemutation:/);
});

test("stale route precondition rejects before durable reservation or mutation", async (t) => {
  const fixture = await buildAuthorizedRoutingPromotionFixture(t);
  const target = await initializedTarget(fixture.root, fixture.authority, "stale", {
    routeRevision: "route-revision:stale",
  });
  const journal = await openJournal(fixture.root, "stale");
  const coordinator = new IsolatedRoutingMutationCoordinator(target, journal);

  await assert.rejects(
    coordinator.apply({
      authority: fixture.authority,
      mutatedAt: "2026-08-21T03:07:00.000Z",
      committedAt: "2026-08-21T03:07:01.000Z",
    }),
    /precondition is stale|target state drifted/,
  );
  assert.equal(journal.inspect().eventCount, 0);
  assert.equal((await target.read()).payload.mutationCount, 0);
});

test("production/live routing target descriptor is rejected before state creation", async (t) => {
  const fixture = await buildAuthorizedRoutingPromotionFixture(t);
  const options = targetOptions(fixture.root, fixture.authority, "production");
  await assert.rejects(
    JsonFileIsolatedRoutingTarget.initialize({
      ...options,
      descriptor: { ...options.descriptor, targetKind: "production_router" },
      state: {
        targetId: options.descriptor.targetId,
        projectId: fixture.authorization.payload.projectId,
        routeId: fixture.authorization.payload.routeId,
        capability: fixture.authorization.payload.capability,
        currentSubjectId: fixture.authorization.payload.referenceSubjectId,
        routeRevision: fixture.authorization.payload.routeRevision,
        mutationCount: 0,
        updatedAt: "2026-08-21T03:01:00.000Z",
      },
    }),
    /Production\/live routing targets are forbidden/,
  );
});

test("one promotion authorization cannot be dispatched twice", async (t) => {
  const fixture = await buildAuthorizedRoutingPromotionFixture(t);
  const target = await initializedTarget(fixture.root, fixture.authority, "duplicate");
  const journal = await openJournal(fixture.root, "duplicate");
  const coordinator = new IsolatedRoutingMutationCoordinator(target, journal);

  await coordinator.apply({
    authority: fixture.authority,
    mutatedAt: "2026-08-21T03:07:00.000Z",
    committedAt: "2026-08-21T03:07:01.000Z",
  });
  await assert.rejects(
    coordinator.apply({
      authority: fixture.authority,
      mutatedAt: "2026-08-21T03:09:00.000Z",
      committedAt: "2026-08-21T03:09:01.000Z",
    }),
    /precondition is stale|already been used|target state drifted/,
  );
  assert.equal((await target.read()).payload.mutationCount, 1);
});

test("restart after durable reservation but before apply proves NOT_APPLIED_SAFE without blind retry", async (t) => {
  const fixture = await buildAuthorizedRoutingPromotionFixture(t);
  const target = await initializedTarget(fixture.root, fixture.authority, "reserved-crash");
  const journal = await openJournal(fixture.root, "reserved-crash");
  const coordinator = new IsolatedRoutingMutationCoordinator(target, journal);

  await assert.rejects(
    coordinator.apply({
      authority: fixture.authority,
      mutatedAt: "2026-08-21T03:07:00.000Z",
      committedAt: "2026-08-21T03:07:01.000Z",
      faultInjector: { hit(point) { if (point === "after_reservation") throw new Error("INJECTED_CRASH_AFTER_RESERVATION"); } },
    }),
    /INJECTED_CRASH_AFTER_RESERVATION/,
  );
  assert.equal((await target.read()).payload.mutationCount, 0);
  assert.equal(journal.inspect().unresolvedOperationIds.length, 1);

  const restartedTarget = await reopenedTarget(fixture.root, fixture.authority, "reserved-crash");
  const restartedJournal = await openJournal(fixture.root, "reserved-crash");
  const restarted = new IsolatedRoutingMutationCoordinator(restartedTarget, restartedJournal);
  const report = await restarted.reconcile({
    authority: fixture.authority,
    observedAt: "2026-08-21T03:08:00.000Z",
  });
  await verifyRoutingMutationRecoveryReport(report);
  assert.equal(report.payload.classification, "NOT_APPLIED_SAFE");
  assert.equal(report.payload.explicitOperatorActionRequired, true);
  assert.equal(report.payload.automaticRetryAllowed, false);
  assert.equal((await restartedTarget.read()).payload.mutationCount, 0);
  assert.equal(restartedJournal.inspect().notAppliedOperationIds.length, 1);
});

test("restart after apply but before durable commit reconciles COMMITTED without duplicate mutation", async (t) => {
  const fixture = await buildAuthorizedRoutingPromotionFixture(t);
  const target = await initializedTarget(fixture.root, fixture.authority, "apply-crash");
  const journal = await openJournal(fixture.root, "apply-crash");
  const coordinator = new IsolatedRoutingMutationCoordinator(target, journal);

  await assert.rejects(
    coordinator.apply({
      authority: fixture.authority,
      mutatedAt: "2026-08-21T03:07:00.000Z",
      committedAt: "2026-08-21T03:07:01.000Z",
      faultInjector: { hit(point) { if (point === "after_apply_before_commit") throw new Error("INJECTED_CRASH_AFTER_APPLY"); } },
    }),
    /INJECTED_CRASH_AFTER_APPLY/,
  );
  const stateAfterCrash = await target.read();
  assert.equal(stateAfterCrash.payload.currentSubjectId, fixture.authorization.payload.candidateSubjectId);
  assert.equal(stateAfterCrash.payload.mutationCount, 1);
  assert.equal(journal.inspect().unresolvedOperationIds.length, 1);

  const restartedTarget = await reopenedTarget(fixture.root, fixture.authority, "apply-crash");
  const restartedJournal = await openJournal(fixture.root, "apply-crash");
  const restarted = new IsolatedRoutingMutationCoordinator(restartedTarget, restartedJournal);
  const report = await restarted.reconcile({
    authority: fixture.authority,
    observedAt: "2026-08-21T03:08:00.000Z",
  });
  await verifyRoutingMutationRecoveryReport(report);
  assert.equal(report.payload.classification, "COMMITTED");
  assert.equal(report.payload.explicitOperatorActionRequired, false);
  assert.equal((await restartedTarget.read()).payload.mutationCount, 1);
  assert.equal(restartedJournal.inspect().committedOperationIds.length, 1);

  const secondReport = await restarted.reconcile({
    authority: fixture.authority,
    observedAt: "2026-08-21T03:09:00.000Z",
  });
  assert.equal(secondReport.payload.classification, "COMMITTED");
  assert.equal((await restartedTarget.read()).payload.mutationCount, 1);
});

test("restart with unexpected route state fails closed to manual reconciliation", async (t) => {
  const fixture = await buildAuthorizedRoutingPromotionFixture(t);
  const target = await initializedTarget(fixture.root, fixture.authority, "unexpected");
  const journal = await openJournal(fixture.root, "unexpected");
  const coordinator = new IsolatedRoutingMutationCoordinator(target, journal);

  await assert.rejects(
    coordinator.apply({
      authority: fixture.authority,
      mutatedAt: "2026-08-21T03:07:00.000Z",
      committedAt: "2026-08-21T03:07:01.000Z",
      faultInjector: { hit(point) { if (point === "after_reservation") throw new Error("INJECTED_CRASH_FOR_UNEXPECTED_STATE"); } },
    }),
    /INJECTED_CRASH_FOR_UNEXPECTED_STATE/,
  );

  const options = targetOptions(fixture.root, fixture.authority, "unexpected");
  const unexpected = await prepareIsolatedRoutingTargetState({
    targetId: options.descriptor.targetId,
    projectId: fixture.authorization.payload.projectId,
    routeId: fixture.authorization.payload.routeId,
    capability: fixture.authorization.payload.capability,
    currentSubjectId: "opencode:9router/unexpected",
    routeRevision: "route-revision:unexpected",
    mutationCount: 1,
    updatedAt: "2026-08-21T03:07:30.000Z",
  }, options.descriptor, options.maxStateBytes, options.maxStringBytes);
  await writeFile(options.descriptor.stateFilePath, `${JSON.stringify(unexpected)}\n`, "utf8");

  const restartedTarget = await reopenedTarget(fixture.root, fixture.authority, "unexpected");
  const restartedJournal = await openJournal(fixture.root, "unexpected");
  const restarted = new IsolatedRoutingMutationCoordinator(restartedTarget, restartedJournal);
  const report = await restarted.reconcile({
    authority: fixture.authority,
    observedAt: "2026-08-21T03:08:00.000Z",
  });
  assert.equal(report.payload.classification, "MANUAL_RECONCILIATION_REQUIRED");
  assert.equal(report.payload.explicitOperatorActionRequired, true);
  assert.equal(report.payload.automaticMutationAllowed, false);
  assert.equal(restartedJournal.inspect().manualReconciliationOperationIds.length, 1);
});

test("routing mutation journal partial write is detected on restart", async (t) => {
  const fixture = await buildAuthorizedRoutingPromotionFixture(t);
  const target = await initializedTarget(fixture.root, fixture.authority, "partial-journal");
  const journal = await openJournal(fixture.root, "partial-journal");
  const coordinator = new IsolatedRoutingMutationCoordinator(target, journal);

  await assert.rejects(
    coordinator.apply({
      authority: fixture.authority,
      mutatedAt: "2026-08-21T03:07:00.000Z",
      committedAt: "2026-08-21T03:07:01.000Z",
      faultInjector: { hit(point) { if (point === "after_reservation") throw new Error("INJECTED_CRASH_FOR_PARTIAL_JOURNAL"); } },
    }),
    /INJECTED_CRASH_FOR_PARTIAL_JOURNAL/,
  );
  await appendFile(journal.filePath, "{partial", "utf8");
  await assert.rejects(
    JsonlRoutingMutationJournal.open(journalOptions(fixture.root, "partial-journal")),
    /not newline-terminated|invalid JSON|partial write/,
  );
});

test("receipt semantic re-hash cannot forge automatic retry authority", async (t) => {
  const fixture = await buildAuthorizedRoutingPromotionFixture(t);
  const target = await initializedTarget(fixture.root, fixture.authority, "forged-receipt");
  const journal = await openJournal(fixture.root, "forged-receipt");
  const coordinator = new IsolatedRoutingMutationCoordinator(target, journal);
  const receipt = await coordinator.apply({
    authority: fixture.authority,
    mutatedAt: "2026-08-21T03:07:00.000Z",
    committedAt: "2026-08-21T03:07:01.000Z",
  });
  const payload = { ...receipt.payload, automaticRetryAllowed: true };
  const receiptSha256 = await sha256Canonical(payload);
  const forged = {
    schemaVersion: 1,
    algorithm: "sha256",
    receiptId: `m5routemutation:${receiptSha256.slice(0, 32).toLowerCase()}`,
    receiptSha256,
    payload,
  };
  await assert.rejects(
    verifyIsolatedRoutingMutationReceipt(forged, fixture.authority, target, journal),
    /cannot grant automatic\/production authority/,
  );
});

test("forged promotion authorization cannot disable explicit mutation authority requirement", async (t) => {
  const fixture = await buildAuthorizedRoutingPromotionFixture(t);
  const target = await initializedTarget(fixture.root, fixture.authority, "forged-auth");
  const journal = await openJournal(fixture.root, "forged-auth");
  const coordinator = new IsolatedRoutingMutationCoordinator(target, journal);

  const payload = { ...fixture.authorization.payload, routingMutationAuthorized: false };
  const authorizationSha256 = await sha256Canonical(payload);
  const forgedAuthorization = {
    schemaVersion: 1,
    algorithm: "sha256",
    authorizationId: `m5routeauth:${authorizationSha256.slice(0, 32).toLowerCase()}`,
    authorizationSha256,
    payload,
  };
  const authority = { ...fixture.authority, authorization: forgedAuthorization };
  await assert.rejects(
    coordinator.apply({
      authority,
      mutatedAt: "2026-08-21T03:07:00.000Z",
      committedAt: "2026-08-21T03:07:01.000Z",
    }),
    /decision\/eligibility state is invalid|requires explicit allowed routing promotion authorization|scope drift/,
  );
  assert.equal(journal.inspect().eventCount, 0);
  assert.equal((await target.read()).payload.mutationCount, 0);
});

async function sha256Canonical(value) {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(sortJson(value))),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortJson(child)]),
  );
}
