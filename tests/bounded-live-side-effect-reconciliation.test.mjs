import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BoundedLiveSideEffectRecoveryCoordinator,
  IsolatedLoopbackBoundedLiveSinkClient,
  JsonlBoundedLiveSideEffectJournal,
  verifyBoundedLiveSideEffectRecoveryReport,
} from "../dist/index.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "9router-live-recovery-test-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const options = { filePath: join(root, "effects.jsonl"), maxFileBytes: 512 * 1024, maxEventBytes: 32 * 1024, maxStringBytes: 2048 };
  return { journal: await JsonlBoundedLiveSideEffectJournal.open(options), options };
}

function publicationReservation(overrides = {}) {
  return {
    kind: "publication",
    operationId: "publication:recovery-1",
    idempotencyKey: "idem:recovery-1",
    sinkId: "sink:test",
    authorityId: "m5liveauth:recovery",
    subjectId: "opencode:9router/smart",
    sampleId: "sample-recovery-1",
    outputSha256: "A".repeat(64),
    reservedAt: "2026-08-20T00:00:00.000Z",
    ...overrides,
  };
}

function appliedProbe(overrides = {}) {
  return {
    id: "probe:test",
    async inspect(request) {
      return {
        status: "applied",
        kind: request.kind,
        idempotencyKey: request.idempotencyKey,
        sinkId: request.sinkId,
        subjectId: request.subjectId,
        sampleId: request.sampleId,
        outputSha256: request.outputSha256,
        externalReference: "external:publication-1",
        observedAt: "2026-08-20T00:00:03.000Z",
        ...overrides,
      };
    },
  };
}

async function isolatedStateClient(t, state) {
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/state") {
      const body = JSON.stringify(state);
      response.writeHead(200, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        "cache-control": "no-store",
      });
      response.end(body);
      return;
    }

    response.writeHead(404, {
      "content-type": "application/json",
    });
    response.end(JSON.stringify({ error: "not_found" }));
  });

  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", resolvePromise);
  });

  t.after(async () => {
    if (!server.listening) return;
    await new Promise((resolvePromise, rejectPromise) => {
      server.close((error) => {
        if (error) rejectPromise(error);
        else resolvePromise();
      });
    });
  });

  const address = server.address();
  assert.ok(address && typeof address === "object");

  return new IsolatedLoopbackBoundedLiveSinkClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
    timeoutMs: 2_000,
  });
}

function validSinkState(overrides = {}) {
  return {
    schemaVersion: 1,
    activeSubjectId: "opencode:9router/hemat",
    publications: [],
    restores: [],
    rawOutputPersisted: false,
    ...overrides,
  };
}

function validPublicationStateEntry(overrides = {}) {
  return {
    idempotencyKey: "idem:existing-publication",
    sampleAuthorizationId: "auth:existing-publication",
    sampleId: "sample-existing-publication",
    selectedSubjectId: "opencode:9router/smart",
    selectedRole: "candidate",
    outputSha256: "B".repeat(64),
    outputBytes: 16,
    publicationReference: "isolated-publication:existing-1",
    publishedAt: "2026-08-20T00:00:02.000Z",
    externallyVisible: true,
    ...overrides,
  };
}

function validRestoreStateEntry(overrides = {}) {
  return {
    idempotencyKey: "idem:existing-restore",
    experimentId: "exp:existing-restore",
    targetSubjectId: "opencode:9router/hemat",
    restoreReference: "isolated-restore:existing-1",
    restoredAt: "2026-08-20T00:00:03.000Z",
    activeSubjectId: "opencode:9router/hemat",
    ...overrides,
  };
}
test("recovery returns consistent_committed without probing an already committed operation", async (t) => {
  const { journal } = await fixture(t);
  await journal.reserve(publicationReservation());
  await journal.recordCommit({ operationId: "publication:recovery-1", externalReference: "external:committed", committedAt: "2026-08-20T00:00:02.000Z" });
  let probeCalls = 0;
  const report = await new BoundedLiveSideEffectRecoveryCoordinator().reconcile({
    journal,
    operationId: "publication:recovery-1",
    probe: { id: "", async inspect() { probeCalls += 1; throw new Error("must not run"); } },
  });
  assert.equal(probeCalls, 0);
  assert.equal(report.payload.classification, "consistent_committed");
  assert.equal(report.payload.externalReference, "external:committed");
  assert.equal(report.payload.automaticRetryAllowed, false);
  assert.equal(report.payload.automaticMutationAllowed, false);
  assert.equal(report.payload.explicitOperatorActionRequired, false);
  await verifyBoundedLiveSideEffectRecoveryReport(report);
});

test("recovery proves an externally applied publication without duplicate publication", async (t) => {
  const { journal, options } = await fixture(t);
  await journal.reserve(publicationReservation());
  const reopened = await JsonlBoundedLiveSideEffectJournal.open(options);
  let probeCalls = 0;
  const probe = appliedProbe();
  const report = await new BoundedLiveSideEffectRecoveryCoordinator().reconcile({
    journal: reopened,
    operationId: "publication:recovery-1",
    probe: { ...probe, async inspect(request) { probeCalls += 1; return probe.inspect(request); } },
  });
  assert.equal(probeCalls, 1);
  assert.equal(report.payload.classification, "external_commit_observed");
  assert.equal(report.payload.externalReference, "external:publication-1");
  assert.equal(report.payload.explicitOperatorActionRequired, true);
  assert.equal(report.payload.automaticRetryAllowed, false);
  assert.equal(report.payload.automaticMutationAllowed, false);
  assert.deepEqual(reopened.inspect().unresolvedOperationIds, ["publication:recovery-1"]);
  await verifyBoundedLiveSideEffectRecoveryReport(report);
});

test("authoritative absence after a reservation is explicit-retry eligible but never automatic", async (t) => {
  const { journal } = await fixture(t);
  await journal.reserve(publicationReservation());
  const report = await new BoundedLiveSideEffectRecoveryCoordinator().reconcile({
    journal,
    operationId: "publication:recovery-1",
    probe: {
      id: "probe:absent",
      async inspect(request) {
        return { status: "absent", kind: request.kind, idempotencyKey: request.idempotencyKey, sinkId: request.sinkId, authoritative: true, observedAt: "2026-08-20T00:00:04.000Z" };
      },
    },
  });
  assert.equal(report.payload.classification, "explicit_retry_eligible");
  assert.equal(report.payload.explicitOperatorActionRequired, true);
  assert.equal(report.payload.automaticRetryAllowed, false);
  assert.equal(report.payload.automaticMutationAllowed, false);
  await verifyBoundedLiveSideEffectRecoveryReport(report);
});

test("operation_error stays manual even when a later probe reports absence", async (t) => {
  const { journal } = await fixture(t);
  await journal.reserve(publicationReservation());
  await journal.recordError({ operationId: "publication:recovery-1", observedAt: "2026-08-20T00:00:02.000Z", error: "sink timeout" });
  const report = await new BoundedLiveSideEffectRecoveryCoordinator().reconcile({
    journal,
    operationId: "publication:recovery-1",
    probe: {
      id: "probe:absent-after-error",
      async inspect(request) {
        return { status: "absent", kind: request.kind, idempotencyKey: request.idempotencyKey, sinkId: request.sinkId, authoritative: true, observedAt: "2026-08-20T00:00:05.000Z" };
      },
    },
  });
  assert.equal(report.payload.classification, "manual_reconciliation_required");
  assert.equal(report.payload.explicitOperatorActionRequired, true);
  assert.equal(report.payload.automaticRetryAllowed, false);
  await verifyBoundedLiveSideEffectRecoveryReport(report);
});

test("applied sink evidence with subject/hash drift fails closed to manual reconciliation", async (t) => {
  const { journal } = await fixture(t);
  await journal.reserve(publicationReservation());
  const report = await new BoundedLiveSideEffectRecoveryCoordinator().reconcile({
    journal,
    operationId: "publication:recovery-1",
    probe: appliedProbe({ subjectId: "opencode:9router/hemat" }),
  });
  assert.equal(report.payload.classification, "manual_reconciliation_required");
  assert.match(report.payload.reason, /subjectId/);
  assert.equal(report.payload.automaticMutationAllowed, false);
  await verifyBoundedLiveSideEffectRecoveryReport(report);
});

test("probe failure is sanitized and cannot trigger retry or mutation", async (t) => {
  const { journal } = await fixture(t);
  await journal.reserve(publicationReservation());
  const report = await new BoundedLiveSideEffectRecoveryCoordinator().reconcile({
    journal,
    operationId: "publication:recovery-1",
    probe: { id: "probe:failure", async inspect() { throw new Error("network failed api_key=super-secret"); } },
  });
  assert.equal(report.payload.classification, "manual_reconciliation_required");
  assert.doesNotMatch(report.payload.reason, /super-secret/);
  assert.match(report.payload.reason, /\[redacted\]/);
  assert.equal(report.payload.automaticRetryAllowed, false);
  assert.equal(report.payload.automaticMutationAllowed, false);
  await verifyBoundedLiveSideEffectRecoveryReport(report);
});

test("malformed or duplicate persisted sink state fails manual and never becomes retry eligible", async (t) => {
  const cases = [
    {
      name: "malformed publication entry",
      state: validSinkState({
        publications: [
          validPublicationStateEntry({ unexpectedField: true }),
        ],
      }),
      error: /not allowed/,
    },
    {
      name: "duplicate publication idempotency key",
      state: validSinkState({
        publications: [
          validPublicationStateEntry({
            idempotencyKey: "idem:duplicate-publication",
            publicationReference: "isolated-publication:duplicate-1",
          }),
          validPublicationStateEntry({
            idempotencyKey: "idem:duplicate-publication",
            publicationReference: "isolated-publication:duplicate-2",
          }),
        ],
      }),
      error: /Duplicate publication idempotency key/,
    },
    {
      name: "restore active-subject drift",
      state: validSinkState({
        restores: [
          validRestoreStateEntry({
            targetSubjectId: "opencode:9router/hemat",
            activeSubjectId: "opencode:9router/smart",
          }),
        ],
      }),
      error: /activeSubjectId must equal targetSubjectId/,
    },
    {
      name: "duplicate restore idempotency key",
      state: validSinkState({
        restores: [
          validRestoreStateEntry({
            idempotencyKey: "idem:duplicate-restore",
            restoreReference: "isolated-restore:duplicate-1",
          }),
          validRestoreStateEntry({
            idempotencyKey: "idem:duplicate-restore",
            restoreReference: "isolated-restore:duplicate-2",
          }),
        ],
      }),
      error: /Duplicate restore idempotency key/,
    },
  ];

  for (const [index, item] of cases.entries()) {
    await t.test(item.name, async (st) => {
      const client = await isolatedStateClient(st, item.state);
      const { journal } = await fixture(st);

      const reservation = publicationReservation({
        operationId: `publication:invalid-state-${index}`,
        idempotencyKey: `idem:requested-absent-${index}`,
        sinkId: client.id,
      });

      await journal.reserve(reservation);

      const request = {
        kind: reservation.kind,
        operationId: reservation.operationId,
        idempotencyKey: reservation.idempotencyKey,
        sinkId: reservation.sinkId,
        authorityId: reservation.authorityId,
        subjectId: reservation.subjectId,
        sampleId: reservation.sampleId,
        outputSha256: reservation.outputSha256,
      };

      await assert.rejects(
        () => client.inspect(request),
        item.error
      );

      const report =
        await new BoundedLiveSideEffectRecoveryCoordinator().reconcile({
          journal,
          operationId: reservation.operationId,
          probe: client,
        });

      assert.equal(
        report.payload.classification,
        "manual_reconciliation_required"
      );
      assert.notEqual(
        report.payload.classification,
        "explicit_retry_eligible"
      );
      assert.equal(report.payload.probeStatus, "unknown");
      assert.equal(report.payload.automaticRetryAllowed, false);
      assert.equal(report.payload.automaticMutationAllowed, false);
      assert.equal(
        report.payload.explicitOperatorActionRequired,
        true
      );

      await verifyBoundedLiveSideEffectRecoveryReport(report);
    });
  }
});
test("semantic forgery: valid report modified into impossible combination fails verification despite valid hash", async () => {
  const basePayload = {
    operationId: "publication:forgery-1",
    kind: "publication",
    journalEventId: "event-1",
    journalEventType: "operation_reserved",
    idempotencyKey: "idem:forgery-1",
    sinkId: "sink:test",
    authorityId: "auth:test",
    subjectId: "subject:test",
    sampleId: "sample:forgery-test",
    outputSha256: "A".repeat(64),
    probeId: "probe:test",
    probeStatus: "absent",
    classification: "explicit_retry_eligible",
    automaticRetryAllowed: false,
    automaticMutationAllowed: false,
    explicitOperatorActionRequired: true,
    observedAt: "2026-08-20T00:00:00.000Z",
    reason: "Valid initial state",
  };

  // Case 1: explicit_retry_eligible with externalReference
  const payload1 = { ...basePayload, externalReference: "ext-1" };
  const sha1 = await sha256CanonicalHelper(payload1);
  const report1 = {
    schemaVersion: 1,
    algorithm: "sha256",
    reconciliationId: `m5livereconcile:${sha1.slice(0, 32).toLowerCase()}`,
    reconciliationSha256: sha1,
    payload: payload1,
  };
  await assert.rejects(() => verifyBoundedLiveSideEffectRecoveryReport(report1), /forbids externalReference/);

  // Case 2: consistent_committed with probe fields
  const payload2 = {
    ...basePayload,
    journalEventType: "operation_committed",
    classification: "consistent_committed",
    externalReference: "ext-1",
    explicitOperatorActionRequired: false,
    probeId: "probe:test",
  };
  const sha256_2 = await sha256CanonicalHelper(payload2);
  const report2 = {
    schemaVersion: 1,
    algorithm: "sha256",
    reconciliationId: `m5livereconcile:${sha256_2.slice(0, 32).toLowerCase()}`,
    reconciliationSha256: sha256_2,
    payload: payload2,
  };
  await assert.rejects(() => verifyBoundedLiveSideEffectRecoveryReport(report2), /forbids probe fields/);

  // Case 3: external_commit_observed with operation_committed eventType
  const payload3 = {
    ...basePayload,
    journalEventType: "operation_committed",
    classification: "external_commit_observed",
    probeStatus: "applied",
    externalReference: "ext-1",
  };
  const sha3 = await sha256CanonicalHelper(payload3);
  const report3 = {
    schemaVersion: 1,
    algorithm: "sha256",
    reconciliationId: `m5livereconcile:${sha3.slice(0, 32).toLowerCase()}`,
    reconciliationSha256: sha3,
    payload: payload3,
  };
  await assert.rejects(() => verifyBoundedLiveSideEffectRecoveryReport(report3), /cannot have journalEventType operation_committed/);

  // Case 4: explicitOperatorActionRequired = false on external_commit_observed
  const payload4 = {
    ...basePayload,
    probeStatus: "applied",
    externalReference: "ext-1",
    classification: "external_commit_observed",
    explicitOperatorActionRequired: false,
  };
  const sha4 = await sha256CanonicalHelper(payload4);
  const report4 = {
    schemaVersion: 1,
    algorithm: "sha256",
    reconciliationId: `m5livereconcile:${sha4.slice(0, 32).toLowerCase()}`,
    reconciliationSha256: sha4,
    payload: payload4,
  };
  await assert.rejects(() => verifyBoundedLiveSideEffectRecoveryReport(report4), /explicitOperatorActionRequired must be true/);

  // Case 5: operation_reserved + authoritative absence cannot be manual.
  const payload5 = {
    ...basePayload,
    classification: "manual_reconciliation_required",
  };
  const sha5 = await sha256CanonicalHelper(payload5);
  const report5 = {
    schemaVersion: 1,
    algorithm: "sha256",
    reconciliationId: `m5livereconcile:${sha5.slice(0, 32).toLowerCase()}`,
    reconciliationSha256: sha5,
    payload: payload5,
  };
  await assert.rejects(
    () => verifyBoundedLiveSideEffectRecoveryReport(report5),
    /must be explicit_retry_eligible/
  );

  // Case 6: manual reconciliation cannot omit probe evidence.
  const {
    probeId: omittedProbeId,
    probeStatus: omittedProbeStatus,
    ...payload6Base
  } = basePayload;
  void omittedProbeId;
  void omittedProbeStatus;

  const payload6 = {
    ...payload6Base,
    classification: "manual_reconciliation_required",
  };
  const sha6 = await sha256CanonicalHelper(payload6);
  const report6 = {
    schemaVersion: 1,
    algorithm: "sha256",
    reconciliationId: `m5livereconcile:${sha6.slice(0, 32).toLowerCase()}`,
    reconciliationSha256: sha6,
    payload: payload6,
  };
  await assert.rejects(
    () => verifyBoundedLiveSideEffectRecoveryReport(report6),
    /requires probeId/
  );
});

async function sha256CanonicalHelper(value) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(sortJsonHelper(value))));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
}
function sortJsonHelper(value) {
  if (Array.isArray(value)) return value.map(sortJsonHelper);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sortJsonHelper(item)]));
}
