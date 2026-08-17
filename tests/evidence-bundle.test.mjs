import test from "node:test";
import assert from "node:assert/strict";
import { EvidenceBundleBuilder, verifyEvidenceBundle } from "../dist/index.js";

const NOW = "2026-08-18T04:15:00.000Z";
const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const DIFF_HASH = "c".repeat(64);
const ARTIFACT_HASH = "d".repeat(64);

function evidence(kind, producer = kind, reference = `${kind}:pass`) {
  return { kind, status: "passed", reference, producer, collectedAt: NOW };
}

function run(overrides = {}) {
  return {
    id: "run-evidence-1",
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

function candidateInput(overrides = {}) {
  return {
    run: run(),
    task: "prepare customer-facing evidence password=super-secret",
    runtimeId: "opencode",
    modelRoute: ["9router/hemat"],
    contextCompilerVersion: "v1",
    skills: ["runtime.reconciliation"],
    toolsets: ["read", "edit"],
    workspace: "D:/private/local/repo",
    policyDecisions: ["publish permitted; authorization=Bearer should-not-leak"],
    changeReferences: [HEAD],
    evidence: [
      evidence("policy"),
      evidence("test"),
      evidence("review"),
      evidence("other", "runtime-reconciliation:opencode", "runtime:opencode:ses-1"),
      {
        ...evidence("deterministic_check", "verifier", "verifier:pass"),
        metadata: { apiKey: "should-not-leak", note: "credential=also-secret" },
      },
    ],
    resourceMetrics: { toolCalls: 4 },
    traceId: "trace-1",
    source: {
      repository: "Fals-Code/intelligent-agent-router",
      baseSha: BASE,
      headSha: HEAD,
      changedFiles: ["src/b.ts", "src/a.ts", "src/a.ts"],
      diffSha256: DIFF_HASH,
      diffBytes: 1234,
      reference: "github:compare",
    },
    artifacts: [{ name: "integrity.jsonl", sha256: ARTIFACT_HASH, bytes: 4096 }],
    ...overrides,
  };
}

function ledger(overrides = {}) {
  const input = candidateInput();
  return {
    runId: input.run.id,
    projectId: input.run.projectId,
    task: input.task,
    riskClass: input.run.riskClass,
    runtimeId: input.runtimeId,
    modelRoute: input.modelRoute,
    contextCompilerVersion: input.contextCompilerVersion,
    skills: input.skills,
    toolsets: input.toolsets,
    workspace: input.workspace,
    policyDecisions: input.policyDecisions,
    approvalIds: input.run.approvalIds,
    changeReferences: input.changeReferences,
    evidence: input.evidence,
    resourceMetrics: input.resourceMetrics,
    traceId: input.traceId,
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
    ...overrides,
  });
}

test("candidate bundle is deterministic, bounded, and excludes raw task/workspace/source patch", async () => {
  const first = await builder().createCandidate(candidateInput());
  const second = await builder().createCandidate(candidateInput());

  assert.equal(first.payload.stage, "candidate");
  assert.equal(first.bundleSha256, second.bundleSha256);
  assert.equal(first.bundleId, second.bundleId);
  assert.deepEqual(first.payload.source.changedFiles, ["src/a.ts", "src/b.ts"]);
  assert.match(first.payload.taskSha256, /^[A-F0-9]{64}$/);
  assert.match(first.payload.workspaceSha256, /^[A-F0-9]{64}$/);
  assert.equal(Object.isFrozen(first), true);
  await verifyEvidenceBundle(first);

  const serialized = JSON.stringify(first);
  assert.doesNotMatch(serialized, /customer-facing evidence/);
  assert.doesNotMatch(serialized, /D:\/private\/local\/repo/);
  assert.doesNotMatch(serialized, /super-secret/);
  assert.doesNotMatch(serialized, /should-not-leak/);
  assert.doesNotMatch(serialized, /also-secret/);
  assert.match(serialized, /redacted/);
  assert.equal("patch" in first.payload.source, false);
  assert.equal("runLedger" in first, false);
});

test("terminal seal preserves bundle identity and binds exact candidate to Run Ledger and CI", async () => {
  const candidate = await builder().createCandidate(candidateInput());
  const sealed = await builder().sealTerminal({
    candidate,
    runLedger: ledger(),
    ci: [{
      provider: "github",
      workflow: "CI",
      runId: "32000000000",
      commitSha: HEAD,
      conclusion: "success",
      reference: "github-actions:32000000000",
    }],
  });

  assert.equal(sealed.payload.stage, "sealed_terminal");
  assert.equal(sealed.bundleId, candidate.bundleId);
  assert.equal(sealed.payload.candidateDigest, candidate.bundleSha256);
  assert.match(sealed.payload.runLedgerSha256, /^[A-F0-9]{64}$/);
  assert.equal(sealed.payload.outcome, "succeeded");
  assert.equal(sealed.payload.ci.length, 1);
  assert.notEqual(sealed.bundleSha256, candidate.bundleSha256);
  await verifyEvidenceBundle(sealed);
});

test("candidate publication requires publish phase, R2-R4, evidence gate, and durable high-risk approval", async () => {
  await assert.rejects(
    () => builder().createCandidate(candidateInput({ run: run({ phase: "review" }) })),
    /requires running publish workflow/,
  );
  await assert.rejects(
    () => builder().createCandidate(candidateInput({ run: run({ riskClass: "R1" }) })),
    /requires R2-R4/,
  );
  await assert.rejects(
    () => builder().createCandidate(candidateInput({ evidence: [evidence("policy")] })),
    /rejected by evidence gate/,
  );
  const r3Evidence = [evidence("policy"), evidence("isolation"), evidence("test"), evidence("independent_review"), evidence("approval")];
  await assert.rejects(
    () => builder().createCandidate(candidateInput({ run: run({ riskClass: "R3", approvalIds: [] }), evidence: r3Evidence })),
    /requires durable workflow approval/,
  );
});

test("terminal seal fails closed on task drift, approval drift, CI head drift, or non-success CI for succeeded run", async () => {
  const candidate = await builder().createCandidate(candidateInput());
  await assert.rejects(
    () => builder().sealTerminal({ candidate, runLedger: ledger({ task: "different task" }) }),
    /task digest does not match/,
  );
  await assert.rejects(
    () => builder().sealTerminal({ candidate, runLedger: ledger({ approvalIds: ["fabricated"] }) }),
    /approvalIds does not match/,
  );
  await assert.rejects(
    () => builder().sealTerminal({
      candidate,
      runLedger: ledger(),
      ci: [{ provider: "github", workflow: "CI", runId: "1", commitSha: "e".repeat(40), conclusion: "success", reference: "actions:1" }],
    }),
    /does not match source headSha/,
  );
  await assert.rejects(
    () => builder().sealTerminal({
      candidate,
      runLedger: ledger(),
      ci: [{ provider: "github", workflow: "CI", runId: "2", commitSha: HEAD, conclusion: "failure", reference: "actions:2" }],
    }),
    /cannot attach non-success CI/,
  );
});

test("bundle collection and byte limits are enforced before publication", async () => {
  await assert.rejects(
    () => builder({ maxChangedFiles: 1 }).createCandidate(candidateInput()),
    /exceeds maxChangedFiles/,
  );
  await assert.rejects(
    () => builder({ maxBundleBytes: 64 }).createCandidate(candidateInput()),
    /exceeds maxBundleBytes/,
  );
});
