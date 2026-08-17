import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlExecutionIntegrityJournal } from "../dist/index.js";

function journalFixture() {
  const root = mkdtempSync(join(tmpdir(), "9router-integrity-security-"));
  const journal = new JsonlExecutionIntegrityJournal({
    filePath: join(root, "integrity.jsonl"),
    maxFileBytes: 1_000_000,
    maxEntryBytes: 64_000,
  });
  const binding = {
    workflowRunId: "run-security",
    projectId: "project-1",
    workflowAttempt: 1,
    runtimeId: "runtime-a",
    sessionId: "session-security",
    workspace: "C:/tmp/security",
    boundAt: "2026-08-18T00:00:01.000Z",
  };
  journal.append({
    runId: binding.workflowRunId,
    projectId: binding.projectId,
    attempt: 1,
    stage: "runtime_bound",
    recordedAt: "2026-08-18T00:00:01.100Z",
    binding,
  });
  return { root, journal, binding };
}

function verification(binding, includeRuntimeEvidence = true) {
  return {
    workflowRunId: binding.workflowRunId,
    runtimeId: binding.runtimeId,
    sessionId: binding.sessionId,
    verifierId: "deterministic-node",
    passed: true,
    evidence: [
      ...(includeRuntimeEvidence ? [{
        kind: "other",
        status: "passed",
        reference: `runtime:${binding.runtimeId}:${binding.sessionId}`,
        producer: `runtime-reconciliation:${binding.runtimeId}`,
        collectedAt: "2026-08-18T00:00:02.000Z",
      }] : []),
      {
        kind: "deterministic_check",
        status: "passed",
        reference: "command:security-pass",
        producer: "deterministic-node",
        collectedAt: "2026-08-18T00:00:02.100Z",
        metadata: {
          authorization: "Bearer secret-token-123",
          note: "password: secret-password-456",
          checks: 3,
        },
      },
    ],
  };
}

test("verification secrets are redacted before integrity journal bytes are persisted", () => {
  const state = journalFixture();
  try {
    state.journal.append({
      runId: state.binding.workflowRunId,
      projectId: state.binding.projectId,
      attempt: 1,
      stage: "verification_recorded",
      recordedAt: "2026-08-18T00:00:02.200Z",
      verification: verification(state.binding),
    });

    const raw = readFileSync(state.journal.filePath, "utf8");
    assert.equal(raw.includes("secret-token-123"), false);
    assert.equal(raw.includes("secret-password-456"), false);
    const persisted = state.journal.history(state.binding.workflowRunId)[1].verification;
    const deterministic = persisted.evidence.find((item) => item.kind === "deterministic_check");
    assert.equal(deterministic.metadata.authorization, "[redacted]");
    assert.equal(deterministic.metadata.note, "password=[redacted]");
  } finally {
    rmSync(state.root, { recursive: true, force: true });
  }
});

test("passed verification without matching runtime reconciliation evidence is rejected", () => {
  const state = journalFixture();
  try {
    assert.throws(
      () => state.journal.append({
        runId: state.binding.workflowRunId,
        projectId: state.binding.projectId,
        attempt: 1,
        stage: "verification_recorded",
        recordedAt: "2026-08-18T00:00:02.200Z",
        verification: verification(state.binding, false),
      }),
      /matching runtime reconciliation evidence/,
    );
    assert.equal(state.journal.history(state.binding.workflowRunId).length, 1);
  } finally {
    rmSync(state.root, { recursive: true, force: true });
  }
});
