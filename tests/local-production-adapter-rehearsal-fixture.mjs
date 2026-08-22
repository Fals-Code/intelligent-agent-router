import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  IsolatedRoutingMutationCoordinator,
  JsonFileIsolatedRoutingTarget,
  JsonFileLocalProductionReadOnlyTarget,
  JsonFileLocalProductionRehearsalTarget,
  JsonlLocalProductionRehearsalJournal,
  JsonlRoutingMutationJournal,
  prepareBackupRestoreReadinessEvidence,
  prepareCredentialIsolationReadinessEvidence,
  prepareLocalProductionRouterState,
  prepareLocalProductionRoutingReadinessAuthorization,
  prepareLocalProductionRoutingReadinessProposal,
  prepareLocalProductionRoutingReadinessSourceSnapshot,
  prepareLocalProductionRoutingTargetSnapshot,
  prepareObservabilityReadinessEvidence,
  prepareRollbackRehearsalReadinessEvidence,
} from "../dist/index.js";
import { buildAuthorizedRoutingPromotionFixture } from "./isolated-routing-mutation-fixture.mjs";

const SHA_A = "A".repeat(64);
const SHA_B = "B".repeat(64);
const SHA_C = "C".repeat(64);

function isolatedTargetOptions(root, authority, suffix) {
  return {
    descriptor: {
      targetKind: "isolated_local_test_router",
      targetId: `isolated-router:${authority.authorization.payload.projectId}:${authority.authorization.payload.routeId}`,
      stateFilePath: join(root, `adapter-rehearsal-isolated-${suffix}.json`),
    },
    maxStateBytes: 128 * 1024,
    maxStringBytes: 4096,
  };
}

function isolatedJournalOptions(root, suffix) {
  return {
    filePath: join(root, `adapter-rehearsal-isolated-${suffix}.jsonl`),
    maxFileBytes: 2 * 1024 * 1024,
    maxEventBytes: 256 * 1024,
    maxStringBytes: 4096,
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

export async function buildLocalProductionAdapterRehearsalFixture(t, suffix = "rehearsal") {
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
  const isolatedCoordinator = new IsolatedRoutingMutationCoordinator(isolatedTarget, isolatedJournal);
  const isolatedMutationReceipt = await isolatedCoordinator.apply({
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
    runId: "run:local-production-rehearsal-readiness-proof",
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
    evidence: [{ kind: "backup", status: "passed", reference: "evidence:backup-integrity-proof", producer: "rehearsal-fixture", collectedAt: "2026-08-21T03:10:00.000Z" }],
    resourceMetrics: {},
    traceId: "trace:local-production-rehearsal-readiness-proof",
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

  const sourceSnapshot = await prepareLocalProductionRoutingReadinessSourceSnapshot({
    adapterId: "adapter:local-production-routing-v1",
    adapterVersion: "design-v1",
    adapterSourceSha256: SHA_B,
    mainSourceSha256: SHA_C,
    evidenceReferences: ["evidence:adapter-source-verified", "evidence:main-source-verified"],
    adapterSourceVerified: true,
    mainSourceVerified: true,
    observedAt: "2026-08-21T03:14:30.000Z",
  });

  const readinessContext = {
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
  };
  const readinessProposal = await prepareLocalProductionRoutingReadinessProposal({
    context: readinessContext,
    proposal: {
      adapterId: sourceSnapshot.payload.adapterId,
      adapterVersion: sourceSnapshot.payload.adapterVersion,
      adapterSourceSha256: sourceSnapshot.payload.adapterSourceSha256,
      mainSourceSha256: sourceSnapshot.payload.mainSourceSha256,
      proposedAt: "2026-08-21T03:15:00.000Z",
      policyReferences: ["policy:local-production-readiness-v1"],
    },
  });
  const workflow = r4Workflow(fixture.authorization.payload.projectId, { updatedAt: "2026-08-21T03:15:30.000Z" });
  const readinessAuthorization = await prepareLocalProductionRoutingReadinessAuthorization({
    proposal: readinessProposal,
    context: readinessContext,
    currentTargetSnapshot: targetSnapshot,
    currentSourceSnapshot: sourceSnapshot,
    workflow,
    authorization: {
      decision: "allow",
      actor: "operator:local-production-readiness",
      decidedAt: "2026-08-21T03:16:00.000Z",
      approvalIds: workflow.approvalIds,
      policyReferences: ["policy:r4-local-production-readiness-approval-v1"],
    },
  });

  const productionTargetId = `local-production-router:${targetSnapshot.payload.installationId}:${targetSnapshot.payload.routeId}`;
  const productionState = await prepareLocalProductionRouterState({
    targetId: productionTargetId,
    installationId: targetSnapshot.payload.installationId,
    projectId: targetSnapshot.payload.projectId,
    routeId: targetSnapshot.payload.routeId,
    capability: targetSnapshot.payload.capability,
    currentSubjectId: targetSnapshot.payload.currentSubjectId,
    routeRevision: targetSnapshot.payload.routeRevision,
    updatedAt: "2026-08-21T03:16:30.000Z",
  });
  const productionPath = join(fixture.root, `local-production-${suffix}.json`);
  mkdirSync(fixture.root, { recursive: true });
  writeFileSync(productionPath, `${JSON.stringify(productionState)}\n`, "utf8");
  const productionTarget = new JsonFileLocalProductionReadOnlyTarget({
    descriptor: { targetKind: "local_production_router", targetId: productionTargetId, stateFilePath: productionPath },
    maxStateBytes: 128 * 1024,
  });
  const rehearsalDescriptor = {
    targetKind: "local_production_rehearsal_clone",
    targetId: `local-production-rehearsal:${readinessAuthorization.authorizationId}:${suffix}`,
    sourceProductionTargetId: productionTargetId,
    stateFilePath: join(fixture.root, `local-production-rehearsal-${suffix}.json`),
    rehearsalOnly: true,
  };
  const rehearsalTarget = await JsonFileLocalProductionRehearsalTarget.initialize({
    descriptor: rehearsalDescriptor,
    productionTarget,
    initializedAt: "2026-08-21T03:17:00.000Z",
    maxStateBytes: 128 * 1024,
  });
  const rehearsalJournalOptions = {
    filePath: join(fixture.root, `local-production-rehearsal-${suffix}.jsonl`),
    maxFileBytes: 2 * 1024 * 1024,
    maxEventBytes: 256 * 1024,
    maxStringBytes: 4096,
  };
  const rehearsalJournal = await JsonlLocalProductionRehearsalJournal.open(rehearsalJournalOptions);

  return {
    root: fixture.root,
    fixture,
    productionPath,
    productionState,
    productionTarget,
    rehearsalDescriptor,
    rehearsalTarget,
    rehearsalJournal,
    rehearsalJournalOptions,
    readinessContext,
    readinessProposal,
    readinessAuthorization,
    targetSnapshot,
    sourceSnapshot,
    workflow,
    authority: {
      readinessAuthorization,
      readinessProposal,
      readinessContext,
      currentTargetSnapshot: targetSnapshot,
      currentSourceSnapshot: sourceSnapshot,
      workflow,
    },
  };
}
