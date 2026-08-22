import { join } from "node:path";
import {
  CanonicalLocalProductionRoutingWriter,
  JsonFileLocalProductionRoutingApplyBackupStore,
  JsonlLocalProductionRoutingApplyJournal,
  LocalProductionAdapterRehearsalCoordinator,
  LocalProductionRoutingApplyCoordinator,
  LocalProductionRoutingSingleWriterBoundary,
  prepareLocalProductionRoutingReadinessSourceSnapshot,
  prepareLocalProductionRoutingTargetSnapshot,
} from "../dist/index.js";
import { buildLocalProductionAdapterRehearsalFixture } from "./local-production-adapter-rehearsal-fixture.mjs";

const SHA_D = "D".repeat(64);
const SHA_E = "E".repeat(64);

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

function applyJournalOptions(root, suffix) {
  return {
    filePath: join(root, `local-production-apply-${suffix}.jsonl`),
    maxFileBytes: 4 * 1024 * 1024,
    maxEventBytes: 512 * 1024,
    maxStringBytes: 4096,
  };
}

export async function freshPrewriteSnapshots(r, overrides = {}) {
  const target = await prepareLocalProductionRoutingTargetSnapshot({
    installationId: r.currentTargetSnapshot.payload.installationId,
    projectId: r.currentTargetSnapshot.payload.projectId,
    routeId: r.currentTargetSnapshot.payload.routeId,
    capability: r.currentTargetSnapshot.payload.capability,
    currentSubjectId: r.currentTargetSnapshot.payload.currentSubjectId,
    routeRevision: r.currentTargetSnapshot.payload.routeRevision,
    canonicalStateOwner: r.currentTargetSnapshot.payload.canonicalStateOwner,
    writeBoundary: r.currentTargetSnapshot.payload.writeBoundary,
    persistenceCategory: r.currentTargetSnapshot.payload.persistenceCategory,
    runtimeId: r.currentTargetSnapshot.payload.runtimeId,
    restartPolicyReference: r.currentTargetSnapshot.payload.restartPolicyReference,
    capturedAt: overrides.targetCapturedAt ?? "2026-08-21T04:03:10.000Z",
    policyReferences: r.currentTargetSnapshot.payload.policyReferences,
    ...(overrides.target ?? {}),
  });
  const source = await prepareLocalProductionRoutingReadinessSourceSnapshot({
    adapterId: r.currentSourceSnapshot.payload.adapterId,
    adapterVersion: r.currentSourceSnapshot.payload.adapterVersion,
    adapterSourceSha256: r.currentSourceSnapshot.payload.adapterSourceSha256,
    mainSourceSha256: r.currentSourceSnapshot.payload.mainSourceSha256,
    evidenceReferences: r.currentSourceSnapshot.payload.evidenceReferences,
    adapterSourceVerified: true,
    mainSourceVerified: true,
    observedAt: overrides.sourceObservedAt ?? "2026-08-21T04:03:20.000Z",
    ...(overrides.source ?? {}),
  });
  return { currentTargetSnapshot: target, currentSourceSnapshot: source };
}

export async function buildLocalProductionRoutingApplyFixture(t, suffix = "apply", overrides = {}) {
  const base = await buildLocalProductionAdapterRehearsalFixture(t, suffix);
  const rehearsalCoordinator = new LocalProductionAdapterRehearsalCoordinator(
    base.productionTarget,
    base.rehearsalTarget,
    base.rehearsalJournal,
    base.productionPreFingerprint,
  );
  await rehearsalCoordinator.applyCandidate({
    authority: base.authority,
    reservedAt: "2026-08-21T03:18:00.000Z",
    appliedAt: "2026-08-21T03:18:01.000Z",
    committedAt: "2026-08-21T03:18:02.000Z",
  });
  await rehearsalCoordinator.restoreReference({
    authority: base.authority,
    reservedAt: "2026-08-21T03:19:00.000Z",
    restoredAt: "2026-08-21T03:19:01.000Z",
    committedAt: "2026-08-21T03:19:02.000Z",
  });
  const rehearsalReceipt = await rehearsalCoordinator.finalize({
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
    adapterVersion: "apply-gate-v2",
    adapterSourceSha256: SHA_D,
    mainSourceSha256: SHA_E,
    evidenceReferences: ["evidence:apply-adapter-source-verified", "evidence:apply-main-source-verified"],
    adapterSourceVerified: true,
    mainSourceVerified: true,
    observedAt: "2026-08-21T04:00:10.000Z",
  });

  const productionPreFingerprint = await base.productionTarget.fingerprint("2026-08-21T04:00:20.000Z");
  const backupStore = new JsonFileLocalProductionRoutingApplyBackupStore({
    storeKind: "local_production_apply_backup_store",
    backupStoreId: `backup-store:local-production-apply:${suffix}`,
    directoryPath: join(base.root, `local-production-apply-backups-${suffix}`),
    productionTargetId: productionPreFingerprint.payload.targetId,
    exactTargetOnly: true,
  });
  const backupEvidence = await backupStore.capture({
    productionTarget: base.productionTarget,
    retentionPolicyReference: "policy:production-apply-backup-retention-v1",
    restoreProcedureReference: "procedure:local-production-route-manual-restore-v1",
    evidenceReferences: ["evidence:fresh-backup-integrity", "evidence:restore-procedure-rehearsed"],
    restoreProcedureRehearsed: true,
    capturedAt: "2026-08-21T04:00:30.000Z",
  });

  const canonicalWriter = new CanonicalLocalProductionRoutingWriter({
    descriptor: {
      writerKind: "canonical_local_production_routing_writer",
      writerId: `writer:local-production-routing:${suffix}`,
      productionTargetId: productionPreFingerprint.payload.targetId,
      projectId: productionPreFingerprint.payload.projectId,
      routeId: productionPreFingerprint.payload.routeId,
      capability: productionPreFingerprint.payload.capability,
      writeBoundaryId: currentTargetSnapshot.payload.writeBoundary,
      stateFilePath: base.productionPath,
      singleWriter: true,
    },
    productionTarget: base.productionTarget,
  });
  const singleWriterBoundary = new LocalProductionRoutingSingleWriterBoundary();
  singleWriterBoundary.register(canonicalWriter);

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
    backupStore,
    canonicalWriter,
    singleWriterBoundary,
  };
  const workflow = applyWorkflow(base.targetSnapshot.payload.projectId, overrides.workflow ?? {});
  const journalOptions = applyJournalOptions(base.root, suffix);
  const applyJournal = await JsonlLocalProductionRoutingApplyJournal.open(journalOptions);
  const applyCoordinator = new LocalProductionRoutingApplyCoordinator(
    base.productionTarget,
    canonicalWriter,
    singleWriterBoundary,
    applyJournal,
    overrides.faultInjector,
  );

  return {
    ...base,
    rehearsalReceipt,
    currentTargetSnapshot,
    currentSourceSnapshot,
    productionPreFingerprint,
    backupEvidence,
    backupStore,
    canonicalWriter,
    singleWriterBoundary,
    context,
    workflow,
    journalOptions,
    applyJournal,
    applyCoordinator,
  };
}
