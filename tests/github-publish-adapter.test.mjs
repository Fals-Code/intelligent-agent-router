import test from "node:test";
import assert from "node:assert/strict";
import { EvidenceBundleBuilder, GitHubPublishAdapter } from "../dist/index.js";

const NOW = "2026-08-18T04:20:00.000Z";
const BASE = "1".repeat(40);
const HEAD = "2".repeat(40);
const DIFF = "3".repeat(64);

function evidence(kind, producer = kind) {
  return { kind, status: "passed", reference: `${kind}:pass`, producer, collectedAt: NOW };
}

function ledger(overrides = {}) {
  return {
    runId: "run-publish-1",
    projectId: "project-1",
    task: "publish password=hidden",
    riskClass: "R1",
    runtimeId: "opencode",
    modelRoute: ["9router/hemat"],
    contextCompilerVersion: "v1",
    skills: ["runtime.reconciliation"],
    toolsets: ["read"],
    workspace: "D:/repo",
    policyDecisions: ["R1 publication policy"],
    approvalIds: [],
    changeReferences: [HEAD],
    evidence: [
      evidence("policy"),
      evidence("isolation"),
      { ...evidence("other", "runtime-reconciliation:opencode"), reference: "runtime:opencode:ses-1" },
      evidence("deterministic_check", "verifier"),
    ],
    resourceMetrics: { toolCalls: 1 },
    traceId: "trace-publish-1",
    outcome: "succeeded",
    createdAt: NOW,
    ...overrides,
  };
}

async function buildBundle(runLedger = ledger()) {
  return new EvidenceBundleBuilder({
    maxBundleBytes: 64 * 1024,
    maxCiRecords: 8,
    maxArtifactDigests: 8,
    maxChangedFiles: 32,
    now: () => NOW,
  }).build({
    runLedger,
    source: {
      repository: "Fals-Code/intelligent-agent-router",
      baseSha: BASE,
      headSha: HEAD,
      changedFiles: ["src/a.ts"],
      diffSha256: DIFF,
      diffBytes: 100,
    },
    ci: [
      {
        provider: "github",
        workflow: "CI",
        runId: "123",
        commitSha: HEAD,
        conclusion: "success",
        reference: "actions:123",
      },
    ],
  });
}

function authorization(bundle, overrides = {}) {
  return {
    runId: bundle.runId,
    bundleSha256: bundle.bundleSha256,
    decision: "allow",
    actor: "policy-engine",
    decidedAt: NOW,
    policyReferences: ["policy:github-publish"],
    approvalIds: [...bundle.approvalIds],
    ...overrides,
  };
}

test("GitHubPublishAdapter publishes one bounded PR comment from a sealed authorized bundle", async () => {
  const bundle = await buildBundle();
  const calls = [];
  const adapter = new GitHubPublishAdapter(
    {
      async createPullRequestComment(input) {
        calls.push(input);
        return { id: "comment-1", reference: "github:pr:28#comment-1" };
      },
    },
    { maxMarkdownBytes: 64 * 1024, now: () => NOW },
  );

  const receipt = await adapter.publishPullRequestComment(
    bundle,
    { repository: "Fals-Code/intelligent-agent-router", pullRequestNumber: 28 },
    authorization(bundle),
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].idempotencyKey, `9router-evidence:${bundle.runId}:${bundle.bundleSha256}`);
  assert.match(calls[0].body, /9Router Evidence Bundle/);
  assert.match(calls[0].body, new RegExp(bundle.bundleSha256));
  assert.match(calls[0].body, new RegExp(bundle.runLedgerSha256));
  assert.doesNotMatch(calls[0].body, /hidden/);
  assert.doesNotMatch(calls[0].body, /D:\/repo/);
  assert.equal(receipt.adapter, "github");
  assert.equal(receipt.bundleSha256, bundle.bundleSha256);
  assert.equal(receipt.commentId, "comment-1");
});

test("GitHubPublishAdapter fails closed on deny, bundle mismatch, or approval mismatch before any GitHub call", async () => {
  const bundle = await buildBundle();
  let calls = 0;
  const adapter = new GitHubPublishAdapter(
    {
      async createPullRequestComment() {
        calls += 1;
        return { id: "unexpected", reference: "unexpected" };
      },
    },
    { maxMarkdownBytes: 64 * 1024, now: () => NOW },
  );

  await assert.rejects(
    () => adapter.publishPullRequestComment(bundle, { repository: "Fals-Code/intelligent-agent-router", pullRequestNumber: 28 }, authorization(bundle, { decision: "deny" })),
    /denied by policy/,
  );
  await assert.rejects(
    () => adapter.publishPullRequestComment(bundle, { repository: "Fals-Code/intelligent-agent-router", pullRequestNumber: 28 }, authorization(bundle, { bundleSha256: "f".repeat(64) })),
    /does not match sealed bundle/,
  );
  await assert.rejects(
    () => adapter.publishPullRequestComment(bundle, { repository: "Fals-Code/intelligent-agent-router", pullRequestNumber: 28 }, authorization(bundle, { approvalIds: ["fabricated"] })),
    /approvalIds do not match/,
  );
  assert.equal(calls, 0);
});

test("GitHubPublishAdapter requires durable workflow approval IDs for R3/R4 publication", async () => {
  const r3 = ledger({
    riskClass: "R3",
    approvalIds: [],
    evidence: [
      evidence("policy"),
      evidence("isolation"),
      evidence("test"),
      evidence("independent_review"),
      evidence("approval"),
    ],
  });
  const bundle = await buildBundle(r3);
  const adapter = new GitHubPublishAdapter(
    { async createPullRequestComment() { throw new Error("must not publish"); } },
    { maxMarkdownBytes: 64 * 1024, now: () => NOW },
  );
  await assert.rejects(
    () => adapter.publishPullRequestComment(bundle, { repository: "Fals-Code/intelligent-agent-router", pullRequestNumber: 28 }, authorization(bundle)),
    /requires durable approval IDs/,
  );
});

test("GitHubPublishAdapter performs no automatic retry when GitHub publication fails", async () => {
  const bundle = await buildBundle();
  let calls = 0;
  const adapter = new GitHubPublishAdapter(
    {
      async createPullRequestComment() {
        calls += 1;
        throw new Error("GitHub unavailable");
      },
    },
    { maxMarkdownBytes: 64 * 1024, now: () => NOW },
  );
  await assert.rejects(
    () => adapter.publishPullRequestComment(bundle, { repository: "Fals-Code/intelligent-agent-router", pullRequestNumber: 28 }, authorization(bundle)),
    /GitHub unavailable/,
  );
  assert.equal(calls, 1);
});

test("GitHubPublishAdapter enforces markdown byte bounds before side effects", async () => {
  const bundle = await buildBundle();
  let calls = 0;
  const adapter = new GitHubPublishAdapter(
    {
      async createPullRequestComment() {
        calls += 1;
        return { id: "unexpected", reference: "unexpected" };
      },
    },
    { maxMarkdownBytes: 64, now: () => NOW },
  );
  await assert.rejects(
    () => adapter.publishPullRequestComment(bundle, { repository: "Fals-Code/intelligent-agent-router", pullRequestNumber: 28 }, authorization(bundle)),
    /exceeds maxMarkdownBytes/,
  );
  assert.equal(calls, 0);
});
