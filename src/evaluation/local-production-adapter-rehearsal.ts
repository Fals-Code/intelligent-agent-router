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
type RehearsalEventType = "rehearsal_reserved" | "rehearsal_committed" | "rehearsal_manual_reconciliation_required";

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
  readonly beforeStateId: string;
  readonly beforeStateSha256: string;
  readonly afterStateId: string;
  readonly afterStateSha256: string;
  readonly beforeSubjectId: string;
  readonly afterSubjectId: string;
  readonly beforeRouteRevision: string;
  readonly afterRouteRevision: string;
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

export interface LocalProductionAdapterRehearsalRecoveryReport {
  readonly phase: RehearsalPhase;
  readonly operationId: string;
  readonly classification: LocalProductionAdapterRehearsalRecoveryClassification;
  readonly journalEventId?: string;
  readonly rehearsalStateId?: string;
  readonly observedAt: string;
  readonly reason: string;
  readonly explicitOperatorActionRequired: boolean;
  readonly automaticRetryAllowed: false;
  readonly automaticRollbackAllowed: false;
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
  readonly productionPostFingerprintId: string;
  readonly productionPostFingerprintSha256: string;
  readonly rehearsalTargetId: string;
  readonly candidateStateId: string;
  readonly candidateStateSha256: string;
  readonly restoredStateId: string;
  readonly restoredStateSha256: string;
  readonly candidateCommitEventId: string;
  readonly candidateCommitEventSha256: string;
  readonly restoreCommitEventId: string;
  readonly restoreCommitEventSha256: string;
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

const PRODUCTION_STATE_FIELDS = new Set(["schemaVersion", "algorithm", "stateId", "stateSha256", "payload"]);
const PRODUCTION_PAYLOAD_FIELDS = new Set([
  "targetId", "installationId", "projectId", "routeId", "capability", "currentSubjectId", "routeRevision", "updatedAt",
  "targetKind", "productionRouter", "providerSpecificStatePersisted", "rawProviderOutputPersisted", "secretMaterialPersisted",
]);
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
  "capability", "beforeStateId", "beforeStateSha256", "afterStateId", "afterStateSha256", "beforeSubjectId", "afterSubjectId",
  "beforeRouteRevision", "afterRouteRevision", "observedAt", "recoveredAfterRestart", "reason", "productionRouteMutated",
  "automaticRetryAllowed", "automaticRollbackAllowed", "automaticRedispatchAllowed", "productionRoutingMutationAuthorized",
]);
const RECEIPT_FIELDS = new Set(["schemaVersion", "algorithm", "receiptId", "receiptSha256", "payload"]);
const RECEIPT_PAYLOAD_FIELDS = new Set([
  "operationId", "readinessAuthorizationId", "readinessAuthorizationSha256", "readinessProposalId", "readinessProposalSha256",
  "targetSnapshotId", "targetSnapshotSha256", "sourceSnapshotId", "sourceSnapshotSha256", "adapterId", "adapterVersion", "adapterSourceSha256",
  "mainSourceSha256", "productionTargetId", "productionPreFingerprintId", "productionPreFingerprintSha256", "productionPostFingerprintId",
  "productionPostFingerprintSha256", "rehearsalTargetId", "candidateStateId", "candidateStateSha256", "restoredStateId", "restoredStateSha256",
  "candidateCommitEventId", "candidateCommitEventSha256", "restoreCommitEventId", "restoreCommitEventSha256", "candidateRecoveredAfterRestart",
  "restoreRecoveredAfterRestart", "completedAt", "classification", "productionRouteMutated", "automaticRetryAllowed", "automaticRollbackAllowed",
  "automaticRedispatchAllowed", "productionRoutingMutationAuthorized",
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
  return Object.freeze({ schemaVersion: 1, algorithm: "sha256" as const, stateId: `m5localprodstate:${stateSha256.slice(0, 32).toLowerCase()}`, stateSha256, payload });
}

export async function verifyLocalProductionRouterState(state: LocalProductionRouterState): Promise<void> {
  assertExactFields(record(state, "Production state"), PRODUCTION_STATE_FIELDS, "Production state");
  if (state.schemaVersion !== 1 || state.algorithm !== "sha256" || !isRecord(state.payload)) throw new Error("Production state envelope is invalid");
  assertExactFields(state.payload, PRODUCTION_PAYLOAD_FIELDS, "Production state payload");
  const p = state.payload as LocalProductionRouterStatePayload;
  for (const [value, label] of [[p.targetId, "targetId"], [p.installationId, "installationId"], [p.projectId, "projectId"], [p.routeId, "routeId"], [p.capability, "capability"], [p.currentSubjectId, "currentSubjectId"], [p.routeRevision, "routeRevision"]] as const) identity(value, `production ${label}`);
  timestamp(p.updatedAt, "production updatedAt");
  if (p.targetKind !== "local_production_router" || p.productionRouter !== true || p.providerSpecificStatePersisted !== false || p.rawProviderOutputPersisted !== false || p.secretMaterialPersisted !== false) throw new Error("Production state safety boundary is invalid");
  const expected = await sha256Canonical(p);
  if (state.stateSha256 !== expected || state.stateId !== `m5localprodstate:${expected.slice(0, 32).toLowerCase()}`) throw new Error("Production state content address is invalid");
}

export class JsonFileLocalProductionReadOnlyTarget {
  readonly descriptor: LocalProductionReadOnlyTargetDescriptor;
  readonly maxStateBytes: number;

  constructor(input: { readonly descriptor: LocalProductionReadOnlyTargetDescriptor; readonly maxStateBytes: number }) {
    if (input.descriptor.targetKind !== "local_production_router") throw new Error("Read-only production target descriptor kind is invalid");
    if (!Number.isSafeInteger(input.maxStateBytes) || input.maxStateBytes <= 0) throw new Error("Production maxStateBytes must be positive");
    this.descriptor = Object.freeze({ ...input.descriptor, targetId: identity(input.descriptor.targetId, "production targetId"), stateFilePath: resolve(input.descriptor.stateFilePath) });
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
    return Object.freeze({ schemaVersion: 1, algorithm: "sha256" as const, fingerprintId: `m5localprodfingerprint:${fingerprintSha256.slice(0, 32).toLowerCase()}`, fingerprintSha256, payload });
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
    this.descriptor = Object.freeze({ ...input.descriptor, stateFilePath: resolve(input.descriptor.stateFilePath) });
    this.maxStateBytes = input.maxStateBytes;
  }

  static async initialize(input: { readonly descriptor: LocalProductionRehearsalTargetDescriptor; readonly productionTarget: JsonFileLocalProductionReadOnlyTarget; readonly initializedAt: string; readonly maxStateBytes: number }): Promise<JsonFileLocalProductionRehearsalTarget> {
    if (input.descriptor.targetKind !== "local_production_rehearsal_clone" || input.descriptor.rehearsalOnly !== true) throw new Error("Rehearsal descriptor is not rehearsal-only");
    if (resolve(input.descriptor.stateFilePath) === resolve(input.productionTarget.descriptor.stateFilePath)) throw new Error("Rehearsal clone path aliases production path");
    if (input.descriptor.targetId === input.productionTarget.descriptor.targetId || input.descriptor.sourceProductionTargetId !== input.productionTarget.descriptor.targetId) throw new Error("Rehearsal clone identity aliases or mismatches production target");
    if (!Number.isSafeInteger(input.maxStateBytes) || input.maxStateBytes <= 0) throw new Error("Rehearsal maxStateBytes must be positive");
    const production = await input.productionTarget.read();
    const target = new JsonFileLocalProductionRehearsalTarget({ descriptor: input.descriptor, maxStateBytes: input.maxStateBytes });
    const state = await prepareRehearsalState({
      targetId: input.descriptor.targetId,
      sourceProductionTargetId: production.payload.targetId,
      projectId: production.payload.projectId,
      routeId: production.payload.routeId,
      capability: production.payload.capability,
      currentSubjectId: production.payload.currentSubjectId,
      routeRevision: production.payload.routeRevision,
      mutationCount: 0,
      updatedAt: input.initializedAt,
    });
    writeUtf8File(target.descriptor.stateFilePath, `${JSON.stringify(state)}\n`);
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
    const next = await prepareRehearsalState({ ...stateInputFrom(current), currentSubjectId: candidateSubjectId, routeRevision: candidateRevision, mutationCount: current.payload.mutationCount + 1, updatedAt });
    this.write(next);
    return next;
  }

  async restore(before: LocalProductionRehearsalState, referenceSubjectId: string, referenceRevision: string, updatedAt: string): Promise<LocalProductionRehearsalState> {
    const current = await this.read();
    if (!sameState(current, before)) throw new Error("Rehearsal clone changed before restore write");
    const next = await prepareRehearsalState({ ...stateInputFrom(current), currentSubjectId: referenceSubjectId, routeRevision: referenceRevision, mutationCount: current.payload.mutationCount + 1, updatedAt });
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

  private constructor(options: LocalProductionRehearsalJournalOptions) {
    if (!Number.isSafeInteger(options.maxFileBytes) || options.maxFileBytes <= 0 || !Number.isSafeInteger(options.maxEventBytes) || options.maxEventBytes <= 0 || !Number.isSafeInteger(options.maxStringBytes) || options.maxStringBytes <= 0) throw new Error("Rehearsal journal limits must be positive integers");
    this.options = Object.freeze({ ...options, filePath: resolve(options.filePath) });
  }

  static async open(options: LocalProductionRehearsalJournalOptions): Promise<JsonlLocalProductionRehearsalJournal> {
    const journal = new JsonlLocalProductionRehearsalJournal(options);
    await journal.load();
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

  async append(payload: LocalProductionRehearsalJournalPayload): Promise<LocalProductionRehearsalJournalEvent> {
    await this.assertFreshRead();
    validateEventPayload(payload);
    const eventSha256 = await sha256Canonical(payload);
    const event: LocalProductionRehearsalJournalEvent = Object.freeze({ algorithm: "sha256" as const, eventId: `m5localprodrehearsalevent:${eventSha256.slice(0, 32).toLowerCase()}`, eventSha256, payload: Object.freeze({ ...payload }) });
    const entry: PersistedRehearsalEntry = Object.freeze({ schemaVersion: 1, sequence: this.entries.length + 1, event });
    const line = `${JSON.stringify(entry)}\n`;
    const eventBytes = utf8Bytes(line);
    if (eventBytes > this.options.maxEventBytes) throw new Error("Rehearsal journal event exceeds size limit");
    if (this.expectedFileSize + eventBytes > this.options.maxFileBytes) throw new Error("Rehearsal journal exceeds file size limit");
    mkdirSync(resolve(this.options.filePath, ".."), { recursive: true });
    const fd = openSync(this.options.filePath, "a");
    try { writeFileSync(fd, line, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
    this.entries.push(entry);
    await this.refreshFingerprint();
    return event;
  }

  private async load(): Promise<void> {
    if (!existsSync(this.options.filePath)) {
      this.entries = [];
      this.expectedFileSize = 0;
      this.expectedFileSha256 = await sha256Text("");
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
    this.entries = entries;
    this.expectedFileSize = utf8Bytes(raw);
    this.expectedFileSha256 = await sha256Text(raw);
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
    private readonly faultInjector?: LocalProductionAdapterRehearsalFaultInjector,
  ) {}

  async applyCandidate(input: { readonly authority: LocalProductionAdapterRehearsalAuthority; readonly reservedAt: string; readonly appliedAt: string; readonly committedAt: string }): Promise<LocalProductionRehearsalJournalEvent> {
    await verifyRehearsalAuthority(input.authority);
    await assertProductionMatchesAuthority(this.productionTarget, input.authority);
    const operation = operationIdentity(input.authority.readinessAuthorization.authorizationId, "candidate");
    if (this.journal.latest(operation.operationId)) throw new Error("Candidate rehearsal operation already exists; automatic retry is forbidden");
    const before = await this.rehearsalTarget.read();
    assertCloneMatchesAuthority(before, input.authority);
    const after = await expectedCandidateState(before, input.authority, input.appliedAt);
    await this.journal.append(journalPayload("rehearsal_reserved", "candidate", operation, input.authority, this.productionTarget.descriptor.targetId, this.rehearsalTarget.descriptor.targetId, before, after, input.reservedAt, false, "candidate mutation reserved"));
    await this.faultInjector?.hit("after_candidate_reservation");
    const applied = await this.rehearsalTarget.writeCandidate(before, after.payload.currentSubjectId, after.payload.routeRevision, input.appliedAt);
    if (!sameState(applied, after)) throw new Error("Candidate rehearsal state does not equal reserved expected state");
    await this.faultInjector?.hit("after_candidate_apply_before_commit");
    return this.journal.append(journalPayload("rehearsal_committed", "candidate", operation, input.authority, this.productionTarget.descriptor.targetId, this.rehearsalTarget.descriptor.targetId, before, after, input.committedAt, false, "candidate mutation committed on rehearsal clone"));
  }

  async restoreReference(input: { readonly authority: LocalProductionAdapterRehearsalAuthority; readonly reservedAt: string; readonly restoredAt: string; readonly committedAt: string }): Promise<LocalProductionRehearsalJournalEvent> {
    await verifyRehearsalAuthority(input.authority);
    await assertProductionMatchesAuthority(this.productionTarget, input.authority);
    const operation = operationIdentity(input.authority.readinessAuthorization.authorizationId, "restore");
    if (this.journal.latest(operation.operationId)) throw new Error("Restore rehearsal operation already exists; automatic retry is forbidden");
    const before = await this.rehearsalTarget.read();
    const candidateCommit = this.journal.latestCommitted("candidate", input.authority.readinessAuthorization.authorizationId);
    if (!candidateCommit || before.stateId !== candidateCommit.payload.afterStateId || before.stateSha256 !== candidateCommit.payload.afterStateSha256) throw new Error("Explicit restore requires an exact committed candidate rehearsal state");
    assertJournalAuthority(candidateCommit, input.authority, this.productionTarget.descriptor.targetId, this.rehearsalTarget.descriptor.targetId);
    const after = await expectedRestoreState(before, input.authority, input.restoredAt);
    await this.journal.append(journalPayload("rehearsal_reserved", "restore", operation, input.authority, this.productionTarget.descriptor.targetId, this.rehearsalTarget.descriptor.targetId, before, after, input.reservedAt, false, "reference restore reserved"));
    await this.faultInjector?.hit("after_restore_reservation");
    const restored = await this.rehearsalTarget.restore(before, after.payload.currentSubjectId, after.payload.routeRevision, input.restoredAt);
    if (!sameState(restored, after)) throw new Error("Restored rehearsal state does not equal reserved expected state");
    await this.faultInjector?.hit("after_restore_apply_before_commit");
    return this.journal.append(journalPayload("rehearsal_committed", "restore", operation, input.authority, this.productionTarget.descriptor.targetId, this.rehearsalTarget.descriptor.targetId, before, after, input.committedAt, false, "reference restore committed on rehearsal clone"));
  }

  async reconcile(input: { readonly authority: LocalProductionAdapterRehearsalAuthority; readonly phase: RehearsalPhase; readonly observedAt: string }): Promise<LocalProductionAdapterRehearsalRecoveryReport> {
    await verifyRehearsalAuthority(input.authority);
    await assertProductionMatchesAuthority(this.productionTarget, input.authority);
    await this.journal.assertFreshRead();
    const operation = operationIdentity(input.authority.readinessAuthorization.authorizationId, input.phase);
    const event = this.journal.latest(operation.operationId);
    if (!event) return recoveryReport(input.phase, operation.operationId, "NO_OPERATION", input.observedAt, "No durable rehearsal operation exists", false);
    assertJournalAuthority(event, input.authority, this.productionTarget.descriptor.targetId, this.rehearsalTarget.descriptor.targetId);
    const current = await this.rehearsalTarget.read();
    if (event.payload.eventType === "rehearsal_committed") {
      if (current.stateId === event.payload.afterStateId && current.stateSha256 === event.payload.afterStateSha256) return recoveryReport(input.phase, operation.operationId, "COMMITTED", input.observedAt, "Durable commit matches current rehearsal state", false, event.eventId, current.stateId);
      await this.appendManual(input, event, current, "Committed rehearsal state drifted from durable commit");
      return recoveryReport(input.phase, operation.operationId, "MANUAL_RECONCILIATION_REQUIRED", input.observedAt, "Committed rehearsal state drifted from durable commit", true, event.eventId, current.stateId);
    }
    if (event.payload.eventType === "rehearsal_manual_reconciliation_required") return recoveryReport(input.phase, operation.operationId, "MANUAL_RECONCILIATION_REQUIRED", input.observedAt, event.payload.reason, true, event.eventId, current.stateId);
    if (current.stateId === event.payload.beforeStateId && current.stateSha256 === event.payload.beforeStateSha256) return recoveryReport(input.phase, operation.operationId, "NOT_APPLIED_SAFE", input.observedAt, "Reservation exists and rehearsal clone remains at exact before state", true, event.eventId, current.stateId);
    if (current.stateId === event.payload.afterStateId && current.stateSha256 === event.payload.afterStateSha256) {
      const commit = await this.journal.append({ ...event.payload, eventType: "rehearsal_committed", observedAt: timestamp(input.observedAt, "recovery observedAt"), recoveredAfterRestart: true, reason: `${input.phase} reconciled committed after restart` });
      return recoveryReport(input.phase, operation.operationId, "COMMITTED", input.observedAt, "Reservation reconciled to exact expected after state without duplicate write", false, commit.eventId, current.stateId);
    }
    await this.appendManual(input, event, current, "Rehearsal clone is neither exact before nor exact expected after state");
    return recoveryReport(input.phase, operation.operationId, "MANUAL_RECONCILIATION_REQUIRED", input.observedAt, "Rehearsal clone is neither exact before nor exact expected after state", true, event.eventId, current.stateId);
  }

  async finalize(input: { readonly authority: LocalProductionAdapterRehearsalAuthority; readonly productionPreFingerprint: LocalProductionRouterFingerprint; readonly completedAt: string }): Promise<LocalProductionAdapterRehearsalReceipt> {
    await verifyRehearsalAuthority(input.authority);
    await this.journal.assertFreshRead();
    const authorizationId = input.authority.readinessAuthorization.authorizationId;
    const candidate = this.journal.latestCommitted("candidate", authorizationId);
    const restore = this.journal.latestCommitted("restore", authorizationId);
    if (!candidate || !restore) throw new Error("Rehearsal receipt requires exact durable candidate and restore commits");
    assertJournalAuthority(candidate, input.authority, this.productionTarget.descriptor.targetId, this.rehearsalTarget.descriptor.targetId);
    assertJournalAuthority(restore, input.authority, this.productionTarget.descriptor.targetId, this.rehearsalTarget.descriptor.targetId);
    const current = await this.rehearsalTarget.read();
    if (current.stateId !== restore.payload.afterStateId || current.stateSha256 !== restore.payload.afterStateSha256) throw new Error("Rehearsal clone does not match durable restored state");
    const post = await this.productionTarget.fingerprint(input.completedAt);
    assertProductionFingerprintsEqual(input.productionPreFingerprint, post);
    const payload: LocalProductionAdapterRehearsalReceiptPayload = Object.freeze({
      operationId: `local-production-rehearsal:${authorizationId}`,
      readinessAuthorizationId: authorizationId,
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
      productionPreFingerprintId: input.productionPreFingerprint.fingerprintId,
      productionPreFingerprintSha256: input.productionPreFingerprint.fingerprintSha256,
      productionPostFingerprintId: post.fingerprintId,
      productionPostFingerprintSha256: post.fingerprintSha256,
      rehearsalTargetId: this.rehearsalTarget.descriptor.targetId,
      candidateStateId: candidate.payload.afterStateId,
      candidateStateSha256: candidate.payload.afterStateSha256,
      restoredStateId: restore.payload.afterStateId,
      restoredStateSha256: restore.payload.afterStateSha256,
      candidateCommitEventId: candidate.eventId,
      candidateCommitEventSha256: candidate.eventSha256,
      restoreCommitEventId: restore.eventId,
      restoreCommitEventSha256: restore.eventSha256,
      candidateRecoveredAfterRestart: candidate.payload.recoveredAfterRestart,
      restoreRecoveredAfterRestart: restore.payload.recoveredAfterRestart,
      completedAt: timestamp(input.completedAt, "rehearsal completedAt"),
      classification: "REHEARSAL_PASSED",
      productionRouteMutated: false,
      automaticRetryAllowed: false,
      automaticRollbackAllowed: false,
      automaticRedispatchAllowed: false,
      productionRoutingMutationAuthorized: false,
    });
    const receiptSha256 = await sha256Canonical(payload);
    const receipt: LocalProductionAdapterRehearsalReceipt = Object.freeze({ schemaVersion: 1, algorithm: "sha256" as const, receiptId: `m5localprodrehearsal:${receiptSha256.slice(0, 32).toLowerCase()}`, receiptSha256, payload });
    await verifyLocalProductionAdapterRehearsalReceipt(receipt, input.authority, input.productionPreFingerprint, this.productionTarget, this.rehearsalTarget, this.journal);
    return receipt;
  }

  private async appendManual(input: { readonly authority: LocalProductionAdapterRehearsalAuthority; readonly phase: RehearsalPhase; readonly observedAt: string }, event: LocalProductionRehearsalJournalEvent, current: LocalProductionRehearsalState, reason: string): Promise<void> {
    await this.journal.append({ ...event.payload, eventType: "rehearsal_manual_reconciliation_required", observedAt: timestamp(input.observedAt, "manual reconciliation observedAt"), recoveredAfterRestart: false, reason: `${reason}; current=${current.stateId}` });
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
  await journal.assertFreshRead();
  assertExactFields(record(receipt, "Rehearsal receipt"), RECEIPT_FIELDS, "Rehearsal receipt");
  if (receipt.schemaVersion !== 1 || receipt.algorithm !== "sha256" || !isRecord(receipt.payload)) throw new Error("Rehearsal receipt envelope is invalid");
  assertExactFields(receipt.payload, RECEIPT_PAYLOAD_FIELDS, "Rehearsal receipt payload");
  const p = receipt.payload;
  const expectedOperationId = `local-production-rehearsal:${authority.readinessAuthorization.authorizationId}`;
  if (p.operationId !== expectedOperationId || p.readinessAuthorizationId !== authority.readinessAuthorization.authorizationId || p.readinessAuthorizationSha256 !== authority.readinessAuthorization.authorizationSha256 || p.readinessProposalId !== authority.readinessProposal.proposalId || p.readinessProposalSha256 !== authority.readinessProposal.proposalSha256 || p.targetSnapshotId !== authority.currentTargetSnapshot.snapshotId || p.targetSnapshotSha256 !== authority.currentTargetSnapshot.snapshotSha256 || p.sourceSnapshotId !== authority.currentSourceSnapshot.snapshotId || p.sourceSnapshotSha256 !== authority.currentSourceSnapshot.snapshotSha256 || p.adapterId !== authority.currentSourceSnapshot.payload.adapterId || p.adapterVersion !== authority.currentSourceSnapshot.payload.adapterVersion || p.adapterSourceSha256 !== authority.currentSourceSnapshot.payload.adapterSourceSha256 || p.mainSourceSha256 !== authority.currentSourceSnapshot.payload.mainSourceSha256) throw new Error("Rehearsal receipt operation/authority/source binding drift detected");
  if (p.productionTargetId !== productionTarget.descriptor.targetId || p.rehearsalTargetId !== rehearsalTarget.descriptor.targetId) throw new Error("Rehearsal receipt target binding drift detected");
  if (p.productionRouteMutated !== false || p.automaticRetryAllowed !== false || p.automaticRollbackAllowed !== false || p.automaticRedispatchAllowed !== false || p.productionRoutingMutationAuthorized !== false || p.classification !== "REHEARSAL_PASSED") throw new Error("Rehearsal receipt safety authority is invalid");
  const candidate = journal.latestCommitted("candidate", authority.readinessAuthorization.authorizationId);
  const restore = journal.latestCommitted("restore", authority.readinessAuthorization.authorizationId);
  if (!candidate || !restore) throw new Error("Rehearsal receipt durable commits are missing");
  assertJournalAuthority(candidate, authority, productionTarget.descriptor.targetId, rehearsalTarget.descriptor.targetId);
  assertJournalAuthority(restore, authority, productionTarget.descriptor.targetId, rehearsalTarget.descriptor.targetId);
  if (p.candidateCommitEventId !== candidate.eventId || p.candidateCommitEventSha256 !== candidate.eventSha256 || p.restoreCommitEventId !== restore.eventId || p.restoreCommitEventSha256 !== restore.eventSha256 || p.candidateStateId !== candidate.payload.afterStateId || p.candidateStateSha256 !== candidate.payload.afterStateSha256 || p.restoredStateId !== restore.payload.afterStateId || p.restoredStateSha256 !== restore.payload.afterStateSha256 || p.candidateRecoveredAfterRestart !== candidate.payload.recoveredAfterRestart || p.restoreRecoveredAfterRestart !== restore.payload.recoveredAfterRestart) throw new Error("Rehearsal receipt durable journal provenance drift detected");
  const current = await rehearsalTarget.read();
  if (current.stateId !== p.restoredStateId || current.stateSha256 !== p.restoredStateSha256 || current.payload.currentSubjectId !== authority.currentTargetSnapshot.payload.currentSubjectId || current.payload.routeRevision !== authority.currentTargetSnapshot.payload.routeRevision) throw new Error("Rehearsal receipt current clone state is not exact restored reference");
  const post = await productionTarget.fingerprint(p.completedAt);
  assertProductionFingerprintsEqual(productionPreFingerprint, post);
  if (p.productionPreFingerprintId !== productionPreFingerprint.fingerprintId || p.productionPreFingerprintSha256 !== productionPreFingerprint.fingerprintSha256 || p.productionPostFingerprintId !== post.fingerprintId || p.productionPostFingerprintSha256 !== post.fingerprintSha256) throw new Error("Rehearsal receipt production fingerprint provenance drift detected");
  const expected = await sha256Canonical(p);
  if (receipt.receiptSha256 !== expected || receipt.receiptId !== `m5localprodrehearsal:${expected.slice(0, 32).toLowerCase()}`) throw new Error("Rehearsal receipt content address is invalid");
  await journal.assertFreshRead();
}

export async function verifyRehearsalAuthority(authority: LocalProductionAdapterRehearsalAuthority): Promise<void> {
  await verifyLocalProductionRoutingReadinessAuthorization(authority.readinessAuthorization, authority.readinessProposal, authority.readinessContext, authority.currentTargetSnapshot, authority.currentSourceSnapshot, authority.workflow);
  const a = authority.readinessAuthorization.payload;
  const p = authority.readinessProposal.payload;
  if (a.decision !== "allow" || a.implementationReadinessAuthorized !== true || p.classification !== "READY_FOR_LOCAL_PRODUCTION_ADAPTER_IMPLEMENTATION") throw new Error("Rehearsal requires exact allowed implementation-readiness authorization");
  if (a.productionRoutingMutationAuthorized !== false || a.automaticRoutingMutationAllowed !== false || a.automaticRetryAllowed !== false || a.automaticRollbackAllowed !== false || a.automaticRedispatchAllowed !== false || p.productionRoutingMutationAuthorized !== false || p.automaticRoutingMutationAllowed !== false || p.automaticRetryAllowed !== false || p.automaticRollbackAllowed !== false || p.automaticRedispatchAllowed !== false) throw new Error("Readiness authority cannot authorize production or automatic mutation during rehearsal");
}

async function assertProductionMatchesAuthority(target: JsonFileLocalProductionReadOnlyTarget, authority: LocalProductionAdapterRehearsalAuthority): Promise<void> {
  const production = await target.read();
  const snapshot = authority.currentTargetSnapshot.payload;
  if (production.payload.installationId !== snapshot.installationId || production.payload.projectId !== snapshot.projectId || production.payload.routeId !== snapshot.routeId || production.payload.capability !== snapshot.capability || production.payload.currentSubjectId !== snapshot.currentSubjectId || production.payload.routeRevision !== snapshot.routeRevision) throw new Error("Production target no longer matches exact readiness target snapshot");
}

function assertCloneMatchesAuthority(state: LocalProductionRehearsalState, authority: LocalProductionAdapterRehearsalAuthority): void {
  const snapshot = authority.currentTargetSnapshot.payload;
  if (state.payload.projectId !== snapshot.projectId || state.payload.routeId !== snapshot.routeId || state.payload.capability !== snapshot.capability || state.payload.currentSubjectId !== snapshot.currentSubjectId || state.payload.routeRevision !== snapshot.routeRevision || state.payload.productionRouter !== false || state.payload.rehearsalOnly !== true) throw new Error("Rehearsal clone does not start from exact authorized reference state");
}

function assertJournalAuthority(event: LocalProductionRehearsalJournalEvent, authority: LocalProductionAdapterRehearsalAuthority, productionTargetId: string, rehearsalTargetId: string): void {
  const p = event.payload;
  if (p.readinessAuthorizationId !== authority.readinessAuthorization.authorizationId || p.readinessAuthorizationSha256 !== authority.readinessAuthorization.authorizationSha256 || p.readinessProposalId !== authority.readinessProposal.proposalId || p.readinessProposalSha256 !== authority.readinessProposal.proposalSha256 || p.targetSnapshotId !== authority.currentTargetSnapshot.snapshotId || p.targetSnapshotSha256 !== authority.currentTargetSnapshot.snapshotSha256 || p.sourceSnapshotId !== authority.currentSourceSnapshot.snapshotId || p.sourceSnapshotSha256 !== authority.currentSourceSnapshot.snapshotSha256 || p.adapterId !== authority.currentSourceSnapshot.payload.adapterId || p.adapterVersion !== authority.currentSourceSnapshot.payload.adapterVersion || p.adapterSourceSha256 !== authority.currentSourceSnapshot.payload.adapterSourceSha256 || p.mainSourceSha256 !== authority.currentSourceSnapshot.payload.mainSourceSha256 || p.productionTargetId !== productionTargetId || p.rehearsalTargetId !== rehearsalTargetId || p.projectId !== authority.currentTargetSnapshot.payload.projectId || p.routeId !== authority.currentTargetSnapshot.payload.routeId || p.capability !== authority.currentTargetSnapshot.payload.capability) throw new Error("Rehearsal journal event authority/source/target binding drift detected");
}

async function expectedCandidateState(before: LocalProductionRehearsalState, authority: LocalProductionAdapterRehearsalAuthority, updatedAt: string): Promise<LocalProductionRehearsalState> {
  const seed = await sha256Canonical({ authorizationId: authority.readinessAuthorization.authorizationId, beforeStateId: before.stateId, candidateSubjectId: authority.readinessProposal.payload.candidateSubjectId });
  return prepareRehearsalState({ ...stateInputFrom(before), currentSubjectId: authority.readinessProposal.payload.candidateSubjectId, routeRevision: `rehearsal-candidate:${seed.slice(0, 32).toLowerCase()}`, mutationCount: before.payload.mutationCount + 1, updatedAt });
}

async function expectedRestoreState(before: LocalProductionRehearsalState, authority: LocalProductionAdapterRehearsalAuthority, updatedAt: string): Promise<LocalProductionRehearsalState> {
  return prepareRehearsalState({ ...stateInputFrom(before), currentSubjectId: authority.currentTargetSnapshot.payload.currentSubjectId, routeRevision: authority.currentTargetSnapshot.payload.routeRevision, mutationCount: before.payload.mutationCount + 1, updatedAt });
}

function stateInputFrom(state: LocalProductionRehearsalState): { targetId: string; sourceProductionTargetId: string; projectId: string; routeId: string; capability: string; currentSubjectId: string; routeRevision: string; mutationCount: number; updatedAt: string } {
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

async function prepareRehearsalState(input: { targetId: string; sourceProductionTargetId: string; projectId: string; routeId: string; capability: string; currentSubjectId: string; routeRevision: string; mutationCount: number; updatedAt: string }): Promise<LocalProductionRehearsalState> {
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
  return Object.freeze({ schemaVersion: 1, algorithm: "sha256" as const, stateId: `m5localprodrehearsalstate:${stateSha256.slice(0, 32).toLowerCase()}`, stateSha256, payload });
}

async function verifyRehearsalState(state: LocalProductionRehearsalState): Promise<void> {
  assertExactFields(record(state, "Rehearsal state"), REHEARSAL_STATE_FIELDS, "Rehearsal state");
  if (state.schemaVersion !== 1 || state.algorithm !== "sha256" || !isRecord(state.payload)) throw new Error("Rehearsal state envelope is invalid");
  assertExactFields(state.payload, REHEARSAL_PAYLOAD_FIELDS, "Rehearsal state payload");
  const p = state.payload;
  if (p.targetKind !== "local_production_rehearsal_clone" || p.rehearsalOnly !== true || p.productionRouter !== false || p.providerSpecificStatePersisted !== false || p.rawProviderOutputPersisted !== false || p.secretMaterialPersisted !== false || !Number.isSafeInteger(p.mutationCount) || p.mutationCount < 0) throw new Error("Rehearsal state safety boundary is invalid");
  timestamp(p.updatedAt, "rehearsal updatedAt");
  const expected = await sha256Canonical(p);
  if (state.stateSha256 !== expected || state.stateId !== `m5localprodrehearsalstate:${expected.slice(0, 32).toLowerCase()}`) throw new Error("Rehearsal state content address is invalid");
}

function journalPayload(eventType: RehearsalEventType, phase: RehearsalPhase, operation: { operationId: string; idempotencyKey: string }, authority: LocalProductionAdapterRehearsalAuthority, productionTargetId: string, rehearsalTargetId: string, before: LocalProductionRehearsalState, after: LocalProductionRehearsalState, observedAt: string, recoveredAfterRestart: boolean, reason: string): LocalProductionRehearsalJournalPayload {
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
    beforeStateId: before.stateId,
    beforeStateSha256: before.stateSha256,
    afterStateId: after.stateId,
    afterStateSha256: after.stateSha256,
    beforeSubjectId: before.payload.currentSubjectId,
    afterSubjectId: after.payload.currentSubjectId,
    beforeRouteRevision: before.payload.routeRevision,
    afterRouteRevision: after.payload.routeRevision,
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
  timestamp(payload.observedAt, "rehearsal journal observedAt");
  text(payload.reason, "rehearsal journal reason");
}

async function verifyJournalEvent(event: LocalProductionRehearsalJournalEvent): Promise<void> {
  assertExactFields(record(event, "Rehearsal journal event"), EVENT_FIELDS, "Rehearsal journal event");
  if (event.algorithm !== "sha256" || !isRecord(event.payload)) throw new Error("Rehearsal journal event envelope is invalid");
  validateEventPayload(event.payload);
  const expected = await sha256Canonical(event.payload);
  if (event.eventSha256 !== expected || event.eventId !== `m5localprodrehearsalevent:${expected.slice(0, 32).toLowerCase()}`) throw new Error("Rehearsal journal event content address is invalid");
}

function operationIdentity(authorizationId: string, phase: RehearsalPhase): { operationId: string; idempotencyKey: string } {
  const value = `local-production-rehearsal:${identity(authorizationId, "readiness authorizationId")}:${phase}`;
  return { operationId: value, idempotencyKey: value };
}

function recoveryReport(phase: RehearsalPhase, operationId: string, classification: LocalProductionAdapterRehearsalRecoveryClassification, observedAt: string, reason: string, explicitOperatorActionRequired: boolean, journalEventId?: string, rehearsalStateId?: string): LocalProductionAdapterRehearsalRecoveryReport {
  const base = {
    phase,
    operationId,
    classification,
    observedAt: timestamp(observedAt, "recovery observedAt"),
    reason,
    explicitOperatorActionRequired,
    automaticRetryAllowed: false as const,
    automaticRollbackAllowed: false as const,
    productionRoutingMutationAuthorized: false as const,
  };
  return Object.freeze({ ...base, ...(journalEventId ? { journalEventId } : {}), ...(rehearsalStateId ? { rehearsalStateId } : {}) });
}

function assertProductionFingerprintsEqual(before: LocalProductionRouterFingerprint, after: LocalProductionRouterFingerprint): void {
  const b = before.payload;
  const a = after.payload;
  if (b.targetId !== a.targetId || b.stateId !== a.stateId || b.stateSha256 !== a.stateSha256 || b.rawFileSha256 !== a.rawFileSha256 || b.projectId !== a.projectId || b.routeId !== a.routeId || b.capability !== a.capability || b.currentSubjectId !== a.currentSubjectId || b.routeRevision !== a.routeRevision) throw new Error("Production target fingerprint drift detected during rehearsal");
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
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, child]) => child !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, sortJson(child)]));
}
