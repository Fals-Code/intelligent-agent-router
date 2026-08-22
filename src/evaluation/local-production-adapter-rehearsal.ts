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
  LocalProductionRoutingReadinessAuthorization,
  LocalProductionRoutingReadinessContext,
  LocalProductionRoutingReadinessProposal,
  LocalProductionRoutingReadinessSourceSnapshot,
  LocalProductionRoutingTargetSnapshot,
} from "./local-production-routing-readiness.js";
import { verifyLocalProductionRoutingReadinessAuthorization } from "./local-production-routing-readiness.js";

export const LOCAL_PRODUCTION_ROUTER_STATE_SCHEMA_VERSION = 1 as const;
export const LOCAL_PRODUCTION_ROUTER_FINGERPRINT_SCHEMA_VERSION = 1 as const;
export const LOCAL_PRODUCTION_REHEARSAL_STATE_SCHEMA_VERSION = 1 as const;
export const LOCAL_PRODUCTION_REHEARSAL_JOURNAL_SCHEMA_VERSION = 1 as const;
export const LOCAL_PRODUCTION_REHEARSAL_RECEIPT_SCHEMA_VERSION = 1 as const;

export type LocalProductionAdapterRehearsalFaultPoint =
  | "after_candidate_reservation"
  | "after_candidate_apply_before_commit"
  | "after_restore_reservation"
  | "after_restore_apply_before_commit";

export type LocalProductionAdapterRehearsalRecoveryClassification =
  | "NO_OPERATION"
  | "COMMITTED"
  | "NOT_APPLIED_SAFE"
  | "MANUAL_RECONCILIATION_REQUIRED";

type RehearsalPhase = "candidate" | "restore";
type RehearsalEventType =
  | "rehearsal_reserved"
  | "rehearsal_committed"
  | "rehearsal_manual_reconciliation_required";

export interface LocalProductionAdapterRehearsalAuthority {
  readonly readinessAuthorization: LocalProductionRoutingReadinessAuthorization;
  readonly readinessProposal: LocalProductionRoutingReadinessProposal;
  readonly readinessContext: LocalProductionRoutingReadinessContext;
  readonly currentTargetSnapshot: LocalProductionRoutingTargetSnapshot;
  readonly currentSourceSnapshot: LocalProductionRoutingReadinessSourceSnapshot;
  readonly workflow: WorkflowRun;
}

export interface LocalProductionRouterStateInput {
  readonly targetId: string;
  readonly installationId: string;
  readonly projectId: string;
  readonly routeId: string;
  readonly capability: string;
  readonly currentSubjectId: string;
  readonly routeRevision: string;
  readonly updatedAt: string;
}

export interface LocalProductionRouterStatePayload extends LocalProductionRouterStateInput {
  readonly targetKind: "local_production_router";
  readonly productionRouter: true;
  readonly providerSpecificStatePersisted: false;
  readonly rawProviderOutputPersisted: false;
  readonly secretMaterialPersisted: false;
}

export interface LocalProductionRouterState {
  readonly schemaVersion: 1;
  readonly algorithm: "sha256";
  readonly stateId: string;
  readonly stateSha256: string;
  readonly payload: LocalProductionRouterStatePayload;
}

export interface LocalProductionRouterFingerprintPayload {
  readonly targetId: string;
  readonly installationId: string;
  readonly stateId: string;
  readonly stateSha256: string;
  readonly rawFileSha256: string;
  readonly projectId: string;
  readonly routeId: string;
  readonly capability: string;
  readonly currentSubjectId: string;
  readonly routeRevision: string;
  readonly observedAt: string;
  readonly productionRouter: true;
  readonly providerSpecificStatePersisted: false;
  readonly secretMaterialPersisted: false;
}

export interface LocalProductionRouterFingerprint {
  readonly schemaVersion: 1;
  readonly algorithm: "sha256";
  readonly fingerprintId: string;
  readonly fingerprintSha256: string;
  readonly payload: LocalProductionRouterFingerprintPayload;
}

export interface LocalProductionReadOnlyTargetDescriptor {
  readonly targetKind: "local_production_router";
  readonly targetId: string;
  readonly stateFilePath: string;
}

export interface LocalProductionRehearsalTargetDescriptor {
  readonly targetKind: "local_production_rehearsal_clone";
  readonly targetId: string;
  readonly sourceProductionTargetId: string;
  readonly stateFilePath: string;
  readonly rehearsalOnly: true;
}

export interface LocalProductionRehearsalStatePayload {
  readonly targetKind: "local_production_rehearsal_clone";
  readonly rehearsalOnly: true;
  readonly productionRouter: false;
  readonly targetId: string;
  readonly sourceProductionTargetId: string;
  readonly projectId: string;
  readonly routeId: string;
  readonly capability: string;
  readonly currentSubjectId: string;
  readonly routeRevision: string;
  readonly mutationCount: number;
  readonly updatedAt: string;
  readonly providerSpecificStatePersisted: false;
  readonly rawProviderOutputPersisted: false;
  readonly secretMaterialPersisted: false;
}

export interface LocalProductionRehearsalState {
  readonly schemaVersion: 1;
  readonly algorithm: "sha256";
  readonly stateId: string;
  readonly stateSha256: string;
  readonly payload: LocalProductionRehearsalStatePayload;
}

export interface LocalProductionRehearsalJournalOptions {
  readonly filePath: string;
  readonly maxFileBytes: number;
  readonly maxEventBytes: number;
  readonly maxStringBytes: number;
}

export interface LocalProductionRehearsalJournalPayload {
  readonly eventType: RehearsalEventType;
  readonly phase: RehearsalPhase;
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly readinessAuthorizationId: string;
  readonly readinessAuthorizationSha256: string;
  readonly readinessProposalId: string;
  readonly readinessProposalSha256: string;
  readonly targetSnapshotId: string;
  readonly targetSnapshotSha256: string;
  readonly sourceSnapshotId: string;
  readonly sourceSnapshotSha256: string;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly adapterSourceSha256: string;
  readonly mainSourceSha256: string;
  readonly productionTargetId: string;
  readonly rehearsalTargetId: string;
  readonly projectId: string;
  readonly routeId: string;
  readonly capability: string;
  readonly productionPreFingerprintId: string;
  readonly productionPreFingerprintSha256: string;
  readonly productionPreRawFileSha256: string;
  readonly productionPreStateId: string;
  readonly productionPreStateSha256: string;
  readonly beforeStateId: string;
  readonly beforeStateSha256: string;
  readonly afterStateId: string;
  readonly afterStateSha256: string;
  readonly beforeSubjectId: string;
  readonly afterSubjectId: string;
  readonly beforeRouteRevision: string;
  readonly afterRouteRevision: string;
  readonly beforeState: LocalProductionRehearsalState;
  readonly afterState: LocalProductionRehearsalState;
  readonly observedAt: string;
  readonly recoveredAfterRestart: boolean;
  readonly reason: string;
  readonly productionRouteMutated: false;
  readonly automaticRetryAllowed: false;
  readonly automaticRollbackAllowed: false;
  readonly automaticRedispatchAllowed: false;
  readonly productionRoutingMutationAuthorized: false;
}

export interface LocalProductionRehearsalJournalEvent {
  readonly algorithm: "sha256";
  readonly eventId: string;
  readonly eventSha256: string;
  readonly payload: LocalProductionRehearsalJournalPayload;
}

interface PersistedRehearsalEntry {
  readonly schemaVersion: 1;
  readonly sequence: number;
  readonly event: LocalProductionRehearsalJournalEvent;
}

export interface LocalProductionRehearsalJournalVerificationContext {
  readonly authority: LocalProductionAdapterRehearsalAuthority;
  readonly productionPreFingerprint: LocalProductionRouterFingerprint;
  readonly productionTargetId: string;
  readonly rehearsalTargetId: string;
}

export interface LocalProductionAdapterRehearsalRecoveryReport {
  readonly phase: RehearsalPhase;
  readonly operationId: string;
  readonly classification: LocalProductionAdapterRehearsalRecoveryClassification;
  readonly journalEventId?: string;
  readonly rehearsalStateId?: string;
  readonly observedAt: string;
  readonly reason: string;
  readonly explicitOperatorActionRequired: boolean;
  readonly productionRouteMutated: false;
  readonly automaticRetryAllowed: false;
  readonly automaticRollbackAllowed: false;
  readonly automaticRedispatchAllowed: false;
  readonly productionRoutingMutationAuthorized: false;
}

export interface LocalProductionAdapterRehearsalReceiptPayload {
  readonly operationId: string;
  readonly readinessAuthorizationId: string;
  readonly readinessAuthorizationSha256: string;
  readonly readinessProposalId: string;
  readonly readinessProposalSha256: string;
  readonly targetSnapshotId: string;
  readonly targetSnapshotSha256: string;
  readonly sourceSnapshotId: string;
  readonly sourceSnapshotSha256: string;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly adapterSourceSha256: string;
  readonly mainSourceSha256: string;
  readonly productionTargetId: string;
  readonly productionPreFingerprintId: string;
  readonly productionPreFingerprintSha256: string;
  readonly productionPreRawFileSha256: string;
  readonly productionPostFingerprintId: string;
  readonly productionPostFingerprintSha256: string;
  readonly productionPostRawFileSha256: string;
  readonly rehearsalTargetId: string;
  readonly candidateStateId: string;
  readonly candidateStateSha256: string;
  readonly restoredStateId: string;
  readonly restoredStateSha256: string;
  readonly candidateReservationEventId: string;
  readonly candidateReservationEventSha256: string;
  readonly candidateCommitEventId: string;
  readonly candidateCommitEventSha256: string;
  readonly restoreReservationEventId: string;
  readonly restoreReservationEventSha256: string;
  readonly restoreCommitEventId: string;
  readonly restoreCommitEventSha256: string;
  readonly journalProgressionSha256: string;
  readonly candidateRecoveredAfterRestart: boolean;
  readonly restoreRecoveredAfterRestart: boolean;
  readonly completedAt: string;
  readonly classification: "REHEARSAL_PASSED";
  readonly productionRouteMutated: false;
  readonly automaticRetryAllowed: false;
  readonly automaticRollbackAllowed: false;
  readonly automaticRedispatchAllowed: false;
  readonly productionRoutingMutationAuthorized: false;
}

export interface LocalProductionAdapterRehearsalReceipt {
  readonly schemaVersion: 1;
  readonly algorithm: "sha256";
  readonly receiptId: string;
  readonly receiptSha256: string;
  readonly payload: LocalProductionAdapterRehearsalReceiptPayload;
}

export interface LocalProductionAdapterRehearsalFaultInjector {
  hit(point: LocalProductionAdapterRehearsalFaultPoint): void | Promise<void>;
}

interface VerifiedProgression {
  readonly candidateReservation?: LocalProductionRehearsalJournalEvent;
  readonly candidateCommit?: LocalProductionRehearsalJournalEvent;
  readonly candidateManual?: LocalProductionRehearsalJournalEvent;
  readonly restoreReservation?: LocalProductionRehearsalJournalEvent;
  readonly restoreCommit?: LocalProductionRehearsalJournalEvent;
  readonly restoreManual?: LocalProductionRehearsalJournalEvent;
  readonly progressionSha256: string;
}

class ProductionDriftError extends Error {}
class ManualReconciliationRequiredError extends Error {}

const PRODUCTION_STATE_FIELDS = new Set(["schemaVersion", "algorithm", "stateId", "stateSha256", "payload"]);
const PRODUCTION_PAYLOAD_FIELDS = new Set([
  "targetId", "installationId", "projectId", "routeId", "capability", "currentSubjectId", "routeRevision", "updatedAt",
  "targetKind", "productionRouter", "providerSpecificStatePersisted", "rawProviderOutputPersisted", "secretMaterialPersisted",
]);
const FINGERPRINT_FIELDS = new Set(["schemaVersion", "algorithm", "fingerprintId", "fingerprintSha256", "payload"]);
const FINGERPRINT_PAYLOAD_FIELDS = new Set([
  "targetId", "installationId", "stateId", "stateSha256", "rawFileSha256", "projectId", "routeId", "capability",
  "currentSubjectId", "routeRevision", "observedAt", "productionRouter", "providerSpecificStatePersisted", "secretMaterialPersisted",
]);
const PRODUCTION_DESCRIPTOR_FIELDS = new Set(["targetKind", "targetId", "stateFilePath"]);
const REHEARSAL_DESCRIPTOR_FIELDS = new Set(["targetKind", "targetId", "sourceProductionTargetId", "stateFilePath", "rehearsalOnly"]);
const REHEARSAL_STATE_FIELDS = new Set(["schemaVersion", "algorithm", "stateId", "stateSha256", "payload"]);
const REHEARSAL_PAYLOAD_FIELDS = new Set([
  "targetKind", "rehearsalOnly", "productionRouter", "targetId", "sourceProductionTargetId", "projectId", "routeId", "capability",
  "currentSubjectId", "routeRevision", "mutationCount", "updatedAt", "providerSpecificStatePersisted", "rawProviderOutputPersisted", "secretMaterialPersisted",
]);
const EVENT_FIELDS = new Set(["algorithm", "eventId", "eventSha256", "payload"]);
const EVENT_PAYLOAD_FIELDS = new Set([
  "eventType", "phase", "operationId", "idempotencyKey", "readinessAuthorizationId", "readinessAuthorizationSha256",
  "readinessProposalId", "readinessProposalSha256", "targetSnapshotId", "targetSnapshotSha256", "sourceSnapshotId", "sourceSnapshotSha256",
  "adapterId", "adapterVersion", "adapterSourceSha256", "mainSourceSha256", "productionTargetId", "rehearsalTargetId", "projectId", "routeId",
  "capability", "productionPreFingerprintId", "productionPreFingerprintSha256", "productionPreRawFileSha256", "productionPreStateId",
  "productionPreStateSha256", "beforeStateId", "beforeStateSha256", "afterStateId", "afterStateSha256", "beforeSubjectId", "afterSubjectId",
  "beforeRouteRevision", "afterRouteRevision", "beforeState", "afterState", "observedAt", "recoveredAfterRestart", "reason",
  "productionRouteMutated", "automaticRetryAllowed", "automaticRollbackAllowed", "automaticRedispatchAllowed", "productionRoutingMutationAuthorized",
]);
const RECEIPT_FIELDS = new Set(["schemaVersion", "algorithm", "receiptId", "receiptSha256", "payload"]);
const RECEIPT_PAYLOAD_FIELDS = new Set([
  "operationId", "readinessAuthorizationId", "readinessAuthorizationSha256", "readinessProposalId", "readinessProposalSha256",
  "targetSnapshotId", "targetSnapshotSha256", "sourceSnapshotId", "sourceSnapshotSha256", "adapterId", "adapterVersion", "adapterSourceSha256",
  "mainSourceSha256", "productionTargetId", "productionPreFingerprintId", "productionPreFingerprintSha256", "productionPreRawFileSha256",
  "productionPostFingerprintId", "productionPostFingerprintSha256", "productionPostRawFileSha256", "rehearsalTargetId", "candidateStateId",
  "candidateStateSha256", "restoredStateId", "restoredStateSha256", "candidateReservationEventId", "candidateReservationEventSha256",
  "candidateCommitEventId", "candidateCommitEventSha256", "restoreReservationEventId", "restoreReservationEventSha256", "restoreCommitEventId",
  "restoreCommitEventSha256", "journalProgressionSha256", "candidateRecoveredAfterRestart", "restoreRecoveredAfterRestart", "completedAt",
  "classification", "productionRouteMutated", "automaticRetryAllowed", "automaticRollbackAllowed", "automaticRedispatchAllowed",
  "productionRoutingMutationAuthorized",
]);

export async function prepareLocalProductionRouterState(input: LocalProductionRouterStateInput): Promise<LocalProductionRouterState> {
  const payload: LocalProductionRouterStatePayload = Object.freeze({
    targetId: identity(input.targetId, "production targetId"),
    installationId: identity(input.installationId, "production installationId"),
    projectId: identity(input.projectId, "production projectId"),
    routeId: identity(input.routeId, "production routeId"),
    capability: identity(input.capability, "production capability"),
    currentSubjectId: identity(input.currentSubjectId, "production currentSubjectId"),
    routeRevision: identity(input.routeRevision, "production routeRevision"),
    updatedAt: timestamp(input.updatedAt, "production updatedAt"),
    targetKind: "local_production_router",
    productionRouter: true,
    providerSpecificStatePersisted: false,
    rawProviderOutputPersisted: false,
    secretMaterialPersisted: false,
  });
  const stateSha256 = await sha256Canonical(payload);
  return Object.freeze({
    schemaVersion: 1,
    algorithm: "sha256" as const,
    stateId: `m5localprodstate:${stateSha256.slice(0, 32).toLowerCase()}`,
    stateSha256,
    payload,
  });
}

export async function verifyLocalProductionRouterState(state: LocalProductionRouterState): Promise<void> {
  assertExactFields(record(state, "Production state"), PRODUCTION_STATE_FIELDS, "Production state");
  if (state.schemaVersion !== 1 || state.algorithm !== "sha256" || !isRecord(state.payload)) throw new Error("Production state envelope is invalid");
  assertExactFields(state.payload, PRODUCTION_PAYLOAD_FIELDS, "Production state payload");
  const p = state.payload as LocalProductionRouterStatePayload;
  for (const [value, label] of [
    [p.targetId, "targetId"], [p.installationId, "installationId"], [p.projectId, "projectId"], [p.routeId, "routeId"],
    [p.capability, "capability"], [p.currentSubjectId, "currentSubjectId"], [p.routeRevision, "routeRevision"],
  ] as const) identity(value, `production ${label}`);
  timestamp(p.updatedAt, "production updatedAt");
  if (p.targetKind !== "local_production_router" || p.productionRouter !== true || p.providerSpecificStatePersisted !== false || p.rawProviderOutputPersisted !== false || p.secretMaterialPersisted !== false) throw new Error("Production state safety boundary is invalid");
  const expected = await sha256Canonical(p);
  if (state.stateSha256 !== expected || state.stateId !== `m5localprodstate:${expected.slice(0, 32).toLowerCase()}`) throw new Error("Production state content address is invalid");
}

export async function verifyLocalProductionRouterFingerprint(fingerprint: LocalProductionRouterFingerprint): Promise<void> {
  assertExactFields(record(fingerprint, "Production fingerprint"), FINGERPRINT_FIELDS, "Production fingerprint");
  if (fingerprint.schemaVersion !== 1 || fingerprint.algorithm !== "sha256" || !isRecord(fingerprint.payload)) throw new Error("Production fingerprint envelope is invalid");
  assertExactFields(fingerprint.payload, FINGERPRINT_PAYLOAD_FIELDS, "Production fingerprint payload");
  const p = fingerprint.payload;
  for (const [value, label] of [
    [p.targetId, "targetId"], [p.installationId, "installationId"], [p.stateId, "stateId"], [p.projectId, "projectId"],
    [p.routeId, "routeId"], [p.capability, "capability"], [p.currentSubjectId, "currentSubjectId"], [p.routeRevision, "routeRevision"],
  ] as const) identity(value, `production fingerprint ${label}`);
  sha256Value(p.stateSha256, "production fingerprint stateSha256");
  sha256Value(p.rawFileSha256, "production fingerprint rawFileSha256");
  timestamp(p.observedAt, "production fingerprint observedAt");
  if (p.productionRouter !== true || p.providerSpecificStatePersisted !== false || p.secretMaterialPersisted !== false) throw new Error("Production fingerprint safety boundary is invalid");
  const expected = await sha256Canonical(p);
  if (fingerprint.fingerprintSha256 !== expected || fingerprint.fingerprintId !== `m5localprodfingerprint:${expected.slice(0, 32).toLowerCase()}`) throw new Error("Production fingerprint content address is invalid");
}

export class JsonFileLocalProductionReadOnlyTarget {
  readonly descriptor: LocalProductionReadOnlyTargetDescriptor;
  readonly maxStateBytes: number;

  constructor(input: { readonly descriptor: LocalProductionReadOnlyTargetDescriptor; readonly maxStateBytes: number }) {
    assertExactFields(record(input.descriptor, "Production target descriptor"), PRODUCTION_DESCRIPTOR_FIELDS, "Production target descriptor");
    if (input.descriptor.targetKind !== "local_production_router") throw new Error("Read-only production target descriptor kind is invalid");
    if (!Number.isSafeInteger(input.maxStateBytes) || input.maxStateBytes <= 0) throw new Error("Production maxStateBytes must be positive");
    this.descriptor = Object.freeze({
      targetKind: "local_production_router" as const,
      targetId: identity(input.descriptor.targetId, "production targetId"),
      stateFilePath: resolve(identity(input.descriptor.stateFilePath, "production stateFilePath")),
    });
    this.maxStateBytes = input.maxStateBytes;
  }

  async read(): Promise<LocalProductionRouterState> {
    const raw = this.readRaw();
    const parsed = JSON.parse(raw) as LocalProductionRouterState;
    await verifyLocalProductionRouterState(parsed);
    if (parsed.payload.targetId !== this.descriptor.targetId) throw new Error("Production target identity mismatch");
    return parsed;
  }

  async fingerprint(observedAt: string): Promise<LocalProductionRouterFingerprint> {
    const raw = this.readRaw();
    const state = JSON.parse(raw) as LocalProductionRouterState;
    await verifyLocalProductionRouterState(state);
    if (state.payload.targetId !== this.descriptor.targetId) throw new Error("Production target identity mismatch");
    const payload: LocalProductionRouterFingerprintPayload = Object.freeze({
      targetId: state.payload.targetId,
      installationId: state.payload.installationId,
      stateId: state.stateId,
      stateSha256: state.stateSha256,
      rawFileSha256: await sha256Text(raw),
      projectId: state.payload.projectId,
      routeId: state.payload.routeId,
      capability: state.payload.capability,
      currentSubjectId: state.payload.currentSubjectId,
      routeRevision: state.payload.routeRevision,
      observedAt: timestamp(observedAt, "production fingerprint observedAt"),
      productionRouter: true,
      providerSpecificStatePersisted: false,
      secretMaterialPersisted: false,
    });
    const fingerprintSha256 = await sha256Canonical(payload);
    return Object.freeze({
      schemaVersion: 1,
      algorithm: "sha256" as const,
      fingerprintId: `m5localprodfingerprint:${fingerprintSha256.slice(0, 32).toLowerCase()}`,
      fingerprintSha256,
      payload,
    });
  }

  private readRaw(): string {
    if (!existsSync(this.descriptor.stateFilePath)) throw new Error("Production target state file does not exist");
    const size = statSync(this.descriptor.stateFilePath).size;
    if (size <= 0 || size > this.maxStateBytes) throw new Error("Production target state file size is invalid");
    return readFileSync(this.descriptor.stateFilePath, "utf8");
  }
}

export class JsonFileLocalProductionRehearsalTarget {
  readonly descriptor: LocalProductionRehearsalTargetDescriptor;
  readonly maxStateBytes: number;

  private constructor(input: { readonly descriptor: LocalProductionRehearsalTargetDescriptor; readonly maxStateBytes: number }) {
    assertExactFields(record(input.descriptor, "Rehearsal target descriptor"), REHEARSAL_DESCRIPTOR_FIELDS, "Rehearsal target descriptor");
    if (input.descriptor.targetKind !== "local_production_rehearsal_clone" || input.descriptor.rehearsalOnly !== true) throw new Error("Rehearsal descriptor is not rehearsal-only");
    if (!Number.isSafeInteger(input.maxStateBytes) || input.maxStateBytes <= 0) throw new Error("Rehearsal maxStateBytes must be positive");
    this.descriptor = Object.freeze({
      targetKind: "local_production_rehearsal_clone" as const,
      targetId: identity(input.descriptor.targetId, "rehearsal targetId"),
      sourceProductionTargetId: identity(input.descriptor.sourceProductionTargetId, "source production targetId"),
      stateFilePath: resolve(identity(input.descriptor.stateFilePath, "rehearsal stateFilePath")),
      rehearsalOnly: true as const,
    });
    this.maxStateBytes = input.maxStateBytes;
  }

  static async initialize(input: {
    readonly descriptor: LocalProductionRehearsalTargetDescriptor;
    readonly productionTarget: JsonFileLocalProductionReadOnlyTarget;
    readonly initializedAt: string;
    readonly maxStateBytes: number;
  }): Promise<JsonFileLocalProductionRehearsalTarget> {
    const target = new JsonFileLocalProductionRehearsalTarget({ descriptor: input.descriptor, maxStateBytes: input.maxStateBytes });
    if (target.descriptor.stateFilePath === input.productionTarget.descriptor.stateFilePath) throw new Error("Rehearsal clone path aliases production path");
    if (target.descriptor.targetId === input.productionTarget.descriptor.targetId) throw new Error("Rehearsal clone identity aliases production identity");
    if (target.descriptor.sourceProductionTargetId !== input.productionTarget.descriptor.targetId) throw new Error("Rehearsal clone sourceProductionTargetId mismatches production target");
    const production = await input.productionTarget.read();
    const state = await prepareRehearsalState({
      targetId: target.descriptor.targetId,
      sourceProductionTargetId: production.payload.targetId,
      projectId: production.payload.projectId,
      routeId: production.payload.routeId,
      capability: production.payload.capability,
      currentSubjectId: production.payload.currentSubjectId,
      routeRevision: production.payload.routeRevision,
      mutationCount: 0,
      updatedAt: input.initializedAt,
    });
    target.write(state);
    return target;
  }

  static open(input: { readonly descriptor: LocalProductionRehearsalTargetDescriptor; readonly maxStateBytes: number }): JsonFileLocalProductionRehearsalTarget {
    return new JsonFileLocalProductionRehearsalTarget(input);
  }

  async read(): Promise<LocalProductionRehearsalState> {
    if (!existsSync(this.descriptor.stateFilePath)) throw new Error("Rehearsal clone state file does not exist");
    const size = statSync(this.descriptor.stateFilePath).size;
    if (size <= 0 || size > this.maxStateBytes) throw new Error("Rehearsal clone state file size is invalid");
    const parsed = JSON.parse(readFileSync(this.descriptor.stateFilePath, "utf8")) as LocalProductionRehearsalState;
    await verifyRehearsalState(parsed);
    if (parsed.payload.targetId !== this.descriptor.targetId || parsed.payload.sourceProductionTargetId !== this.descriptor.sourceProductionTargetId) throw new Error("Rehearsal clone descriptor mismatch");
    return parsed;
  }

  async writeCandidate(before: LocalProductionRehearsalState, candidateSubjectId: string, candidateRevision: string, updatedAt: string): Promise<LocalProductionRehearsalState> {
    const current = await this.read();
    if (!sameState(current, before)) throw new Error("Rehearsal clone changed before candidate write");
    const next = await prepareRehearsalState({
      ...stateInputFrom(current),
      currentSubjectId: candidateSubjectId,
      routeRevision: candidateRevision,
      mutationCount: current.payload.mutationCount + 1,
      updatedAt,
    });
    this.write(next);
    return next;
  }

  async restore(before: LocalProductionRehearsalState, referenceSubjectId: string, referenceRevision: string, updatedAt: string): Promise<LocalProductionRehearsalState> {
    const current = await this.read();
    if (!sameState(current, before)) throw new Error("Rehearsal clone changed before restore write");
    const next = await prepareRehearsalState({
      ...stateInputFrom(current),
      currentSubjectId: referenceSubjectId,
      routeRevision: referenceRevision,
      mutationCount: current.payload.mutationCount + 1,
      updatedAt,
    });
    this.write(next);
    return next;
  }

  private write(state: LocalProductionRehearsalState): void {
    const raw = `${JSON.stringify(state)}\n`;
    if (utf8Bytes(raw) > this.maxStateBytes) throw new Error("Rehearsal clone state exceeds size limit");
    writeUtf8File(this.descriptor.stateFilePath, raw);
  }
}

export class JsonlLocalProductionRehearsalJournal {
  readonly options: LocalProductionRehearsalJournalOptions;
  private entries: PersistedRehearsalEntry[] = [];
  private expectedFileSize = 0;
  private expectedFileSha256 = "";
  private verificationContext?: LocalProductionRehearsalJournalVerificationContext;

  private constructor(options: LocalProductionRehearsalJournalOptions) {
    if (!Number.isSafeInteger(options.maxFileBytes) || options.maxFileBytes <= 0 || !Number.isSafeInteger(options.maxEventBytes) || options.maxEventBytes <= 0 || !Number.isSafeInteger(options.maxStringBytes) || options.maxStringBytes <= 0) throw new Error("Rehearsal journal limits must be positive integers");
    this.options = Object.freeze({ ...options, filePath: resolve(options.filePath) });
  }

  static async open(
    options: LocalProductionRehearsalJournalOptions,
    verificationContext?: LocalProductionRehearsalJournalVerificationContext,
  ): Promise<JsonlLocalProductionRehearsalJournal> {
    const journal = new JsonlLocalProductionRehearsalJournal(options);
    await journal.load(verificationContext);
    return journal;
  }

  latest(operationId: string): LocalProductionRehearsalJournalEvent | undefined {
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const event = this.entries[index]?.event;
      if (event?.payload.operationId === operationId) return event;
    }
    return undefined;
  }

  latestCommitted(phase: RehearsalPhase, authorizationId: string): LocalProductionRehearsalJournalEvent | undefined {
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const event = this.entries[index]?.event;
      if (event?.payload.phase === phase && event.payload.readinessAuthorizationId === authorizationId && event.payload.eventType === "rehearsal_committed") return event;
    }
    return undefined;
  }

  async assertFreshRead(): Promise<void> {
    const raw = existsSync(this.options.filePath) ? readFileSync(this.options.filePath, "utf8") : "";
    if (utf8Bytes(raw) !== this.expectedFileSize || await sha256Text(raw) !== this.expectedFileSha256) throw new Error("Rehearsal journal durable state changed after reader opened");
  }

  async verifyProgression(context: LocalProductionRehearsalJournalVerificationContext): Promise<VerifiedProgression> {
    await this.assertFreshRead();
    this.verificationContext = context;
    return verifyCanonicalJournalProgression(this.entries, context);
  }

  async append(
    payload: LocalProductionRehearsalJournalPayload,
    context?: LocalProductionRehearsalJournalVerificationContext,
  ): Promise<LocalProductionRehearsalJournalEvent> {
    await this.assertFreshRead();
    validateEventPayload(payload);
    const eventSha256 = await sha256Canonical(payload);
    const event: LocalProductionRehearsalJournalEvent = Object.freeze({
      algorithm: "sha256" as const,
      eventId: `m5localprodrehearsalevent:${eventSha256.slice(0, 32).toLowerCase()}`,
      eventSha256,
      payload: Object.freeze({ ...payload }),
    });
    const entry: PersistedRehearsalEntry = Object.freeze({ schemaVersion: 1, sequence: this.entries.length + 1, event });
    const prospective = [...this.entries, entry];
    await verifyEntrySequence(prospective);
    const canonicalContext = context ?? this.verificationContext;
    if (!canonicalContext) throw new Error("Rehearsal journal append requires exact authority and production pre-fingerprint context");
    await verifyCanonicalJournalProgression(prospective, canonicalContext);
    const line = `${JSON.stringify(entry)}\n`;
    const eventBytes = utf8Bytes(line);
    if (eventBytes > this.options.maxEventBytes) throw new Error("Rehearsal journal event exceeds size limit");
    if (this.expectedFileSize + eventBytes > this.options.maxFileBytes) throw new Error("Rehearsal journal exceeds file size limit");
    mkdirSync(resolve(this.options.filePath, ".."), { recursive: true });
    const fd = openSync(this.options.filePath, "a");
    try { writeFileSync(fd, line, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
    this.entries.push(entry);
    this.verificationContext = canonicalContext;
    await this.refreshFingerprint();
    return event;
  }

  private async load(verificationContext?: LocalProductionRehearsalJournalVerificationContext): Promise<void> {
    if (!existsSync(this.options.filePath)) {
      this.entries = [];
      this.expectedFileSize = 0;
      this.expectedFileSha256 = await sha256Text("");
      this.verificationContext = verificationContext;
      return;
    }
    const raw = readFileSync(this.options.filePath, "utf8");
    if (utf8Bytes(raw) > this.options.maxFileBytes) throw new Error("Rehearsal journal exceeds file size limit");
    if (raw.length > 0 && !raw.endsWith("\n")) throw new Error("Rehearsal journal is truncated or partial");
    const lines = raw.split("\n").filter(Boolean);
    const entries: PersistedRehearsalEntry[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      if (utf8Bytes(line) > this.options.maxEventBytes) throw new Error("Rehearsal journal event exceeds size limit");
      const parsed = JSON.parse(line) as PersistedRehearsalEntry;
      if (parsed.schemaVersion !== 1 || parsed.sequence !== index + 1 || !parsed.event) throw new Error("Rehearsal journal sequence/envelope is invalid");
      await verifyJournalEvent(parsed.event);
      entries.push(parsed);
    }
    await verifyEntrySequence(entries);
    this.entries = entries;
    this.expectedFileSize = utf8Bytes(raw);
    this.expectedFileSha256 = await sha256Text(raw);
    if (entries.length > 0 && !verificationContext) throw new Error("Non-empty rehearsal journal reopen requires exact authority and production pre-fingerprint context");
    if (verificationContext) {
      await verifyCanonicalJournalProgression(entries, verificationContext);
      this.verificationContext = verificationContext;
    }
  }

  private async refreshFingerprint(): Promise<void> {
    const raw = readFileSync(this.options.filePath, "utf8");
    this.expectedFileSize = utf8Bytes(raw);
    this.expectedFileSha256 = await sha256Text(raw);
  }
}

export class LocalProductionAdapterRehearsalCoordinator {
  constructor(
    private readonly productionTarget: JsonFileLocalProductionReadOnlyTarget,
    private readonly rehearsalTarget: JsonFileLocalProductionRehearsalTarget,
    private readonly journal: JsonlLocalProductionRehearsalJournal,
    private readonly productionPreFingerprint: LocalProductionRouterFingerprint,
    private readonly faultInjector?: LocalProductionAdapterRehearsalFaultInjector,
  ) {}

  async applyCandidate(input: {
    readonly authority: LocalProductionAdapterRehearsalAuthority;
    readonly reservedAt: string;
    readonly appliedAt: string;
    readonly committedAt: string;
  }): Promise<LocalProductionRehearsalJournalEvent> {
    const context = await this.prepareContext(input.authority);
    const progression = await this.journal.verifyProgression(context);
    if (progression.candidateManual || progression.restoreManual) throw new ManualReconciliationRequiredError("Rehearsal journal is terminal manual reconciliation");
    const operation = operationIdentity(input.authority.readinessAuthorization.authorizationId, "candidate");
    if (this.journal.latest(operation.operationId)) throw new Error("Candidate rehearsal operation already exists; automatic retry is forbidden");
    const before = await this.rehearsalTarget.read();
    assertCloneMatchesAuthority(before, input.authority);
    const after = await expectedCandidateState(before, input.authority, input.appliedAt);

    try {
      await assertProductionStable(this.productionTarget, input.authority, this.productionPreFingerprint, input.reservedAt);
    } catch (error) {
      if (!(error instanceof ProductionDriftError)) throw error;
      await this.journal.append(journalPayload("rehearsal_manual_reconciliation_required", "candidate", operation, input.authority, this.productionPreFingerprint, this.productionTarget.descriptor.targetId, this.rehearsalTarget.descriptor.targetId, before, before, input.reservedAt, false, "production drift before candidate reservation"), context);
      throw new ManualReconciliationRequiredError(error.message);
    }

    const reservation = await this.journal.append(journalPayload("rehearsal_reserved", "candidate", operation, input.authority, this.productionPreFingerprint, this.productionTarget.descriptor.targetId, this.rehearsalTarget.descriptor.targetId, before, after, input.reservedAt, false, "candidate mutation reserved"), context);
    await this.faultInjector?.hit("after_candidate_reservation");

    try {
      await assertProductionStable(this.productionTarget, input.authority, this.productionPreFingerprint, input.appliedAt);
    } catch (error) {
      if (!(error instanceof ProductionDriftError)) throw error;
      await this.appendManualFromEvent(input.authority, context, reservation, before, input.appliedAt, "production drift after candidate reservation before clone apply");
      throw new ManualReconciliationRequiredError(error.message);
    }

    const applied = await this.rehearsalTarget.writeCandidate(before, after.payload.currentSubjectId, after.payload.routeRevision, input.appliedAt);
    if (!sameState(applied, after)) throw new Error("Candidate rehearsal state does not equal reserved expected state");
    await this.faultInjector?.hit("after_candidate_apply_before_commit");

    try {
      await assertProductionStable(this.productionTarget, input.authority, this.productionPreFingerprint, input.committedAt);
    } catch (error) {
      if (!(error instanceof ProductionDriftError)) throw error;
      await this.appendManualFromEvent(input.authority, context, reservation, applied, input.committedAt, "production drift after candidate clone apply before candidate commit");
      throw new ManualReconciliationRequiredError(error.message);
    }

    return this.journal.append(journalPayload("rehearsal_committed", "candidate", operation, input.authority, this.productionPreFingerprint, this.productionTarget.descriptor.targetId, this.rehearsalTarget.descriptor.targetId, before, after, input.committedAt, false, "candidate mutation committed on rehearsal clone"), context);
  }

  async restoreReference(input: {
    readonly authority: LocalProductionAdapterRehearsalAuthority;
    readonly reservedAt: string;
    readonly restoredAt: string;
    readonly committedAt: string;
  }): Promise<LocalProductionRehearsalJournalEvent> {
    const context = await this.prepareContext(input.authority);
    const progression = await this.journal.verifyProgression(context);
    if (progression.candidateManual || progression.restoreManual) throw new ManualReconciliationRequiredError("Rehearsal journal is terminal manual reconciliation");
    const candidateCommit = progression.candidateCommit;
    if (!candidateCommit) throw new Error("Explicit restore requires a valid durable candidate commit");
    const operation = operationIdentity(input.authority.readinessAuthorization.authorizationId, "restore");
    if (this.journal.latest(operation.operationId)) throw new Error("Restore rehearsal operation already exists; automatic retry is forbidden");
    const current = await this.rehearsalTarget.read();

    try {
      await assertProductionStable(this.productionTarget, input.authority, this.productionPreFingerprint, input.reservedAt);
    } catch (error) {
      if (!(error instanceof ProductionDriftError)) throw error;
      await this.journal.append(journalPayload("rehearsal_manual_reconciliation_required", "restore", operation, input.authority, this.productionPreFingerprint, this.productionTarget.descriptor.targetId, this.rehearsalTarget.descriptor.targetId, candidateCommit.payload.afterState, candidateCommit.payload.afterState, input.reservedAt, false, `production drift before restore reservation; current=${current.stateId}`), context);
      throw new ManualReconciliationRequiredError(error.message);
    }

    if (!sameState(current, candidateCommit.payload.afterState)) {
      await this.journal.append(journalPayload("rehearsal_manual_reconciliation_required", "restore", operation, input.authority, this.productionPreFingerprint, this.productionTarget.descriptor.targetId, this.rehearsalTarget.descriptor.targetId, candidateCommit.payload.afterState, candidateCommit.payload.afterState, input.reservedAt, false, `clone drift before restore reservation; current=${current.stateId}`), context);
      throw new ManualReconciliationRequiredError("Explicit restore requires exact committed candidate rehearsal state");
    }

    const after = await expectedRestoreState(current, input.authority, input.restoredAt);
    const reservation = await this.journal.append(journalPayload("rehearsal_reserved", "restore", operation, input.authority, this.productionPreFingerprint, this.productionTarget.descriptor.targetId, this.rehearsalTarget.descriptor.targetId, current, after, input.reservedAt, false, "reference restore reserved"), context);
    await this.faultInjector?.hit("after_restore_reservation");

    try {
      await assertProductionStable(this.productionTarget, input.authority, this.productionPreFingerprint, input.restoredAt);
    } catch (error) {
      if (!(error instanceof ProductionDriftError)) throw error;
      await this.appendManualFromEvent(input.authority, context, reservation, current, input.restoredAt, "production drift after restore reservation before clone restore");
      throw new ManualReconciliationRequiredError(error.message);
    }

    const restored = await this.rehearsalTarget.restore(current, after.payload.currentSubjectId, after.payload.routeRevision, input.restoredAt);
    if (!sameState(restored, after)) throw new Error("Restored rehearsal state does not equal reserved expected state");
    await this.faultInjector?.hit("after_restore_apply_before_commit");

    try {
      await assertProductionStable(this.productionTarget, input.authority, this.productionPreFingerprint, input.committedAt);
    } catch (error) {
      if (!(error instanceof ProductionDriftError)) throw error;
      await this.appendManualFromEvent(input.authority, context, reservation, restored, input.committedAt, "production drift after restore clone write before restore commit");
      throw new ManualReconciliationRequiredError(error.message);
    }

    return this.journal.append(journalPayload("rehearsal_committed", "restore", operation, input.authority, this.productionPreFingerprint, this.productionTarget.descriptor.targetId, this.rehearsalTarget.descriptor.targetId, current, after, input.committedAt, false, "reference restore committed on rehearsal clone"), context);
  }

  async reconcile(input: {
    readonly authority: LocalProductionAdapterRehearsalAuthority;
    readonly phase: RehearsalPhase;
    readonly observedAt: string;
  }): Promise<LocalProductionAdapterRehearsalRecoveryReport> {
    const context = await this.prepareContext(input.authority);
    const progression = await this.journal.verifyProgression(context);
    const operation = operationIdentity(input.authority.readinessAuthorization.authorizationId, input.phase);
    const event = this.journal.latest(operation.operationId);
    const current = await this.rehearsalTarget.read();

    try {
      await assertProductionStable(this.productionTarget, input.authority, this.productionPreFingerprint, input.observedAt);
    } catch (error) {
      if (!(error instanceof ProductionDriftError)) throw error;
      const manual = await this.appendManualForCurrentOperation(input, context, progression, event, current, `production drift during ${input.phase} reconciliation`);
      return recoveryReport(input.phase, operation.operationId, "MANUAL_RECONCILIATION_REQUIRED", input.observedAt, error.message, true, manual?.eventId ?? event?.eventId, current.stateId);
    }

    if (!event) return recoveryReport(input.phase, operation.operationId, "NO_OPERATION", input.observedAt, "No durable rehearsal operation exists", false);
    if (event.payload.eventType === "rehearsal_manual_reconciliation_required") return recoveryReport(input.phase, operation.operationId, "MANUAL_RECONCILIATION_REQUIRED", input.observedAt, event.payload.reason, true, event.eventId, current.stateId);

    if (event.payload.eventType === "rehearsal_committed") {
      if (sameState(current, event.payload.afterState)) return recoveryReport(input.phase, operation.operationId, "COMMITTED", input.observedAt, "Durable commit matches current rehearsal state", false, event.eventId, current.stateId);
      const manual = await this.appendManualFromEvent(input.authority, context, event, current, input.observedAt, "committed rehearsal state drifted from durable commit");
      return recoveryReport(input.phase, operation.operationId, "MANUAL_RECONCILIATION_REQUIRED", input.observedAt, "Committed rehearsal state drifted from durable commit", true, manual.eventId, current.stateId);
    }

    if (sameState(current, event.payload.beforeState)) return recoveryReport(input.phase, operation.operationId, "NOT_APPLIED_SAFE", input.observedAt, "Reservation exists and rehearsal clone remains at exact before state", true, event.eventId, current.stateId);

    if (sameState(current, event.payload.afterState)) {
      await assertProductionStable(this.productionTarget, input.authority, this.productionPreFingerprint, input.observedAt);
      const commit = await this.journal.append({
        ...event.payload,
        eventType: "rehearsal_committed",
        observedAt: timestamp(input.observedAt, "recovery observedAt"),
        recoveredAfterRestart: true,
        reason: `${input.phase} reconciled committed after restart`,
      }, context);
      return recoveryReport(input.phase, operation.operationId, "COMMITTED", input.observedAt, "Reservation reconciled to exact expected after state without duplicate write", false, commit.eventId, current.stateId);
    }

    const manual = await this.appendManualFromEvent(input.authority, context, event, current, input.observedAt, "rehearsal clone is neither exact before nor exact expected after state");
    return recoveryReport(input.phase, operation.operationId, "MANUAL_RECONCILIATION_REQUIRED", input.observedAt, "Rehearsal clone is neither exact before nor exact expected after state", true, manual.eventId, current.stateId);
  }

  async finalize(input: {
    readonly authority: LocalProductionAdapterRehearsalAuthority;
    readonly productionPreFingerprint: LocalProductionRouterFingerprint;
    readonly completedAt: string;
  }): Promise<LocalProductionAdapterRehearsalReceipt> {
    await assertSameCanonicalPreFingerprint(this.productionPreFingerprint, input.productionPreFingerprint);
    const context = await this.prepareContext(input.authority);
    let progression = await this.journal.verifyProgression(context);
    if (!progression.candidateReservation || !progression.candidateCommit || !progression.restoreReservation || !progression.restoreCommit || progression.candidateManual || progression.restoreManual) throw new Error("Rehearsal receipt requires canonical reservation -> commit -> restore reservation -> restore commit progression");
    const current = await this.rehearsalTarget.read();
    if (!sameState(current, progression.restoreCommit.payload.afterState)) throw new Error("Rehearsal clone does not match durable restored state");
    assertRestoredReference(current, input.authority);

    try {
      await assertProductionStable(this.productionTarget, input.authority, this.productionPreFingerprint, input.completedAt);
    } catch (error) {
      if (!(error instanceof ProductionDriftError)) throw error;
      const manual = await this.appendManualFromEvent(input.authority, context, progression.restoreCommit, current, input.completedAt, "production drift at finalization");
      progression = await this.journal.verifyProgression(context);
      throw new ManualReconciliationRequiredError(`${error.message}; journal=${manual.eventId}; progression=${progression.progressionSha256}`);
    }

    const post = await this.productionTarget.fingerprint(input.completedAt);
    assertProductionFingerprintsStable(this.productionPreFingerprint, post);
    const cRes = progression.candidateReservation;
    const cCom = progression.candidateCommit;
    const rRes = progression.restoreReservation;
    const rCom = progression.restoreCommit;
    const payload: LocalProductionAdapterRehearsalReceiptPayload = Object.freeze({
      operationId: `local-production-rehearsal:${input.authority.readinessAuthorization.authorizationId}`,
      readinessAuthorizationId: input.authority.readinessAuthorization.authorizationId,
      readinessAuthorizationSha256: input.authority.readinessAuthorization.authorizationSha256,
      readinessProposalId: input.authority.readinessProposal.proposalId,
      readinessProposalSha256: input.authority.readinessProposal.proposalSha256,
      targetSnapshotId: input.authority.currentTargetSnapshot.snapshotId,
      targetSnapshotSha256: input.authority.currentTargetSnapshot.snapshotSha256,
      sourceSnapshotId: input.authority.currentSourceSnapshot.snapshotId,
      sourceSnapshotSha256: input.authority.currentSourceSnapshot.snapshotSha256,
      adapterId: input.authority.currentSourceSnapshot.payload.adapterId,
      adapterVersion: input.authority.currentSourceSnapshot.payload.adapterVersion,
      adapterSourceSha256: input.authority.currentSourceSnapshot.payload.adapterSourceSha256,
      mainSourceSha256: input.authority.currentSourceSnapshot.payload.mainSourceSha256,
      productionTargetId: this.productionTarget.descriptor.targetId,
      productionPreFingerprintId: this.productionPreFingerprint.fingerprintId,
      productionPreFingerprintSha256: this.productionPreFingerprint.fingerprintSha256,
      productionPreRawFileSha256: this.productionPreFingerprint.payload.rawFileSha256,
      productionPostFingerprintId: post.fingerprintId,
      productionPostFingerprintSha256: post.fingerprintSha256,
      productionPostRawFileSha256: post.payload.rawFileSha256,
      rehearsalTargetId: this.rehearsalTarget.descriptor.targetId,
      candidateStateId: cCom.payload.afterStateId,
      candidateStateSha256: cCom.payload.afterStateSha256,
      restoredStateId: rCom.payload.afterStateId,
      restoredStateSha256: rCom.payload.afterStateSha256,
      candidateReservationEventId: cRes.eventId,
      candidateReservationEventSha256: cRes.eventSha256,
      candidateCommitEventId: cCom.eventId,
      candidateCommitEventSha256: cCom.eventSha256,
      restoreReservationEventId: rRes.eventId,
      restoreReservationEventSha256: rRes.eventSha256,
      restoreCommitEventId: rCom.eventId,
      restoreCommitEventSha256: rCom.eventSha256,
      journalProgressionSha256: progression.progressionSha256,
      candidateRecoveredAfterRestart: cCom.payload.recoveredAfterRestart,
      restoreRecoveredAfterRestart: rCom.payload.recoveredAfterRestart,
      completedAt: timestamp(input.completedAt, "rehearsal completedAt"),
      classification: "REHEARSAL_PASSED",
      productionRouteMutated: false,
      automaticRetryAllowed: false,
      automaticRollbackAllowed: false,
      automaticRedispatchAllowed: false,
      productionRoutingMutationAuthorized: false,
    });
    const receiptSha256 = await sha256Canonical(payload);
    const receipt: LocalProductionAdapterRehearsalReceipt = Object.freeze({
      schemaVersion: 1,
      algorithm: "sha256" as const,
      receiptId: `m5localprodrehearsal:${receiptSha256.slice(0, 32).toLowerCase()}`,
      receiptSha256,
      payload,
    });
    await verifyLocalProductionAdapterRehearsalReceipt(receipt, input.authority, this.productionPreFingerprint, this.productionTarget, this.rehearsalTarget, this.journal);
    return receipt;
  }

  private async prepareContext(authority: LocalProductionAdapterRehearsalAuthority): Promise<LocalProductionRehearsalJournalVerificationContext> {
    await verifyRehearsalAuthority(authority);
    await verifyLocalProductionRouterFingerprint(this.productionPreFingerprint);
    assertPreFingerprintMatchesAuthority(this.productionPreFingerprint, authority, this.productionTarget.descriptor.targetId);
    if (this.rehearsalTarget.descriptor.sourceProductionTargetId !== this.productionTarget.descriptor.targetId) throw new Error("Rehearsal target source identity does not match production target");
    return {
      authority,
      productionPreFingerprint: this.productionPreFingerprint,
      productionTargetId: this.productionTarget.descriptor.targetId,
      rehearsalTargetId: this.rehearsalTarget.descriptor.targetId,
    };
  }

  private async appendManualFromEvent(
    authority: LocalProductionAdapterRehearsalAuthority,
    context: LocalProductionRehearsalJournalVerificationContext,
    event: LocalProductionRehearsalJournalEvent,
    current: LocalProductionRehearsalState,
    observedAt: string,
    reason: string,
  ): Promise<LocalProductionRehearsalJournalEvent> {
    return this.journal.append({
      ...event.payload,
      eventType: "rehearsal_manual_reconciliation_required",
      observedAt: timestamp(observedAt, "manual reconciliation observedAt"),
      recoveredAfterRestart: false,
      reason: `${reason}; current=${current.stateId}`,
    }, context);
  }

  private async appendManualForCurrentOperation(
    input: { readonly authority: LocalProductionAdapterRehearsalAuthority; readonly phase: RehearsalPhase; readonly observedAt: string },
    context: LocalProductionRehearsalJournalVerificationContext,
    progression: VerifiedProgression,
    event: LocalProductionRehearsalJournalEvent | undefined,
    current: LocalProductionRehearsalState,
    reason: string,
  ): Promise<LocalProductionRehearsalJournalEvent | undefined> {
    if (event?.payload.eventType === "rehearsal_manual_reconciliation_required") return event;
    if (event) return this.appendManualFromEvent(input.authority, context, event, current, input.observedAt, reason);
    const operation = operationIdentity(input.authority.readinessAuthorization.authorizationId, input.phase);
    if (input.phase === "candidate") {
      try {
        assertCloneMatchesAuthority(current, input.authority);
      } catch {
        return undefined;
      }
      return this.journal.append(journalPayload("rehearsal_manual_reconciliation_required", "candidate", operation, input.authority, this.productionPreFingerprint, this.productionTarget.descriptor.targetId, this.rehearsalTarget.descriptor.targetId, current, current, input.observedAt, false, reason), context);
    }
    if (!progression.candidateCommit) return undefined;
    const expected = progression.candidateCommit.payload.afterState;
    return this.journal.append(journalPayload("rehearsal_manual_reconciliation_required", "restore", operation, input.authority, this.productionPreFingerprint, this.productionTarget.descriptor.targetId, this.rehearsalTarget.descriptor.targetId, expected, expected, input.observedAt, false, `${reason}; current=${current.stateId}`), context);
  }
}

export async function verifyLocalProductionAdapterRehearsalReceipt(
  receipt: LocalProductionAdapterRehearsalReceipt,
  authority: LocalProductionAdapterRehearsalAuthority,
  productionPreFingerprint: LocalProductionRouterFingerprint,
  productionTarget: JsonFileLocalProductionReadOnlyTarget,
  rehearsalTarget: JsonFileLocalProductionRehearsalTarget,
  journal: JsonlLocalProductionRehearsalJournal,
): Promise<void> {
  await verifyRehearsalAuthority(authority);
  await verifyLocalProductionRouterFingerprint(productionPreFingerprint);
  assertPreFingerprintMatchesAuthority(productionPreFingerprint, authority, productionTarget.descriptor.targetId);
  const context: LocalProductionRehearsalJournalVerificationContext = {
    authority,
    productionPreFingerprint,
    productionTargetId: productionTarget.descriptor.targetId,
    rehearsalTargetId: rehearsalTarget.descriptor.targetId,
  };
  const progression = await journal.verifyProgression(context);
  if (!progression.candidateReservation || !progression.candidateCommit || !progression.restoreReservation || !progression.restoreCommit || progression.candidateManual || progression.restoreManual) throw new Error("Rehearsal receipt requires a complete canonical durable journal state machine");

  assertExactFields(record(receipt, "Rehearsal receipt"), RECEIPT_FIELDS, "Rehearsal receipt");
  if (receipt.schemaVersion !== 1 || receipt.algorithm !== "sha256" || !isRecord(receipt.payload)) throw new Error("Rehearsal receipt envelope is invalid");
  assertExactFields(receipt.payload, RECEIPT_PAYLOAD_FIELDS, "Rehearsal receipt payload");
  const p = receipt.payload;
  const expectedOperationId = `local-production-rehearsal:${authority.readinessAuthorization.authorizationId}`;
  if (
    p.operationId !== expectedOperationId ||
    p.readinessAuthorizationId !== authority.readinessAuthorization.authorizationId ||
    p.readinessAuthorizationSha256 !== authority.readinessAuthorization.authorizationSha256 ||
    p.readinessProposalId !== authority.readinessProposal.proposalId ||
    p.readinessProposalSha256 !== authority.readinessProposal.proposalSha256 ||
    p.targetSnapshotId !== authority.currentTargetSnapshot.snapshotId ||
    p.targetSnapshotSha256 !== authority.currentTargetSnapshot.snapshotSha256 ||
    p.sourceSnapshotId !== authority.currentSourceSnapshot.snapshotId ||
    p.sourceSnapshotSha256 !== authority.currentSourceSnapshot.snapshotSha256 ||
    p.adapterId !== authority.currentSourceSnapshot.payload.adapterId ||
    p.adapterVersion !== authority.currentSourceSnapshot.payload.adapterVersion ||
    p.adapterSourceSha256 !== authority.currentSourceSnapshot.payload.adapterSourceSha256 ||
    p.mainSourceSha256 !== authority.currentSourceSnapshot.payload.mainSourceSha256
  ) throw new Error("Rehearsal receipt operation/authority/source binding drift detected");
  if (p.productionTargetId !== productionTarget.descriptor.targetId || p.rehearsalTargetId !== rehearsalTarget.descriptor.targetId) throw new Error("Rehearsal receipt target binding drift detected");
  if (p.productionRouteMutated !== false || p.automaticRetryAllowed !== false || p.automaticRollbackAllowed !== false || p.automaticRedispatchAllowed !== false || p.productionRoutingMutationAuthorized !== false || p.classification !== "REHEARSAL_PASSED") throw new Error("Rehearsal receipt safety authority is invalid");

  const cRes = progression.candidateReservation;
  const cCom = progression.candidateCommit;
  const rRes = progression.restoreReservation;
  const rCom = progression.restoreCommit;
  if (
    p.candidateReservationEventId !== cRes.eventId || p.candidateReservationEventSha256 !== cRes.eventSha256 ||
    p.candidateCommitEventId !== cCom.eventId || p.candidateCommitEventSha256 !== cCom.eventSha256 ||
    p.restoreReservationEventId !== rRes.eventId || p.restoreReservationEventSha256 !== rRes.eventSha256 ||
    p.restoreCommitEventId !== rCom.eventId || p.restoreCommitEventSha256 !== rCom.eventSha256 ||
    p.journalProgressionSha256 !== progression.progressionSha256 ||
    p.candidateStateId !== cCom.payload.afterStateId || p.candidateStateSha256 !== cCom.payload.afterStateSha256 ||
    p.restoredStateId !== rCom.payload.afterStateId || p.restoredStateSha256 !== rCom.payload.afterStateSha256 ||
    p.candidateRecoveredAfterRestart !== cCom.payload.recoveredAfterRestart || p.restoreRecoveredAfterRestart !== rCom.payload.recoveredAfterRestart
  ) throw new Error("Rehearsal receipt durable journal provenance drift detected");

  if (Date.parse(p.completedAt) < Date.parse(rCom.payload.observedAt)) throw new Error("Rehearsal receipt completion timestamp predates durable restore commit");
  const current = await rehearsalTarget.read();
  if (!sameState(current, rCom.payload.afterState)) throw new Error("Rehearsal receipt current clone state is not exact restored state");
  assertRestoredReference(current, authority);

  await assertProductionStable(productionTarget, authority, productionPreFingerprint, p.completedAt);
  const post = await productionTarget.fingerprint(p.completedAt);
  assertProductionFingerprintsStable(productionPreFingerprint, post);
  if (
    p.productionPreFingerprintId !== productionPreFingerprint.fingerprintId ||
    p.productionPreFingerprintSha256 !== productionPreFingerprint.fingerprintSha256 ||
    p.productionPreRawFileSha256 !== productionPreFingerprint.payload.rawFileSha256 ||
    p.productionPostFingerprintId !== post.fingerprintId ||
    p.productionPostFingerprintSha256 !== post.fingerprintSha256 ||
    p.productionPostRawFileSha256 !== post.payload.rawFileSha256
  ) throw new Error("Rehearsal receipt production fingerprint provenance drift detected");

  const expected = await sha256Canonical(p);
  if (receipt.receiptSha256 !== expected || receipt.receiptId !== `m5localprodrehearsal:${expected.slice(0, 32).toLowerCase()}`) throw new Error("Rehearsal receipt content address is invalid");
  await journal.assertFreshRead();
}

export async function verifyRehearsalAuthority(authority: LocalProductionAdapterRehearsalAuthority): Promise<void> {
  const a = record(authority, "Rehearsal authority");
  for (const field of ["readinessAuthorization", "readinessProposal", "readinessContext", "currentTargetSnapshot", "currentSourceSnapshot", "workflow"] as const) {
    if (!(field in a) || a[field] === undefined || a[field] === null) throw new Error(`Rehearsal authority.${field} is required`);
  }
  await verifyLocalProductionRoutingReadinessAuthorization(
    authority.readinessAuthorization,
    authority.readinessProposal,
    authority.readinessContext,
    authority.currentTargetSnapshot,
    authority.currentSourceSnapshot,
    authority.workflow,
  );
  const authorization = authority.readinessAuthorization.payload;
  const proposal = authority.readinessProposal.payload;
  if (authorization.decision !== "allow" || authorization.implementationReadinessAuthorized !== true || proposal.classification !== "READY_FOR_LOCAL_PRODUCTION_ADAPTER_IMPLEMENTATION") throw new Error("Rehearsal requires exact allowed implementation-readiness authorization");
  if (
    authorization.productionRoutingMutationAuthorized !== false || authorization.automaticRoutingMutationAllowed !== false ||
    authorization.automaticRetryAllowed !== false || authorization.automaticRollbackAllowed !== false || authorization.automaticRedispatchAllowed !== false ||
    proposal.productionRoutingMutationAuthorized !== false || proposal.automaticRoutingMutationAllowed !== false || proposal.automaticRetryAllowed !== false ||
    proposal.automaticRollbackAllowed !== false || proposal.automaticRedispatchAllowed !== false
  ) throw new Error("Readiness authority cannot authorize production or automatic mutation during rehearsal");
}

async function verifyCanonicalJournalProgression(
  entries: readonly PersistedRehearsalEntry[],
  context: LocalProductionRehearsalJournalVerificationContext,
): Promise<VerifiedProgression> {
  await verifyRehearsalAuthority(context.authority);
  await verifyLocalProductionRouterFingerprint(context.productionPreFingerprint);
  assertPreFingerprintMatchesAuthority(context.productionPreFingerprint, context.authority, context.productionTargetId);
  await verifyEntrySequence(entries);

  let candidateStage: "none" | "reserved" | "committed" | "manual" = "none";
  let restoreStage: "none" | "reserved" | "committed" | "manual" = "none";
  let terminalManual = false;
  let candidateReservation: LocalProductionRehearsalJournalEvent | undefined;
  let candidateCommit: LocalProductionRehearsalJournalEvent | undefined;
  let candidateManual: LocalProductionRehearsalJournalEvent | undefined;
  let restoreReservation: LocalProductionRehearsalJournalEvent | undefined;
  let restoreCommit: LocalProductionRehearsalJournalEvent | undefined;
  let restoreManual: LocalProductionRehearsalJournalEvent | undefined;
  const canonicalEvents: Array<{ eventId: string; eventSha256: string; sequence: number }> = [];

  for (const entry of entries) {
    const event = entry.event;
    const p = event.payload;
    if (terminalManual) throw new Error("Rehearsal journal cannot progress after manual reconciliation terminal state");
    assertJournalAuthority(event, context);
    assertEventPreFingerprint(event, context.productionPreFingerprint);
    canonicalEvents.push({ eventId: event.eventId, eventSha256: event.eventSha256, sequence: entry.sequence });

    if (p.phase === "candidate") {
      if (restoreStage !== "none") throw new Error("Candidate event cannot appear after restore progression starts");
      if (p.eventType === "rehearsal_reserved") {
        if (candidateStage !== "none") throw new Error("Duplicate or invalid candidate reservation progression");
        candidateStage = "reserved";
        candidateReservation = event;
      } else if (p.eventType === "rehearsal_committed") {
        if (candidateStage !== "reserved" || !candidateReservation) throw new Error("Orphan or duplicate candidate commit progression");
        candidateStage = "committed";
        candidateCommit = event;
      } else {
        if (candidateStage === "manual") throw new Error("Duplicate candidate manual terminal progression");
        candidateStage = "manual";
        candidateManual = event;
        terminalManual = true;
      }
    } else {
      if (candidateStage !== "committed" || !candidateCommit) throw new Error("Restore progression requires exact valid candidate commit first");
      if (p.eventType === "rehearsal_reserved") {
        if (restoreStage !== "none") throw new Error("Duplicate or invalid restore reservation progression");
        restoreStage = "reserved";
        restoreReservation = event;
      } else if (p.eventType === "rehearsal_committed") {
        if (restoreStage !== "reserved" || !restoreReservation) throw new Error("Orphan or duplicate restore commit progression");
        restoreStage = "committed";
        restoreCommit = event;
      } else {
        if (restoreStage === "manual") throw new Error("Duplicate restore manual terminal progression");
        restoreStage = "manual";
        restoreManual = event;
        terminalManual = true;
      }
    }
  }

  if (candidateReservation) await assertCandidateReservationSemantics(candidateReservation, context);
  if (candidateCommit && candidateReservation) assertCommitMatchesReservation(candidateCommit, candidateReservation, "candidate");
  if (candidateManual) assertManualTerminalSemantics(candidateManual, candidateReservation, candidateCommit, "candidate", context);
  if (restoreReservation && candidateCommit) await assertRestoreReservationSemantics(restoreReservation, candidateCommit, context);
  if (restoreCommit && restoreReservation) assertCommitMatchesReservation(restoreCommit, restoreReservation, "restore");
  if (restoreManual) assertManualTerminalSemantics(restoreManual, restoreReservation, restoreCommit, "restore", context, candidateCommit);

  if (candidateCommit && candidateReservation && Date.parse(candidateCommit.payload.observedAt) < Date.parse(candidateReservation.payload.afterState.payload.updatedAt)) throw new Error("Candidate commit timestamp predates candidate applied state");
  if (restoreReservation && candidateCommit && Date.parse(restoreReservation.payload.observedAt) < Date.parse(candidateCommit.payload.observedAt)) throw new Error("Restore reservation timestamp predates candidate commit");
  if (restoreCommit && restoreReservation && Date.parse(restoreCommit.payload.observedAt) < Date.parse(restoreReservation.payload.afterState.payload.updatedAt)) throw new Error("Restore commit timestamp predates restored state");

  return Object.freeze({
    ...(candidateReservation ? { candidateReservation } : {}),
    ...(candidateCommit ? { candidateCommit } : {}),
    ...(candidateManual ? { candidateManual } : {}),
    ...(restoreReservation ? { restoreReservation } : {}),
    ...(restoreCommit ? { restoreCommit } : {}),
    ...(restoreManual ? { restoreManual } : {}),
    progressionSha256: await sha256Canonical(canonicalEvents),
  });
}

async function assertCandidateReservationSemantics(
  reservation: LocalProductionRehearsalJournalEvent,
  context: LocalProductionRehearsalJournalVerificationContext,
): Promise<void> {
  const p = reservation.payload;
  const before = p.beforeState;
  const after = p.afterState;
  const snapshot = context.authority.currentTargetSnapshot.payload;
  if (p.recoveredAfterRestart !== false) throw new Error("Candidate reservation cannot claim recoveredAfterRestart");
  if (before.payload.targetId !== context.rehearsalTargetId || before.payload.sourceProductionTargetId !== context.productionTargetId || before.payload.projectId !== snapshot.projectId || before.payload.routeId !== snapshot.routeId || before.payload.capability !== snapshot.capability || before.payload.currentSubjectId !== snapshot.currentSubjectId || before.payload.routeRevision !== snapshot.routeRevision || before.payload.mutationCount !== 0) throw new Error("Candidate reservation before-state is not exact authorized reference clone state");
  if (Date.parse(before.payload.updatedAt) > Date.parse(p.observedAt)) throw new Error("Candidate reservation predates exact before-state");
  if (Date.parse(after.payload.updatedAt) < Date.parse(p.observedAt)) throw new Error("Candidate applied-state timestamp predates reservation");
  const candidateSubjectId = context.authority.readinessProposal.payload.candidateSubjectId;
  const expectedRevision = await candidateRevision(context.authority.readinessAuthorization.authorizationId, before.stateId, candidateSubjectId);
  const expected = await prepareRehearsalState({
    ...stateInputFrom(before),
    currentSubjectId: candidateSubjectId,
    routeRevision: expectedRevision,
    mutationCount: before.payload.mutationCount + 1,
    updatedAt: after.payload.updatedAt,
  });
  if (!sameState(after, expected) || after.payload.currentSubjectId !== candidateSubjectId || after.payload.routeRevision !== expectedRevision) throw new Error("Candidate state is not deterministically derived from exact authority and before-state");
}

async function assertRestoreReservationSemantics(
  reservation: LocalProductionRehearsalJournalEvent,
  candidateCommit: LocalProductionRehearsalJournalEvent,
  context: LocalProductionRehearsalJournalVerificationContext,
): Promise<void> {
  const p = reservation.payload;
  if (p.recoveredAfterRestart !== false) throw new Error("Restore reservation cannot claim recoveredAfterRestart");
  if (!sameState(p.beforeState, candidateCommit.payload.afterState)) throw new Error("Restore before-state does not continue exact candidate commit after-state");
  if (Date.parse(p.observedAt) < Date.parse(candidateCommit.payload.observedAt)) throw new Error("Restore reservation predates candidate commit");
  if (Date.parse(p.afterState.payload.updatedAt) < Date.parse(p.observedAt)) throw new Error("Restored-state timestamp predates restore reservation");
  const reference = context.authority.currentTargetSnapshot.payload;
  const expected = await prepareRehearsalState({
    ...stateInputFrom(p.beforeState),
    currentSubjectId: reference.currentSubjectId,
    routeRevision: reference.routeRevision,
    mutationCount: p.beforeState.payload.mutationCount + 1,
    updatedAt: p.afterState.payload.updatedAt,
  });
  if (!sameState(p.afterState, expected) || p.afterState.payload.currentSubjectId !== reference.currentSubjectId || p.afterState.payload.routeRevision !== reference.routeRevision) throw new Error("Restore after-state is not exact authorized reference state");
}

function assertCommitMatchesReservation(
  commit: LocalProductionRehearsalJournalEvent,
  reservation: LocalProductionRehearsalJournalEvent,
  phase: RehearsalPhase,
): void {
  if (!sameState(commit.payload.beforeState, reservation.payload.beforeState) || !sameState(commit.payload.afterState, reservation.payload.afterState)) throw new Error(`${phase} commit before/after state does not match exact reservation`);
  if (commit.payload.operationId !== reservation.payload.operationId || commit.payload.idempotencyKey !== reservation.payload.idempotencyKey) throw new Error(`${phase} commit operation identity drift detected`);
  if (Date.parse(commit.payload.observedAt) < Date.parse(reservation.payload.observedAt)) throw new Error(`${phase} commit timestamp predates reservation`);
}

function assertManualTerminalSemantics(
  manual: LocalProductionRehearsalJournalEvent,
  reservation: LocalProductionRehearsalJournalEvent | undefined,
  commit: LocalProductionRehearsalJournalEvent | undefined,
  phase: RehearsalPhase,
  context: LocalProductionRehearsalJournalVerificationContext,
  candidateCommit?: LocalProductionRehearsalJournalEvent,
): void {
  if (manual.payload.recoveredAfterRestart !== false) throw new Error(`${phase} manual reconciliation cannot claim recovered commit`);
  const prior = commit ?? reservation;
  if (prior) {
    if (!sameState(manual.payload.beforeState, prior.payload.beforeState) || !sameState(manual.payload.afterState, prior.payload.afterState)) throw new Error(`${phase} manual terminal event must preserve exact operation reservation/commit state pair`);
    if (Date.parse(manual.payload.observedAt) < Date.parse(prior.payload.observedAt)) throw new Error(`${phase} manual reconciliation timestamp predates prior durable event`);
    return;
  }
  if (phase === "candidate") {
    const s = context.authority.currentTargetSnapshot.payload;
    const state = manual.payload.beforeState;
    if (!sameState(manual.payload.beforeState, manual.payload.afterState) || state.payload.targetId !== context.rehearsalTargetId || state.payload.sourceProductionTargetId !== context.productionTargetId || state.payload.projectId !== s.projectId || state.payload.routeId !== s.routeId || state.payload.capability !== s.capability || state.payload.currentSubjectId !== s.currentSubjectId || state.payload.routeRevision !== s.routeRevision || state.payload.mutationCount !== 0) throw new Error("Pre-reservation candidate manual event must bind exact authorized reference clone state");
  } else {
    if (!candidateCommit || !sameState(manual.payload.beforeState, candidateCommit.payload.afterState) || !sameState(manual.payload.afterState, candidateCommit.payload.afterState)) throw new Error("Pre-reservation restore manual event must bind exact committed candidate state");
    if (Date.parse(manual.payload.observedAt) < Date.parse(candidateCommit.payload.observedAt)) throw new Error("Pre-reservation restore manual timestamp predates candidate commit");
  }
}

async function verifyEntrySequence(entries: readonly PersistedRehearsalEntry[]): Promise<void> {
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry || entry.schemaVersion !== 1 || entry.sequence !== index + 1) throw new Error("Rehearsal journal sequence/envelope is invalid");
    await verifyJournalEvent(entry.event);
  }
}

function assertJournalAuthority(event: LocalProductionRehearsalJournalEvent, context: LocalProductionRehearsalJournalVerificationContext): void {
  const p = event.payload;
  const authority = context.authority;
  if (
    p.readinessAuthorizationId !== authority.readinessAuthorization.authorizationId ||
    p.readinessAuthorizationSha256 !== authority.readinessAuthorization.authorizationSha256 ||
    p.readinessProposalId !== authority.readinessProposal.proposalId ||
    p.readinessProposalSha256 !== authority.readinessProposal.proposalSha256 ||
    p.targetSnapshotId !== authority.currentTargetSnapshot.snapshotId ||
    p.targetSnapshotSha256 !== authority.currentTargetSnapshot.snapshotSha256 ||
    p.sourceSnapshotId !== authority.currentSourceSnapshot.snapshotId ||
    p.sourceSnapshotSha256 !== authority.currentSourceSnapshot.snapshotSha256 ||
    p.adapterId !== authority.currentSourceSnapshot.payload.adapterId ||
    p.adapterVersion !== authority.currentSourceSnapshot.payload.adapterVersion ||
    p.adapterSourceSha256 !== authority.currentSourceSnapshot.payload.adapterSourceSha256 ||
    p.mainSourceSha256 !== authority.currentSourceSnapshot.payload.mainSourceSha256 ||
    p.productionTargetId !== context.productionTargetId || p.rehearsalTargetId !== context.rehearsalTargetId ||
    p.projectId !== authority.currentTargetSnapshot.payload.projectId || p.routeId !== authority.currentTargetSnapshot.payload.routeId ||
    p.capability !== authority.currentTargetSnapshot.payload.capability
  ) throw new Error("Rehearsal journal event authority/source/target binding drift detected");
}

function assertEventPreFingerprint(event: LocalProductionRehearsalJournalEvent, pre: LocalProductionRouterFingerprint): void {
  const p = event.payload;
  if (
    p.productionPreFingerprintId !== pre.fingerprintId ||
    p.productionPreFingerprintSha256 !== pre.fingerprintSha256 ||
    p.productionPreRawFileSha256 !== pre.payload.rawFileSha256 ||
    p.productionPreStateId !== pre.payload.stateId ||
    p.productionPreStateSha256 !== pre.payload.stateSha256
  ) throw new Error("Rehearsal journal production pre-fingerprint provenance drift detected");
}

async function assertProductionStable(
  target: JsonFileLocalProductionReadOnlyTarget,
  authority: LocalProductionAdapterRehearsalAuthority,
  pre: LocalProductionRouterFingerprint,
  observedAt: string,
): Promise<void> {
  await verifyLocalProductionRouterFingerprint(pre);
  assertPreFingerprintMatchesAuthority(pre, authority, target.descriptor.targetId);
  const state = await target.read();
  const snapshot = authority.currentTargetSnapshot.payload;
  if (
    state.payload.targetId !== target.descriptor.targetId || state.payload.installationId !== snapshot.installationId ||
    state.payload.projectId !== snapshot.projectId || state.payload.routeId !== snapshot.routeId || state.payload.capability !== snapshot.capability ||
    state.payload.currentSubjectId !== snapshot.currentSubjectId || state.payload.routeRevision !== snapshot.routeRevision
  ) throw new ProductionDriftError("Production semantic state drift detected during rehearsal");
  const current = await target.fingerprint(observedAt);
  try {
    assertProductionFingerprintsStable(pre, current);
  } catch {
    throw new ProductionDriftError("Production target fingerprint drift detected during rehearsal");
  }
}

function assertPreFingerprintMatchesAuthority(
  pre: LocalProductionRouterFingerprint,
  authority: LocalProductionAdapterRehearsalAuthority,
  productionTargetId: string,
): void {
  const s = authority.currentTargetSnapshot.payload;
  const p = pre.payload;
  if (
    p.targetId !== productionTargetId || p.installationId !== s.installationId || p.projectId !== s.projectId || p.routeId !== s.routeId ||
    p.capability !== s.capability || p.currentSubjectId !== s.currentSubjectId || p.routeRevision !== s.routeRevision || p.productionRouter !== true
  ) throw new Error("Canonical production pre-fingerprint does not match exact readiness target authority");
}

async function assertSameCanonicalPreFingerprint(left: LocalProductionRouterFingerprint, right: LocalProductionRouterFingerprint): Promise<void> {
  await verifyLocalProductionRouterFingerprint(left);
  await verifyLocalProductionRouterFingerprint(right);
  if (left.fingerprintId !== right.fingerprintId || left.fingerprintSha256 !== right.fingerprintSha256 || left.payload.rawFileSha256 !== right.payload.rawFileSha256 || left.payload.stateId !== right.payload.stateId || left.payload.stateSha256 !== right.payload.stateSha256) throw new Error("Finalization production pre-fingerprint is not the canonical immutable pre-fingerprint");
}

function assertProductionFingerprintsStable(before: LocalProductionRouterFingerprint, after: LocalProductionRouterFingerprint): void {
  const b = before.payload;
  const a = after.payload;
  if (
    b.targetId !== a.targetId || b.installationId !== a.installationId || b.stateId !== a.stateId || b.stateSha256 !== a.stateSha256 ||
    b.rawFileSha256 !== a.rawFileSha256 || b.projectId !== a.projectId || b.routeId !== a.routeId || b.capability !== a.capability ||
    b.currentSubjectId !== a.currentSubjectId || b.routeRevision !== a.routeRevision
  ) throw new Error("Production target fingerprint drift detected during rehearsal");
}

function assertCloneMatchesAuthority(state: LocalProductionRehearsalState, authority: LocalProductionAdapterRehearsalAuthority): void {
  const snapshot = authority.currentTargetSnapshot.payload;
  if (
    state.payload.projectId !== snapshot.projectId || state.payload.routeId !== snapshot.routeId || state.payload.capability !== snapshot.capability ||
    state.payload.currentSubjectId !== snapshot.currentSubjectId || state.payload.routeRevision !== snapshot.routeRevision ||
    state.payload.productionRouter !== false || state.payload.rehearsalOnly !== true || state.payload.mutationCount !== 0
  ) throw new Error("Rehearsal clone does not start from exact authorized reference state");
}

function assertRestoredReference(state: LocalProductionRehearsalState, authority: LocalProductionAdapterRehearsalAuthority): void {
  const snapshot = authority.currentTargetSnapshot.payload;
  if (state.payload.currentSubjectId !== snapshot.currentSubjectId || state.payload.routeRevision !== snapshot.routeRevision || state.payload.productionRouter !== false || state.payload.rehearsalOnly !== true) throw new Error("Restored rehearsal clone is not exact authorized reference state");
}

async function expectedCandidateState(before: LocalProductionRehearsalState, authority: LocalProductionAdapterRehearsalAuthority, updatedAt: string): Promise<LocalProductionRehearsalState> {
  const revision = await candidateRevision(authority.readinessAuthorization.authorizationId, before.stateId, authority.readinessProposal.payload.candidateSubjectId);
  return prepareRehearsalState({
    ...stateInputFrom(before),
    currentSubjectId: authority.readinessProposal.payload.candidateSubjectId,
    routeRevision: revision,
    mutationCount: before.payload.mutationCount + 1,
    updatedAt,
  });
}

async function candidateRevision(authorizationId: string, beforeStateId: string, candidateSubjectId: string): Promise<string> {
  const seed = await sha256Canonical({ authorizationId, beforeStateId, candidateSubjectId });
  return `rehearsal-candidate:${seed.slice(0, 32).toLowerCase()}`;
}

async function expectedRestoreState(before: LocalProductionRehearsalState, authority: LocalProductionAdapterRehearsalAuthority, updatedAt: string): Promise<LocalProductionRehearsalState> {
  return prepareRehearsalState({
    ...stateInputFrom(before),
    currentSubjectId: authority.currentTargetSnapshot.payload.currentSubjectId,
    routeRevision: authority.currentTargetSnapshot.payload.routeRevision,
    mutationCount: before.payload.mutationCount + 1,
    updatedAt,
  });
}

function stateInputFrom(state: LocalProductionRehearsalState): {
  targetId: string;
  sourceProductionTargetId: string;
  projectId: string;
  routeId: string;
  capability: string;
  currentSubjectId: string;
  routeRevision: string;
  mutationCount: number;
  updatedAt: string;
} {
  return {
    targetId: state.payload.targetId,
    sourceProductionTargetId: state.payload.sourceProductionTargetId,
    projectId: state.payload.projectId,
    routeId: state.payload.routeId,
    capability: state.payload.capability,
    currentSubjectId: state.payload.currentSubjectId,
    routeRevision: state.payload.routeRevision,
    mutationCount: state.payload.mutationCount,
    updatedAt: state.payload.updatedAt,
  };
}

async function prepareRehearsalState(input: {
  targetId: string;
  sourceProductionTargetId: string;
  projectId: string;
  routeId: string;
  capability: string;
  currentSubjectId: string;
  routeRevision: string;
  mutationCount: number;
  updatedAt: string;
}): Promise<LocalProductionRehearsalState> {
  if (!Number.isSafeInteger(input.mutationCount) || input.mutationCount < 0) throw new Error("Rehearsal mutationCount is invalid");
  const payload: LocalProductionRehearsalStatePayload = Object.freeze({
    targetKind: "local_production_rehearsal_clone",
    rehearsalOnly: true,
    productionRouter: false,
    targetId: identity(input.targetId, "rehearsal targetId"),
    sourceProductionTargetId: identity(input.sourceProductionTargetId, "source production targetId"),
    projectId: identity(input.projectId, "rehearsal projectId"),
    routeId: identity(input.routeId, "rehearsal routeId"),
    capability: identity(input.capability, "rehearsal capability"),
    currentSubjectId: identity(input.currentSubjectId, "rehearsal currentSubjectId"),
    routeRevision: identity(input.routeRevision, "rehearsal routeRevision"),
    mutationCount: input.mutationCount,
    updatedAt: timestamp(input.updatedAt, "rehearsal updatedAt"),
    providerSpecificStatePersisted: false,
    rawProviderOutputPersisted: false,
    secretMaterialPersisted: false,
  });
  const stateSha256 = await sha256Canonical(payload);
  return Object.freeze({
    schemaVersion: 1,
    algorithm: "sha256" as const,
    stateId: `m5localprodrehearsalstate:${stateSha256.slice(0, 32).toLowerCase()}`,
    stateSha256,
    payload,
  });
}

async function verifyRehearsalState(state: LocalProductionRehearsalState): Promise<void> {
  assertExactFields(record(state, "Rehearsal state"), REHEARSAL_STATE_FIELDS, "Rehearsal state");
  if (state.schemaVersion !== 1 || state.algorithm !== "sha256" || !isRecord(state.payload)) throw new Error("Rehearsal state envelope is invalid");
  assertExactFields(state.payload, REHEARSAL_PAYLOAD_FIELDS, "Rehearsal state payload");
  const p = state.payload;
  if (p.targetKind !== "local_production_rehearsal_clone" || p.rehearsalOnly !== true || p.productionRouter !== false || p.providerSpecificStatePersisted !== false || p.rawProviderOutputPersisted !== false || p.secretMaterialPersisted !== false || !Number.isSafeInteger(p.mutationCount) || p.mutationCount < 0) throw new Error("Rehearsal state safety boundary is invalid");
  for (const [value, label] of [[p.targetId, "targetId"], [p.sourceProductionTargetId, "sourceProductionTargetId"], [p.projectId, "projectId"], [p.routeId, "routeId"], [p.capability, "capability"], [p.currentSubjectId, "currentSubjectId"], [p.routeRevision, "routeRevision"]] as const) identity(value, `rehearsal ${label}`);
  timestamp(p.updatedAt, "rehearsal updatedAt");
  const expected = await sha256Canonical(p);
  if (state.stateSha256 !== expected || state.stateId !== `m5localprodrehearsalstate:${expected.slice(0, 32).toLowerCase()}`) throw new Error("Rehearsal state content address is invalid");
}

function journalPayload(
  eventType: RehearsalEventType,
  phase: RehearsalPhase,
  operation: { operationId: string; idempotencyKey: string },
  authority: LocalProductionAdapterRehearsalAuthority,
  productionPreFingerprint: LocalProductionRouterFingerprint,
  productionTargetId: string,
  rehearsalTargetId: string,
  before: LocalProductionRehearsalState,
  after: LocalProductionRehearsalState,
  observedAt: string,
  recoveredAfterRestart: boolean,
  reason: string,
): LocalProductionRehearsalJournalPayload {
  return Object.freeze({
    eventType,
    phase,
    operationId: operation.operationId,
    idempotencyKey: operation.idempotencyKey,
    readinessAuthorizationId: authority.readinessAuthorization.authorizationId,
    readinessAuthorizationSha256: authority.readinessAuthorization.authorizationSha256,
    readinessProposalId: authority.readinessProposal.proposalId,
    readinessProposalSha256: authority.readinessProposal.proposalSha256,
    targetSnapshotId: authority.currentTargetSnapshot.snapshotId,
    targetSnapshotSha256: authority.currentTargetSnapshot.snapshotSha256,
    sourceSnapshotId: authority.currentSourceSnapshot.snapshotId,
    sourceSnapshotSha256: authority.currentSourceSnapshot.snapshotSha256,
    adapterId: authority.currentSourceSnapshot.payload.adapterId,
    adapterVersion: authority.currentSourceSnapshot.payload.adapterVersion,
    adapterSourceSha256: authority.currentSourceSnapshot.payload.adapterSourceSha256,
    mainSourceSha256: authority.currentSourceSnapshot.payload.mainSourceSha256,
    productionTargetId,
    rehearsalTargetId,
    projectId: authority.currentTargetSnapshot.payload.projectId,
    routeId: authority.currentTargetSnapshot.payload.routeId,
    capability: authority.currentTargetSnapshot.payload.capability,
    productionPreFingerprintId: productionPreFingerprint.fingerprintId,
    productionPreFingerprintSha256: productionPreFingerprint.fingerprintSha256,
    productionPreRawFileSha256: productionPreFingerprint.payload.rawFileSha256,
    productionPreStateId: productionPreFingerprint.payload.stateId,
    productionPreStateSha256: productionPreFingerprint.payload.stateSha256,
    beforeStateId: before.stateId,
    beforeStateSha256: before.stateSha256,
    afterStateId: after.stateId,
    afterStateSha256: after.stateSha256,
    beforeSubjectId: before.payload.currentSubjectId,
    afterSubjectId: after.payload.currentSubjectId,
    beforeRouteRevision: before.payload.routeRevision,
    afterRouteRevision: after.payload.routeRevision,
    beforeState: Object.freeze({ ...before, payload: Object.freeze({ ...before.payload }) }),
    afterState: Object.freeze({ ...after, payload: Object.freeze({ ...after.payload }) }),
    observedAt: timestamp(observedAt, "journal observedAt"),
    recoveredAfterRestart,
    reason: text(reason, "journal reason"),
    productionRouteMutated: false,
    automaticRetryAllowed: false,
    automaticRollbackAllowed: false,
    automaticRedispatchAllowed: false,
    productionRoutingMutationAuthorized: false,
  });
}

function validateEventPayload(payload: LocalProductionRehearsalJournalPayload): void {
  assertExactFields(record(payload, "Rehearsal journal payload"), EVENT_PAYLOAD_FIELDS, "Rehearsal journal payload");
  if (!["rehearsal_reserved", "rehearsal_committed", "rehearsal_manual_reconciliation_required"].includes(payload.eventType) || !["candidate", "restore"].includes(payload.phase)) throw new Error("Rehearsal journal event type/phase is invalid");
  const operation = operationIdentity(payload.readinessAuthorizationId, payload.phase);
  if (payload.operationId !== operation.operationId || payload.idempotencyKey !== operation.idempotencyKey) throw new Error("Rehearsal journal operation/idempotency identity is not canonical");
  if (payload.productionRouteMutated !== false || payload.automaticRetryAllowed !== false || payload.automaticRollbackAllowed !== false || payload.automaticRedispatchAllowed !== false || payload.productionRoutingMutationAuthorized !== false) throw new Error("Rehearsal journal safety authority is invalid");
  if (typeof payload.recoveredAfterRestart !== "boolean") throw new Error("Rehearsal journal recoveredAfterRestart is invalid");
  sha256Value(payload.productionPreRawFileSha256, "rehearsal journal productionPreRawFileSha256");
  sha256Value(payload.productionPreStateSha256, "rehearsal journal productionPreStateSha256");
  timestamp(payload.observedAt, "rehearsal journal observedAt");
  text(payload.reason, "rehearsal journal reason");
  if (!sameStateIdentity(payload.beforeState, payload.beforeStateId, payload.beforeStateSha256, payload.beforeSubjectId, payload.beforeRouteRevision)) throw new Error("Rehearsal journal before-state duplicate provenance drift detected");
  if (!sameStateIdentity(payload.afterState, payload.afterStateId, payload.afterStateSha256, payload.afterSubjectId, payload.afterRouteRevision)) throw new Error("Rehearsal journal after-state duplicate provenance drift detected");
}

async function verifyJournalEvent(event: LocalProductionRehearsalJournalEvent): Promise<void> {
  assertExactFields(record(event, "Rehearsal journal event"), EVENT_FIELDS, "Rehearsal journal event");
  if (event.algorithm !== "sha256" || !isRecord(event.payload)) throw new Error("Rehearsal journal event envelope is invalid");
  validateEventPayload(event.payload);
  await verifyRehearsalState(event.payload.beforeState);
  await verifyRehearsalState(event.payload.afterState);
  const expected = await sha256Canonical(event.payload);
  if (event.eventSha256 !== expected || event.eventId !== `m5localprodrehearsalevent:${expected.slice(0, 32).toLowerCase()}`) throw new Error("Rehearsal journal event content address is invalid");
}

function sameStateIdentity(state: LocalProductionRehearsalState, stateId: string, stateSha256: string, subjectId: string, routeRevision: string): boolean {
  return state.stateId === stateId && state.stateSha256 === stateSha256 && state.payload.currentSubjectId === subjectId && state.payload.routeRevision === routeRevision;
}

function operationIdentity(authorizationId: string, phase: RehearsalPhase): { operationId: string; idempotencyKey: string } {
  const value = `local-production-rehearsal:${identity(authorizationId, "readiness authorizationId")}:${phase}`;
  return { operationId: value, idempotencyKey: value };
}

function recoveryReport(
  phase: RehearsalPhase,
  operationId: string,
  classification: LocalProductionAdapterRehearsalRecoveryClassification,
  observedAt: string,
  reason: string,
  explicitOperatorActionRequired: boolean,
  journalEventId?: string,
  rehearsalStateId?: string,
): LocalProductionAdapterRehearsalRecoveryReport {
  const base = {
    phase,
    operationId,
    classification,
    observedAt: timestamp(observedAt, "recovery observedAt"),
    reason,
    explicitOperatorActionRequired,
    productionRouteMutated: false as const,
    automaticRetryAllowed: false as const,
    automaticRollbackAllowed: false as const,
    automaticRedispatchAllowed: false as const,
    productionRoutingMutationAuthorized: false as const,
  };
  return Object.freeze({ ...base, ...(journalEventId ? { journalEventId } : {}), ...(rehearsalStateId ? { rehearsalStateId } : {}) });
}

function sameState(left: LocalProductionRehearsalState, right: LocalProductionRehearsalState): boolean {
  return left.stateId === right.stateId && left.stateSha256 === right.stateSha256;
}

function writeUtf8File(path: string, content: string): void {
  mkdirSync(resolve(path, ".."), { recursive: true });
  const fd = openSync(path, "w");
  try { writeFileSync(fd, content, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function identity(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096 || /[\u0000-\u001F\u007F]/u.test(value)) throw new Error(`${label} is invalid`);
  if (/\b(password|passwd|secret|token|api[-_]?key|authorization|bearer)\b\s*[:=]/iu.test(value)) throw new Error(`${label} appears to contain secret material`);
  return value;
}

function sha256Value(value: string, label: string): string {
  if (typeof value !== "string" || !/^[0-9A-F]{64}$/u.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function text(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096 || /[\u0000\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function timestamp(value: string, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`${label} is invalid`);
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactFields(value: Record<string, unknown>, fields: Set<string>, label: string): void {
  const keys = Object.keys(value);
  if (keys.length !== fields.size || keys.some((key) => !fields.has(key))) throw new Error(`${label} contains unknown, missing, or provider-specific fields`);
}

async function sha256Canonical(value: unknown): Promise<string> {
  return sha256Text(JSON.stringify(sortJson(value)));
}

async function sha256Text(value: string): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("Web Crypto SHA-256 is unavailable in this runtime");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortJson(child)]),
  );
}
