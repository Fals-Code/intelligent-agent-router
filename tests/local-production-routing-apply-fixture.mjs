import {
  LocalProductionAdapterRehearsalCoordinator,
  prepareLocalProductionRoutingApplyBackupEvidence,
  prepareLocalProductionRoutingReadinessSourceSnapshot,
  prepareLocalProductionRoutingTargetSnapshot,
} from "../dist/index.js";
import { buildLocalProductionAdapterRehearsalFixture } from "./local-production-adapter-rehearsal-fixture.mjs";

const SHA_D = "D".repeat(64);
const SHA_E = "E".repeat(64);
const SHA_F = "F".repeat(64);

function applyWorkflow(projectId, overrides = {}) {
  return {
    id: "workflow:local-production-apply-r4",
    projectId,
    riskClass: "R4",
    phase: "approval",
    status: "running",
    attempt: 1,
    approvalIds: ["approval:local-production-apply:1"],
    createdAt: "2026-08-21T04:01:00.000Z",
    updatedAt: "2026-08-21T04:01:30.000Z",
    ...overrides,
  };
}

export async function buildLocalProductionRoutingApplyFixture(t, suffix = "apply") {
  const base = await buildLocalProductionAdapterRehearsalFixture(t, suffix);
  const coordinator = new LocalProductionAdapterRehearsalCoordinator(
    base.productionTarget,
    base.rehearsalTarget,
    base.rehearsalJournal,
    base.productionPreFingerprint,
  );
  await coordinator.applyCandidate({
    authority: base.authority,
    reservedAt: "2026-08-21T03:18:00.000Z",
    appliedAt: "2026-08-21T03:18:01.000Z",
    committedAt: "2026-08-21T03:18:02.000Z",
  });
  await coordinator.restoreReference({
    authority: base.authority,
    reservedAt: "2026-08-21T03:19:00.000Z",
    restoredAt: "2026-08-21T03:19:01.000Z",
    committedAt: "2026-08-21T03:19:02.000Z",
  });
  const rehearsalReceipt = await coordinator.finalize({
    authority: base.authority,
    productionPreFingerprint: base.productionPreFingerprint,
    completedAt: "2026-08-21T03:20:00.000Z",
  });

  const currentTargetSnapshot = await prepareLocalProductionRoutingTargetSnapshot({
    installationId: base.targetSnapshot.payload.installationId,
    projectId: base.targetSnapshot.payload.projectId,
    routeId: base.targetSnapshot.payload.routeId,
    capability: base.targetSnapshot.payload.capability,
    currentSubjectId: base.targetSnapshot.payload.currentSubjectId,
    routeRevision: base.targetSnapshot.payload.routeRevision,
    canonicalStateOwner: base.targetSnapshot.payload.canonicalStateOwner,
    writeBoundary: base.targetSnapshot.payload.writeBoundary,
    persistenceCategory: base.targetSnapshot.payload.persistenceCategory,
    runtimeId: base.targetSnapshot.payload.runtimeId,
    restartPolicyReference: base.targetSnapshot.payload.restartPolicyReference,
    capturedAt: "2026-08-21T04:00:00.000Z",
    policyReferences: base.targetSnapshot.payload.policyReferences,
  });

  const currentSourceSnapshot = await prepareLocalProductionRoutingReadinessSourceSnapshot({
    adapterId: base.sourceSnapshot.payload.adapterId,
    adapterVersion: "apply-gate-v1",
    adapterSourceSha256: SHA_D,
    mainSourceSha256: SHA_E,
    evidenceReferences: ["evidence:apply-adapter-source-verified", "evidence:apply-main-source-verified"],
    adapterSourceVerified: true,
    mainSourceVerified: true,
    observedAt: "2026-08-21T04:00:10.000Z",
  });

  const productionPreFingerprint = await base.productionTarget.fingerprint("2026-08-21T04:00:20.000Z");
  const backupEvidence = await prepareLocalProductionRoutingApplyBackupEvidence({
    backupId: `backup:local-production-apply:${suffix}`,
    backupSha256: SHA_F,
    productionTargetId: productionPreFingerprint.payload.targetId,
    productionStateId: productionPreFingerprint.payload.stateId,
    productionStateSha256: productionPreFingerprint.payload.stateSha256,
    productionRawFileSha256: productionPreFingerprint.payload.rawFileSha256,
    retentionPolicyReference: "policy:production-apply-backup-retention-v1",
    restoreProcedureReference: "procedure:local-production-route-manual-restore-v1",
    evidenceReferences: ["evidence:fresh-backup-integrity", "evidence:restore-procedure-rehearsed"],
    backupIntegrityVerified: true,
    restoreProcedureRehearsed: true,
    retainedForManualRecovery: true,
    automaticRollbackAllowed: false,
    capturedAt: "2026-08-21T04:00:30.000Z",
  });

  const context = {
    rehearsalReceipt,
    rehearsalAuthority: base.authority,
    rehearsalProductionPreFingerprint: base.productionPreFingerprint,
    rehearsalProductionTarget: base.productionTarget,
    rehearsalTarget: base.rehearsalTarget,
    rehearsalJournal: base.rehearsalJournal,
    currentTargetSnapshot,
    currentSourceSnapshot,
    productionTarget: base.productionTarget,
    productionPreFingerprint,
    backupEvidence,
  };
  const workflow = applyWorkflow(base.targetSnapshot.payload.projectId);

  return {
    ...base,
    rehearsalReceipt,
    currentTargetSnapshot,
    currentSourceSnapshot,
    productionPreFingerprint,
    backupEvidence,
    context,
    workflow,
  };
}
