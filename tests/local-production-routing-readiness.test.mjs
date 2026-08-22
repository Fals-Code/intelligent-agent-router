import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import {
  IsolatedRoutingMutationCoordinator,
  JsonFileIsolatedRoutingTarget,
  JsonlRoutingMutationJournal,
  prepareBackupRestoreReadinessEvidence,
  prepareCredentialIsolationReadinessEvidence,
  prepareLocalProductionRoutingReadinessAuthorization,
  prepareLocalProductionRoutingReadinessProposal,
  prepareLocalProductionRoutingTargetSnapshot,
  prepareObservabilityReadinessEvidence,
  prepareRollbackRehearsalReadinessEvidence,
  verifyLocalProductionRoutingReadinessAuthorization,
  verifyLocalProductionRoutingReadinessProposal,
} from "../dist/index.js";
import { buildAuthorizedRoutingPromotionFixture } from "./isolated-routing-mutation-fixture.mjs";

const SHA_A = "A".repeat(64);
const SHA_B = "B".repeat(64);
const SHA_C = "C".repeat(64);

function isolatedTargetOptions(root, authority, suffix = "readiness") {
  return {
    descriptor: {
      targetKind: "isolated_local_test_router",
      targetId: `isolated-router:${authority.authorization.payload.projectId}:${authority.authorization.payload.routeId}`,
      stateFilePath: join(root, `readiness-isolated-router-${suffix}.json`),
    },
    maxStateBytes: 128 * 1024,
    maxStringBytes: 4096,
  };
}

function isolatedJournalOptions(root, suffix = "readiness") {
  return {
    filePath: join(root, `readiness-isolated-journal-${suffix}.jsonl`),
    maxFileBytes: 2 * 1024 * 1024,
    maxEventBytes: 256 * 1024,
    maxStringBytes: 4096,
  };
}

async function buildReadyContext(t, suffix = "readiness") {
  const fixture = await buildAuthorizedRoutingPromotionFixture(t);
  const targetOptions = isolatedTargetOptions(fixture.root, fixture.authority, suffix);
  const isolatedTarget = await JsonFileIsolatedRoutingTarget.initialize({
    ...targetOptions,
    state: {
      targetId: targetOptions.descriptor.targetId,
      projectId: fixture.authorization.payload.projectId,
      routeId: fixture.authorization.payload.routeId,
      capability: fixture.authorization.payload.capability,
      currentSubjectId: fixture.authorization.payload.referenceSubjectId,
      routeRevision: fixture.authorization.payload.routeRevision,
      mutationCount: 0,
      updatedAt: "2026-08-21T03:06:30.000Z",
    },
  });
  const isolatedJournal = await JsonlRoutingMutationJournal.open(isolatedJournalOptions(fixture.root, suffix));
  const coordinator = new IsolatedRoutingMutationCoordinator(isolatedTarget, isolatedJournal);
  const isolatedMutationReceipt = await coordinator.apply({
    authority: fixture.authority,
    mutatedAt: "2026-08-21T03:07:00.000Z",
    committedAt: "2026-08-21T03:07:01.000Z",
  });

  const targetSnapshot = await prepareLocalProductionRoutingTargetSnapshot({
    installationId: "installation:local-9router-primary",
    projectId: fixture.authorization.payload.projectId,
    routeId: fixture.authorization.payload.routeId,
    capability: fixture.authorization.payload.capability,
    currentSubjectId: fixture.authorization.payload.referenceSubjectId,
    routeRevision: fixture.authorization.payload.routeRevision,
    canonicalStateOwner: "9router:local-routing-config",
    writeBoundary: "adapter:local-production-routing",
    persistenceCategory: "local-routing-config",
    runtimeId: "9router:local-runtime",
    restartPolicyReference: "policy:local-routing-restart-recovery-v1",
    capturedAt: "2026-08-21T03:08:00.000Z",
    policyReferences: ["policy:single-writer-v1", "policy:r4-production-routing-v1"],
  });

  const credentialEvidence = await prepareCredentialIsolationReadinessEvidence({
    credentialBrokerId: "broker:local-credential-boundary",
    credentialScopeId: "scope:route-code-interactive-write-only",
    filesystemScopeId: "scope:local-routing-config-file",
    networkEgressScopeId: "scope:loopback-local-router-only",
    adapterWriteScopeId: "scope:exact-project-route-capability",
    evidenceReferences: ["evidence:credential-scope-audit", "evidence:adapter-write-scope-audit"],
    credentialScopeVerified: true,
    autonomousWorkerLongLivedSecretAccess: false,
    exactTargetOnly: true,
    providerFailureContained: true,
    singleWriterVerified: true,
    observedAt: "2026-08-21T03:09:00.000Z",
  });

  const backupEvidence = await prepareBackupRestoreReadinessEvidence({
    backupId: "backup:local-route-known-good-v1",
    backupSha256: SHA_A,
    referenceStateSha256: targetSnapshot.snapshotSha256,
    restoredStateSha256: targetSnapshot.snapshotSha256,
    retentionPolicyReference: "policy:local-route-backup-retention-v1",
    evidenceReferences: ["evidence:backup-integrity-proof", "evidence:restore-rehearsal-proof"],
    backupIntegrityVerified: true,
    restoreVerified: true,
    destructiveCleanupPerformed: false,
    observedAt: "2026-08-21T03:10:00.000Z",
  });

  const rollbackEvidence = await prepareRollbackRehearsalReadinessEvidence({
    rehearsalId: "rollback-rehearsal:local-route-v1",
    rehearsalResult: "PASSED",
    restoredSubjectId: fixture.authorization.payload.referenceSubjectId,
    restoredRouteRevision: fixture.authorization.payload.routeRevision,
    evidenceReferences: ["evidence:rollback-exact-reference", "evidence:rollback-no-duplicate-side-effect"],
    exactReferenceRestored: true,
    duplicateSideEffectObserved: false,
    automaticRollbackAllowed: false,
    observedAt: "2026-08-21T03:11:00.000Z",
  });

  const runLedgerRecords = [{
    runId: "run:local-production-readiness-proof",
    projectId: fixture.authorization.payload.projectId,
    task: "Verify local production routing readiness evidence.",
    riskClass: "R4",
    runtimeId: "9router:verifier",
    modelRoute: ["9router/review"],
    contextCompilerVersion: "fixture",
    skills: [],
    toolsets: [],
    workspace: "isolated-readiness-proof",
    policyDecisions: ["policy:r4-production-routing-v1"],
    approvalIds: ["approval:readiness-evidence:1"],
    changeReferences: [],
    evidence: [{ kind: "backup", status: "passed", reference: "evidence:backup-integrity-proof", producer: "readiness-fixture", collectedAt: "2026-08-21T03:10:00.000Z" }],
    resourceMetrics: {},
    traceId: "trace:local-production-readiness-proof",
    outcome: "succeeded",
    createdAt: "2026-08-21T03:11:30.000Z",
  }];
  const runLedgerReference = `run-ledger:${runLedgerRecords[0].runId}:${runLedgerRecords[0].traceId}`;

  const observabilityEvidence = await prepareObservabilityReadinessEvidence({
    runLedgerReferences: [runLedgerReference],
    traceReferences: [runLedgerRecords[0].traceId],
    approvalAttributionReady: true,
    adapterAttributionReady: true,
    beforeAfterStateAttributionReady: true,
    sanitizedOperationalResultReady: true,
    observedAt: "2026-08-21T03:12:00.000Z",
  });

  return {
    fixture,
    isolatedTarget,
    isolatedJournal,
    isolatedMutationReceipt,
    targetSnapshot,
    credentialEvidence,
    backupEvidence,
    rollbackEvidence,
    observabilityEvidence,
    runLedgerRecords,
    context: {
      promotionAuthority: fixture.authority,
      isolatedMutationReceipt,
      isolatedTarget,
      isolatedJournal,
      targetSnapshot,
      credentialEvidence,
      backupEvidence,
      rollbackEvidence,
      observabilityEvidence,
      runLedgerRecords,
    },
  };
}

function proposalInput(overrides = {}) {
  return {
    adapterId: "adapter:local-production-routing-v1",
    adapterVersion: "design-v1",
    adapterSourceSha256: SHA_B,
    mainSourceSha256: SHA_C,
    proposedAt: "2026-08-21T03:13:00.000Z",
    policyReferences: ["policy:local-production-readiness-v1"],
    ...overrides,
  };
}

function r4Workflow(projectId, overrides = {}) {
  return {
    id: "workflow:local-production-readiness-r4",
    projectId,
    riskClass: "R4",
    phase: "approval",
    status: "running",
    attempt: 1,
    approvalIds: ["approval:local-production-readiness:1"],
    createdAt: "2026-08-21T03:13:30.000Z",
    updatedAt: "2026-08-21T03:14:00.000Z",
    ...overrides,
  };
}

test("ready contract authorizes implementation readiness only and never production mutation", async (t) => {
  const ready = await buildReadyContext(t, "ready");
  const proposal = await prepareLocalProductionRoutingReadinessProposal({ context: ready.context, proposal: proposalInput() });
  assert.equal(proposal.payload.classification, "READY_FOR_LOCAL_PRODUCTION_ADAPTER_IMPLEMENTATION");
  assert.equal(proposal.payload.productionRoutingMutationAuthorized, false);
  assert.equal(proposal.payload.automaticRoutingMutationAllowed, false);
  assert.equal(proposal.payload.automaticRollbackAllowed, false);

  const workflow = r4Workflow(ready.fixture.authorization.payload.projectId);
  const authorization = await prepareLocalProductionRoutingReadinessAuthorization({
    proposal,
    context: ready.context,
    currentTargetSnapshot: ready.targetSnapshot,
    workflow,
    authorization: {
      decision: "allow",
      actor: "operator:local-production-readiness",
      decidedAt: "2026-08-21T03:15:00.000Z",
      approvalIds: workflow.approvalIds,
      policyReferences: ["policy:r4-local-production-readiness-approval-v1"],
    },
  });
  assert.equal(authorization.payload.implementationReadinessAuthorized, true);
  assert.equal(authorization.payload.productionRoutingMutationAuthorized, false);
  assert.equal(authorization.payload.riskClass, "R4");
  await verifyLocalProductionRoutingReadinessAuthorization(authorization, proposal, ready.context, ready.targetSnapshot, workflow);
});

test("credential or isolation weakness classifies NOT_READY and cannot be allowed", async (t) => {
  const ready = await buildReadyContext(t, "credential-not-ready");
  const credentialEvidence = await prepareCredentialIsolationReadinessEvidence({
    ...ready.credentialEvidence.payload,
    credentialScopeVerified: false,
  });
  const context = { ...ready.context, credentialEvidence };
  const proposal = await prepareLocalProductionRoutingReadinessProposal({ context, proposal: proposalInput() });
  assert.equal(proposal.payload.classification, "NOT_READY");
  assert.match(proposal.payload.reasons.join(" "), /Credential scope/);
  const workflow = r4Workflow(ready.fixture.authorization.payload.projectId);
  await assert.rejects(
    prepareLocalProductionRoutingReadinessAuthorization({
      proposal,
      context,
      currentTargetSnapshot: ready.targetSnapshot,
      workflow,
      authorization: {
        decision: "allow",
        actor: "operator:readiness",
        decidedAt: "2026-08-21T03:15:00.000Z",
        approvalIds: workflow.approvalIds,
        policyReferences: ["policy:r4-local-production-readiness-approval-v1"],
      },
    }),
    /READY classification/,
  );
});

test("manual rollback rehearsal classification fails closed", async (t) => {
  const ready = await buildReadyContext(t, "manual-rollback");
  const rollbackEvidence = await prepareRollbackRehearsalReadinessEvidence({
    ...ready.rollbackEvidence.payload,
    rehearsalResult: "MANUAL_RECONCILIATION_REQUIRED",
    exactReferenceRestored: false,
  });
  const context = { ...ready.context, rollbackEvidence };
  const proposal = await prepareLocalProductionRoutingReadinessProposal({ context, proposal: proposalInput() });
  assert.equal(proposal.payload.classification, "MANUAL_RECONCILIATION_REQUIRED");
});

test("stale local-production target snapshot rejects authorization after approval", async (t) => {
  const ready = await buildReadyContext(t, "target-drift");
  const proposal = await prepareLocalProductionRoutingReadinessProposal({ context: ready.context, proposal: proposalInput() });
  const drifted = await prepareLocalProductionRoutingTargetSnapshot({
    ...ready.targetSnapshot.payload,
    routeRevision: "route-revision:drifted-after-readiness",
    capturedAt: "2026-08-21T03:14:30.000Z",
  });
  const workflow = r4Workflow(ready.fixture.authorization.payload.projectId);
  await assert.rejects(
    prepareLocalProductionRoutingReadinessAuthorization({
      proposal,
      context: ready.context,
      currentTargetSnapshot: drifted,
      workflow,
      authorization: {
        decision: "allow",
        actor: "operator:readiness",
        decidedAt: "2026-08-21T03:15:00.000Z",
        approvalIds: workflow.approvalIds,
        policyReferences: ["policy:r4-local-production-readiness-approval-v1"],
      },
    }),
    /stale or drifted/,
  );
});

test("backup state must bind the exact local-production reference snapshot", async (t) => {
  const ready = await buildReadyContext(t, "backup-mismatch");
  const backupEvidence = await prepareBackupRestoreReadinessEvidence({
    ...ready.backupEvidence.payload,
    referenceStateSha256: SHA_A,
    restoredStateSha256: SHA_A,
  });
  const context = { ...ready.context, backupEvidence };
  await assert.rejects(
    prepareLocalProductionRoutingReadinessProposal({ context, proposal: proposalInput() }),
    /Backup evidence reference state does not match/,
  );
});

test("secret-like material is rejected from readiness identity/evidence fields", async () => {
  await assert.rejects(
    prepareCredentialIsolationReadinessEvidence({
      credentialBrokerId: "broker:local",
      credentialScopeId: "authorization=Bearer SUPERSECRET012345678901234567890",
      filesystemScopeId: "scope:file",
      networkEgressScopeId: "scope:loopback",
      adapterWriteScopeId: "scope:route",
      evidenceReferences: ["evidence:credential"],
      credentialScopeVerified: true,
      autonomousWorkerLongLivedSecretAccess: false,
      exactTargetOnly: true,
      providerFailureContained: true,
      singleWriterVerified: true,
      observedAt: "2026-08-21T03:09:00.000Z",
    }),
    /secret-like material/,
  );
});

test("R4 durable workflow and exact approval set are mandatory", async (t) => {
  const ready = await buildReadyContext(t, "r4-required");
  const proposal = await prepareLocalProductionRoutingReadinessProposal({ context: ready.context, proposal: proposalInput() });
  const wrongRisk = r4Workflow(ready.fixture.authorization.payload.projectId, { riskClass: "R3" });
  await assert.rejects(
    prepareLocalProductionRoutingReadinessAuthorization({
      proposal,
      context: ready.context,
      currentTargetSnapshot: ready.targetSnapshot,
      workflow: wrongRisk,
      authorization: {
        decision: "allow",
        actor: "operator:readiness",
        decidedAt: "2026-08-21T03:15:00.000Z",
        approvalIds: wrongRisk.approvalIds,
        policyReferences: ["policy:r4-local-production-readiness-approval-v1"],
      },
    }),
    /exact R4 workflow scope/,
  );

  const workflow = r4Workflow(ready.fixture.authorization.payload.projectId);
  await assert.rejects(
    prepareLocalProductionRoutingReadinessAuthorization({
      proposal,
      context: ready.context,
      currentTargetSnapshot: ready.targetSnapshot,
      workflow,
      authorization: {
        decision: "allow",
        actor: "operator:readiness",
        decidedAt: "2026-08-21T03:15:00.000Z",
        approvalIds: ["approval:wrong"],
        policyReferences: ["policy:r4-local-production-readiness-approval-v1"],
      },
    }),
    /do not match durable R4 workflow approvals/,
  );
});

test("rehashed proposal cannot forge production or automatic mutation authority", async (t) => {
  const ready = await buildReadyContext(t, "forged-authority");
  const proposal = await prepareLocalProductionRoutingReadinessProposal({ context: ready.context, proposal: proposalInput() });
  const forgedPayload = {
    ...proposal.payload,
    productionRoutingMutationAuthorized: true,
    automaticRoutingMutationAllowed: true,
    automaticRetryAllowed: true,
    automaticRollbackAllowed: true,
    automaticRedispatchAllowed: true,
  };
  const digest = await sha256Canonical(forgedPayload);
  const forged = {
    schemaVersion: 1,
    algorithm: "sha256",
    proposalId: `m5localprodready:${digest.slice(0, 32).toLowerCase()}`,
    proposalSha256: digest,
    payload: forgedPayload,
  };
  await assert.rejects(
    verifyLocalProductionRoutingReadinessProposal(forged, ready.context),
    /cannot grant production or automatic mutation authority/,
  );
});

test("stale isolated journal reader fails closed after second-writer durable classification drift", async (t) => {
  const ready = await buildReadyContext(t, "stale-journal");
  const staleJournal = await JsonlRoutingMutationJournal.open(isolatedJournalOptions(ready.fixture.root, "stale-journal"));
  const secondWriter = await JsonlRoutingMutationJournal.open(isolatedJournalOptions(ready.fixture.root, "stale-journal"));
  await secondWriter.recordManual({
    operationId: ready.isolatedMutationReceipt.payload.operationId,
    observedAt: "2026-08-21T03:12:30.000Z",
    reason: "Independent durable classification changed after readiness verifier opened.",
  });
  const context = { ...ready.context, isolatedJournal: staleJournal };
  await assert.rejects(
    prepareLocalProductionRoutingReadinessProposal({ context, proposal: proposalInput() }),
    /changed since this reader opened|reopen before evidence verification/,
  );
});

test("adapter source identity is content-addressed and authorization is bound to exact proposal", async (t) => {
  const ready = await buildReadyContext(t, "adapter-source");
  const proposal = await prepareLocalProductionRoutingReadinessProposal({ context: ready.context, proposal: proposalInput() });
  const workflow = r4Workflow(ready.fixture.authorization.payload.projectId);
  const authorization = await prepareLocalProductionRoutingReadinessAuthorization({
    proposal,
    context: ready.context,
    currentTargetSnapshot: ready.targetSnapshot,
    workflow,
    authorization: {
      decision: "allow",
      actor: "operator:readiness",
      decidedAt: "2026-08-21T03:15:00.000Z",
      approvalIds: workflow.approvalIds,
      policyReferences: ["policy:r4-local-production-readiness-approval-v1"],
    },
  });
  const driftedProposal = await prepareLocalProductionRoutingReadinessProposal({
    context: ready.context,
    proposal: proposalInput({ adapterSourceSha256: SHA_A }),
  });
  await assert.rejects(
    verifyLocalProductionRoutingReadinessAuthorization(authorization, driftedProposal, ready.context, ready.targetSnapshot, workflow),
    /scope\/source drift|content address|proposalId/,
  );
});

async function sha256Canonical(value) {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(sortJson(value))),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortJson(child)]),
  );
}
