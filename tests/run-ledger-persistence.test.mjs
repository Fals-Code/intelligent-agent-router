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

function evidence(kind) {
  return {
    kind,
    status: "passed",
    reference: `${kind}:ref`,
    producer: "run-ledger-persistence-test",
    collectedAt: "2026-08-18T00:00:00.000Z",
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

async function withTempLedger(t) {
  const dir = await mkdtemp(join(tmpdir(), "9router-run-ledger-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return join(dir, "runs.jsonl");
}

test("JsonlRunLedger durably appends versioned records and reloads them after restart", async (t) => {
  const filePath = await withTempLedger(t);
  const ledger = new JsonlRunLedger({ filePath });

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

  const reloaded = new JsonlRunLedger({ filePath });
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
  const ledger = new JsonlRunLedger({ filePath });

  assert.throws(
    () => ledger.append(ledgerRecord("run-invalid", { evidence: [evidence("policy")] })),
    /Evidence gate rejected successful run/,
  );
  assert.equal(existsSync(filePath), false);
  assert.equal(ledger.list().length, 0);
});

test("JsonlRunLedger rejects duplicate run IDs after reload without mutating the file", async (t) => {
  const filePath = await withTempLedger(t);
  const ledger = new JsonlRunLedger({ filePath });
  ledger.append(ledgerRecord("run-1"));
  const before = await readFile(filePath, "utf8");

  const reloaded = new JsonlRunLedger({ filePath });
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
    () => new JsonlRunLedger({ filePath }),
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
  assert.throws(() => new JsonlRunLedger({ filePath }), /Unsupported run ledger schema version/);

  await writeFile(filePath, "{not-json}\n", "utf8");
  assert.throws(() => new JsonlRunLedger({ filePath }), /invalid JSON at line 1/);
});

test("JsonlRunLedger detects another writer before append and fails closed", async (t) => {
  const filePath = await withTempLedger(t);
  const writerA = new JsonlRunLedger({ filePath });
  const writerB = new JsonlRunLedger({ filePath });

  writerA.append(ledgerRecord("run-a"));
  assert.throws(
    () => writerB.append(ledgerRecord("run-b")),
    /changed outside this writer; reopen before appending/,
  );

  const reloaded = new JsonlRunLedger({ filePath });
  assert.deepEqual(reloaded.list().map((record) => record.runId), ["run-a"]);
});
