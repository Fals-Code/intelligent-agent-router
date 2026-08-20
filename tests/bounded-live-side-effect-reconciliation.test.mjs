import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BoundedLiveSideEffectRecoveryCoordinator,
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

test("recovery returns consistent_committed without probing an already committed operation", async (t) => {
  const { journal } = await fixture(t);
  await journal.reserve(publicationReservation());
  await journal.recordCommit({ operationId: "publication:recovery-1", externalReference: "external:committed", committedAt: "2026-08-20T00:00:02.000Z" });
  let probeCalls = 0;
  const report = await new BoundedLiveSideEffectRecoveryCoordinator().reconcile({
    journal,
    operationId: "publication:recovery-1",
    probe: { id: "probe:unused", async inspect() { probeCalls += 1; throw new Error("must not run"); } },
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
