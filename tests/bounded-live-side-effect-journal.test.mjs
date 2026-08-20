import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlBoundedLiveSideEffectJournal } from "../dist/index.js";

async function openJournal(t, name = "effects.jsonl") {
  const root = await mkdtemp(join(tmpdir(), "9router-live-effect-test-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const path = join(root, name);
  const options = { filePath: path, maxFileBytes: 512 * 1024, maxEventBytes: 32 * 1024, maxStringBytes: 2048 };
  return { journal: await JsonlBoundedLiveSideEffectJournal.open(options), options };
}

test("bounded-live side-effect journal persists reservation before commit and survives reopen", async (t) => {
  const { journal, options } = await openJournal(t);
  const reserved = await journal.reserve({ kind: "publication", operationId: "publication:1", idempotencyKey: "idem:1", sinkId: "sink:test", authorityId: "m5liveauth:test", subjectId: "opencode:9router/smart", sampleId: "sample-1", outputSha256: "A".repeat(64), reservedAt: "2026-08-19T07:10:00.000Z" });
  assert.match(reserved.eventId, /^m5liveeffect:/);
  assert.deepEqual(journal.inspect().unresolvedOperationIds, ["publication:1"]);
  const reopenedPending = await JsonlBoundedLiveSideEffectJournal.open(options);
  assert.deepEqual(reopenedPending.inspect().unresolvedOperationIds, ["publication:1"]);
  await assert.rejects(() => reopenedPending.reserve({ kind: "publication", operationId: "publication:2", idempotencyKey: "idem:2", sinkId: "sink:test", authorityId: "m5liveauth:test2", subjectId: "opencode:9router/smart", sampleId: "sample-2", outputSha256: "B".repeat(64), reservedAt: "2026-08-19T07:10:01.000Z" }), /unresolved operation/);
  const committed = await reopenedPending.recordCommit({ operationId: "publication:1", externalReference: "publication:ref-1", committedAt: "2026-08-19T07:10:02.000Z" });
  assert.match(committed.eventId, /^m5liveeffect:/);
  const reopened = await JsonlBoundedLiveSideEffectJournal.open(options);
  assert.deepEqual(reopened.inspect().committedOperationIds, ["publication:1"]);
  assert.deepEqual(reopened.inspect().unresolvedOperationIds, []);
  await assert.rejects(() => reopened.reserve({ kind: "publication", operationId: "publication:1", idempotencyKey: "idem:1", sinkId: "sink:test", authorityId: "m5liveauth:test", subjectId: "opencode:9router/smart", sampleId: "sample-1", outputSha256: "A".repeat(64), reservedAt: "2026-08-19T07:10:03.000Z" }), /already exists/);
});

test("bounded-live side-effect error is unknown/manual and secret material is not persisted", async (t) => {
  const { journal, options } = await openJournal(t, "unknown.jsonl");
  await journal.reserve({ kind: "reference_restore", operationId: "restore:1", idempotencyKey: "restore-idem:1", sinkId: "sink:restore", authorityId: "m5rollbackauth:test", subjectId: "opencode:9router/hemat", reservedAt: "2026-08-19T07:11:00.000Z" });
  await journal.recordError({ operationId: "restore:1", observedAt: "2026-08-19T07:11:01.000Z", error: "restore failed api_key=super-secret-value" });
  const serialized = JSON.stringify(journal.list());
  assert.doesNotMatch(serialized, /super-secret-value/);
  assert.match(serialized, /\[redacted\]/);
  assert.deepEqual(journal.inspect().unknownSideEffectOperationIds, ["restore:1"]);
  const reopened = await JsonlBoundedLiveSideEffectJournal.open(options);
  assert.deepEqual(reopened.inspect().unresolvedOperationIds, ["restore:1"]);
  await assert.rejects(() => reopened.recordCommit({ operationId: "restore:1", externalReference: "restore:late", committedAt: "2026-08-19T07:11:02.000Z" }), /requires unresolved reservation/);
});

test("bounded-live side-effect journal fails closed on partial/external file mutation", async (t) => {
  const { journal, options } = await openJournal(t, "drift.jsonl");
  await journal.reserve({ kind: "publication", operationId: "publication:drift", idempotencyKey: "idem:drift", sinkId: "sink:test", authorityId: "m5liveauth:drift", subjectId: "opencode:9router/smart", sampleId: "sample-drift", outputSha256: "C".repeat(64), reservedAt: "2026-08-19T07:12:00.000Z" });
  await appendFile(options.filePath, "tamper", "utf8");
  await assert.rejects(() => journal.recordCommit({ operationId: "publication:drift", externalReference: "publication:drift", committedAt: "2026-08-19T07:12:01.000Z" }), /changed outside this writer/);
  await assert.rejects(() => JsonlBoundedLiveSideEffectJournal.open(options), /not newline-terminated|invalid JSON/);
});
