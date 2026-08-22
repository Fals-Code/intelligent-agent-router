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
  prepareLocalProductionRoutingReadinessSourceSnapshot,
  prepareLocalProductionRoutingTargetSnapshot,
  prepareObservabilityReadinessEvidence,
  prepareRollbackRehearsalReadinessEvidence,
  verifyLocalProductionRoutingReadinessAuthorization,
  verifyLocalProductionRoutingReadinessEvidence,
  verifyLocalProductionRoutingReadinessProposal,
  verifyLocalProductionRoutingReadinessSourceSnapshot,
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

function sourceSnapshotInput(overrides = {}) {
  return {
    adapterId: "adapter:local-production-routing-v1",
    adapterVersion: "design-v1",
    adapterSourceSha256: SHA_B,
    mainSourceSha256: SHA_C,
    evidenceReferences: ["evidence:adapter-source-verified", "evidence:main-source-verified"],
    adapterSourceVerified: true,
    mainSourceVerified: true,
    observedAt: "2026-08-21T03:14:30.000Z",
    ...overrides,
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
    evidenceReferences: ["evidence:adapter-write-scope-audit", "evidence:credential-scope-audit"],
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

  const sourceSnapshot = await prepareLocalProductionRoutingReadinessSourceSnapshot(sourceSnapshotInput());

  return {
    fixture,
    isolatedTarget,
    isolatedJournal,
    isolatedMutationReceipt,
    targetSnapshot,
    sourceSnapshot,
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

function authorizationInput(workflow, overrides = {}) {
  return {
    decision: "allow",
    actor: "operator:local-production-readiness",
    decidedAt: "2026-08-21T03:15:00.000Z",
    approvalIds: workflow.approvalIds,
    policyReferences: ["policy:r4-local-production-readiness-approval-v1"],
    ...overrides,
  };
}

async function createAuthorization(ready, proposal, workflow = r4Workflow(ready.fixture.authorization.payload.projectId), overrides = {}) {
  return prepareLocalProductionRoutingReadinessAuthorization({
    proposal,
    context: ready.context,
    currentTargetSnapshot: ready.targetSnapshot,
    currentSourceSnapshot: ready.sourceSnapshot,
    workflow,
    authorization: authorizationInput(workflow, overrides),
  });
}

test("ready contract authorizes implementation readiness only and never production mutation", async (t) => {
  const ready = await buildReadyContext(t, "ready");
  const proposal = await prepareLocalProductionRoutingReadinessProposal({ context: ready.context, proposal: proposalInput() });
  assert.equal(proposal.payload.classification, "READY_FOR_LOCAL_PRODUCTION_ADAPTER_IMPLEMENTATION");
  assert.equal(proposal.payload.productionRoutingMutationAuthorized, false);
  assert.equal(proposal.payload.automaticRoutingMutationAllowed, false);
  assert.equal(proposal.payload.automaticRollbackAllowed, false);

  const workflow = r4Workflow(ready.fixture.authorization.payload.projectId);
  const authorization = await createAuthorization(ready, proposal, workflow);
  assert.equal(authorization.payload.implementationReadinessAuthorized, true);
  assert.equal(authorization.payload.productionRoutingMutationAuthorized, false);
  assert.equal(authorization.payload.riskClass, "R4");
  await verifyLocalProductionRoutingReadinessAuthorization(
    authorization,
    proposal,
    ready.context,
    ready.targetSnapshot,
    ready.sourceSnapshot,
    workflow,
  );
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
      currentSourceSnapshot: ready.sourceSnapshot,
      workflow,
      authorization: authorizationInput(workflow),
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
  const target = ready.targetSnapshot.payload;
  const drifted = await prepareLocalProductionRoutingTargetSnapshot({
    installationId: target.installationId,
    projectId: target.projectId,
    routeId: target.routeId,
    capability: target.capability,
    currentSubjectId: target.currentSubjectId,
    routeRevision: "route-revision:drifted-after-readiness",
    canonicalStateOwner: target.canonicalStateOwner,
    writeBoundary: target.writeBoundary,
    persistenceCategory: target.persistenceCategory,
    runtimeId: target.runtimeId,
    restartPolicyReference: target.restartPolicyReference,
    capturedAt: "2026-08-21T03:14:30.000Z",
    policyReferences: target.policyReferences,
  });
  const workflow = r4Workflow(ready.fixture.authorization.payload.projectId);
  await assert.rejects(
    prepareLocalProductionRoutingReadinessAuthorization({
      proposal,
      context: ready.context,
      currentTargetSnapshot: drifted,
      currentSourceSnapshot: ready.sourceSnapshot,
      workflow,
      authorization: authorizationInput(workflow),
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
      currentSourceSnapshot: ready.sourceSnapshot,
      workflow: wrongRisk,
      authorization: authorizationInput(wrongRisk),
    }),
    /exact R4 workflow scope/,
  );

  const workflow = r4Workflow(ready.fixture.authorization.payload.projectId);
  await assert.rejects(
    prepareLocalProductionRoutingReadinessAuthorization({
      proposal,
      context: ready.context,
      currentTargetSnapshot: ready.targetSnapshot,
      currentSourceSnapshot: ready.sourceSnapshot,
      workflow,
      authorization: authorizationInput(workflow, { approvalIds: ["approval:wrong"] }),
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
  const forged = await rehashProposal(proposal, forgedPayload);
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
  const authorization = await createAuthorization(ready, proposal, workflow);
  const driftedProposal = await prepareLocalProductionRoutingReadinessProposal({
    context: ready.context,
    proposal: proposalInput({ adapterSourceSha256: SHA_A }),
  });
  await assert.rejects(
    verifyLocalProductionRoutingReadinessAuthorization(
      authorization,
      driftedProposal,
      ready.context,
      ready.targetSnapshot,
      ready.sourceSnapshot,
      workflow,
    ),
    /stale, drifted, or unverified|scope\/source drift|content address|proposalId/,
  );
});

test("readiness evidence, proposal, authorization, and current source snapshots reject rehashed provider-specific extra fields", async (t) => {
  const ready = await buildReadyContext(t, "unknown-fields");
  const proposal = await prepareLocalProductionRoutingReadinessProposal({ context: ready.context, proposal: proposalInput() });
  const workflow = r4Workflow(ready.fixture.authorization.payload.projectId);
  const authorization = await createAuthorization(ready, proposal, workflow);

  const extra = { providerSpecificCredential: "api_key=LEAKED_PROVIDER_SECRET_012345678901234567890" };
  const forgedEvidencePayload = { ...ready.credentialEvidence.payload, ...extra };
  const forgedEvidence = await rehashEvidence(ready.credentialEvidence, forgedEvidencePayload);
  await assert.rejects(
    verifyLocalProductionRoutingReadinessEvidence(forgedEvidence),
    /providerSpecificCredential is not allowed/,
  );

  const forgedProposal = await rehashProposal(proposal, { ...proposal.payload, ...extra });
  await assert.rejects(
    verifyLocalProductionRoutingReadinessProposal(forgedProposal, ready.context),
    /providerSpecificCredential is not allowed/,
  );

  const forgedAuthorization = await rehashAuthorization(authorization, { ...authorization.payload, ...extra });
  await assert.rejects(
    verifyLocalProductionRoutingReadinessAuthorization(
      forgedAuthorization,
      proposal,
      ready.context,
      ready.targetSnapshot,
      ready.sourceSnapshot,
      workflow,
    ),
    /providerSpecificCredential is not allowed/,
  );

  const forgedSource = await rehashSourceSnapshot(ready.sourceSnapshot, { ...ready.sourceSnapshot.payload, ...extra });
  await assert.rejects(
    verifyLocalProductionRoutingReadinessSourceSnapshot(forgedSource),
    /providerSpecificCredential is not allowed/,
  );
});

test("old readiness authorization fails against refreshed adapter or main source drift", async (t) => {
  const ready = await buildReadyContext(t, "source-freshness");
  const proposal = await prepareLocalProductionRoutingReadinessProposal({ context: ready.context, proposal: proposalInput() });
  const workflow = r4Workflow(ready.fixture.authorization.payload.projectId);
  const authorization = await createAuthorization(ready, proposal, workflow);

  const adapterDrift = await prepareLocalProductionRoutingReadinessSourceSnapshot(sourceSnapshotInput({
    adapterSourceSha256: SHA_A,
    observedAt: "2026-08-21T03:16:00.000Z",
  }));
  await assert.rejects(
    verifyLocalProductionRoutingReadinessAuthorization(
      authorization,
      proposal,
      ready.context,
      ready.targetSnapshot,
      adapterDrift,
      workflow,
    ),
    /adapter\/main source is stale, drifted, or unverified/,
  );

  const mainDrift = await prepareLocalProductionRoutingReadinessSourceSnapshot(sourceSnapshotInput({
    mainSourceSha256: SHA_A,
    observedAt: "2026-08-21T03:16:00.000Z",
  }));
  await assert.rejects(
    verifyLocalProductionRoutingReadinessAuthorization(
      authorization,
      proposal,
      ready.context,
      ready.targetSnapshot,
      mainDrift,
      workflow,
    ),
    /adapter\/main source is stale, drifted, or unverified/,
  );

  const unverified = await prepareLocalProductionRoutingReadinessSourceSnapshot(sourceSnapshotInput({
    adapterSourceVerified: false,
    observedAt: "2026-08-21T03:16:00.000Z",
  }));
  await assert.rejects(
    verifyLocalProductionRoutingReadinessAuthorization(
      authorization,
      proposal,
      ready.context,
      ready.targetSnapshot,
      unverified,
      workflow,
    ),
    /adapter\/main source is stale, drifted, or unverified/,
  );
});

test("mandatory readiness proposal scope drift matrix rejects project route capability reference candidate and revision drift", async (t) => {
  const ready = await buildReadyContext(t, "scope-drift-matrix");
  const proposal = await prepareLocalProductionRoutingReadinessProposal({ context: ready.context, proposal: proposalInput() });
  const alternateCapability = proposal.payload.capability === "code.review" ? "code.interactive" : "code.review";
  const cases = [
    ["projectId", "project:drifted"],
    ["routeId", "route:drifted"],
    ["capability", alternateCapability],
    ["referenceSubjectId", "subject:drifted-reference"],
    ["candidateSubjectId", "subject:drifted-candidate"],
    ["routeRevision", "route-revision:drifted"],
  ];
  for (const [field, value] of cases) {
    const forged = await rehashProposal(proposal, { ...proposal.payload, [field]: value });
    await assert.rejects(
      verifyLocalProductionRoutingReadinessProposal(forged, ready.context),
      /canonical source binding drift detected/,
      `expected ${field} drift to fail closed`,
    );
  }
});

test("mandatory missing isolated backup and rollback evidence fail closed at readiness boundary", async (t) => {
  const ready = await buildReadyContext(t, "missing-evidence");
  for (const field of ["isolatedMutationReceipt", "credentialEvidence", "backupEvidence", "rollbackEvidence"]) {
    const context = { ...ready.context, [field]: undefined };
    await assert.rejects(
      prepareLocalProductionRoutingReadinessProposal({ context, proposal: proposalInput() }),
      new RegExp(`context\\.${field} evidence is required`),
      `expected missing ${field} to fail closed`,
    );
  }
});

test("invalid backup integrity and FAILED rollback rehearsal classify NOT_READY", async (t) => {
  const ready = await buildReadyContext(t, "failed-readiness-proofs");
  const backupEvidence = await prepareBackupRestoreReadinessEvidence({
    ...ready.backupEvidence.payload,
    backupIntegrityVerified: false,
  });
  const backupProposal = await prepareLocalProductionRoutingReadinessProposal({
    context: { ...ready.context, backupEvidence },
    proposal: proposalInput(),
  });
  assert.equal(backupProposal.payload.classification, "NOT_READY");
  assert.match(backupProposal.payload.reasons.join(" "), /Backup integrity is not verified/);

  const rollbackEvidence = await prepareRollbackRehearsalReadinessEvidence({
    ...ready.rollbackEvidence.payload,
    rehearsalResult: "FAILED",
    exactReferenceRestored: false,
  });
  const rollbackProposal = await prepareLocalProductionRoutingReadinessProposal({
    context: { ...ready.context, rollbackEvidence },
    proposal: proposalInput(),
  });
  assert.equal(rollbackProposal.payload.classification, "NOT_READY");
  assert.match(rollbackProposal.payload.reasons.join(" "), /Rollback rehearsal is not a clean/);
});

test("broadened credential or write scope and multiple-writer ambiguity classify NOT_READY", async (t) => {
  const ready = await buildReadyContext(t, "scope-and-writer-ambiguity");
  const credentialEvidence = await prepareCredentialIsolationReadinessEvidence({
    ...ready.credentialEvidence.payload,
    exactTargetOnly: false,
    singleWriterVerified: false,
  });
  const proposal = await prepareLocalProductionRoutingReadinessProposal({
    context: { ...ready.context, credentialEvidence },
    proposal: proposalInput(),
  });
  assert.equal(proposal.payload.classification, "NOT_READY");
  assert.match(proposal.payload.reasons.join(" "), /not bounded to the exact target/);
  assert.match(proposal.payload.reasons.join(" "), /Single-writer ownership is not proven/);
});

test("missing and stale human approval or workflow state fails closed", async (t) => {
  const ready = await buildReadyContext(t, "approval-freshness");
  const proposal = await prepareLocalProductionRoutingReadinessProposal({ context: ready.context, proposal: proposalInput() });
  const workflow = r4Workflow(ready.fixture.authorization.payload.projectId);

  await assert.rejects(
    prepareLocalProductionRoutingReadinessAuthorization({
      proposal,
      context: ready.context,
      currentTargetSnapshot: ready.targetSnapshot,
      currentSourceSnapshot: ready.sourceSnapshot,
      workflow: undefined,
      authorization: authorizationInput(workflow),
    }),
    /workflow must be an object/,
  );

  await assert.rejects(
    prepareLocalProductionRoutingReadinessAuthorization({
      proposal,
      context: ready.context,
      currentTargetSnapshot: ready.targetSnapshot,
      currentSourceSnapshot: ready.sourceSnapshot,
      workflow,
      authorization: authorizationInput(workflow, { approvalIds: [] }),
    }),
    /approvalId list must not be empty/,
  );

  const authorization = await createAuthorization(ready, proposal, workflow);
  const staleWorkflow = { ...workflow, updatedAt: "2026-08-21T03:16:00.000Z" };
  await assert.rejects(
    verifyLocalProductionRoutingReadinessAuthorization(
      authorization,
      proposal,
      ready.context,
      ready.targetSnapshot,
      ready.sourceSnapshot,
      staleWorkflow,
    ),
    /predates proposal or workflow/,
  );
});

async function rehashEvidence(evidence, payload) {
  const digest = await sha256Canonical({ kind: evidence.kind, payload });
  return {
    ...evidence,
    evidenceId: `m5localprodproof:${evidence.kind}:${digest.slice(0, 32).toLowerCase()}`,
    evidenceSha256: digest,
    payload,
  };
}

async function rehashProposal(proposal, payload) {
  const digest = await sha256Canonical(payload);
  return {
    ...proposal,
    proposalId: `m5localprodready:${digest.slice(0, 32).toLowerCase()}`,
    proposalSha256: digest,
    payload,
  };
}

async function rehashAuthorization(authorization, payload) {
  const digest = await sha256Canonical(payload);
  return {
    ...authorization,
    authorizationId: `m5localprodreadyauth:${digest.slice(0, 32).toLowerCase()}`,
    authorizationSha256: digest,
    payload,
  };
}

async function rehashSourceSnapshot(snapshot, payload) {
  const digest = await sha256Canonical(payload);
  return {
    ...snapshot,
    snapshotId: `m5localprodsource:${digest.slice(0, 32).toLowerCase()}`,
    snapshotSha256: digest,
    payload,
  };
}

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
