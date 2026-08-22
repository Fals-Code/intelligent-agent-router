import * as nodeFsRuntime from "node:fs";
import * as nodePathRuntime from "node:path";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import type { WorkflowRun } from "../control-plane/contracts.js";
import type {
  LocalProductionRoutingReadinessSourceSnapshot,
  LocalProductionRoutingTargetSnapshot,
} from "./local-production-routing-readiness.js";
import {
  verifyLocalProductionRoutingReadinessAuthorization,
  verifyLocalProductionRoutingReadinessSourceSnapshot,
  verifyLocalProductionRoutingTargetSnapshot,
} from "./local-production-routing-readiness.js";
import type {
  LocalProductionAdapterRehearsalAuthority,
  LocalProductionAdapterRehearsalReceipt,
  LocalProductionRouterFingerprint,
  LocalProductionRouterState,
  JsonFileLocalProductionReadOnlyTarget,
  JsonFileLocalProductionRehearsalTarget,
  JsonlLocalProductionRehearsalJournal,
} from "./local-production-adapter-rehearsal.js";
import {
  prepareLocalProductionRouterState,
  verifyLocalProductionAdapterRehearsalReceipt,
  verifyLocalProductionRouterFingerprint,
  verifyLocalProductionRouterState,
} from "./local-production-adapter-rehearsal.js";

const runtimeFs = nodeFsRuntime as unknown as {
  readonly realpathSync: (path: string) => string;
  readonly statSync: (path: string, options: { readonly bigint: true }) => {
    readonly dev: bigint;
    readonly ino: bigint;
    readonly size: bigint;
  };
  readonly renameSync: (from: string, to: string) => void;
  readonly unlinkSync: (path: string) => void;
};
const runtimePath = nodePathRuntime as unknown as {
  readonly basename: (path: string) => string;
  readonly dirname: (path: string) => string;
};

export const LOCAL_PRODUCTION_ROUTING_APPLY_BACKUP_EVIDENCE_SCHEMA_VERSION = 2 as const;
export const LOCAL_PRODUCTION_ROUTING_APPLY_PROPOSAL_SCHEMA_VERSION = 2 as const;
export const LOCAL_PRODUCTION_ROUTING_APPLY_AUTHORIZATION_SCHEMA_VERSION = 2 as const;
export const LOCAL_PRODUCTION_ROUTING_APPLY_EXECUTION_APPROVAL_SCHEMA_VERSION = 2 as const;
export const LOCAL_PRODUCTION_ROUTING_APPLY_PREWRITE_SEAL_SCHEMA_VERSION = 2 as const;
export const LOCAL_PRODUCTION_ROUTING_APPLY_JOURNAL_SCHEMA_VERSION = 1 as const;
export const LOCAL_PRODUCTION_ROUTING_APPLY_RECEIPT_SCHEMA_VERSION = 1 as const;

export type LocalProductionRoutingApplyClassification =
  | "NOT_APPLIED_SAFE"
  | "APPLIED_VERIFIED"
  | "MANUAL_RECONCILIATION_REQUIRED";

export type LocalProductionRoutingApplyFaultPoint =
  | "after_reservation_before_write"
  | "after_write_before_commit";

export interface LocalProductionRoutingApplyFaultInjector {
  hit(point: LocalProductionRoutingApplyFaultPoint): void | Promise<void>;
}

export interface LocalProductionRoutingApplyBackupEvidenceInput {
  readonly backupId: string;
  readonly backupSha256: string;
  readonly backupStoreId: string;
  readonly backupObjectKey: string;
  readonly backupByteLength: number;
  readonly productionTargetId: string;
  readonly productionStateId: string;
  readonly productionStateSha256: string;
  readonly productionRawFileSha256: string;
  readonly retentionPolicyReference: string;
  readonly restoreProcedureReference: string;
  readonly evidenceReferences: readonly string[];
  readonly backupIntegrityVerified: boolean;
  readonly restoreProcedureRehearsed: boolean;
  readonly retainedForManualRecovery: boolean;
  readonly automaticRollbackAllowed: false;
  readonly capturedAt: string;
}

export interface LocalProductionRoutingApplyBackupEvidence {
  readonly schemaVersion: 2;
  readonly algorithm: "sha256";
  readonly evidenceId: string;
  readonly evidenceSha256: string;
  readonly payload: LocalProductionRoutingApplyBackupEvidenceInput;
}

export interface LocalProductionRoutingApplyBackupStoreDescriptor {
  readonly storeKind: "local_production_apply_backup_store";
  readonly backupStoreId: string;
  readonly directoryPath: string;
  readonly productionTargetId: string;
  readonly exactTargetOnly: true;
}

export interface CanonicalLocalProductionRoutingWriterDescriptor {
  readonly writerKind: "canonical_local_production_routing_writer";
  readonly writerId: string;
  readonly productionTargetId: string;
  readonly projectId: string;
  readonly routeId: string;
  readonly capability: string;
  readonly writeBoundaryId: string;
  readonly stateFilePath: string;
  readonly singleWriter: true;
}

export interface LocalProductionRoutingApplyContext {
  readonly rehearsalReceipt: LocalProductionAdapterRehearsalReceipt;
  readonly rehearsalAuthority: LocalProductionAdapterRehearsalAuthority;
  readonly rehearsalProductionPreFingerprint: LocalProductionRouterFingerprint;
  readonly rehearsalProductionTarget: JsonFileLocalProductionReadOnlyTarget;
  readonly rehearsalTarget: JsonFileLocalProductionRehearsalTarget;
  readonly rehearsalJournal: JsonlLocalProductionRehearsalJournal;
  readonly currentTargetSnapshot: LocalProductionRoutingTargetSnapshot;
  readonly currentSourceSnapshot: LocalProductionRoutingReadinessSourceSnapshot;
  readonly productionTarget: JsonFileLocalProductionReadOnlyTarget;
  readonly productionPreFingerprint: LocalProductionRouterFingerprint;
  readonly backupEvidence: LocalProductionRoutingApplyBackupEvidence;
  readonly backupStore: JsonFileLocalProductionRoutingApplyBackupStore;
  readonly canonicalWriter: CanonicalLocalProductionRoutingWriter;
  readonly singleWriterBoundary: LocalProductionRoutingSingleWriterBoundary;
}

export interface LocalProductionRoutingApplyProposalInput {
  readonly candidateSubjectId: string;
  readonly candidateRouteRevision: string;
  readonly proposedAt: string;
  readonly policyReferences: readonly string[];
  readonly runLedgerReferences: readonly string[];
  readonly traceReferences: readonly string[];
}

export interface LocalProductionRoutingApplyProposalPayload extends LocalProductionRoutingApplyProposalInput {
  readonly readinessAuthorizationId: string;
  readonly readinessAuthorizationSha256: string;
  readonly rehearsalReceiptId: string;
  readonly rehearsalReceiptSha256: string;
  readonly targetSnapshotId: string;
  readonly targetSnapshotSha256: string;
  readonly sourceSnapshotId: string;
  readonly sourceSnapshotSha256: string;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly adapterSourceSha256: string;
  readonly mainSourceSha256: string;
  readonly productionTargetId: string;
  readonly projectId: string;
  readonly routeId: string;
  readonly capability: string;
  readonly referenceSubjectId: string;
  readonly referenceRouteRevision: string;
  readonly productionPreFingerprintId: string;
  readonly productionPreFingerprintSha256: string;
  readonly productionPreStateId: string;
  readonly productionPreStateSha256: string;
  readonly productionPreRawFileSha256: string;
  readonly backupEvidenceId: string;
  readonly backupEvidenceSha256: string;
  readonly backupId: string;
  readonly backupSha256: string;
  readonly canonicalWriterId: string;
  readonly writeBoundaryId: string;
  readonly singleWriterVerified: true;
  readonly productionRoutingMutationAuthorized: false;
  readonly automaticRoutingMutationAllowed: false;
  readonly automaticRetryAllowed: false;
  readonly automaticRollbackAllowed: false;
  readonly automaticRedispatchAllowed: false;
  readonly automaticPromotionAllowed: false;
}

export interface LocalProductionRoutingApplyProposal {
  readonly schemaVersion: 2;
  readonly algorithm: "sha256";
  readonly proposalId: string;
  readonly proposalSha256: string;
  readonly payload: LocalProductionRoutingApplyProposalPayload;
}

export interface LocalProductionRoutingApplyAuthorizationInput {
  readonly decision: "allow" | "deny";
  readonly actor: string;
  readonly decidedAt: string;
  readonly approvalIds: readonly string[];
  readonly policyReferences: readonly string[];
}

export interface LocalProductionRoutingApplyAuthorizationPayload extends LocalProductionRoutingApplyAuthorizationInput {
  readonly proposalId: string;
  readonly proposalSha256: string;
  readonly workflowRunId: string;
  readonly riskClass: "R4";
  readonly projectId: string;
  readonly routeId: string;
  readonly capability: string;
  readonly productionTargetId: string;
  readonly referenceSubjectId: string;
  readonly referenceRouteRevision: string;
  readonly candidateSubjectId: string;
  readonly candidateRouteRevision: string;
  readonly rehearsalReceiptId: string;
  readonly rehearsalReceiptSha256: string;
  readonly sourceSnapshotId: string;
  readonly sourceSnapshotSha256: string;
  readonly backupEvidenceId: string;
  readonly backupEvidenceSha256: string;
  readonly canonicalWriterId: string;
  readonly productionPreFingerprintId: string;
  readonly productionPreFingerprintSha256: string;
  readonly productionRoutingMutationAuthorized: boolean;
  readonly oneShotAuthorization: true;
  readonly automaticRoutingMutationAllowed: false;
  readonly automaticRetryAllowed: false;
  readonly automaticRollbackAllowed: false;
  readonly automaticRedispatchAllowed: false;
  readonly automaticPromotionAllowed: false;
}

export interface LocalProductionRoutingApplyAuthorization {
  readonly schemaVersion: 2;
  readonly algorithm: "sha256";
  readonly authorizationId: string;
  readonly authorizationSha256: string;
  readonly payload: LocalProductionRoutingApplyAuthorizationPayload;
}

export interface LocalProductionRoutingApplyExecutionApprovalInput {
  readonly actor: string;
  readonly approvedAt: string;
  readonly explicitApplyNow: true;
  readonly policyReferences: readonly string[];
}

export interface LocalProductionRoutingApplyExecutionApprovalPayload extends LocalProductionRoutingApplyExecutionApprovalInput {
  readonly operationId: string;
  readonly proposalId: string;
  readonly proposalSha256: string;
  readonly authorizationId: string;
  readonly authorizationSha256: string;
  readonly productionTargetId: string;
  readonly productionPreFingerprintId: string;
  readonly productionPreFingerprintSha256: string;
  readonly candidateSubjectId: string;
  readonly candidateRouteRevision: string;
  readonly canonicalWriterId: string;
  readonly oneShotExecutionApproval: true;
  readonly automaticRoutingMutationAllowed: false;
  readonly automaticRetryAllowed: false;
  readonly automaticRollbackAllowed: false;
  readonly automaticRedispatchAllowed: false;
  readonly automaticPromotionAllowed: false;
}

export interface LocalProductionRoutingApplyExecutionApproval {
  readonly schemaVersion: 2;
  readonly algorithm: "sha256";
  readonly approvalId: string;
  readonly approvalSha256: string;
  readonly payload: LocalProductionRoutingApplyExecutionApprovalPayload;
}

export interface LocalProductionRoutingApplyPrewriteSealPayload {
  readonly operationId: string;
  readonly proposalId: string;
  readonly proposalSha256: string;
  readonly authorizationId: string;
  readonly authorizationSha256: string;
  readonly executionApprovalId: string;
  readonly executionApprovalSha256: string;
  readonly productionTargetId: string;
  readonly productionFingerprintId: string;
  readonly productionFingerprintSha256: string;
  readonly productionStateId: string;
  readonly productionStateSha256: string;
  readonly productionRawFileSha256: string;
  readonly proposalSourceSnapshotId: string;
  readonly proposalSourceSnapshotSha256: string;
  readonly currentSourceSnapshotId: string;
  readonly currentSourceSnapshotSha256: string;
  readonly currentTargetSnapshotId: string;
  readonly currentTargetSnapshotSha256: string;
  readonly backupEvidenceId: string;
  readonly backupEvidenceSha256: string;
  readonly canonicalWriterId: string;
  readonly observedAt: string;
  readonly productionWritePerformed: false;
  readonly productionRoutingMutationAuthorized: true;
  readonly automaticRoutingMutationAllowed: false;
  readonly automaticRetryAllowed: false;
  readonly automaticRollbackAllowed: false;
  readonly automaticRedispatchAllowed: false;
  readonly automaticPromotionAllowed: false;
}

export interface LocalProductionRoutingApplyPrewriteSeal {
  readonly schemaVersion: 2;
  readonly algorithm: "sha256";
  readonly sealId: string;
  readonly sealSha256: string;
  readonly payload: LocalProductionRoutingApplyPrewriteSealPayload;
}

type ApplyJournalEventType =
  | "apply_reserved"
  | "apply_committed"
  | "not_applied_safe"
  | "manual_reconciliation_required";

export interface LocalProductionRoutingApplyJournalEventPayload {
  readonly eventType: ApplyJournalEventType;
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly productionTargetId: string;
  readonly projectId: string;
  readonly routeId: string;
  readonly capability: string;
  readonly beforeStateId: string;
  readonly beforeStateSha256: string;
  readonly beforeSubjectId: string;
  readonly beforeRouteRevision: string;
  readonly afterStateId: string;
  readonly afterStateSha256: string;
  readonly afterSubjectId: string;
  readonly afterRouteRevision: string;
  readonly candidateState: LocalProductionRouterState;
  readonly candidateRawFileSha256: string;
  readonly productionPreFingerprintId: string;
  readonly productionPreFingerprintSha256: string;
  readonly productionPreRawFileSha256: string;
  readonly readinessAuthorizationId: string;
  readonly readinessAuthorizationSha256: string;
  readonly rehearsalReceiptId: string;
  readonly rehearsalReceiptSha256: string;
  readonly proposalId: string;
  readonly proposalSha256: string;
  readonly authorizationId: string;
  readonly authorizationSha256: string;
  readonly executionApprovalId: string;
  readonly executionApprovalSha256: string;
  readonly prewriteSealId: string;
  readonly prewriteSealSha256: string;
  readonly currentSourceSnapshotId: string;
  readonly currentSourceSnapshotSha256: string;
  readonly currentTargetSnapshotId: string;
  readonly currentTargetSnapshotSha256: string;
  readonly backupEvidenceId: string;
  readonly backupEvidenceSha256: string;
  readonly backupId: string;
  readonly backupSha256: string;
  readonly canonicalWriterId: string;
  readonly workflowRunId: string;
  readonly approvalIds: readonly string[];
  readonly runLedgerReferences: readonly string[];
  readonly traceReferences: readonly string[];
  readonly observedAt: string;
  readonly recoveredAfterRestart: boolean;
  readonly classification: "PENDING" | LocalProductionRoutingApplyClassification;
  readonly productionWriteObserved: "NO" | "YES" | "UNKNOWN";
  readonly sanitizedResult: string;
  readonly automaticRoutingMutationAllowed: false;
  readonly automaticRetryAllowed: false;
  readonly automaticRollbackAllowed: false;
  readonly automaticRedispatchAllowed: false;
  readonly automaticPromotionAllowed: false;
}

export interface LocalProductionRoutingApplyJournalEvent {
  readonly algorithm: "sha256";
  readonly eventId: string;
  readonly eventSha256: string;
  readonly payload: LocalProductionRoutingApplyJournalEventPayload;
}

interface PersistedApplyJournalEntry {
  readonly schemaVersion: 1;
  readonly sequence: number;
  readonly previousEntrySha256: string | null;
  readonly event: LocalProductionRoutingApplyJournalEvent;
  readonly entrySha256: string;
}

export interface LocalProductionRoutingApplyJournalOptions {
  readonly filePath: string;
  readonly maxFileBytes: number;
  readonly maxEventBytes: number;
  readonly maxStringBytes: number;
}

export interface LocalProductionRoutingApplyReceiptPayload {
  readonly classification: LocalProductionRoutingApplyClassification;
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly productionTargetId: string;
  readonly projectId: string;
  readonly routeId: string;
  readonly capability: string;
  readonly referenceStateId: string;
  readonly referenceStateSha256: string;
  readonly referenceSubjectId: string;
  readonly referenceRouteRevision: string;
  readonly candidateStateId: string;
  readonly candidateStateSha256: string;
  readonly candidateSubjectId: string;
  readonly candidateRouteRevision: string;
  readonly productionPreFingerprintId: string;
  readonly productionPreFingerprintSha256: string;
  readonly productionPreRawFileSha256: string;
  readonly productionPostFingerprintId: string | null;
  readonly productionPostFingerprintSha256: string | null;
  readonly productionPostRawFileSha256: string | null;
  readonly reservationEventId: string;
  readonly reservationEventSha256: string;
  readonly commitEventId: string | null;
  readonly commitEventSha256: string | null;
  readonly terminalEventId: string | null;
  readonly terminalEventSha256: string | null;
  readonly journalProgressionSha256: string;
  readonly readinessAuthorizationId: string;
  readonly readinessAuthorizationSha256: string;
  readonly rehearsalReceiptId: string;
  readonly rehearsalReceiptSha256: string;
  readonly proposalId: string;
  readonly proposalSha256: string;
  readonly authorizationId: string;
  readonly authorizationSha256: string;
  readonly executionApprovalId: string;
  readonly executionApprovalSha256: string;
  readonly prewriteSealId: string;
  readonly prewriteSealSha256: string;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly adapterSourceSha256: string;
  readonly mainSourceSha256: string;
  readonly backupEvidenceId: string;
  readonly backupEvidenceSha256: string;
  readonly backupId: string;
  readonly backupSha256: string;
  readonly canonicalWriterId: string;
  readonly workflowRunId: string;
  readonly approvalIds: readonly string[];
  readonly authorizationActor: string;
  readonly authorizationDecidedAt: string;
  readonly executionApprovalActor: string;
  readonly executionApprovedAt: string;
  readonly runLedgerReferences: readonly string[];
  readonly traceReferences: readonly string[];
  readonly completedAt: string;
  readonly reason: string;
  readonly recoveredAfterRestart: boolean;
  readonly oneShotConsumed: true;
  readonly productionRouteMutated: boolean;
  readonly productionRoutingMutationAuthorizedForThisOperation: true;
  readonly futureProductionMutationAuthorized: false;
  readonly automaticRoutingMutationAllowed: false;
  readonly automaticRetryAllowed: false;
  readonly automaticRollbackAllowed: false;
  readonly automaticRedispatchAllowed: false;
  readonly automaticPromotionAllowed: false;
}

export interface LocalProductionRoutingApplyReceipt {
  readonly schemaVersion: 1;
  readonly algorithm: "sha256";
  readonly receiptId: string;
  readonly receiptSha256: string;
  readonly payload: LocalProductionRoutingApplyReceiptPayload;
}

class ProductionApplyWriteError extends Error {
  constructor(message: string, readonly writeMayHaveOccurred: boolean) {
    super(message);
  }
}

const AUTO_FIELDS = [
  "automaticRoutingMutationAllowed",
  "automaticRetryAllowed",
  "automaticRollbackAllowed",
  "automaticRedispatchAllowed",
  "automaticPromotionAllowed",
] as const;

export class JsonFileLocalProductionRoutingApplyBackupStore {
  readonly descriptor: LocalProductionRoutingApplyBackupStoreDescriptor;

  constructor(descriptor: LocalProductionRoutingApplyBackupStoreDescriptor) {
    assertExactKeys(descriptor, ["storeKind", "backupStoreId", "directoryPath", "productionTargetId", "exactTargetOnly"], "backup store descriptor");
    if (descriptor.storeKind !== "local_production_apply_backup_store" || descriptor.exactTargetOnly !== true) {
      throw new Error("Production apply backup store must be exact-target only");
    }
    this.descriptor = Object.freeze({
      ...descriptor,
      backupStoreId: identity(descriptor.backupStoreId, "backupStoreId"),
      directoryPath: resolve(identity(descriptor.directoryPath, "backup directory")),
      productionTargetId: identity(descriptor.productionTargetId, "backup productionTargetId"),
    });
    mkdirSync(this.descriptor.directoryPath, { recursive: true });
  }

  async capture(input: {
    readonly productionTarget: JsonFileLocalProductionReadOnlyTarget;
    readonly retentionPolicyReference: string;
    readonly restoreProcedureReference: string;
    readonly evidenceReferences: readonly string[];
    readonly restoreProcedureRehearsed: true;
    readonly capturedAt: string;
  }): Promise<LocalProductionRoutingApplyBackupEvidence> {
    if (input.productionTarget.descriptor.targetId !== this.descriptor.productionTargetId) throw new Error("Backup store target identity mismatch");
    const capturedAt = timestamp(input.capturedAt, "backup capturedAt");
    const state = await input.productionTarget.read();
    const fingerprint = await input.productionTarget.fingerprint(capturedAt);
    const raw = readBoundedRaw(input.productionTarget.descriptor.stateFilePath, input.productionTarget.maxStateBytes, "production backup source");
    const rawSha = await sha256Text(raw);
    if (rawSha !== fingerprint.payload.rawFileSha256 || state.stateId !== fingerprint.payload.stateId || state.stateSha256 !== fingerprint.payload.stateSha256) {
      throw new Error("Backup source semantic/raw fingerprint mismatch");
    }
    const objectKey = `${rawSha.toLowerCase()}.json`;
    const backupPath = resolve(this.descriptor.directoryPath, objectKey);
    if (runtimePath.dirname(backupPath) !== this.descriptor.directoryPath) throw new Error("Backup object escaped bounded store");
    assertDistinctPhysicalCandidate(input.productionTarget.descriptor.stateFilePath, backupPath);
    if (!existsSync(backupPath)) {
      const fd = openSync(backupPath, "wx", 0o600);
      try { writeFileSync(fd, raw, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
      fsyncDirectoryBestEffort(this.descriptor.directoryPath);
    }
    const backupRaw = readBoundedRaw(backupPath, input.productionTarget.maxStateBytes, "production backup");
    if (backupRaw !== raw || await sha256Text(backupRaw) !== rawSha) throw new Error("Fresh backup integrity verification failed");
    const parsed = JSON.parse(backupRaw) as LocalProductionRouterState;
    await verifyLocalProductionRouterState(parsed);
    if (parsed.stateId !== state.stateId || parsed.stateSha256 !== state.stateSha256) throw new Error("Fresh backup semantic state mismatch");
    return prepareLocalProductionRoutingApplyBackupEvidence({
      backupId: `m5localprodbackup:${rawSha.slice(0, 32).toLowerCase()}`,
      backupSha256: rawSha,
      backupStoreId: this.descriptor.backupStoreId,
      backupObjectKey: objectKey,
      backupByteLength: byteLength(backupRaw),
      productionTargetId: fingerprint.payload.targetId,
      productionStateId: fingerprint.payload.stateId,
      productionStateSha256: fingerprint.payload.stateSha256,
      productionRawFileSha256: fingerprint.payload.rawFileSha256,
      retentionPolicyReference: input.retentionPolicyReference,
      restoreProcedureReference: input.restoreProcedureReference,
      evidenceReferences: input.evidenceReferences,
      backupIntegrityVerified: true,
      restoreProcedureRehearsed: input.restoreProcedureRehearsed,
      retainedForManualRecovery: true,
      automaticRollbackAllowed: false,
      capturedAt,
    });
  }

  async verify(evidence: LocalProductionRoutingApplyBackupEvidence): Promise<void> {
    await verifyLocalProductionRoutingApplyBackupEvidence(evidence);
    if (evidence.payload.backupStoreId !== this.descriptor.backupStoreId || evidence.payload.productionTargetId !== this.descriptor.productionTargetId) {
      throw new Error("Backup evidence store/target mismatch");
    }
    const path = resolve(this.descriptor.directoryPath, evidence.payload.backupObjectKey);
    if (runtimePath.dirname(path) !== this.descriptor.directoryPath || !existsSync(path)) throw new Error("Backup object missing from bounded store");
    const raw = readBoundedRaw(path, evidence.payload.backupByteLength, "production backup");
    if (byteLength(raw) !== evidence.payload.backupByteLength || await sha256Text(raw) !== evidence.payload.backupSha256) {
      throw new Error("Backup object bytes do not match integrity proof");
    }
    const state = JSON.parse(raw) as LocalProductionRouterState;
    await verifyLocalProductionRouterState(state);
    if (state.payload.targetId !== evidence.payload.productionTargetId || state.stateId !== evidence.payload.productionStateId ||
        state.stateSha256 !== evidence.payload.productionStateSha256 || evidence.payload.backupSha256 !== evidence.payload.productionRawFileSha256) {
      throw new Error("Backup semantic/raw identity mismatch");
    }
  }
}

export class LocalProductionRoutingSingleWriterBoundary {
  private writer: CanonicalLocalProductionRoutingWriter | undefined;

  register(writer: CanonicalLocalProductionRoutingWriter): void {
    if (this.writer && this.writer !== writer) throw new Error("Second/co-primary production writer is forbidden");
    this.writer = writer;
  }

  verify(writer: CanonicalLocalProductionRoutingWriter): void {
    if (!this.writer || this.writer !== writer) throw new Error("Canonical production writer is not the single registered writer");
  }
}

export class CanonicalLocalProductionRoutingWriter {
  readonly descriptor: CanonicalLocalProductionRoutingWriterDescriptor;
  private readonly physicalRealPath: string;
  private readonly physicalDev: bigint;
  private readonly physicalIno: bigint;
  private writes = 0;

  constructor(input: { readonly descriptor: CanonicalLocalProductionRoutingWriterDescriptor; readonly productionTarget: JsonFileLocalProductionReadOnlyTarget }) {
    assertExactKeys(input.descriptor, ["writerKind", "writerId", "productionTargetId", "projectId", "routeId", "capability", "writeBoundaryId", "stateFilePath", "singleWriter"], "canonical writer descriptor");
    const targetPath = resolve(input.productionTarget.descriptor.stateFilePath);
    const stateFilePath = resolve(identity(input.descriptor.stateFilePath, "writer stateFilePath"));
    if (input.descriptor.writerKind !== "canonical_local_production_routing_writer" || input.descriptor.singleWriter !== true ||
        input.descriptor.productionTargetId !== input.productionTarget.descriptor.targetId || stateFilePath !== targetPath) {
      throw new Error("Canonical writer descriptor broadens or mismatches exact production target");
    }
    this.descriptor = Object.freeze({ ...input.descriptor, stateFilePath });
    this.physicalRealPath = runtimeFs.realpathSync(targetPath);
    const stat = runtimeFs.statSync(targetPath, { bigint: true });
    this.physicalDev = stat.dev;
    this.physicalIno = stat.ino;
  }

  get writeCount(): number { return this.writes; }

  async writeOnce(input: {
    readonly operationId: string;
    readonly expectedBeforeFingerprint: LocalProductionRouterFingerprint;
    readonly candidateState: LocalProductionRouterState;
    readonly productionTarget: JsonFileLocalProductionReadOnlyTarget;
    readonly observedAt: string;
  }): Promise<LocalProductionRouterFingerprint> {
    if (this.writes !== 0) throw new ProductionApplyWriteError("Canonical production writer cannot execute a second write", false);
    if (input.productionTarget.descriptor.targetId !== this.descriptor.productionTargetId ||
        resolve(input.productionTarget.descriptor.stateFilePath) !== this.descriptor.stateFilePath) {
      throw new ProductionApplyWriteError("Canonical production writer target mismatch", false);
    }
    await verifyLocalProductionRouterFingerprint(input.expectedBeforeFingerprint);
    await verifyLocalProductionRouterState(input.candidateState);
    assertWriterScope(this.descriptor, input.candidateState);
    this.assertPhysicalIdentity();
    const before = await input.productionTarget.fingerprint(input.observedAt);
    assertFingerprintEquivalent(before, input.expectedBeforeFingerprint, "Production changed before canonical write");
    const candidateRaw = JSON.stringify(input.candidateState);
    const candidateRawSha = await sha256Text(candidateRaw);
    const tempPath = `${this.descriptor.stateFilePath}.m5apply-${safeFileToken(input.operationId)}.tmp`;
    if (existsSync(tempPath)) throw new ProductionApplyWriteError("Canonical writer temporary path already exists", false);
    let renamed = false;
    try {
      const fd = openSync(tempPath, "wx", 0o600);
      try { writeFileSync(fd, candidateRaw, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
      const stagedRaw = readBoundedRaw(tempPath, input.productionTarget.maxStateBytes, "candidate staged state");
      if (stagedRaw !== candidateRaw || await sha256Text(stagedRaw) !== candidateRawSha) throw new ProductionApplyWriteError("Candidate staged bytes failed integrity proof", false);
      const staged = JSON.parse(stagedRaw) as LocalProductionRouterState;
      await verifyLocalProductionRouterState(staged);
      this.assertPhysicalIdentity();
      const immediateBefore = await input.productionTarget.fingerprint(input.observedAt);
      assertFingerprintEquivalent(immediateBefore, input.expectedBeforeFingerprint, "Production changed at final write boundary");
      runtimeFs.renameSync(tempPath, this.descriptor.stateFilePath);
      renamed = true;
      this.writes += 1;
      fsyncDirectoryBestEffort(runtimePath.dirname(this.descriptor.stateFilePath));
      const post = await input.productionTarget.fingerprint(input.observedAt);
      assertCandidateFingerprint(post, input.candidateState, candidateRawSha);
      return post;
    } catch (error) {
      if (!renamed && existsSync(tempPath)) { try { runtimeFs.unlinkSync(tempPath); } catch { /* bounded temp cleanup only */ } }
      if (error instanceof ProductionApplyWriteError) throw error;
      throw new ProductionApplyWriteError(sanitizeError(error, "Canonical production write failed"), renamed);
    }
  }

  private assertPhysicalIdentity(): void {
    const realPath = runtimeFs.realpathSync(this.descriptor.stateFilePath);
    const stat = runtimeFs.statSync(this.descriptor.stateFilePath, { bigint: true });
    if (realPath !== this.physicalRealPath || stat.dev !== this.physicalDev || stat.ino !== this.physicalIno) {
      throw new ProductionApplyWriteError("Physical production target identity changed before write", false);
    }
  }
}

export class JsonlLocalProductionRoutingApplyJournal {
  readonly options: LocalProductionRoutingApplyJournalOptions;
  private entriesValue: PersistedApplyJournalEntry[] = [];
  private rawSnapshot = "";

  private constructor(options: LocalProductionRoutingApplyJournalOptions) {
    this.options = Object.freeze({
      filePath: resolve(identity(options.filePath, "apply journal path")),
      maxFileBytes: positiveInteger(options.maxFileBytes, "apply journal maxFileBytes"),
      maxEventBytes: positiveInteger(options.maxEventBytes, "apply journal maxEventBytes"),
      maxStringBytes: positiveInteger(options.maxStringBytes, "apply journal maxStringBytes"),
    });
  }

  static async open(options: LocalProductionRoutingApplyJournalOptions): Promise<JsonlLocalProductionRoutingApplyJournal> {
    const journal = new JsonlLocalProductionRoutingApplyJournal(options);
    mkdirSync(runtimePath.dirname(journal.options.filePath), { recursive: true });
    if (!existsSync(journal.options.filePath)) {
      const fd = openSync(journal.options.filePath, "wx", 0o600);
      try { fsyncSync(fd); } finally { closeSync(fd); }
    }
    await journal.reload();
    return journal;
  }

  async events(): Promise<readonly LocalProductionRoutingApplyJournalEvent[]> {
    await this.assertFresh();
    return this.entriesValue.map((entry) => entry.event);
  }

  async append(event: LocalProductionRoutingApplyJournalEvent): Promise<LocalProductionRoutingApplyJournalEvent> {
    await this.assertFresh();
    await verifyApplyJournalEvent(event, this.options.maxStringBytes);
    assertAppendProgression(this.entriesValue.map((entry) => entry.event), event);
    if (byteLength(JSON.stringify(event)) > this.options.maxEventBytes) throw new Error("Production apply journal event exceeds byte bound");
    const sequence = this.entriesValue.length + 1;
    const previousEntrySha256 = this.entriesValue.at(-1)?.entrySha256 ?? null;
    const core = { schemaVersion: 1 as const, sequence, previousEntrySha256, event };
    const entrySha256 = await sha256Canonical(core);
    const entry: PersistedApplyJournalEntry = { ...core, entrySha256 };
    const line = `${JSON.stringify(entry)}\n`;
    if (byteLength(this.rawSnapshot) + byteLength(line) > this.options.maxFileBytes) throw new Error("Production apply journal exceeds file byte bound");
    const fd = openSync(this.options.filePath, "a", 0o600);
    try { writeFileSync(fd, line, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
    this.entriesValue = [...this.entriesValue, entry];
    this.rawSnapshot += line;
    return event;
  }

  private async reload(): Promise<void> {
    const raw = readBoundedRaw(this.options.filePath, this.options.maxFileBytes, "production apply journal", true);
    if (raw.length > 0 && !raw.endsWith("\n")) throw new Error("Production apply journal is partial/truncated");
    const lines = raw.length === 0 ? [] : raw.slice(0, -1).split("\n");
    const entries: PersistedApplyJournalEntry[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      let parsed: PersistedApplyJournalEntry;
      try { parsed = JSON.parse(lines[index]) as PersistedApplyJournalEntry; } catch { throw new Error("Production apply journal contains invalid JSON"); }
      assertExactKeys(parsed, ["schemaVersion", "sequence", "previousEntrySha256", "event", "entrySha256"], "apply journal entry");
      if (parsed.schemaVersion !== 1 || parsed.sequence !== index + 1) throw new Error("Production apply journal sequence/schema drift");
      if (parsed.previousEntrySha256 !== (entries.at(-1)?.entrySha256 ?? null)) throw new Error("Production apply journal hash-chain drift");
      await verifyApplyJournalEvent(parsed.event, this.options.maxStringBytes);
      const expected = await sha256Canonical({ schemaVersion: parsed.schemaVersion, sequence: parsed.sequence, previousEntrySha256: parsed.previousEntrySha256, event: parsed.event });
      if (parsed.entrySha256 !== expected) throw new Error("Production apply journal entry hash tamper detected");
      assertAppendProgression(entries.map((entry) => entry.event), parsed.event);
      entries.push(parsed);
    }
    this.entriesValue = entries;
    this.rawSnapshot = raw;
  }

  private async assertFresh(): Promise<void> {
    const raw = readBoundedRaw(this.options.filePath, this.options.maxFileBytes, "production apply journal", true);
    if (raw !== this.rawSnapshot) throw new Error("Production apply journal stale reader / second-writer drift detected");
  }
}

export async function prepareLocalProductionRoutingApplyBackupEvidence(input: LocalProductionRoutingApplyBackupEvidenceInput): Promise<LocalProductionRoutingApplyBackupEvidence> {
  assertExactKeys(input, ["backupId", "backupSha256", "backupStoreId", "backupObjectKey", "backupByteLength", "productionTargetId", "productionStateId", "productionStateSha256", "productionRawFileSha256", "retentionPolicyReference", "restoreProcedureReference", "evidenceReferences", "backupIntegrityVerified", "restoreProcedureRehearsed", "retainedForManualRecovery", "automaticRollbackAllowed", "capturedAt"], "apply backup input");
  const payload: LocalProductionRoutingApplyBackupEvidenceInput = deepFreeze({
    backupId: identity(input.backupId, "backupId"), backupSha256: sha256(input.backupSha256, "backupSha256"),
    backupStoreId: identity(input.backupStoreId, "backupStoreId"), backupObjectKey: safeObjectKey(input.backupObjectKey),
    backupByteLength: positiveInteger(input.backupByteLength, "backupByteLength"), productionTargetId: identity(input.productionTargetId, "productionTargetId"),
    productionStateId: identity(input.productionStateId, "productionStateId"), productionStateSha256: sha256(input.productionStateSha256, "productionStateSha256"),
    productionRawFileSha256: sha256(input.productionRawFileSha256, "productionRawFileSha256"), retentionPolicyReference: identity(input.retentionPolicyReference, "retentionPolicyReference"),
    restoreProcedureReference: identity(input.restoreProcedureReference, "restoreProcedureReference"), evidenceReferences: normalizeSet(input.evidenceReferences, "backup evidence reference", true),
    backupIntegrityVerified: exactBoolean(input.backupIntegrityVerified, "backupIntegrityVerified"), restoreProcedureRehearsed: exactBoolean(input.restoreProcedureRehearsed, "restoreProcedureRehearsed"),
    retainedForManualRecovery: exactBoolean(input.retainedForManualRecovery, "retainedForManualRecovery"), automaticRollbackAllowed: input.automaticRollbackAllowed,
    capturedAt: timestamp(input.capturedAt, "capturedAt"),
  });
  if (payload.automaticRollbackAllowed !== false || !payload.backupIntegrityVerified || !payload.restoreProcedureRehearsed || !payload.retainedForManualRecovery) throw new Error("Production apply backup evidence is incomplete or grants automatic rollback");
  if (payload.backupSha256 !== payload.productionRawFileSha256) throw new Error("Backup raw hash must equal exact production pre-state raw hash");
  const evidenceSha256 = await sha256Canonical(payload);
  return deepFreeze({ schemaVersion: 2 as const, algorithm: "sha256" as const, evidenceId: `m5localprodapplybackup:${evidenceSha256.slice(0, 32).toLowerCase()}`, evidenceSha256, payload });
}

export async function verifyLocalProductionRoutingApplyBackupEvidence(evidence: LocalProductionRoutingApplyBackupEvidence): Promise<void> {
  assertExactKeys(evidence, ["schemaVersion", "algorithm", "evidenceId", "evidenceSha256", "payload"], "apply backup evidence");
  if (evidence.schemaVersion !== 2 || evidence.algorithm !== "sha256") throw new Error("Production apply backup evidence envelope invalid");
  const expected = await prepareLocalProductionRoutingApplyBackupEvidence(evidence.payload);
  if (evidence.evidenceId !== expected.evidenceId || evidence.evidenceSha256 !== expected.evidenceSha256 || !sameJson(evidence.payload, expected.payload)) throw new Error("Production apply backup evidence content-address drift");
}

export async function prepareLocalProductionRoutingApplyProposal(input: { readonly context: LocalProductionRoutingApplyContext; readonly proposal: LocalProductionRoutingApplyProposalInput }): Promise<LocalProductionRoutingApplyProposal> {
  assertExactKeys(input.proposal, ["candidateSubjectId", "candidateRouteRevision", "proposedAt", "policyReferences", "runLedgerReferences", "traceReferences"], "apply proposal input");
  await verifyApplyContext(input.context, true);
  const c = input.context;
  const proposedAt = timestamp(input.proposal.proposedAt, "proposedAt");
  const latest = Math.max(Date.parse(c.currentTargetSnapshot.payload.capturedAt), Date.parse(c.currentSourceSnapshot.payload.observedAt), Date.parse(c.productionPreFingerprint.payload.observedAt), Date.parse(c.backupEvidence.payload.capturedAt), Date.parse(c.rehearsalReceipt.payload.completedAt));
  if (Date.parse(proposedAt) <= latest) throw new Error("Production apply proposal must follow final evidence snapshot");
  if (Date.parse(c.backupEvidence.payload.capturedAt) < Date.parse(c.productionPreFingerprint.payload.observedAt)) throw new Error("Production backup is stale relative to production pre-fingerprint");
  const candidateSubjectId = identity(input.proposal.candidateSubjectId, "candidateSubjectId");
  const candidateRouteRevision = identity(input.proposal.candidateRouteRevision, "candidateRouteRevision");
  if (candidateSubjectId === c.productionPreFingerprint.payload.currentSubjectId || candidateRouteRevision === c.productionPreFingerprint.payload.routeRevision) throw new Error("Production candidate must differ from exact reference subject and revision");
  const readiness = c.rehearsalAuthority.readinessAuthorization;
  const source = c.currentSourceSnapshot.payload;
  const target = c.currentTargetSnapshot.payload;
  const pre = c.productionPreFingerprint.payload;
  const backup = c.backupEvidence;
  const writer = c.canonicalWriter.descriptor;
  const payload: LocalProductionRoutingApplyProposalPayload = deepFreeze({
    candidateSubjectId, candidateRouteRevision, proposedAt,
    policyReferences: normalizeSet(input.proposal.policyReferences, "apply proposal policy reference", true),
    runLedgerReferences: normalizeSet(input.proposal.runLedgerReferences, "apply Run Ledger reference", true), traceReferences: normalizeSet(input.proposal.traceReferences, "apply trace reference", true),
    readinessAuthorizationId: readiness.authorizationId, readinessAuthorizationSha256: readiness.authorizationSha256,
    rehearsalReceiptId: c.rehearsalReceipt.receiptId, rehearsalReceiptSha256: c.rehearsalReceipt.receiptSha256,
    targetSnapshotId: c.currentTargetSnapshot.snapshotId, targetSnapshotSha256: c.currentTargetSnapshot.snapshotSha256,
    sourceSnapshotId: c.currentSourceSnapshot.snapshotId, sourceSnapshotSha256: c.currentSourceSnapshot.snapshotSha256,
    adapterId: source.adapterId, adapterVersion: source.adapterVersion, adapterSourceSha256: source.adapterSourceSha256, mainSourceSha256: source.mainSourceSha256,
    productionTargetId: c.productionTarget.descriptor.targetId, projectId: target.projectId, routeId: target.routeId, capability: target.capability,
    referenceSubjectId: pre.currentSubjectId, referenceRouteRevision: pre.routeRevision, productionPreFingerprintId: c.productionPreFingerprint.fingerprintId,
    productionPreFingerprintSha256: c.productionPreFingerprint.fingerprintSha256, productionPreStateId: pre.stateId, productionPreStateSha256: pre.stateSha256,
    productionPreRawFileSha256: pre.rawFileSha256, backupEvidenceId: backup.evidenceId, backupEvidenceSha256: backup.evidenceSha256,
    backupId: backup.payload.backupId, backupSha256: backup.payload.backupSha256, canonicalWriterId: writer.writerId, writeBoundaryId: writer.writeBoundaryId,
    singleWriterVerified: true as const, productionRoutingMutationAuthorized: false as const,
    automaticRoutingMutationAllowed: false as const, automaticRetryAllowed: false as const, automaticRollbackAllowed: false as const,
    automaticRedispatchAllowed: false as const, automaticPromotionAllowed: false as const,
  });
  const proposalSha256 = await sha256Canonical(payload);
  return deepFreeze({ schemaVersion: 2 as const, algorithm: "sha256" as const, proposalId: `m5localprodapplyproposal:${proposalSha256.slice(0, 32).toLowerCase()}`, proposalSha256, payload });
}

export async function verifyLocalProductionRoutingApplyProposal(proposal: LocalProductionRoutingApplyProposal, context: LocalProductionRoutingApplyContext, requireLivePreState = true): Promise<void> {
  assertExactKeys(proposal, ["schemaVersion", "algorithm", "proposalId", "proposalSha256", "payload"], "apply proposal");
  if (proposal.schemaVersion !== 2 || proposal.algorithm !== "sha256") throw new Error("Production apply proposal envelope invalid");
  await verifyApplyContext(context, requireLivePreState);
  assertProposalBindings(proposal, context);
  const expectedSha = await sha256Canonical(proposal.payload);
  if (proposal.proposalSha256 !== expectedSha || proposal.proposalId !== `m5localprodapplyproposal:${expectedSha.slice(0, 32).toLowerCase()}`) throw new Error("Production apply proposal content-address drift");
  assertAutomaticFlags(proposal.payload, "apply proposal");
}

export async function prepareLocalProductionRoutingApplyAuthorization(input: { readonly proposal: LocalProductionRoutingApplyProposal; readonly context: LocalProductionRoutingApplyContext; readonly workflow: WorkflowRun; readonly authorization: LocalProductionRoutingApplyAuthorizationInput }): Promise<LocalProductionRoutingApplyAuthorization> {
  assertExactKeys(input.authorization, ["decision", "actor", "decidedAt", "approvalIds", "policyReferences"], "apply authorization input");
  await verifyLocalProductionRoutingApplyProposal(input.proposal, input.context, true);
  assertR4Workflow(input.workflow, input.proposal.payload.projectId, input.authorization.approvalIds, input.authorization.decision === "allow");
  const decidedAt = timestamp(input.authorization.decidedAt, "authorization decidedAt");
  if (Date.parse(decidedAt) <= Date.parse(input.proposal.payload.proposedAt)) throw new Error("R4 production-apply authorization must be after final proposal/evidence snapshot");
  const decision = input.authorization.decision;
  if (decision !== "allow" && decision !== "deny") throw new Error("Production apply authorization decision invalid");
  const p = input.proposal.payload;
  const payload: LocalProductionRoutingApplyAuthorizationPayload = deepFreeze({
    decision, actor: identity(input.authorization.actor, "authorization actor"), decidedAt,
    approvalIds: normalizeSet(input.authorization.approvalIds, "authorization approvalId", decision === "allow"), policyReferences: normalizeSet(input.authorization.policyReferences, "authorization policy reference", true),
    proposalId: input.proposal.proposalId, proposalSha256: input.proposal.proposalSha256, workflowRunId: identity(input.workflow.id, "workflowRunId"), riskClass: "R4" as const,
    projectId: p.projectId, routeId: p.routeId, capability: p.capability, productionTargetId: p.productionTargetId,
    referenceSubjectId: p.referenceSubjectId, referenceRouteRevision: p.referenceRouteRevision, candidateSubjectId: p.candidateSubjectId, candidateRouteRevision: p.candidateRouteRevision,
    rehearsalReceiptId: p.rehearsalReceiptId, rehearsalReceiptSha256: p.rehearsalReceiptSha256, sourceSnapshotId: p.sourceSnapshotId, sourceSnapshotSha256: p.sourceSnapshotSha256,
    backupEvidenceId: p.backupEvidenceId, backupEvidenceSha256: p.backupEvidenceSha256, canonicalWriterId: p.canonicalWriterId,
    productionPreFingerprintId: p.productionPreFingerprintId, productionPreFingerprintSha256: p.productionPreFingerprintSha256,
    productionRoutingMutationAuthorized: decision === "allow", oneShotAuthorization: true as const,
    automaticRoutingMutationAllowed: false as const, automaticRetryAllowed: false as const, automaticRollbackAllowed: false as const,
    automaticRedispatchAllowed: false as const, automaticPromotionAllowed: false as const,
  });
  const authorizationSha256 = await sha256Canonical(payload);
  return deepFreeze({ schemaVersion: 2 as const, algorithm: "sha256" as const, authorizationId: `m5localprodapplyauth:${authorizationSha256.slice(0, 32).toLowerCase()}`, authorizationSha256, payload });
}

export async function verifyLocalProductionRoutingApplyAuthorization(authorization: LocalProductionRoutingApplyAuthorization, proposal: LocalProductionRoutingApplyProposal, context: LocalProductionRoutingApplyContext, workflow: WorkflowRun, requireLivePreState = true): Promise<void> {
  assertExactKeys(authorization, ["schemaVersion", "algorithm", "authorizationId", "authorizationSha256", "payload"], "apply authorization");
  if (authorization.schemaVersion !== 2 || authorization.algorithm !== "sha256") throw new Error("Production apply authorization envelope invalid");
  await verifyLocalProductionRoutingApplyProposal(proposal, context, requireLivePreState);
  assertR4Workflow(workflow, proposal.payload.projectId, authorization.payload.approvalIds, authorization.payload.decision === "allow");
  assertAuthorizationBindings(authorization, proposal, workflow);
  const expectedSha = await sha256Canonical(authorization.payload);
  if (authorization.authorizationSha256 !== expectedSha || authorization.authorizationId !== `m5localprodapplyauth:${expectedSha.slice(0, 32).toLowerCase()}`) throw new Error("Production apply authorization content-address drift");
  assertAutomaticFlags(authorization.payload, "apply authorization");
  if (authorization.payload.productionRoutingMutationAuthorized !== (authorization.payload.decision === "allow")) throw new Error("Production apply authorization authority flag drift");
}

export async function prepareLocalProductionRoutingApplyExecutionApproval(input: { readonly proposal: LocalProductionRoutingApplyProposal; readonly authorization: LocalProductionRoutingApplyAuthorization; readonly context: LocalProductionRoutingApplyContext; readonly workflow: WorkflowRun; readonly approval: LocalProductionRoutingApplyExecutionApprovalInput }): Promise<LocalProductionRoutingApplyExecutionApproval> {
  assertExactKeys(input.approval, ["actor", "approvedAt", "explicitApplyNow", "policyReferences"], "execution approval input");
  await verifyLocalProductionRoutingApplyAuthorization(input.authorization, input.proposal, input.context, input.workflow, true);
  if (input.authorization.payload.decision !== "allow" || input.authorization.payload.productionRoutingMutationAuthorized !== true) throw new Error("Execution approval requires allowed exact production-apply authorization");
  if (input.approval.explicitApplyNow !== true) throw new Error("Execution approval must explicitly authorize apply now");
  const approvedAt = timestamp(input.approval.approvedAt, "execution approvedAt");
  if (Date.parse(approvedAt) <= Date.parse(input.authorization.payload.decidedAt)) throw new Error("Execution approval must be later than R4 production-apply authorization");
  const operationId = await deterministicOperationId(input.proposal, input.authorization);
  const p = input.proposal.payload;
  const payload: LocalProductionRoutingApplyExecutionApprovalPayload = deepFreeze({
    actor: identity(input.approval.actor, "execution approval actor"), approvedAt, explicitApplyNow: true as const,
    policyReferences: normalizeSet(input.approval.policyReferences, "execution approval policy reference", true), operationId,
    proposalId: input.proposal.proposalId, proposalSha256: input.proposal.proposalSha256, authorizationId: input.authorization.authorizationId, authorizationSha256: input.authorization.authorizationSha256,
    productionTargetId: p.productionTargetId, productionPreFingerprintId: p.productionPreFingerprintId, productionPreFingerprintSha256: p.productionPreFingerprintSha256,
    candidateSubjectId: p.candidateSubjectId, candidateRouteRevision: p.candidateRouteRevision, canonicalWriterId: p.canonicalWriterId, oneShotExecutionApproval: true as const,
    automaticRoutingMutationAllowed: false as const, automaticRetryAllowed: false as const, automaticRollbackAllowed: false as const,
    automaticRedispatchAllowed: false as const, automaticPromotionAllowed: false as const,
  });
  const approvalSha256 = await sha256Canonical(payload);
  return deepFreeze({ schemaVersion: 2 as const, algorithm: "sha256" as const, approvalId: `m5localprodapplyexec:${approvalSha256.slice(0, 32).toLowerCase()}`, approvalSha256, payload });
}

export async function verifyLocalProductionRoutingApplyExecutionApproval(approval: LocalProductionRoutingApplyExecutionApproval, proposal: LocalProductionRoutingApplyProposal, authorization: LocalProductionRoutingApplyAuthorization, context: LocalProductionRoutingApplyContext, workflow: WorkflowRun, requireLivePreState = true): Promise<void> {
  assertExactKeys(approval, ["schemaVersion", "algorithm", "approvalId", "approvalSha256", "payload"], "execution approval");
  if (approval.schemaVersion !== 2 || approval.algorithm !== "sha256") throw new Error("Execution approval envelope invalid");
  await verifyLocalProductionRoutingApplyAuthorization(authorization, proposal, context, workflow, requireLivePreState);
  if (authorization.payload.decision !== "allow" || authorization.payload.productionRoutingMutationAuthorized !== true || approval.payload.explicitApplyNow !== true) throw new Error("Execution approval lacks exact allowed apply-now authority");
  const operationId = await deterministicOperationId(proposal, authorization);
  const p = proposal.payload;
  if (approval.payload.operationId !== operationId || approval.payload.proposalId !== proposal.proposalId || approval.payload.proposalSha256 !== proposal.proposalSha256 ||
      approval.payload.authorizationId !== authorization.authorizationId || approval.payload.authorizationSha256 !== authorization.authorizationSha256 ||
      approval.payload.productionTargetId !== p.productionTargetId || approval.payload.productionPreFingerprintId !== p.productionPreFingerprintId ||
      approval.payload.productionPreFingerprintSha256 !== p.productionPreFingerprintSha256 || approval.payload.candidateSubjectId !== p.candidateSubjectId ||
      approval.payload.candidateRouteRevision !== p.candidateRouteRevision || approval.payload.canonicalWriterId !== p.canonicalWriterId || approval.payload.oneShotExecutionApproval !== true ||
      Date.parse(approval.payload.approvedAt) <= Date.parse(authorization.payload.decidedAt)) throw new Error("Execution approval exact operation/authority binding drift");
  const expectedSha = await sha256Canonical(approval.payload);
  if (approval.approvalSha256 !== expectedSha || approval.approvalId !== `m5localprodapplyexec:${expectedSha.slice(0, 32).toLowerCase()}`) throw new Error("Execution approval content-address drift");
  assertAutomaticFlags(approval.payload, "execution approval");
}

export async function prepareLocalProductionRoutingApplyPrewriteSeal(input: { readonly proposal: LocalProductionRoutingApplyProposal; readonly authorization: LocalProductionRoutingApplyAuthorization; readonly executionApproval: LocalProductionRoutingApplyExecutionApproval; readonly context: LocalProductionRoutingApplyContext; readonly workflow: WorkflowRun; readonly currentTargetSnapshot: LocalProductionRoutingTargetSnapshot; readonly currentSourceSnapshot: LocalProductionRoutingReadinessSourceSnapshot; readonly observedAt: string }): Promise<LocalProductionRoutingApplyPrewriteSeal> {
  await verifyLocalProductionRoutingApplyExecutionApproval(input.executionApproval, input.proposal, input.authorization, input.context, input.workflow, true);
  await verifyLocalProductionRoutingTargetSnapshot(input.currentTargetSnapshot);
  await verifyLocalProductionRoutingReadinessSourceSnapshot(input.currentSourceSnapshot);
  const observedAt = timestamp(input.observedAt, "prewrite observedAt");
  if (Date.parse(input.currentTargetSnapshot.payload.capturedAt) < Date.parse(input.executionApproval.payload.approvedAt) || Date.parse(input.currentSourceSnapshot.payload.observedAt) < Date.parse(input.executionApproval.payload.approvedAt) || Date.parse(observedAt) < Date.parse(input.currentTargetSnapshot.payload.capturedAt) || Date.parse(observedAt) < Date.parse(input.currentSourceSnapshot.payload.observedAt)) throw new Error("Prewrite target/source observations are stale relative to execution approval");
  assertTargetSnapshotEquivalent(input.currentTargetSnapshot, input.context.currentTargetSnapshot);
  assertSourceSnapshotEquivalent(input.currentSourceSnapshot, input.context.currentSourceSnapshot);
  input.context.singleWriterBoundary.verify(input.context.canonicalWriter);
  await input.context.backupStore.verify(input.context.backupEvidence);
  const live = await input.context.productionTarget.fingerprint(observedAt);
  assertFingerprintEquivalent(live, input.context.productionPreFingerprint, "Production changed before prewrite seal");
  const payload: LocalProductionRoutingApplyPrewriteSealPayload = deepFreeze({
    operationId: input.executionApproval.payload.operationId, proposalId: input.proposal.proposalId, proposalSha256: input.proposal.proposalSha256,
    authorizationId: input.authorization.authorizationId, authorizationSha256: input.authorization.authorizationSha256,
    executionApprovalId: input.executionApproval.approvalId, executionApprovalSha256: input.executionApproval.approvalSha256,
    productionTargetId: input.proposal.payload.productionTargetId, productionFingerprintId: live.fingerprintId, productionFingerprintSha256: live.fingerprintSha256,
    productionStateId: live.payload.stateId, productionStateSha256: live.payload.stateSha256, productionRawFileSha256: live.payload.rawFileSha256,
    proposalSourceSnapshotId: input.proposal.payload.sourceSnapshotId, proposalSourceSnapshotSha256: input.proposal.payload.sourceSnapshotSha256,
    currentSourceSnapshotId: input.currentSourceSnapshot.snapshotId, currentSourceSnapshotSha256: input.currentSourceSnapshot.snapshotSha256,
    currentTargetSnapshotId: input.currentTargetSnapshot.snapshotId, currentTargetSnapshotSha256: input.currentTargetSnapshot.snapshotSha256,
    backupEvidenceId: input.context.backupEvidence.evidenceId, backupEvidenceSha256: input.context.backupEvidence.evidenceSha256,
    canonicalWriterId: input.context.canonicalWriter.descriptor.writerId, observedAt, productionWritePerformed: false as const, productionRoutingMutationAuthorized: true as const,
    automaticRoutingMutationAllowed: false as const, automaticRetryAllowed: false as const, automaticRollbackAllowed: false as const,
    automaticRedispatchAllowed: false as const, automaticPromotionAllowed: false as const,
  });
  const sealSha256 = await sha256Canonical(payload);
  return deepFreeze({ schemaVersion: 2 as const, algorithm: "sha256" as const, sealId: `m5localprodapplyseal:${sealSha256.slice(0, 32).toLowerCase()}`, sealSha256, payload });
}

export async function verifyLocalProductionRoutingApplyPrewriteSeal(seal: LocalProductionRoutingApplyPrewriteSeal, input: { readonly proposal: LocalProductionRoutingApplyProposal; readonly authorization: LocalProductionRoutingApplyAuthorization; readonly executionApproval: LocalProductionRoutingApplyExecutionApproval; readonly context: LocalProductionRoutingApplyContext; readonly workflow: WorkflowRun; readonly currentTargetSnapshot: LocalProductionRoutingTargetSnapshot; readonly currentSourceSnapshot: LocalProductionRoutingReadinessSourceSnapshot }): Promise<void> {
  assertExactKeys(seal, ["schemaVersion", "algorithm", "sealId", "sealSha256", "payload"], "prewrite seal");
  if (seal.schemaVersion !== 2 || seal.algorithm !== "sha256") throw new Error("Prewrite seal envelope invalid");
  const expected = await prepareLocalProductionRoutingApplyPrewriteSeal({ ...input, observedAt: seal.payload.observedAt });
  if (seal.sealId !== expected.sealId || seal.sealSha256 !== expected.sealSha256 || !sameJson(seal.payload, expected.payload)) throw new Error("Prewrite seal canonical binding drift");
}

export class LocalProductionRoutingApplyCoordinator {
  constructor(
    private readonly productionTarget: JsonFileLocalProductionReadOnlyTarget,
    private readonly writer: CanonicalLocalProductionRoutingWriter,
    private readonly singleWriterBoundary: LocalProductionRoutingSingleWriterBoundary,
    private readonly journal: JsonlLocalProductionRoutingApplyJournal,
    private readonly faultInjector?: LocalProductionRoutingApplyFaultInjector,
  ) {}

  async execute(input: { readonly proposal: LocalProductionRoutingApplyProposal; readonly authorization: LocalProductionRoutingApplyAuthorization; readonly executionApproval: LocalProductionRoutingApplyExecutionApproval; readonly prewriteSeal: LocalProductionRoutingApplyPrewriteSeal; readonly context: LocalProductionRoutingApplyContext; readonly workflow: WorkflowRun; readonly currentTargetSnapshot: LocalProductionRoutingTargetSnapshot; readonly currentSourceSnapshot: LocalProductionRoutingReadinessSourceSnapshot; readonly reservedAt: string; readonly appliedAt: string; readonly committedAt: string; readonly completedAt: string }): Promise<LocalProductionRoutingApplyReceipt> {
    await verifyLocalProductionRoutingApplyPrewriteSeal(input.prewriteSeal, input);
    this.singleWriterBoundary.verify(this.writer);
    if (this.writer !== input.context.canonicalWriter || this.productionTarget !== input.context.productionTarget) throw new Error("Coordinator is not bound to exact canonical production writer/target");
    const existing = operationEvents(await this.journal.events(), input.executionApproval.payload.operationId);
    if (existing.length !== 0) throw new Error("One-shot production apply operation already has durable journal state");
    const candidateState = await buildCandidateState(input.proposal, input.context.productionPreFingerprint, input.appliedAt);
    const candidateRawSha = await sha256Text(JSON.stringify(candidateState));
    const reservation = await prepareApplyJournalEvent("apply_reserved", input, candidateState, candidateRawSha, input.reservedAt, false, "PENDING", "NO", "production apply durably reserved before side effect");
    await this.journal.append(reservation);
    await this.faultInjector?.hit("after_reservation_before_write");
    try {
      await this.writer.writeOnce({ operationId: input.executionApproval.payload.operationId, expectedBeforeFingerprint: input.context.productionPreFingerprint, candidateState, productionTarget: this.productionTarget, observedAt: input.appliedAt });
    } catch (error) {
      return this.classifyWriteFailure(error, input, reservation, candidateState, candidateRawSha);
    }
    await this.faultInjector?.hit("after_write_before_commit");
    try {
      const post = await this.productionTarget.fingerprint(input.committedAt);
      assertCandidateFingerprint(post, candidateState, candidateRawSha);
    } catch (error) {
      const manual = await this.appendTerminal("manual_reconciliation_required", input, candidateState, candidateRawSha, input.committedAt, false, "MANUAL_RECONCILIATION_REQUIRED", "UNKNOWN", sanitizeError(error, "production read-back unverifiable"));
      return this.prepareReceipt(input, reservation, null, manual, false);
    }
    const commit = await prepareApplyJournalEvent("apply_committed", input, candidateState, candidateRawSha, input.committedAt, false, "APPLIED_VERIFIED", "YES", "exact candidate read-back verified and apply committed");
    await this.journal.append(commit);
    return this.prepareReceipt(input, reservation, commit, null, false);
  }

  async recover(input: { readonly proposal: LocalProductionRoutingApplyProposal; readonly authorization: LocalProductionRoutingApplyAuthorization; readonly executionApproval: LocalProductionRoutingApplyExecutionApproval; readonly prewriteSeal: LocalProductionRoutingApplyPrewriteSeal; readonly context: LocalProductionRoutingApplyContext; readonly workflow: WorkflowRun; readonly currentTargetSnapshot: LocalProductionRoutingTargetSnapshot; readonly currentSourceSnapshot: LocalProductionRoutingReadinessSourceSnapshot; readonly observedAt: string; readonly completedAt: string }): Promise<LocalProductionRoutingApplyReceipt> {
    await verifyStaticRecoveryAuthority(input);
    const events = operationEvents(await this.journal.events(), input.executionApproval.payload.operationId);
    for (const event of events) assertEventBindings(event, input);
    const progression = classifyProgression(events);
    if (!progression.reservation) throw new Error("Recovery requires durable apply reservation");
    const candidate = progression.reservation.payload.candidateState;
    const candidateRawSha = progression.reservation.payload.candidateRawFileSha256;
    if (progression.manual) return this.prepareReceipt(input, progression.reservation, progression.commit ?? null, progression.manual, true);
    if (progression.safe) return this.prepareReceipt(input, progression.reservation, null, progression.safe, true);
    if (progression.commit) {
      const live = await safeFingerprint(this.productionTarget, input.observedAt);
      if (live) {
        try { assertCandidateFingerprint(live, candidate, candidateRawSha); return this.prepareReceipt(input, progression.reservation, progression.commit, null, true); } catch { /* durable commit drift becomes manual */ }
      }
      const manual = await this.appendTerminal("manual_reconciliation_required", input, candidate, candidateRawSha, input.observedAt, true, "MANUAL_RECONCILIATION_REQUIRED", "UNKNOWN", "committed production state is no longer exact/verifiable");
      return this.prepareReceipt(input, progression.reservation, progression.commit, manual, true);
    }
    const live = await safeFingerprint(this.productionTarget, input.observedAt);
    if (live && fingerprintMatchesReference(live, input.context.productionPreFingerprint)) {
      const safe = await this.appendTerminal("not_applied_safe", input, candidate, candidateRawSha, input.observedAt, true, "NOT_APPLIED_SAFE", "NO", "reservation exists and exact original production pre-state remains");
      return this.prepareReceipt(input, progression.reservation, null, safe, true);
    }
    if (live) {
      try {
        assertCandidateFingerprint(live, candidate, candidateRawSha);
        const commit = await prepareApplyJournalEvent("apply_committed", input, candidate, candidateRawSha, input.observedAt, true, "APPLIED_VERIFIED", "YES", "recovery proved exact candidate already applied; no duplicate write");
        await this.journal.append(commit);
        return this.prepareReceipt(input, progression.reservation, commit, null, true);
      } catch { /* unexpected state becomes manual */ }
    }
    const manual = await this.appendTerminal("manual_reconciliation_required", input, candidate, candidateRawSha, input.observedAt, true, "MANUAL_RECONCILIATION_REQUIRED", "UNKNOWN", live ? "unexpected production state during recovery" : "production state unreadable or unverifiable during recovery");
    return this.prepareReceipt(input, progression.reservation, null, manual, true);
  }

  private async classifyWriteFailure(error: unknown, input: Parameters<LocalProductionRoutingApplyCoordinator["execute"]>[0], reservation: LocalProductionRoutingApplyJournalEvent, candidate: LocalProductionRouterState, candidateRawSha: string): Promise<LocalProductionRoutingApplyReceipt> {
    const live = await safeFingerprint(this.productionTarget, input.committedAt);
    const writeMayHaveOccurred = error instanceof ProductionApplyWriteError && error.writeMayHaveOccurred;
    if (!writeMayHaveOccurred && live && fingerprintMatchesReference(live, input.context.productionPreFingerprint)) {
      const safe = await this.appendTerminal("not_applied_safe", input, candidate, candidateRawSha, input.committedAt, false, "NOT_APPLIED_SAFE", "NO", sanitizeError(error, "canonical write failed before mutation"));
      return this.prepareReceipt(input, reservation, null, safe, false);
    }
    const manual = await this.appendTerminal("manual_reconciliation_required", input, candidate, candidateRawSha, input.committedAt, false, "MANUAL_RECONCILIATION_REQUIRED", "UNKNOWN", sanitizeError(error, "canonical production write outcome ambiguous"));
    return this.prepareReceipt(input, reservation, null, manual, false);
  }

  private async appendTerminal(eventType: "not_applied_safe" | "manual_reconciliation_required", input: { readonly proposal: LocalProductionRoutingApplyProposal; readonly authorization: LocalProductionRoutingApplyAuthorization; readonly executionApproval: LocalProductionRoutingApplyExecutionApproval; readonly prewriteSeal: LocalProductionRoutingApplyPrewriteSeal; readonly context: LocalProductionRoutingApplyContext; readonly workflow: WorkflowRun; readonly currentTargetSnapshot: LocalProductionRoutingTargetSnapshot; readonly currentSourceSnapshot: LocalProductionRoutingReadinessSourceSnapshot }, candidate: LocalProductionRouterState, candidateRawSha: string, observedAt: string, recovered: boolean, classification: "NOT_APPLIED_SAFE" | "MANUAL_RECONCILIATION_REQUIRED", writeObserved: "NO" | "UNKNOWN", result: string): Promise<LocalProductionRoutingApplyJournalEvent> {
    const event = await prepareApplyJournalEvent(eventType, input, candidate, candidateRawSha, observedAt, recovered, classification, writeObserved, result);
    await this.journal.append(event);
    return event;
  }

  private async prepareReceipt(input: { readonly proposal: LocalProductionRoutingApplyProposal; readonly authorization: LocalProductionRoutingApplyAuthorization; readonly executionApproval: LocalProductionRoutingApplyExecutionApproval; readonly prewriteSeal: LocalProductionRoutingApplyPrewriteSeal; readonly context: LocalProductionRoutingApplyContext; readonly workflow: WorkflowRun; readonly currentTargetSnapshot: LocalProductionRoutingTargetSnapshot; readonly currentSourceSnapshot: LocalProductionRoutingReadinessSourceSnapshot; readonly completedAt: string }, reservation: LocalProductionRoutingApplyJournalEvent, commit: LocalProductionRoutingApplyJournalEvent | null, terminal: LocalProductionRoutingApplyJournalEvent | null, recovered: boolean): Promise<LocalProductionRoutingApplyReceipt> {
    const classification: LocalProductionRoutingApplyClassification = terminal?.payload.eventType === "manual_reconciliation_required" ? "MANUAL_RECONCILIATION_REQUIRED" : terminal?.payload.eventType === "not_applied_safe" ? "NOT_APPLIED_SAFE" : commit ? "APPLIED_VERIFIED" : "MANUAL_RECONCILIATION_REQUIRED";
    const events = operationEvents(await this.journal.events(), input.executionApproval.payload.operationId);
    const progressionSha = await sha256Canonical(events.map((event) => [event.eventId, event.eventSha256]));
    const completedAt = timestamp(input.completedAt, "receipt completedAt");
    const post = classification === "MANUAL_RECONCILIATION_REQUIRED" ? await safeFingerprint(this.productionTarget, completedAt) : await this.productionTarget.fingerprint(completedAt);
    if (classification === "APPLIED_VERIFIED" && post) assertCandidateFingerprint(post, reservation.payload.candidateState, reservation.payload.candidateRawFileSha256);
    if (classification === "NOT_APPLIED_SAFE" && post && !fingerprintMatchesReference(post, input.context.productionPreFingerprint)) throw new Error("NOT_APPLIED_SAFE receipt cannot be emitted after production drift");
    const p = input.proposal.payload;
    const payload: LocalProductionRoutingApplyReceiptPayload = deepFreeze({
      classification, operationId: input.executionApproval.payload.operationId, idempotencyKey: input.executionApproval.payload.operationId,
      productionTargetId: p.productionTargetId, projectId: p.projectId, routeId: p.routeId, capability: p.capability,
      referenceStateId: p.productionPreStateId, referenceStateSha256: p.productionPreStateSha256, referenceSubjectId: p.referenceSubjectId, referenceRouteRevision: p.referenceRouteRevision,
      candidateStateId: reservation.payload.candidateState.stateId, candidateStateSha256: reservation.payload.candidateState.stateSha256, candidateSubjectId: p.candidateSubjectId, candidateRouteRevision: p.candidateRouteRevision,
      productionPreFingerprintId: p.productionPreFingerprintId, productionPreFingerprintSha256: p.productionPreFingerprintSha256, productionPreRawFileSha256: p.productionPreRawFileSha256,
      productionPostFingerprintId: post?.fingerprintId ?? null, productionPostFingerprintSha256: post?.fingerprintSha256 ?? null, productionPostRawFileSha256: post?.payload.rawFileSha256 ?? null,
      reservationEventId: reservation.eventId, reservationEventSha256: reservation.eventSha256, commitEventId: commit?.eventId ?? null, commitEventSha256: commit?.eventSha256 ?? null,
      terminalEventId: terminal?.eventId ?? null, terminalEventSha256: terminal?.eventSha256 ?? null, journalProgressionSha256: progressionSha,
      readinessAuthorizationId: p.readinessAuthorizationId, readinessAuthorizationSha256: p.readinessAuthorizationSha256, rehearsalReceiptId: p.rehearsalReceiptId, rehearsalReceiptSha256: p.rehearsalReceiptSha256,
      proposalId: input.proposal.proposalId, proposalSha256: input.proposal.proposalSha256, authorizationId: input.authorization.authorizationId, authorizationSha256: input.authorization.authorizationSha256,
      executionApprovalId: input.executionApproval.approvalId, executionApprovalSha256: input.executionApproval.approvalSha256, prewriteSealId: input.prewriteSeal.sealId, prewriteSealSha256: input.prewriteSeal.sealSha256,
      adapterId: p.adapterId, adapterVersion: p.adapterVersion, adapterSourceSha256: p.adapterSourceSha256, mainSourceSha256: p.mainSourceSha256,
      backupEvidenceId: p.backupEvidenceId, backupEvidenceSha256: p.backupEvidenceSha256, backupId: p.backupId, backupSha256: p.backupSha256, canonicalWriterId: p.canonicalWriterId,
      workflowRunId: input.authorization.payload.workflowRunId, approvalIds: input.authorization.payload.approvalIds, authorizationActor: input.authorization.payload.actor, authorizationDecidedAt: input.authorization.payload.decidedAt,
      executionApprovalActor: input.executionApproval.payload.actor, executionApprovedAt: input.executionApproval.payload.approvedAt, runLedgerReferences: p.runLedgerReferences, traceReferences: p.traceReferences,
      completedAt, reason: terminal?.payload.sanitizedResult ?? commit?.payload.sanitizedResult ?? "manual reconciliation required", recoveredAfterRestart: recovered,
      oneShotConsumed: true as const, productionRouteMutated: classification === "APPLIED_VERIFIED", productionRoutingMutationAuthorizedForThisOperation: true as const,
      futureProductionMutationAuthorized: false as const, automaticRoutingMutationAllowed: false as const, automaticRetryAllowed: false as const,
      automaticRollbackAllowed: false as const, automaticRedispatchAllowed: false as const, automaticPromotionAllowed: false as const,
    });
    const receiptSha256 = await sha256Canonical(payload);
    const receipt: LocalProductionRoutingApplyReceipt = deepFreeze({ schemaVersion: 1 as const, algorithm: "sha256" as const, receiptId: `m5localprodapplyreceipt:${receiptSha256.slice(0, 32).toLowerCase()}`, receiptSha256, payload });
    await verifyLocalProductionRoutingApplyReceipt(receipt, { ...input, journal: this.journal });
    return receipt;
  }
}

export async function verifyLocalProductionRoutingApplyReceipt(receipt: LocalProductionRoutingApplyReceipt, input: { readonly proposal: LocalProductionRoutingApplyProposal; readonly authorization: LocalProductionRoutingApplyAuthorization; readonly executionApproval: LocalProductionRoutingApplyExecutionApproval; readonly prewriteSeal: LocalProductionRoutingApplyPrewriteSeal; readonly context: LocalProductionRoutingApplyContext; readonly workflow: WorkflowRun; readonly currentTargetSnapshot: LocalProductionRoutingTargetSnapshot; readonly currentSourceSnapshot: LocalProductionRoutingReadinessSourceSnapshot; readonly journal: JsonlLocalProductionRoutingApplyJournal }): Promise<void> {
  assertExactKeys(receipt, ["schemaVersion", "algorithm", "receiptId", "receiptSha256", "payload"], "apply receipt");
  if (receipt.schemaVersion !== 1 || receipt.algorithm !== "sha256") throw new Error("Production apply receipt envelope invalid");
  const expectedSha = await sha256Canonical(receipt.payload);
  if (receipt.receiptSha256 !== expectedSha || receipt.receiptId !== `m5localprodapplyreceipt:${expectedSha.slice(0, 32).toLowerCase()}`) throw new Error("Production apply receipt content-address invalid");
  assertAutomaticFlags(receipt.payload, "apply receipt");
  if (receipt.payload.futureProductionMutationAuthorized !== false || receipt.payload.productionRoutingMutationAuthorizedForThisOperation !== true || receipt.payload.oneShotConsumed !== true || receipt.payload.productionRouteMutated !== (receipt.payload.classification === "APPLIED_VERIFIED")) throw new Error("Production apply receipt authority/mutation boundary invalid");
  await verifyStaticRecoveryAuthority({ ...input, observedAt: receipt.payload.completedAt, completedAt: receipt.payload.completedAt });
  await input.context.backupStore.verify(input.context.backupEvidence);
  const events = operationEvents(await input.journal.events(), receipt.payload.operationId);
  for (const event of events) assertEventBindings(event, input);
  const progression = classifyProgression(events);
  if (!progression.reservation || receipt.payload.reservationEventId !== progression.reservation.eventId || receipt.payload.reservationEventSha256 !== progression.reservation.eventSha256) throw new Error("Receipt reservation provenance mismatch");
  if (receipt.payload.journalProgressionSha256 !== await sha256Canonical(events.map((event) => [event.eventId, event.eventSha256]))) throw new Error("Receipt journal progression mismatch");
  assertReceiptStaticBindings(receipt, input, progression.reservation);
  if (receipt.payload.classification === "APPLIED_VERIFIED") {
    if (!progression.commit || progression.safe || progression.manual || receipt.payload.commitEventId !== progression.commit.eventId || receipt.payload.commitEventSha256 !== progression.commit.eventSha256 || receipt.payload.terminalEventId !== null) throw new Error("APPLIED_VERIFIED lacks exact durable commit provenance");
    const live = await input.context.productionTarget.fingerprint(receipt.payload.completedAt);
    assertCandidateFingerprint(live, progression.reservation.payload.candidateState, progression.reservation.payload.candidateRawFileSha256);
    assertReceiptPostFingerprint(receipt, live);
  } else if (receipt.payload.classification === "NOT_APPLIED_SAFE") {
    if (!progression.safe || progression.commit || progression.manual || receipt.payload.terminalEventId !== progression.safe.eventId || receipt.payload.commitEventId !== null) throw new Error("NOT_APPLIED_SAFE lacks exact durable terminal provenance");
    const live = await input.context.productionTarget.fingerprint(receipt.payload.completedAt);
    if (!fingerprintMatchesReference(live, input.context.productionPreFingerprint)) throw new Error("NOT_APPLIED_SAFE does not match exact original production bytes/state");
    assertReceiptPostFingerprint(receipt, live);
  } else if (receipt.payload.classification === "MANUAL_RECONCILIATION_REQUIRED") {
    if (!progression.manual || progression.safe || receipt.payload.terminalEventId !== progression.manual.eventId || receipt.payload.terminalEventSha256 !== progression.manual.eventSha256) throw new Error("MANUAL_RECONCILIATION_REQUIRED lacks exact durable manual provenance");
    if (progression.commit) {
      if (receipt.payload.commitEventId !== progression.commit.eventId || receipt.payload.commitEventSha256 !== progression.commit.eventSha256) throw new Error("Manual receipt lost prior durable commit provenance");
    } else if (receipt.payload.commitEventId !== null || receipt.payload.commitEventSha256 !== null) throw new Error("Manual receipt forges commit provenance");
  } else throw new Error("Production apply receipt classification invalid");
}

async function verifyApplyContext(context: LocalProductionRoutingApplyContext, requireLivePreState: boolean): Promise<void> {
  await verifyLocalProductionRoutingTargetSnapshot(context.currentTargetSnapshot);
  await verifyLocalProductionRoutingReadinessSourceSnapshot(context.currentSourceSnapshot);
  if (context.currentSourceSnapshot.payload.adapterSourceVerified !== true || context.currentSourceSnapshot.payload.mainSourceVerified !== true) throw new Error("Current adapter/main source snapshot is not independently verified");
  await verifyLocalProductionRoutingReadinessAuthorization(context.rehearsalAuthority.readinessAuthorization, context.rehearsalAuthority.readinessProposal, context.rehearsalAuthority.readinessContext, context.rehearsalAuthority.currentTargetSnapshot, context.rehearsalAuthority.currentSourceSnapshot, context.rehearsalAuthority.workflow);
  assertTargetSnapshotEquivalent(context.currentTargetSnapshot, context.rehearsalAuthority.currentTargetSnapshot);
  await verifyLocalProductionRouterFingerprint(context.productionPreFingerprint);
  await context.backupStore.verify(context.backupEvidence);
  context.singleWriterBoundary.verify(context.canonicalWriter);
  if (requireLivePreState) {
    await verifyLocalProductionAdapterRehearsalReceipt(context.rehearsalReceipt, context.rehearsalAuthority, context.rehearsalProductionPreFingerprint, context.rehearsalProductionTarget, context.rehearsalTarget, context.rehearsalJournal);
    const live = await context.productionTarget.fingerprint(context.productionPreFingerprint.payload.observedAt);
    assertFingerprintEquivalent(live, context.productionPreFingerprint, "Production pre-state stale/drifted");
  } else {
    await verifyHistoricalRehearsalReceipt(context);
  }
  const pre = context.productionPreFingerprint.payload;
  const target = context.currentTargetSnapshot.payload;
  const writer = context.canonicalWriter.descriptor;
  if (context.productionTarget.descriptor.targetId !== pre.targetId || target.projectId !== pre.projectId || target.routeId !== pre.routeId || target.capability !== pre.capability || target.currentSubjectId !== pre.currentSubjectId || target.routeRevision !== pre.routeRevision || writer.productionTargetId !== pre.targetId || writer.projectId !== pre.projectId || writer.routeId !== pre.routeId || writer.capability !== pre.capability || writer.writeBoundaryId !== target.writeBoundary || context.backupEvidence.payload.productionTargetId !== pre.targetId || context.backupEvidence.payload.productionStateId !== pre.stateId || context.backupEvidence.payload.productionStateSha256 !== pre.stateSha256 || context.backupEvidence.payload.productionRawFileSha256 !== pre.rawFileSha256) throw new Error("Production apply target/source/backup/writer binding drift");
}

async function verifyHistoricalRehearsalReceipt(context: LocalProductionRoutingApplyContext): Promise<void> {
  const receipt = context.rehearsalReceipt;
  const expectedSha = await sha256Canonical(receipt.payload);
  if (receipt.schemaVersion !== 1 || receipt.algorithm !== "sha256" || receipt.receiptSha256 !== expectedSha || receipt.receiptId !== `m5localprodrehearsal:${expectedSha.slice(0, 32).toLowerCase()}`) throw new Error("Historical rehearsal receipt content-address invalid");
  const progression = await context.rehearsalJournal.verifyProgression({ authority: context.rehearsalAuthority, productionPreFingerprint: context.rehearsalProductionPreFingerprint, productionTargetId: context.rehearsalProductionTarget.descriptor.targetId, rehearsalTargetId: context.rehearsalTarget.descriptor.targetId }) as unknown as {
    candidateReservation?: { eventId: string; eventSha256: string };
    candidateCommit?: { eventId: string; eventSha256: string };
    candidateManual?: unknown;
    restoreReservation?: { eventId: string; eventSha256: string };
    restoreCommit?: { eventId: string; eventSha256: string; payload: { afterState: { stateId: string; stateSha256: string } } };
    restoreManual?: unknown;
    progressionSha256: string;
  };
  if (!progression.candidateReservation || !progression.candidateCommit || !progression.restoreReservation || !progression.restoreCommit || progression.candidateManual || progression.restoreManual) throw new Error("Historical rehearsal journal progression is incomplete");
  const restored = await context.rehearsalTarget.read();
  const p = receipt.payload;
  if (p.readinessAuthorizationId !== context.rehearsalAuthority.readinessAuthorization.authorizationId || p.readinessAuthorizationSha256 !== context.rehearsalAuthority.readinessAuthorization.authorizationSha256 ||
      p.productionPreFingerprintId !== context.rehearsalProductionPreFingerprint.fingerprintId || p.productionPreFingerprintSha256 !== context.rehearsalProductionPreFingerprint.fingerprintSha256 ||
      p.productionTargetId !== context.rehearsalProductionTarget.descriptor.targetId || p.rehearsalTargetId !== context.rehearsalTarget.descriptor.targetId ||
      p.candidateReservationEventId !== progression.candidateReservation.eventId || p.candidateReservationEventSha256 !== progression.candidateReservation.eventSha256 ||
      p.candidateCommitEventId !== progression.candidateCommit.eventId || p.candidateCommitEventSha256 !== progression.candidateCommit.eventSha256 ||
      p.restoreReservationEventId !== progression.restoreReservation.eventId || p.restoreReservationEventSha256 !== progression.restoreReservation.eventSha256 ||
      p.restoreCommitEventId !== progression.restoreCommit.eventId || p.restoreCommitEventSha256 !== progression.restoreCommit.eventSha256 ||
      p.journalProgressionSha256 !== progression.progressionSha256 || restored.stateId !== p.restoredStateId || restored.stateSha256 !== p.restoredStateSha256 || p.classification !== "REHEARSAL_PASSED" || p.productionRouteMutated !== false || p.automaticRetryAllowed !== false || p.automaticRollbackAllowed !== false || p.automaticRedispatchAllowed !== false || p.productionRoutingMutationAuthorized !== false) throw new Error("Historical rehearsal receipt durable provenance drift");
}

async function verifyStaticRecoveryAuthority(input: { readonly proposal: LocalProductionRoutingApplyProposal; readonly authorization: LocalProductionRoutingApplyAuthorization; readonly executionApproval: LocalProductionRoutingApplyExecutionApproval; readonly prewriteSeal: LocalProductionRoutingApplyPrewriteSeal; readonly context: LocalProductionRoutingApplyContext; readonly workflow: WorkflowRun; readonly currentTargetSnapshot: LocalProductionRoutingTargetSnapshot; readonly currentSourceSnapshot: LocalProductionRoutingReadinessSourceSnapshot; readonly observedAt: string; readonly completedAt: string }): Promise<void> {
  await verifyLocalProductionRoutingApplyExecutionApproval(input.executionApproval, input.proposal, input.authorization, input.context, input.workflow, false);
  await verifyLocalProductionRoutingTargetSnapshot(input.currentTargetSnapshot);
  await verifyLocalProductionRoutingReadinessSourceSnapshot(input.currentSourceSnapshot);
  assertTargetSnapshotEquivalent(input.currentTargetSnapshot, input.context.currentTargetSnapshot);
  assertSourceSnapshotEquivalent(input.currentSourceSnapshot, input.context.currentSourceSnapshot);
  const sealSha = await sha256Canonical(input.prewriteSeal.payload);
  if (input.prewriteSeal.schemaVersion !== 2 || input.prewriteSeal.algorithm !== "sha256" || input.prewriteSeal.sealSha256 !== sealSha || input.prewriteSeal.sealId !== `m5localprodapplyseal:${sealSha.slice(0, 32).toLowerCase()}`) throw new Error("Prewrite seal content-address invalid during recovery");
  const s = input.prewriteSeal.payload;
  if (s.operationId !== input.executionApproval.payload.operationId || s.proposalId !== input.proposal.proposalId || s.authorizationId !== input.authorization.authorizationId || s.executionApprovalId !== input.executionApproval.approvalId || s.productionTargetId !== input.proposal.payload.productionTargetId || s.productionStateId !== input.proposal.payload.productionPreStateId || s.productionStateSha256 !== input.proposal.payload.productionPreStateSha256 || s.productionRawFileSha256 !== input.proposal.payload.productionPreRawFileSha256 || s.currentTargetSnapshotId !== input.currentTargetSnapshot.snapshotId || s.currentTargetSnapshotSha256 !== input.currentTargetSnapshot.snapshotSha256 || s.currentSourceSnapshotId !== input.currentSourceSnapshot.snapshotId || s.currentSourceSnapshotSha256 !== input.currentSourceSnapshot.snapshotSha256 || s.backupEvidenceId !== input.proposal.payload.backupEvidenceId || s.canonicalWriterId !== input.proposal.payload.canonicalWriterId) throw new Error("Prewrite seal exact recovery provenance drift");
  assertAutomaticFlags(s, "prewrite seal");
  await input.context.backupStore.verify(input.context.backupEvidence);
}

async function prepareApplyJournalEvent(eventType: ApplyJournalEventType, input: { readonly proposal: LocalProductionRoutingApplyProposal; readonly authorization: LocalProductionRoutingApplyAuthorization; readonly executionApproval: LocalProductionRoutingApplyExecutionApproval; readonly prewriteSeal: LocalProductionRoutingApplyPrewriteSeal; readonly context: LocalProductionRoutingApplyContext; readonly workflow: WorkflowRun; readonly currentTargetSnapshot: LocalProductionRoutingTargetSnapshot; readonly currentSourceSnapshot: LocalProductionRoutingReadinessSourceSnapshot }, candidateState: LocalProductionRouterState, candidateRawFileSha256: string, observedAt: string, recoveredAfterRestart: boolean, classification: "PENDING" | LocalProductionRoutingApplyClassification, productionWriteObserved: "NO" | "YES" | "UNKNOWN", sanitizedResult: string): Promise<LocalProductionRoutingApplyJournalEvent> {
  await verifyLocalProductionRouterState(candidateState);
  const p = input.proposal.payload;
  const payload: LocalProductionRoutingApplyJournalEventPayload = deepFreeze({
    eventType, operationId: input.executionApproval.payload.operationId, idempotencyKey: input.executionApproval.payload.operationId,
    productionTargetId: p.productionTargetId, projectId: p.projectId, routeId: p.routeId, capability: p.capability,
    beforeStateId: p.productionPreStateId, beforeStateSha256: p.productionPreStateSha256, beforeSubjectId: p.referenceSubjectId, beforeRouteRevision: p.referenceRouteRevision,
    afterStateId: candidateState.stateId, afterStateSha256: candidateState.stateSha256, afterSubjectId: p.candidateSubjectId, afterRouteRevision: p.candidateRouteRevision,
    candidateState, candidateRawFileSha256: sha256(candidateRawFileSha256, "candidateRawFileSha256"), productionPreFingerprintId: p.productionPreFingerprintId,
    productionPreFingerprintSha256: p.productionPreFingerprintSha256, productionPreRawFileSha256: p.productionPreRawFileSha256,
    readinessAuthorizationId: p.readinessAuthorizationId, readinessAuthorizationSha256: p.readinessAuthorizationSha256, rehearsalReceiptId: p.rehearsalReceiptId, rehearsalReceiptSha256: p.rehearsalReceiptSha256,
    proposalId: input.proposal.proposalId, proposalSha256: input.proposal.proposalSha256, authorizationId: input.authorization.authorizationId, authorizationSha256: input.authorization.authorizationSha256,
    executionApprovalId: input.executionApproval.approvalId, executionApprovalSha256: input.executionApproval.approvalSha256, prewriteSealId: input.prewriteSeal.sealId, prewriteSealSha256: input.prewriteSeal.sealSha256,
    currentSourceSnapshotId: input.currentSourceSnapshot.snapshotId, currentSourceSnapshotSha256: input.currentSourceSnapshot.snapshotSha256,
    currentTargetSnapshotId: input.currentTargetSnapshot.snapshotId, currentTargetSnapshotSha256: input.currentTargetSnapshot.snapshotSha256,
    backupEvidenceId: p.backupEvidenceId, backupEvidenceSha256: p.backupEvidenceSha256, backupId: p.backupId, backupSha256: p.backupSha256, canonicalWriterId: p.canonicalWriterId,
    workflowRunId: input.authorization.payload.workflowRunId, approvalIds: input.authorization.payload.approvalIds, runLedgerReferences: p.runLedgerReferences, traceReferences: p.traceReferences,
    observedAt: timestamp(observedAt, "apply journal observedAt"), recoveredAfterRestart: exactBoolean(recoveredAfterRestart, "recoveredAfterRestart"), classification, productionWriteObserved,
    sanitizedResult: sanitizedOperationalResult(sanitizedResult), automaticRoutingMutationAllowed: false as const, automaticRetryAllowed: false as const,
    automaticRollbackAllowed: false as const, automaticRedispatchAllowed: false as const, automaticPromotionAllowed: false as const,
  });
  const eventSha256 = await sha256Canonical(payload);
  return deepFreeze({ algorithm: "sha256" as const, eventId: `m5localprodapplyevent:${eventSha256.slice(0, 32).toLowerCase()}`, eventSha256, payload });
}

async function verifyApplyJournalEvent(event: LocalProductionRoutingApplyJournalEvent, maxStringBytes: number): Promise<void> {
  assertExactKeys(event, ["algorithm", "eventId", "eventSha256", "payload"], "apply journal event");
  if (event.algorithm !== "sha256") throw new Error("Apply journal event algorithm invalid");
  assertNoOversizedStrings(event.payload, maxStringBytes, "apply journal event");
  await verifyLocalProductionRouterState(event.payload.candidateState);
  assertAutomaticFlags(event.payload, "apply journal event");
  if (event.payload.idempotencyKey !== event.payload.operationId || event.payload.afterStateId !== event.payload.candidateState.stateId || event.payload.afterStateSha256 !== event.payload.candidateState.stateSha256 || event.payload.afterSubjectId !== event.payload.candidateState.payload.currentSubjectId || event.payload.afterRouteRevision !== event.payload.candidateState.payload.routeRevision) throw new Error("Apply journal operation/candidate identity drift");
  const expected = await sha256Canonical(event.payload);
  if (event.eventSha256 !== expected || event.eventId !== `m5localprodapplyevent:${expected.slice(0, 32).toLowerCase()}`) throw new Error("Apply journal event content-address tamper");
  if (event.payload.eventType === "apply_reserved" && (event.payload.classification !== "PENDING" || event.payload.productionWriteObserved !== "NO")) throw new Error("Apply reservation semantics invalid");
  if (event.payload.eventType === "apply_committed" && (event.payload.classification !== "APPLIED_VERIFIED" || event.payload.productionWriteObserved !== "YES")) throw new Error("Apply commit semantics invalid");
  if (event.payload.eventType === "not_applied_safe" && (event.payload.classification !== "NOT_APPLIED_SAFE" || event.payload.productionWriteObserved !== "NO")) throw new Error("Apply safe terminal semantics invalid");
  if (event.payload.eventType === "manual_reconciliation_required" && event.payload.classification !== "MANUAL_RECONCILIATION_REQUIRED") throw new Error("Apply manual terminal semantics invalid");
}

function assertAppendProgression(existing: readonly LocalProductionRoutingApplyJournalEvent[], next: LocalProductionRoutingApplyJournalEvent): void {
  const same = existing.filter((event) => event.payload.operationId === next.payload.operationId);
  const types = same.map((event) => event.payload.eventType);
  if (next.payload.eventType === "apply_reserved") { if (same.length !== 0) throw new Error("Duplicate apply reservation"); return; }
  if (!types.includes("apply_reserved")) throw new Error("Apply commit/terminal cannot precede reservation");
  if (types.includes("not_applied_safe") || types.includes("manual_reconciliation_required")) throw new Error("Apply operation already terminal");
  if (types.includes("apply_committed")) {
    if (next.payload.eventType === "manual_reconciliation_required" && same.length === 2) return;
    throw new Error("Committed apply cannot be replayed or converted to another automatic action");
  }
  if (same.length !== 1) throw new Error("Apply journal progression ambiguous");
}

function classifyProgression(events: readonly LocalProductionRoutingApplyJournalEvent[]): { reservation?: LocalProductionRoutingApplyJournalEvent; commit?: LocalProductionRoutingApplyJournalEvent; safe?: LocalProductionRoutingApplyJournalEvent; manual?: LocalProductionRoutingApplyJournalEvent } {
  const reservation = events.filter((e) => e.payload.eventType === "apply_reserved"); const commit = events.filter((e) => e.payload.eventType === "apply_committed");
  const safe = events.filter((e) => e.payload.eventType === "not_applied_safe"); const manual = events.filter((e) => e.payload.eventType === "manual_reconciliation_required");
  if (reservation.length !== 1 || commit.length > 1 || safe.length > 1 || manual.length > 1 || (safe.length && (commit.length || manual.length)) || events.length !== reservation.length + commit.length + safe.length + manual.length) throw new Error("Apply durable journal progression invalid/ambiguous");
  if (commit.length && manual.length && events.indexOf(manual[0]) < events.indexOf(commit[0])) throw new Error("Manual-after-commit progression order invalid");
  return { reservation: reservation[0], commit: commit[0], safe: safe[0], manual: manual[0] };
}

function assertEventBindings(event: LocalProductionRoutingApplyJournalEvent, input: { readonly proposal: LocalProductionRoutingApplyProposal; readonly authorization: LocalProductionRoutingApplyAuthorization; readonly executionApproval: LocalProductionRoutingApplyExecutionApproval; readonly prewriteSeal: LocalProductionRoutingApplyPrewriteSeal; readonly context: LocalProductionRoutingApplyContext; readonly workflow: WorkflowRun; readonly currentTargetSnapshot: LocalProductionRoutingTargetSnapshot; readonly currentSourceSnapshot: LocalProductionRoutingReadinessSourceSnapshot }): void {
  const e = event.payload; const p = input.proposal.payload;
  if (e.operationId !== input.executionApproval.payload.operationId || e.idempotencyKey !== e.operationId || e.productionTargetId !== p.productionTargetId || e.projectId !== p.projectId || e.routeId !== p.routeId || e.capability !== p.capability || e.beforeStateId !== p.productionPreStateId || e.beforeStateSha256 !== p.productionPreStateSha256 || e.beforeSubjectId !== p.referenceSubjectId || e.beforeRouteRevision !== p.referenceRouteRevision || e.afterSubjectId !== p.candidateSubjectId || e.afterRouteRevision !== p.candidateRouteRevision || e.productionPreFingerprintId !== p.productionPreFingerprintId || e.productionPreFingerprintSha256 !== p.productionPreFingerprintSha256 || e.productionPreRawFileSha256 !== p.productionPreRawFileSha256 || e.readinessAuthorizationId !== p.readinessAuthorizationId || e.readinessAuthorizationSha256 !== p.readinessAuthorizationSha256 || e.rehearsalReceiptId !== p.rehearsalReceiptId || e.rehearsalReceiptSha256 !== p.rehearsalReceiptSha256 || e.proposalId !== input.proposal.proposalId || e.proposalSha256 !== input.proposal.proposalSha256 || e.authorizationId !== input.authorization.authorizationId || e.authorizationSha256 !== input.authorization.authorizationSha256 || e.executionApprovalId !== input.executionApproval.approvalId || e.executionApprovalSha256 !== input.executionApproval.approvalSha256 || e.prewriteSealId !== input.prewriteSeal.sealId || e.prewriteSealSha256 !== input.prewriteSeal.sealSha256 || e.currentSourceSnapshotId !== input.currentSourceSnapshot.snapshotId || e.currentSourceSnapshotSha256 !== input.currentSourceSnapshot.snapshotSha256 || e.currentTargetSnapshotId !== input.currentTargetSnapshot.snapshotId || e.currentTargetSnapshotSha256 !== input.currentTargetSnapshot.snapshotSha256 || e.backupEvidenceId !== p.backupEvidenceId || e.backupEvidenceSha256 !== p.backupEvidenceSha256 || e.backupId !== p.backupId || e.backupSha256 !== p.backupSha256 || e.canonicalWriterId !== p.canonicalWriterId || e.workflowRunId !== input.authorization.payload.workflowRunId || !sameJson(e.approvalIds, input.authorization.payload.approvalIds) || !sameJson(e.runLedgerReferences, p.runLedgerReferences) || !sameJson(e.traceReferences, p.traceReferences)) throw new Error("Apply journal event authority/state/provenance binding drift");
}

function assertProposalBindings(proposal: LocalProductionRoutingApplyProposal, context: LocalProductionRoutingApplyContext): void {
  const p = proposal.payload; const pre = context.productionPreFingerprint.payload;
  if (p.readinessAuthorizationId !== context.rehearsalAuthority.readinessAuthorization.authorizationId || p.readinessAuthorizationSha256 !== context.rehearsalAuthority.readinessAuthorization.authorizationSha256 || p.rehearsalReceiptId !== context.rehearsalReceipt.receiptId || p.rehearsalReceiptSha256 !== context.rehearsalReceipt.receiptSha256 || p.targetSnapshotId !== context.currentTargetSnapshot.snapshotId || p.targetSnapshotSha256 !== context.currentTargetSnapshot.snapshotSha256 || p.sourceSnapshotId !== context.currentSourceSnapshot.snapshotId || p.sourceSnapshotSha256 !== context.currentSourceSnapshot.snapshotSha256 || p.adapterId !== context.currentSourceSnapshot.payload.adapterId || p.adapterVersion !== context.currentSourceSnapshot.payload.adapterVersion || p.adapterSourceSha256 !== context.currentSourceSnapshot.payload.adapterSourceSha256 || p.mainSourceSha256 !== context.currentSourceSnapshot.payload.mainSourceSha256 || p.productionTargetId !== context.productionTarget.descriptor.targetId || p.projectId !== pre.projectId || p.routeId !== pre.routeId || p.capability !== pre.capability || p.referenceSubjectId !== pre.currentSubjectId || p.referenceRouteRevision !== pre.routeRevision || p.productionPreFingerprintId !== context.productionPreFingerprint.fingerprintId || p.productionPreFingerprintSha256 !== context.productionPreFingerprint.fingerprintSha256 || p.productionPreStateId !== pre.stateId || p.productionPreStateSha256 !== pre.stateSha256 || p.productionPreRawFileSha256 !== pre.rawFileSha256 || p.backupEvidenceId !== context.backupEvidence.evidenceId || p.backupEvidenceSha256 !== context.backupEvidence.evidenceSha256 || p.backupId !== context.backupEvidence.payload.backupId || p.backupSha256 !== context.backupEvidence.payload.backupSha256 || p.canonicalWriterId !== context.canonicalWriter.descriptor.writerId || p.writeBoundaryId !== context.canonicalWriter.descriptor.writeBoundaryId || p.singleWriterVerified !== true || p.productionRoutingMutationAuthorized !== false) throw new Error("Apply proposal exact authority/source/target/backup/writer binding drift");
}

function assertAuthorizationBindings(authorization: LocalProductionRoutingApplyAuthorization, proposal: LocalProductionRoutingApplyProposal, workflow: WorkflowRun): void {
  const a = authorization.payload; const p = proposal.payload;
  if (a.proposalId !== proposal.proposalId || a.proposalSha256 !== proposal.proposalSha256 || a.workflowRunId !== workflow.id || a.riskClass !== "R4" || a.projectId !== p.projectId || a.routeId !== p.routeId || a.capability !== p.capability || a.productionTargetId !== p.productionTargetId || a.referenceSubjectId !== p.referenceSubjectId || a.referenceRouteRevision !== p.referenceRouteRevision || a.candidateSubjectId !== p.candidateSubjectId || a.candidateRouteRevision !== p.candidateRouteRevision || a.rehearsalReceiptId !== p.rehearsalReceiptId || a.rehearsalReceiptSha256 !== p.rehearsalReceiptSha256 || a.sourceSnapshotId !== p.sourceSnapshotId || a.sourceSnapshotSha256 !== p.sourceSnapshotSha256 || a.backupEvidenceId !== p.backupEvidenceId || a.backupEvidenceSha256 !== p.backupEvidenceSha256 || a.canonicalWriterId !== p.canonicalWriterId || a.productionPreFingerprintId !== p.productionPreFingerprintId || a.productionPreFingerprintSha256 !== p.productionPreFingerprintSha256 || a.oneShotAuthorization !== true || Date.parse(a.decidedAt) <= Date.parse(p.proposedAt)) throw new Error("Apply authorization canonical binding drift");
}

function assertReceiptStaticBindings(receipt: LocalProductionRoutingApplyReceipt, input: { readonly proposal: LocalProductionRoutingApplyProposal; readonly authorization: LocalProductionRoutingApplyAuthorization; readonly executionApproval: LocalProductionRoutingApplyExecutionApproval; readonly prewriteSeal: LocalProductionRoutingApplyPrewriteSeal; readonly context: LocalProductionRoutingApplyContext; readonly workflow: WorkflowRun }, reservation: LocalProductionRoutingApplyJournalEvent): void {
  const r = receipt.payload; const p = input.proposal.payload;
  if (r.operationId !== input.executionApproval.payload.operationId || r.idempotencyKey !== r.operationId || r.productionTargetId !== p.productionTargetId || r.projectId !== p.projectId || r.routeId !== p.routeId || r.capability !== p.capability || r.referenceStateId !== p.productionPreStateId || r.referenceStateSha256 !== p.productionPreStateSha256 || r.referenceSubjectId !== p.referenceSubjectId || r.referenceRouteRevision !== p.referenceRouteRevision || r.candidateStateId !== reservation.payload.candidateState.stateId || r.candidateStateSha256 !== reservation.payload.candidateState.stateSha256 || r.candidateSubjectId !== p.candidateSubjectId || r.candidateRouteRevision !== p.candidateRouteRevision || r.productionPreFingerprintId !== p.productionPreFingerprintId || r.productionPreFingerprintSha256 !== p.productionPreFingerprintSha256 || r.productionPreRawFileSha256 !== p.productionPreRawFileSha256 || r.readinessAuthorizationId !== p.readinessAuthorizationId || r.readinessAuthorizationSha256 !== p.readinessAuthorizationSha256 || r.rehearsalReceiptId !== p.rehearsalReceiptId || r.rehearsalReceiptSha256 !== p.rehearsalReceiptSha256 || r.proposalId !== input.proposal.proposalId || r.proposalSha256 !== input.proposal.proposalSha256 || r.authorizationId !== input.authorization.authorizationId || r.authorizationSha256 !== input.authorization.authorizationSha256 || r.executionApprovalId !== input.executionApproval.approvalId || r.executionApprovalSha256 !== input.executionApproval.approvalSha256 || r.prewriteSealId !== input.prewriteSeal.sealId || r.prewriteSealSha256 !== input.prewriteSeal.sealSha256 || r.adapterId !== p.adapterId || r.adapterVersion !== p.adapterVersion || r.adapterSourceSha256 !== p.adapterSourceSha256 || r.mainSourceSha256 !== p.mainSourceSha256 || r.backupEvidenceId !== p.backupEvidenceId || r.backupEvidenceSha256 !== p.backupEvidenceSha256 || r.backupId !== p.backupId || r.backupSha256 !== p.backupSha256 || r.canonicalWriterId !== p.canonicalWriterId || r.workflowRunId !== input.authorization.payload.workflowRunId || !sameJson(r.approvalIds, input.authorization.payload.approvalIds) || r.authorizationActor !== input.authorization.payload.actor || r.authorizationDecidedAt !== input.authorization.payload.decidedAt || r.executionApprovalActor !== input.executionApproval.payload.actor || r.executionApprovedAt !== input.executionApproval.payload.approvedAt || !sameJson(r.runLedgerReferences, p.runLedgerReferences) || !sameJson(r.traceReferences, p.traceReferences)) throw new Error("Receipt exact authority/state/provenance binding drift");
}

async function buildCandidateState(proposal: LocalProductionRoutingApplyProposal, pre: LocalProductionRouterFingerprint, updatedAt: string): Promise<LocalProductionRouterState> {
  return prepareLocalProductionRouterState({ targetId: proposal.payload.productionTargetId, installationId: pre.payload.installationId, projectId: proposal.payload.projectId, routeId: proposal.payload.routeId, capability: proposal.payload.capability, currentSubjectId: proposal.payload.candidateSubjectId, routeRevision: proposal.payload.candidateRouteRevision, updatedAt: timestamp(updatedAt, "candidate updatedAt") });
}

async function deterministicOperationId(proposal: LocalProductionRoutingApplyProposal, authorization: LocalProductionRoutingApplyAuthorization): Promise<string> {
  const digest = await sha256Canonical({ proposalId: proposal.proposalId, proposalSha256: proposal.proposalSha256, authorizationId: authorization.authorizationId, authorizationSha256: authorization.authorizationSha256, productionTargetId: proposal.payload.productionTargetId, productionPreFingerprintId: proposal.payload.productionPreFingerprintId, productionPreFingerprintSha256: proposal.payload.productionPreFingerprintSha256, candidateSubjectId: proposal.payload.candidateSubjectId, candidateRouteRevision: proposal.payload.candidateRouteRevision, backupEvidenceId: proposal.payload.backupEvidenceId, backupEvidenceSha256: proposal.payload.backupEvidenceSha256, canonicalWriterId: proposal.payload.canonicalWriterId });
  return `m5localprodapplyop:${digest.slice(0, 32).toLowerCase()}`;
}

function assertTargetSnapshotEquivalent(current: LocalProductionRoutingTargetSnapshot, bound: LocalProductionRoutingTargetSnapshot): void {
  const a = current.payload; const b = bound.payload;
  for (const key of ["installationId", "projectId", "routeId", "capability", "currentSubjectId", "routeRevision", "canonicalStateOwner", "writeBoundary", "persistenceCategory", "runtimeId", "restartPolicyReference", "targetKind", "singleWriterRequired", "providerSpecificStatePersisted", "rawProviderOutputPersisted", "secretMaterialPersisted"] as const) if (a[key] !== b[key]) throw new Error(`Fresh target snapshot drift: ${key}`);
  if (!sameJson(a.policyReferences, b.policyReferences)) throw new Error("Fresh target policy references drift");
}

function assertSourceSnapshotEquivalent(current: LocalProductionRoutingReadinessSourceSnapshot, bound: LocalProductionRoutingReadinessSourceSnapshot): void {
  const a = current.payload; const b = bound.payload;
  for (const key of ["adapterId", "adapterVersion", "adapterSourceSha256", "mainSourceSha256", "sourceKind", "providerSpecificStatePersisted", "secretMaterialPersisted"] as const) if (a[key] !== b[key]) throw new Error(`Fresh adapter/main source drift: ${key}`);
  if (a.adapterSourceVerified !== true || a.mainSourceVerified !== true) throw new Error("Fresh adapter/main source is not independently verified");
}

function assertWriterScope(descriptor: CanonicalLocalProductionRoutingWriterDescriptor, state: LocalProductionRouterState): void {
  if (state.payload.targetId !== descriptor.productionTargetId || state.payload.projectId !== descriptor.projectId || state.payload.routeId !== descriptor.routeId || state.payload.capability !== descriptor.capability || state.payload.productionRouter !== true || state.payload.providerSpecificStatePersisted !== false || state.payload.rawProviderOutputPersisted !== false || state.payload.secretMaterialPersisted !== false) throw new ProductionApplyWriteError("Canonical writer candidate broadens scope or normalized schema", false);
}

function assertFingerprintEquivalent(actual: LocalProductionRouterFingerprint, expected: LocalProductionRouterFingerprint, message: string): void {
  const a = actual.payload; const e = expected.payload;
  if (a.targetId !== e.targetId || a.installationId !== e.installationId || a.stateId !== e.stateId || a.stateSha256 !== e.stateSha256 || a.rawFileSha256 !== e.rawFileSha256 || a.projectId !== e.projectId || a.routeId !== e.routeId || a.capability !== e.capability || a.currentSubjectId !== e.currentSubjectId || a.routeRevision !== e.routeRevision || a.productionRouter !== true || a.providerSpecificStatePersisted !== false || a.secretMaterialPersisted !== false) throw new Error(message);
}

function fingerprintMatchesReference(actual: LocalProductionRouterFingerprint, expected: LocalProductionRouterFingerprint): boolean { try { assertFingerprintEquivalent(actual, expected, "reference mismatch"); return true; } catch { return false; } }

function assertCandidateFingerprint(actual: LocalProductionRouterFingerprint, candidate: LocalProductionRouterState, rawSha: string): void {
  if (actual.payload.targetId !== candidate.payload.targetId || actual.payload.stateId !== candidate.stateId || actual.payload.stateSha256 !== candidate.stateSha256 || actual.payload.projectId !== candidate.payload.projectId || actual.payload.routeId !== candidate.payload.routeId || actual.payload.capability !== candidate.payload.capability || actual.payload.currentSubjectId !== candidate.payload.currentSubjectId || actual.payload.routeRevision !== candidate.payload.routeRevision || actual.payload.rawFileSha256 !== rawSha) throw new Error("Production candidate read-back/fingerprint mismatch");
}

function assertReceiptPostFingerprint(receipt: LocalProductionRoutingApplyReceipt, live: LocalProductionRouterFingerprint): void { if (receipt.payload.productionPostFingerprintId !== live.fingerprintId || receipt.payload.productionPostFingerprintSha256 !== live.fingerprintSha256 || receipt.payload.productionPostRawFileSha256 !== live.payload.rawFileSha256) throw new Error("Receipt post-fingerprint provenance mismatch"); }

function assertR4Workflow(workflow: WorkflowRun, projectId: string, approvalIds: readonly string[], requireApproval: boolean): void {
  if (workflow.projectId !== projectId || workflow.riskClass !== "R4") throw new Error("Production apply requires exact R4 workflow scope");
  if (workflow.phase !== "approval" && workflow.phase !== "publish") throw new Error("Production apply workflow must be approval/publish boundary");
  if (requireApproval && workflow.status !== "running") throw new Error("Production apply allow requires active workflow");
  if (!sameJson(normalizeSet(workflow.approvalIds, "workflow approvalId", requireApproval), normalizeSet(approvalIds, "authorization approvalId", requireApproval))) throw new Error("Production apply approval set must equal durable workflow approvals");
}

function assertAutomaticFlags(value: object, label: string): void { const record = value as Record<string, unknown>; for (const field of AUTO_FIELDS) if (record[field] !== false) throw new Error(`${label} cannot grant automatic authority: ${field}`); }
function operationEvents(events: readonly LocalProductionRoutingApplyJournalEvent[], operationId: string): LocalProductionRoutingApplyJournalEvent[] { return events.filter((event) => event.payload.operationId === operationId); }
async function safeFingerprint(target: JsonFileLocalProductionReadOnlyTarget, observedAt: string): Promise<LocalProductionRouterFingerprint | null> { try { return await target.fingerprint(observedAt); } catch { return null; } }

function readBoundedRaw(path: string, maxBytes: number, label: string, allowEmpty = false): string { if (!existsSync(path)) throw new Error(`${label} file does not exist`); const size = statSync(path).size; if ((!allowEmpty && size <= 0) || size > maxBytes) throw new Error(`${label} file size invalid`); return readFileSync(path, "utf8"); }
function assertDistinctPhysicalCandidate(productionPath: string, candidatePath: string): void { const productionReal = runtimeFs.realpathSync(resolve(productionPath)); const candidate = resolve(candidatePath); if (productionReal === candidate) throw new Error("Backup path aliases production target"); if (existsSync(candidate)) { const candidateReal = runtimeFs.realpathSync(candidate); const p = runtimeFs.statSync(productionReal, { bigint: true }); const c = runtimeFs.statSync(candidateReal, { bigint: true }); if (candidateReal === productionReal || (p.dev === c.dev && p.ino === c.ino)) throw new Error("Backup path physically aliases production target"); } }
function fsyncDirectoryBestEffort(directoryPath: string): void { try { const fd = openSync(directoryPath, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } } catch { /* file fsync remains authoritative; directory fsync is platform-best-effort */ } }
function safeFileToken(value: string): string { return identity(value, "operationId").replace(/[^A-Za-z0-9._-]/g, "_").slice(-96); }
function safeObjectKey(value: string): string { const v = identity(value, "backupObjectKey"); if (v !== runtimePath.basename(v) || v.includes("/") || v.includes("\\") || v === "." || v === "..") throw new Error("Backup object key broadens filesystem scope"); return v; }
function sanitizedOperationalResult(value: string): string { const v = identity(value, "sanitized operational result"); if (containsSecretLikeMaterial(v)) throw new Error("Operational result contains secret-like material"); return v; }
function sanitizeError(error: unknown, fallback: string): string { const text = error instanceof Error ? error.message : fallback; if (containsSecretLikeMaterial(text)) return fallback; return text.slice(0, 512); }
function containsSecretLikeMaterial(value: string): boolean { return /(authorization\s*:|bearer\s+|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password\s*[=:])/i.test(value); }
function assertNoOversizedStrings(value: unknown, maxBytes: number, label: string): void { if (typeof value === "string") { if (byteLength(value) > maxBytes) throw new Error(`${label} contains oversized string`); return; } if (Array.isArray(value)) { for (const item of value) assertNoOversizedStrings(item, maxBytes, label); return; } if (value && typeof value === "object") for (const item of Object.values(value as Record<string, unknown>)) assertNoOversizedStrings(item, maxBytes, label); }
function identity(value: string, label: string): string { if (typeof value !== "string" || value.length === 0 || value.length > 512 || containsSecretLikeMaterial(value)) throw new Error(`${label} invalid or secret-bearing`); return value; }
function sha256(value: string, label: string): string { if (typeof value !== "string" || !/^[A-Fa-f0-9]{64}$/.test(value)) throw new Error(`${label} must be SHA-256`); return value.toUpperCase(); }
function timestamp(value: string, label: string): string { if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`${label} must be ISO timestamp`); return new Date(value).toISOString(); }
function exactBoolean(value: boolean, label: string): boolean { if (typeof value !== "boolean") throw new Error(`${label} must be boolean`); return value; }
function positiveInteger(value: number, label: string): number { if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be positive safe integer`); return value; }
function normalizeSet(values: readonly string[], label: string, requireNonEmpty: boolean): readonly string[] { if (!Array.isArray(values)) throw new Error(`${label} list invalid`); const normalized = [...new Set(values.map((v) => identity(v, label)))].sort(); if (normalized.length !== values.length) throw new Error(`${label} list contains duplicates`); if (requireNonEmpty && normalized.length === 0) throw new Error(`${label} list cannot be empty`); return Object.freeze(normalized); }
function assertExactKeys(value: object, expected: readonly string[], label: string): void { const actual = Object.keys(value); const unknown = actual.filter((key) => !expected.includes(key)); const missing = expected.filter((key) => !Object.prototype.hasOwnProperty.call(value, key)); if (unknown.length || missing.length) throw new Error(`${label} has unknown/provider-specific or missing fields`); }
function byteLength(value: string): number { return new TextEncoder().encode(value).byteLength; }
async function sha256Canonical(value: unknown): Promise<string> { return sha256Text(JSON.stringify(sortJson(value))); }
async function sha256Text(value: string): Promise<string> { if (!globalThis.crypto?.subtle) throw new Error("Web Crypto SHA-256 unavailable"); const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)); return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase(); }
function sortJson(value: unknown): unknown { if (Array.isArray(value)) return value.map(sortJson); if (!value || typeof value !== "object") return value; return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, sortJson(child)])); }
function sameJson(left: unknown, right: unknown): boolean { return JSON.stringify(sortJson(left)) === JSON.stringify(sortJson(right)); }
function deepFreeze<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); } return value; }
