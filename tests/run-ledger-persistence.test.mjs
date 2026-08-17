import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  JsonlRunLedger,
  RUN_LEDGER_SCHEMA_VERSION,
} from "../dist/control-plane/index.js";

const DEFAULT_MAX_FILE_BYTES = 64 * 1024;
const DEFAULT_MAX_RECORD_BYTES = 16 * 1024;

function evidence(kind, overrides = {}) {
  return {
    kind,
    status: "passed",
    reference: `${kind}:ref`,
    producer: "run-ledger-persistence-test",
    collectedAt: "2026-08-18T00:00:00.000Z",
    ...overrides,
  };
}

function ledgerRecord(runId, overrides = {}) {
  return {
    runId,
    projectId: "project-1",
    task: "Persist a bounded 9Router run",
    riskClass: "R2",
    runtimeId: "opencode",
    modelRoute: ["9router/hemat", "9router/review"],
    contextCompilerVersion: "context-v1",
    skills: ["code-review"],
    toolsets: ["read", "edit"],
    workspace: `worktree/${runId}`,
    policyDecisions: ["isolated-worktree", "bounded-tools"],
    approvalIds: [],
    changeReferences: [`commit:${runId}`],
    evidence: [evidence("policy"), evidence("test"), evidence("review")],
    resourceMetrics: { durationMs: 125, toolCalls: 4 },
    traceId: `trace-${runId}`,
    outcome: "succeeded",
    createdAt: "2026-08-18T00:00:00.000Z",
    ...overrides,
  };
}

function openLedger(filePath, overrides = {}) {
  return new JsonlRunLedger({
    filePath,
    maxFileBytes: DEFAULT_MAX_FILE_BYTES,
    maxRecordBytes: DEFAULT_MAX_RECORD_BYTES,
    ...overrides,
  });
}

async function withTempLedger(t) {
  const dir = await mkdtemp(join(tmpdir(), "9router-run-ledger-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return join(dir, "runs.jsonl");
}

test("JsonlRunLedger durably appends versioned records and reloads them after restart", async (t) => {
  const filePath = await withTempLedger(t);
  const ledger = openLedger(filePath);

  ledger.append(ledgerRecord("run-1"));
  ledger.append(
    ledgerRecord("run-2", {
      outcome: "failed",
      failureReason: "deterministic verifier failed",
      evidence: [],
    }),
  );

  const raw = await readFile(filePath, "utf8");
  assert.ok(raw.endsWith("\n"));
  const lines = raw.trimEnd().split("\n");
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).schemaVersion, RUN_LEDGER_SCHEMA_VERSION);
  assert.equal(JSON.parse(lines[1]).schemaVersion, RUN_LEDGER_SCHEMA_VERSION);

  const reloaded = openLedger(filePath);
  assert.deepEqual(
    reloaded.list().map((record) => [record.runId, record.outcome]),
    [["run-1", "succeeded"], ["run-2", "failed"]],
  );
  assert.equal(reloaded.get("run-2")?.failureReason, "deterministic verifier failed");
  assert.ok(Object.isFrozen(reloaded.get("run-1")));
  assert.ok(Object.isFrozen(reloaded.get("run-1")?.evidence));
});

test("JsonlRunLedger rejects evidence-invalid success before writing bytes", async (t) => {
  const filePath = await withTempLedger(t);
  const ledger = openLedger(filePath);

  assert.throws(
    () => ledger.append(ledgerRecord("run-invalid", { evidence: [evidence("policy")] })),
    /Evidence gate rejected successful run/,
  );
  assert.equal(existsSync(filePath), false);
  assert.equal(ledger.list().length, 0);
});

test("JsonlRunLedger rejects non-finite evidence metadata before persistence", async (t) => {
  const filePath = await withTempLedger(t);
  const ledger = openLedger(filePath);
  const invalidEvidence = [
    evidence("policy"),
    evidence("test", { metadata: { durationMs: Number.POSITIVE_INFINITY } }),
    evidence("review"),
  ];

  assert.throws(
    () => ledger.append(ledgerRecord("run-invalid-metadata", { evidence: invalidEvidence })),
    /metadata\.durationMs must be a finite number/,
  );
  assert.equal(existsSync(filePath), false);
});

test("JsonlRunLedger rejects duplicate run IDs after reload without mutating the file", async (t) => {
  const filePath = await withTempLedger(t);
  const ledger = openLedger(filePath);
  ledger.append(ledgerRecord("run-1"));
  const before = await readFile(filePath, "utf8");

  const reloaded = openLedger(filePath);
  assert.throws(() => reloaded.append(ledgerRecord("run-1")), /already exists/);
  assert.equal(await readFile(filePath, "utf8"), before);
});

test("JsonlRunLedger fails closed on a truncated final record", async (t) => {
  const filePath = await withTempLedger(t);
  await writeFile(
    filePath,
    JSON.stringify({ schemaVersion: RUN_LEDGER_SCHEMA_VERSION, record: ledgerRecord("run-1") }),
    "utf8",
  );

  assert.throws(
    () => openLedger(filePath),
    /not newline-terminated; possible partial write/,
  );
});

test("JsonlRunLedger fails closed on unsupported schema versions and invalid JSON", async (t) => {
  const filePath = await withTempLedger(t);
  await writeFile(
    filePath,
    `${JSON.stringify({ schemaVersion: 99, record: ledgerRecord("run-1") })}\n`,
    "utf8",
  );
  assert.throws(() => openLedger(filePath), /Unsupported run ledger schema version/);

  await writeFile(filePath, "{not-json}\n", "utf8");
  assert.throws(() => openLedger(filePath), /invalid JSON at line 1/);
});

test("JsonlRunLedger requires explicit valid byte bounds", async (t) => {
  const filePath = await withTempLedger(t);
  assert.throws(
    () => new JsonlRunLedger({ filePath, maxFileBytes: 0, maxRecordBytes: 1 }),
    /maxFileBytes must be a positive integer/,
  );
  assert.throws(
    () => new JsonlRunLedger({ filePath, maxFileBytes: 100, maxRecordBytes: 101 }),
    /maxRecordBytes must not exceed maxFileBytes/,
  );
});

test("JsonlRunLedger rejects an oversized record before writing bytes", async (t) => {
  const filePath = await withTempLedger(t);
  const ledger = new JsonlRunLedger({ filePath, maxFileBytes: 4 * 1024, maxRecordBytes: 64 });

  assert.throws(() => ledger.append(ledgerRecord("run-too-large")), /exceeds maxRecordBytes/);
  assert.equal(existsSync(filePath), false);
});

test("JsonlRunLedger stops cleanly at maxFileBytes without partial append", async (t) => {
  const filePath = await withTempLedger(t);
  const initial = openLedger(filePath);
  initial.append(ledgerRecord("run-1"));
  const before = await readFile(filePath, "utf8");
  const exactBytes = new TextEncoder().encode(before).byteLength;

  const capped = new JsonlRunLedger({
    filePath,
    maxFileBytes: exactBytes,
    maxRecordBytes: exactBytes,
  });
  assert.throws(() => capped.append(ledgerRecord("run-2")), /would exceed maxFileBytes/);
  assert.equal(await readFile(filePath, "utf8"), before);
});

test("JsonlRunLedger detects another writer before append and fails closed", async (t) => {
  const filePath = await withTempLedger(t);
  const writerA = openLedger(filePath);
  const writerB = openLedger(filePath);

  writerA.append(ledgerRecord("run-a"));
  assert.throws(
    () => writerB.append(ledgerRecord("run-b")),
    /changed outside this writer; reopen before appending/,
  );

  const reloaded = openLedger(filePath);
  assert.deepEqual(reloaded.list().map((record) => record.runId), ["run-a"]);
});
