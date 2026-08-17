import test from "node:test";
import assert from "node:assert/strict";
import { EvidenceBundleBuilder } from "../dist/index.js";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const DIFF_HASH = "c".repeat(64);
const ARTIFACT_HASH = "d".repeat(64);
const NOW = "2026-08-18T04:15:00.000Z";

function record(overrides = {}) {
  return {
    runId: "run-evidence-1",
    projectId: "project-1",
    task: "publish evidence password=super-secret",
    riskClass: "R1",
    runtimeId: "opencode",
    modelRoute: ["9router/hemat"],
    contextCompilerVersion: "v1",
    skills: ["runtime.reconciliation"],
    toolsets: ["read"],
    workspace: "D:/repo",
    policyDecisions: ["authorization=Bearer should-not-leak"],
    approvalIds: [],
    changeReferences: [HEAD],
    evidence: [
      { kind: "policy", status: "passed", reference: "policy:r1", producer: "policy", collectedAt: NOW },
      { kind: "isolation", status: "passed", reference: "workspace:isolated", producer: "workspace", collectedAt: NOW },
      {
        kind: "other",
        status: "passed",
        reference: "runtime:opencode:ses-1",
        producer: "runtime-reconciliation:opencode",
        collectedAt: NOW,
      },
      {
        kind: "deterministic_check",
        status: "passed",
        reference: "verifier:pass",
        producer: "verifier",
        collectedAt: NOW,
        metadata: { apiKey: "api_key=should-not-leak" },
      },
    ],
    resourceMetrics: { toolCalls: 4 },
    traceId: "trace-1",
    outcome: "succeeded",
    createdAt: NOW,
    ...overrides,
  };
}

function builder(overrides = {}) {
  return new EvidenceBundleBuilder({
    maxBundleBytes: 64 * 1024,
    maxCiRecords: 8,
    maxArtifactDigests: 16,
    maxChangedFiles: 64,
    now: () => NOW,
    ...overrides,
  });
}

function input(runLedger = record()) {
  return {
    runLedger,
    source: {
      repository: "Fals-Code/intelligent-agent-router",
      baseSha: BASE,
      headSha: HEAD,
      changedFiles: ["src/b.ts", "src/a.ts", "src/a.ts"],
      diffSha256: DIFF_HASH,
      diffBytes: 1234,
      reference: "github:compare",
    },
    ci: [
      {
        provider: "github",
        workflow: "CI",
        runId: "32000000000",
        commitSha: HEAD,
        conclusion: "success",
        reference: "github-actions:32000000000",
      },
    ],
    artifacts: [
      {
        name: "ledger.jsonl",
        sha256: ARTIFACT_HASH,
        bytes: 4096,
        reference: "local-proof:ledger",
      },
    ],
  };
}

test("EvidenceBundleBuilder seals canonical Run Ledger, source, CI, verification and artifact digests", async () => {
  const bundle = await builder().build(input());
  assert.equal(bundle.schemaVersion, 1);
  assert.equal(bundle.runId, "run-evidence-1");
  assert.match(bundle.bundleSha256, /^[A-F0-9]{64}$/);
  assert.match(bundle.runLedgerSha256, /^[A-F0-9]{64}$/);
  assert.match(bundle.bundleId, /^9router-evidence:run-evidence-1:[0-9a-f]{16}$/);
  assert.deepEqual(bundle.source.changedFiles, ["src/a.ts", "src/b.ts"]);
  assert.equal(bundle.ci[0].commitSha, HEAD);
  assert.equal(bundle.artifacts[0].sha256, ARTIFACT_HASH.toUpperCase());
  assert.equal(bundle.verificationEvidence.length, 2);
  assert.equal(bundle.approvalIds.length, 0);
  assert.equal(Object.isFrozen(bundle), true);
  assert.equal(Object.isFrozen(bundle.runLedger), true);
  const serialized = JSON.stringify(bundle);
  assert.doesNotMatch(serialized, /super-secret/);
  assert.doesNotMatch(serialized, /should-not-leak/);
  assert.match(serialized, /redacted/);
  assert.equal("patch" in bundle.source, false);
});

test("EvidenceBundleBuilder produces the same sealed digest for identical canonical input and time", async () => {
  const first = await builder().build(input());
  const second = await builder().build(input());
  assert.equal(first.bundleSha256, second.bundleSha256);
  assert.equal(first.runLedgerSha256, second.runLedgerSha256);
  assert.deepEqual(first, second);
});

test("EvidenceBundleBuilder rejects CI evidence that is not attached to the source head", async () => {
  const bad = input();
  bad.ci[0] = { ...bad.ci[0], commitSha: "e".repeat(40) };
  await assert.rejects(() => builder().build(bad), /does not match source headSha/);
});

test("EvidenceBundleBuilder enforces explicit bundle and collection bounds before publication", async () => {
  await assert.rejects(
    () => builder({ maxChangedFiles: 1 }).build(input()),
    /exceeds maxChangedFiles/,
  );
  await assert.rejects(
    () => builder({ maxCiRecords: 1 }).build({ ...input(), ci: [input().ci[0], { ...input().ci[0], runId: "2" }] }),
    /exceed maxCiRecords/,
  );
  await assert.rejects(
    () => builder({ maxBundleBytes: 64 }).build(input()),
    /exceeds maxBundleBytes/,
  );
});

test("EvidenceBundleBuilder reuses canonical Run Ledger validation instead of accepting fabricated success", async () => {
  const invalid = record({ evidence: [{ kind: "policy", status: "passed", reference: "p", producer: "p", collectedAt: NOW }] });
  await assert.rejects(() => builder().build(input(invalid)), /Evidence gate rejected successful run/);
});
