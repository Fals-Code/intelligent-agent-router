import test from "node:test";
import assert from "node:assert/strict";
import { EvidenceBundleBuilder } from "../dist/index.js";

const NOW = "2026-08-18T04:25:00.000Z";
const HEAD = "a".repeat(40);

function ev(kind) {
  return { kind, status: "passed", reference: `${kind}:pass`, producer: kind, collectedAt: NOW };
}

function candidateInput() {
  return {
    run: {
      id: "run-hardening",
      projectId: "project-hardening",
      riskClass: "R2",
      phase: "publish",
      status: "running",
      attempt: 1,
      approvalIds: [],
      createdAt: NOW,
      updatedAt: NOW,
    },
    task: "bounded publication task",
    runtimeId: "opencode",
    modelRoute: ["9router/hemat"],
    contextCompilerVersion: "v1",
    skills: [],
    toolsets: ["read"],
    workspace: "D:/repo",
    policyDecisions: ["publish allowed"],
    changeReferences: [HEAD],
    evidence: [ev("policy"), ev("test"), ev("review")],
    resourceMetrics: { toolCalls: 1 },
    traceId: "trace-hardening",
  };
}

function ledger(input = candidateInput(), overrides = {}) {
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

function builder() {
  return new EvidenceBundleBuilder({
    maxBundleBytes: 32 * 1024,
    maxCiRecords: 4,
    maxArtifactDigests: 4,
    maxChangedFiles: 16,
  });
}

test("terminal seal reuses canonical Run Ledger validation before hashing", async () => {
  const input = candidateInput();
  const candidate = await builder().createCandidate(input);

  await assert.rejects(
    () => builder().sealTerminal({ candidate, runLedger: ledger(input, { outcome: "fabricated-success" }) }),
    /outcome is invalid/,
  );
  await assert.rejects(
    () => builder().sealTerminal({
      candidate,
      runLedger: ledger(input, {
        evidence: [...input.evidence, { kind: "fabricated", status: "passed", reference: "x", producer: "x", collectedAt: NOW }],
      }),
    }),
    /kind is invalid/,
  );
});
