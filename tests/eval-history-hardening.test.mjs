import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JsonlEvalHistory, RoutingEvalPlane, prepareGoldenTaskSuite } from "../dist/index.js";

const limits = { maxTasks: 4, maxAssertionsPerTask: 4, maxPromptBytes: 2048, maxStringBytes: 1024, maxSuiteBytes: 32 * 1024 };

async function fixture() {
  const suite = await prepareGoldenTaskSuite({ schemaVersion: 1, suiteId: "hardening-suite", description: "fixture", tasks: [{ id: "task", kind: "routing", prompt: "Summarize this synthetic input.", critical: false, minimumScore: 1, assertions: [{ id: "model", kind: "primary_model_equals", weight: 1, expected: "model-a" }] }] }, limits);
  const plane = new RoutingEvalPlane({ maxReportBytes: 32 * 1024, maxSubjectIdBytes: 1024 });
  const report = await plane.evaluate(suite, { id: "router-hardening", async route() { return { primaryModel: { candidate: { id: "model-a" } }, selectedSkills: [], analysis: { requiresVerification: false } }; } });
  const baseline = { schemaVersion: 1, baselineId: "hardening-baseline", suiteId: suite.suiteId, suiteSha256: suite.suiteSha256, subjectId: "router-hardening", minimumWeightedScore: 1, minimumTaskPassRate: 1, minimumCriticalPassRate: 1, maximumFailedTasks: 0 };
  return { report, baseline };
}

async function root(t) { const value = await mkdtemp(join(tmpdir(), "9router-eval-hardening-")); t.after(() => rm(value, { recursive: true, force: true })); return value; }
const opts = (filePath, overrides = {}) => ({ filePath, maxFileBytes: 512 * 1024, maxObservationBytes: 96 * 1024, maxReportBytes: 32 * 1024, maxStringBytes: 1024, maxSourceReferences: 4, ...overrides });

test("eval history enforces observation/file byte ceilings before persistence", async (t) => {
  const dir = await root(t); const { report, baseline } = await fixture();
  const tinyObservation = await JsonlEvalHistory.open(opts(join(dir, "tiny-observation.jsonl"), { maxObservationBytes: 128 }));
  await assert.rejects(() => tinyObservation.append({ observedAt: "2026-08-18T10:00:00.000Z", report, baseline }), /maxObservationBytes/);
  const tinyFile = await JsonlEvalHistory.open(opts(join(dir, "tiny-file.jsonl"), { maxFileBytes: 1024, maxObservationBytes: 1024 }));
  await assert.rejects(() => tinyFile.append({ observedAt: "2026-08-18T10:01:00.000Z", report, baseline }), /(maxObservationBytes|maxFileBytes)/);
});

test("eval history rejects unsupported schema and sequence drift on replay", async (t) => {
  const dir = await root(t); const filePath = join(dir, "history.jsonl"); const { report, baseline } = await fixture();
  const history = await JsonlEvalHistory.open(opts(filePath));
  await history.append({ observedAt: "2026-08-18T10:10:00.000Z", report, baseline });
  const original = await readFile(filePath, "utf8");
  await writeFile(filePath, original.replace('"schemaVersion":1', '"schemaVersion":2'), "utf8");
  await assert.rejects(() => JsonlEvalHistory.open(opts(filePath)), /Unsupported eval history schema version/);
  await writeFile(filePath, original.replace('"sequence":1', '"sequence":2'), "utf8");
  await assert.rejects(() => JsonlEvalHistory.open(opts(filePath)), /sequence mismatch/);
});

test("eval history rejects secret-like measurement references before bytes are written", async (t) => {
  const dir = await root(t); const filePath = join(dir, "history.jsonl"); const { report, baseline } = await fixture();
  const history = await JsonlEvalHistory.open(opts(filePath));
  await assert.rejects(() => history.append({ observedAt: "2026-08-18T10:20:00.000Z", report, baseline, measurement: { latencyMs: 10, sourceReferences: ["authorization=Bearer abcdefghijklmnopqrstuvwxyz"] } }), /secret-like material/);
  assert.equal(history.list().length, 0);
});
