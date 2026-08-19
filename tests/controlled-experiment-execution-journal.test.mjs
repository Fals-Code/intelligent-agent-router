import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  JsonlControlledExperimentExecutionJournal,
  verifyControlledExperimentExecutionJournalEvent,
} from "../dist/index.js";

async function journalFixture(t, name = "journal.jsonl") {
  const root = await mkdtemp(join(tmpdir(), "9router-execution-journal-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = join(root, name);
  const options = {
    filePath,
    experimentId: "m5experiment:test-experiment",
    maxFileBytes: 512 * 1024,
    maxEventBytes: 32 * 1024,
    maxStringBytes: 2048,
  };
  return { root, filePath, options, journal: await JsonlControlledExperimentExecutionJournal.open(options) };
}

async function reserve(journal, sampleId = "sample-1", exposure = "shadow", liveAssignment = "none") {
  return journal.reserveSample({
    sampleId,
    exposure,
    liveAssignment,
    inputReference: `fixture:${sampleId}`,
    reservedAt: "2026-08-19T00:00:00.000Z",
  });
}

test("execution journal persists reservation -> dispatch -> completion and replays identical counters", async (t) => {
  const { journal, options } = await journalFixture(t);
  const reservation = await reserve(journal);
  await verifyControlledExperimentExecutionJournalEvent(reservation);
  const dispatched = await journal.recordDispatch({
    sampleId: "sample-1",
    adapterId: "adapter:test",
    acceptedAt: "2026-08-19T00:00:01.000Z",
    referenceExecutionReference: "runtime:reference:sample-1",
    candidateExecutionReference: "runtime:candidate:sample-1",
    candidateOutputExternallyVisible: false,
  });
  await verifyControlledExperimentExecutionJournalEvent(dispatched);
  await journal.recordCompletion({
    sampleId: "sample-1",
    completedAt: "2026-08-19T00:00:02.000Z",
    referenceObservationId: "evalobs:reference-1",
    candidateObservationId: "evalobs:candidate-1",
  });
  const state = journal.inspect();
  assert.equal(state.reservedSampleCount, 1);
  assert.equal(state.completedSampleCount, 1);
  assert.equal(state.completedShadowSamples, 1);
  assert.deepEqual(state.unresolvedSampleIds, []);
  assert.equal(state.automaticRedispatchAllowed, false);

  const reopened = await JsonlControlledExperimentExecutionJournal.open(options);
  assert.deepEqual(reopened.inspect(), state);
  assert.equal(reopened.list().length, 3);
});

test("execution journal rejects concurrent or duplicate samples and visibility drift", async (t) => {
  const { journal } = await journalFixture(t);
  await reserve(journal, "pending");
  await assert.rejects(() => reserve(journal, "other"), /unresolved sample|concurrent/);
  await assert.rejects(() => reserve(journal, "pending"), /already exists/);

  const live = await journalFixture(t, "live.jsonl");
  await reserve(live.journal, "live-1", "bounded_live", "candidate");
  await assert.rejects(
    () => live.journal.recordDispatch({
      sampleId: "live-1",
      adapterId: "adapter:test",
      acceptedAt: "2026-08-19T00:00:01.000Z",
      referenceExecutionReference: "runtime:reference:live-1",
      candidateExecutionReference: "runtime:candidate:live-1",
      candidateOutputExternallyVisible: false,
    }),
    /visibility does not match/,
  );
});

test("execution journal replay fails closed on digest tampering and truncation", async (t) => {
  const { journal, filePath, options } = await journalFixture(t);
  await reserve(journal);
  const raw = await readFile(filePath, "utf8");
  const line = JSON.parse(raw.trim());
  line.event.payload.inputReference = "fixture:tampered";
  await writeFile(filePath, `${JSON.stringify(line)}\n`, "utf8");
  await assert.rejects(() => JsonlControlledExperimentExecutionJournal.open(options), /digest does not match canonical payload/);

  const truncated = await journalFixture(t, "truncated.jsonl");
  await reserve(truncated.journal, "sample-t");
  const rawTruncated = await readFile(truncated.filePath, "utf8");
  await writeFile(truncated.filePath, rawTruncated.trimEnd(), "utf8");
  await assert.rejects(() => JsonlControlledExperimentExecutionJournal.open(truncated.options), /not newline-terminated/);
});

test("execution journal detects stale writer and secret-like references", async (t) => {
  const { journal, filePath } = await journalFixture(t);
  await appendFile(filePath, " ", "utf8");
  await assert.rejects(() => reserve(journal), /changed outside this writer/);

  const secret = await journalFixture(t, "secret.jsonl");
  await assert.rejects(
    () => secret.journal.reserveSample({
      sampleId: "secret-1",
      exposure: "shadow",
      liveAssignment: "none",
      inputReference: "authorization=Bearer abcdefghijklmnopqrstuvwxyz",
      reservedAt: "2026-08-19T00:00:00.000Z",
    }),
    /secret-like material/,
  );
});

test("dispatch error is durable unknown side effect and blocks future reservations after restart", async (t) => {
  const { journal, options } = await journalFixture(t);
  await reserve(journal, "unknown-1");
  const event = await journal.recordDispatchError({
    sampleId: "unknown-1",
    adapterId: "adapter:test",
    observedAt: "2026-08-19T00:00:01.000Z",
    error: "provider timeout access_token=never-persist-this",
  });
  assert.equal(event.payload.sideEffectState, "unknown");
  assert.equal(event.payload.manualReconciliationRequired, true);
  assert.doesNotMatch(JSON.stringify(event), /never-persist-this/);

  const reopened = await JsonlControlledExperimentExecutionJournal.open(options);
  assert.deepEqual(reopened.inspect().dispatchErrorSampleIds, ["unknown-1"]);
  await assert.rejects(() => reserve(reopened, "unknown-2"), /unresolved sample|concurrent/);
});
