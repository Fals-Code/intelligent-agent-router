import test from "node:test";
import assert from "node:assert/strict";
import { EvidenceBundleBuilder, GitHubPublishAdapter } from "../dist/index.js";

const NOW = "2026-08-18T04:20:00.000Z";
const BASE = "1".repeat(40);
const HEAD = "2".repeat(40);
const DIFF = "3".repeat(64);

function evidence(kind, producer = kind, reference = `${kind}:pass`) {
  return { kind, status: "passed", reference, producer, collectedAt: NOW };
}

function run(overrides = {}) {
  return {
    id: "run-publish-1",
    projectId: "project-1",
    riskClass: "R2",
    phase: "publish",
    status: "running",
    attempt: 1,
    approvalIds: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function input(overrides = {}) {
  return {
    run: run(),
    task: "publish internal task password=hidden",
    runtimeId: "opencode",
    modelRoute: ["9router/hemat"],
    contextCompilerVersion: "v1",
    skills: ["runtime.reconciliation"],
    toolsets: ["read", "edit"],
    workspace: "D:/secret/local/repo",
    policyDecisions: ["R2 publication policy"],
    changeReferences: [HEAD],
    evidence: [
      evidence("policy"),
      evidence("test"),
      evidence("review"),
      evidence("other", "runtime-reconciliation:opencode", "runtime:opencode:ses-1"),
      evidence("deterministic_check", "verifier", "verifier:pass"),
    ],
    resourceMetrics: { toolCalls: 1 },
    traceId: "trace-publish-1",
    source: {
      repository: "Fals-Code/intelligent-agent-router",
      baseSha: BASE,
      headSha: HEAD,
      changedFiles: ["src/a.ts"],
      diffSha256: DIFF,
      diffBytes: 100,
    },
    ...overrides,
  };
}

function ledger(candidateInput = input(), overrides = {}) {
  return {
    runId: candidateInput.run.id,
    projectId: candidateInput.run.projectId,
    task: candidateInput.task,
    riskClass: candidateInput.run.riskClass,
    runtimeId: candidateInput.runtimeId,
    modelRoute: candidateInput.modelRoute,
    contextCompilerVersion: candidateInput.contextCompilerVersion,
    skills: candidateInput.skills,
    toolsets: candidateInput.toolsets,
    workspace: candidateInput.workspace,
    policyDecisions: candidateInput.policyDecisions,
    approvalIds: candidateInput.run.approvalIds,
    changeReferences: candidateInput.changeReferences,
    evidence: candidateInput.evidence,
    resourceMetrics: candidateInput.resourceMetrics,
    traceId: candidateInput.traceId,
    outcome: "succeeded",
    createdAt: NOW,
    ...overrides,
  };
}

function builder() {
  return new EvidenceBundleBuilder({
    maxBundleBytes: 64 * 1024,
    maxCiRecords: 8,
    maxArtifactDigests: 8,
    maxChangedFiles: 32,
  });
}

async function candidate(overrides = {}) {
  return builder().createCandidate(input(overrides));
}

function authorization(bundle, overrides = {}) {
  return {
    runId: bundle.payload.runId,
    bundleSha256: bundle.bundleSha256,
    decision: "allow",
    actor: "policy-engine",
    decidedAt: NOW,
    policyReferences: ["policy:github-publish"],
    approvalIds: [...bundle.payload.approvalIds],
    ...overrides,
  };
}

function client(calls, failure) {
  return {
    async createOrUpdatePullRequest(request) {
      calls.push({ type: "pr", request });
      if (failure) throw new Error(failure);
      return { pullRequestNumber: 28, reference: "github:pr:28" };
    },
    async createPullRequestComment(request) {
      calls.push({ type: "comment", request });
      if (failure) throw new Error(failure);
      return { id: "comment-1", reference: "github:pr:28#comment-1" };
    },
  };
}

test("GitHub adapter publishes one candidate PR without leaking raw task/workspace", async () => {
  const bundle = await candidate();
  const calls = [];
  const adapter = new GitHubPublishAdapter(client(calls), { maxMarkdownBytes: 64 * 1024, now: () => NOW });
  const receipt = await adapter.publishCandidate(
    bundle,
    {
      repository: "Fals-Code/intelligent-agent-router",
      baseBranch: "main",
      headBranch: "feat/evidence-bundle-github-publish",
      title: "Evidence bundle publication",
      draft: true,
    },
    authorization(bundle),
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, "pr");
  assert.match(calls[0].request.idempotencyKey, /:candidate:/);
  assert.match(calls[0].request.body, /9Router Publication Evidence/);
  assert.match(calls[0].request.body, new RegExp(bundle.bundleSha256));
  assert.doesNotMatch(calls[0].request.body, /internal task/);
  assert.doesNotMatch(calls[0].request.body, /D:\/secret\/local\/repo/);
  assert.equal(receipt.operation, "candidate_pr");
  assert.equal(receipt.pullRequestNumber, 28);
});

test("GitHub adapter attaches a terminal seal only after Run Ledger sealing", async () => {
  const candidateInput = input();
  const pre = await builder().createCandidate(candidateInput);
  const sealed = await builder().sealTerminal({
    candidate: pre,
    runLedger: ledger(candidateInput),
    ci: [{ provider: "github", workflow: "CI", runId: "76", commitSha: HEAD, conclusion: "success", reference: "actions:76" }],
  });
  const calls = [];
  const adapter = new GitHubPublishAdapter(client(calls), { maxMarkdownBytes: 64 * 1024, now: () => NOW });
  const receipt = await adapter.publishTerminalSeal(
    sealed,
    { repository: "Fals-Code/intelligent-agent-router", pullRequestNumber: 28 },
    authorization(sealed),
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, "comment");
  assert.match(calls[0].request.idempotencyKey, /:terminal:/);
  assert.match(calls[0].request.body, new RegExp(sealed.payload.runLedgerSha256));
  assert.match(calls[0].request.body, /CI/);
  assert.equal(receipt.operation, "terminal_seal");
  assert.equal(receipt.externalId, "comment-1");
});

test("authorization deny, digest mismatch, approval mismatch, or bundle tamper fail before GitHub side effects", async () => {
  const bundle = await candidate();
  const calls = [];
  const adapter = new GitHubPublishAdapter(client(calls), { maxMarkdownBytes: 64 * 1024, now: () => NOW });
  const target = { repository: "Fals-Code/intelligent-agent-router", baseBranch: "main", headBranch: "feat/test", title: "test" };

  await assert.rejects(() => adapter.publishCandidate(bundle, target, authorization(bundle, { decision: "deny" })), /denied by policy/);
  await assert.rejects(() => adapter.publishCandidate(bundle, target, authorization(bundle, { bundleSha256: "f".repeat(64) })), /does not match exact evidence bundle/);
  await assert.rejects(() => adapter.publishCandidate(bundle, target, authorization(bundle, { approvalIds: ["fabricated"] })), /approvalIds do not match/);
  const tampered = { ...bundle, bundleSha256: "a".repeat(64) };
  await assert.rejects(() => adapter.publishCandidate(tampered, target, authorization(tampered)), /does not match canonical payload/);
  assert.equal(calls.length, 0);
});

test("high-risk publication authorization must carry the exact durable approvals", async () => {
  const r3Evidence = [
    evidence("policy"),
    evidence("isolation"),
    evidence("test"),
    evidence("independent_review"),
    evidence("approval"),
  ];
  const r3Bundle = await candidate({
    run: run({ riskClass: "R3", approvalIds: ["approval-1"] }),
    evidence: r3Evidence,
  });
  const calls = [];
  const adapter = new GitHubPublishAdapter(client(calls), { maxMarkdownBytes: 64 * 1024, now: () => NOW });
  const target = { repository: "Fals-Code/intelligent-agent-router", baseBranch: "main", headBranch: "feat/r3", title: "R3" };
  await assert.rejects(
    () => adapter.publishCandidate(r3Bundle, target, authorization(r3Bundle, { approvalIds: [] })),
    /approvalIds do not match/,
  );
  assert.equal(calls.length, 0);
});

test("GitHub publication has no automatic retry and enforces Markdown bounds before side effects", async () => {
  const bundle = await candidate();
  const failedCalls = [];
  const failing = new GitHubPublishAdapter(client(failedCalls, "GitHub unavailable"), { maxMarkdownBytes: 64 * 1024, now: () => NOW });
  await assert.rejects(
    () => failing.publishCandidate(
      bundle,
      { repository: "Fals-Code/intelligent-agent-router", baseBranch: "main", headBranch: "feat/test", title: "test" },
      authorization(bundle),
    ),
    /GitHub unavailable/,
  );
  assert.equal(failedCalls.length, 1);

  const boundedCalls = [];
  const bounded = new GitHubPublishAdapter(client(boundedCalls), { maxMarkdownBytes: 64, now: () => NOW });
  await assert.rejects(
    () => bounded.publishCandidate(
      bundle,
      { repository: "Fals-Code/intelligent-agent-router", baseBranch: "main", headBranch: "feat/test", title: "test" },
      authorization(bundle),
    ),
    /exceeds maxMarkdownBytes/,
  );
  assert.equal(boundedCalls.length, 0);
});
