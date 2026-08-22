import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { EvidenceRecord } from "../control-plane/contracts.js";
import type {
  RoutingPreconditionSnapshot,
  RoutingPromotionAuthorization,
  RoutingPromotionContext,
  RoutingPromotionProposal,
} from "../evaluation/routing-promotion.js";
import {
  verifyRoutingPreconditionSnapshot,
  verifyRoutingPromotionAuthorization,
} from "../evaluation/routing-promotion.js";
import type { WorkflowRun } from "../control-plane/contracts.js";

export const ISOLATED_ROUTING_TARGET_STATE_SCHEMA_VERSION = 1 as const;
export const ROUTING_MUTATION_JOURNAL_SCHEMA_VERSION = 1 as const;
export const ISOLATED_ROUTING_MUTATION_RECEIPT_SCHEMA_VERSION = 1 as const;
export const ROUTING_MUTATION_RECOVERY_REPORT_SCHEMA_VERSION = 1 as const;

export type IsolatedRoutingMutationFaultPoint =
  | "after_reservation"
  | "after_apply_before_commit";

export interface IsolatedRoutingTargetDescriptor {
  readonly targetKind: "isolated_local_test_router";
  readonly targetId: string;
  readonly stateFilePath: string;
}

export interface IsolatedRoutingTargetStateInput {
  readonly targetId: string;
  readonly projectId: string;
  readonly routeId: string;
  readonly capability: string;
  readonly currentSubjectId: string;
  readonly routeRevision: string;
  readonly mutationCount: number;
  readonly updatedAt: string;
}

export interface IsolatedRoutingTargetStatePayload extends IsolatedRoutingTargetStateInput {
  readonly targetKind: "isolated_local_test_router";
  readonly productionRouter: false;
  readonly providerSpecificStatePersisted: false;
  readonly rawProviderOutputPersisted: false;
}

export interface IsolatedRoutingTargetState {
  readonly schemaVersion: typeof ISOLATED_ROUTING_TARGET_STATE_SCHEMA_VERSION;
  readonly algorithm: "sha256";
  readonly stateId: string;
  readonly stateSha256: string;
  readonly payload: IsolatedRoutingTargetStatePayload;
}

export interface RoutingMutationAuthoritySources {
  readonly authorization: RoutingPromotionAuthorization;
  readonly proposal: RoutingPromotionProposal;
  readonly proposalContext: RoutingPromotionContext;
  readonly preconditionSnapshot: RoutingPreconditionSnapshot;
  readonly workflow: WorkflowRun;
}

export interface RoutingMutationFaultInjector {
  hit(point: IsolatedRoutingMutationFaultPoint): void | Promise<void>;
}

type RoutingMutationCommonPayload = {
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly targetKind: "isolated_local_test_router";
  readonly targetId: string;
  readonly projectId: string;
  readonly routeId: string;
  readonly capability: string;
  readonly authorizationId: string;
  readonly authorizationSha256: string;
  readonly proposalId: string;
  readonly proposalSha256: string;
  readonly preconditionSnapshotId: string;
  readonly preconditionSnapshotSha256: string;
  readonly beforeStateId: string;
  readonly beforeStateSha256: string;
  readonly afterStateId: string;
  readonly afterStateSha256: string;
  readonly beforeSubjectId: string;
  readonly afterSubjectId: string;
  readonly beforeRouteRevision: string;
  readonly afterRouteRevision: string;
  readonly automaticRetryAllowed: false;
  readonly automaticRollbackAllowed: false;
  readonly productionRoutingMutationAllowed: false;
};

type RoutingMutationReservationPayload = RoutingMutationCommonPayload & {
  readonly eventType: "mutation_reserved";
  readonly reservedAt: string;
};

type RoutingMutationCommitPayload = RoutingMutationCommonPayload & {
  readonly eventType: "mutation_committed";
  readonly committedAt: string;
  readonly recoveredAfterRestart: boolean;
};

type RoutingMutationNotAppliedPayload = RoutingMutationCommonPayload & {
  readonly eventType: "mutation_not_applied";
  readonly observedAt: string;
  readonly reason: string;
  readonly explicitOperatorActionRequired: true;
};

type RoutingMutationManualPayload = RoutingMutationCommonPayload & {
  readonly eventType: "mutation_manual_reconciliation_required";
  readonly observedAt: string;
  readonly reason: string;
  readonly explicitOperatorActionRequired: true;
};

export type RoutingMutationJournalPayload =
  | RoutingMutationReservationPayload
  | RoutingMutationCommitPayload
  | RoutingMutationNotAppliedPayload
  | RoutingMutationManualPayload;

export interface RoutingMutationJournalEvent {
  readonly algorithm: "sha256";
  readonly eventId: string;
  readonly eventSha256: string;
  readonly payload: RoutingMutationJournalPayload;
}

export interface RoutingMutationJournalOptions {
  readonly filePath: string;
  readonly maxFileBytes: number;
  readonly maxEventBytes: number;
  readonly maxStringBytes: number;
}

export interface RoutingMutationJournalState {
  readonly eventCount: number;
  readonly operationCount: number;
  readonly committedOperationIds: readonly string[];
  readonly notAppliedOperationIds: readonly string[];
  readonly unresolvedOperationIds: readonly string[];
  readonly manualReconciliationOperationIds: readonly string[];
  readonly automaticRetryAllowed: false;
}

interface PersistedRoutingMutationJournalEntry {
  readonly schemaVersion: typeof ROUTING_MUTATION_JOURNAL_SCHEMA_VERSION;
  readonly sequence: number;
  readonly event: RoutingMutationJournalEvent;
}

export interface IsolatedRoutingMutationReceiptPayload {
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly authorizationId: string;
  readonly authorizationSha256: string;
  readonly proposalId: string;
  readonly proposalSha256: string;
  readonly preconditionSnapshotId: string;
  readonly preconditionSnapshotSha256: string;
  readonly targetKind: "isolated_local_test_router";
  readonly targetId: string;
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
  readonly mutationJournalCommitEventId: string;
  readonly mutationJournalCommitEventSha256: string;
  readonly committedAt: string;
  readonly recoveredAfterRestart: boolean;
  readonly automaticRetryAllowed: false;
  readonly automaticRollbackAllowed: false;
  readonly productionRoutingMutationAllowed: false;
}

export interface IsolatedRoutingMutationReceipt {
  readonly schemaVersion: typeof ISOLATED_ROUTING_MUTATION_RECEIPT_SCHEMA_VERSION;
  readonly algorithm: "sha256";
  readonly receiptId: string;
  readonly receiptSha256: string;
  readonly payload: IsolatedRoutingMutationReceiptPayload;
}

export type RoutingMutationRecoveryClassification =
  | "NO_OPERATION"
  | "COMMITTED"
  | "NOT_APPLIED_SAFE"
  | "MANUAL_RECONCILIATION_REQUIRED";

export interface RoutingMutationRecoveryReportPayload {
  readonly operationId: string;
  readonly authorizationId: string;
  readonly proposalId: string;
  readonly targetId: string;
  readonly routeId: string;
  readonly classification: RoutingMutationRecoveryClassification;
  readonly journalEventId?: string;
  readonly targetStateId?: string;
  readonly observedAt: string;
  readonly reason: string;
  readonly explicitOperatorActionRequired: boolean;
  readonly automaticRetryAllowed: false;
  readonly automaticMutationAllowed: false;
  readonly productionRoutingMutationAllowed: false;
}

export interface RoutingMutationRecoveryReport {
  readonly schemaVersion: typeof ROUTING_MUTATION_RECOVERY_REPORT_SCHEMA_VERSION;
  readonly algorithm: "sha256";
  readonly reportId: string;
  readonly reportSha256: string;
  readonly payload: RoutingMutationRecoveryReportPayload;
}

const TARGET_DESCRIPTOR_FIELDS = new Set(["targetKind", "targetId", "stateFilePath"]);
const TARGET_STATE_FIELDS = new Set(["schemaVersion", "algorithm", "stateId", "stateSha256", "payload"]);
const TARGET_STATE_PAYLOAD_FIELDS = new Set([
  "targetId", "projectId", "routeId", "capability", "currentSubjectId", "routeRevision", "mutationCount", "updatedAt",
  "targetKind", "productionRouter", "providerSpecificStatePersisted", "rawProviderOutputPersisted",
]);
const JOURNAL_EVENT_FIELDS = new Set(["algorithm", "eventId", "eventSha256", "payload"]);
const JOURNAL_ENTRY_FIELDS = new Set(["schemaVersion", "sequence", "event"]);
const JOURNAL_COMMON_FIELDS = [
  "operationId", "idempotencyKey", "targetKind", "targetId", "projectId", "routeId", "capability",
  "authorizationId", "authorizationSha256", "proposalId", "proposalSha256", "preconditionSnapshotId",
  "preconditionSnapshotSha256", "beforeStateId", "beforeStateSha256", "afterStateId", "afterStateSha256",
  "beforeSubjectId", "afterSubjectId", "beforeRouteRevision", "afterRouteRevision",
  "automaticRetryAllowed", "automaticRollbackAllowed", "productionRoutingMutationAllowed",
] as const;
const JOURNAL_RESERVATION_FIELDS = new Set([...JOURNAL_COMMON_FIELDS, "eventType", "reservedAt"]);
const JOURNAL_COMMIT_FIELDS = new Set([...JOURNAL_COMMON_FIELDS, "eventType", "committedAt", "recoveredAfterRestart"]);
const JOURNAL_NOT_APPLIED_FIELDS = new Set([...JOURNAL_COMMON_FIELDS, "eventType", "observedAt", "reason", "explicitOperatorActionRequired"]);
const JOURNAL_MANUAL_FIELDS = new Set([...JOURNAL_COMMON_FIELDS, "eventType", "observedAt", "reason", "explicitOperatorActionRequired"]);
const RECEIPT_FIELDS = new Set(["schemaVersion", "algorithm", "receiptId", "receiptSha256", "payload"]);
const RECEIPT_PAYLOAD_FIELDS = new Set([
  "operationId", "idempotencyKey", "authorizationId", "authorizationSha256", "proposalId", "proposalSha256",
  "preconditionSnapshotId", "preconditionSnapshotSha256", "targetKind", "targetId", "projectId", "routeId", "capability",
  "beforeStateId", "beforeStateSha256", "afterStateId", "afterStateSha256", "beforeSubjectId", "afterSubjectId",
  "beforeRouteRevision", "afterRouteRevision", "mutationJournalCommitEventId", "mutationJournalCommitEventSha256",
  "committedAt", "recoveredAfterRestart", "automaticRetryAllowed", "automaticRollbackAllowed", "productionRoutingMutationAllowed",
]);
const RECOVERY_REPORT_FIELDS = new Set(["schemaVersion", "algorithm", "reportId", "reportSha256", "payload"]);
const RECOVERY_REPORT_PAYLOAD_FIELDS = new Set([
  "operationId", "authorizationId", "proposalId", "targetId", "routeId", "classification", "journalEventId",
  "targetStateId", "observedAt", "reason", "explicitOperatorActionRequired", "automaticRetryAllowed",
  "automaticMutationAllowed", "productionRoutingMutationAllowed",
]);

export class JsonFileIsolatedRoutingTarget {
  readonly descriptor: IsolatedRoutingTargetDescriptor;
  private readonly maxStateBytes: number;
  private readonly maxStringBytes: number;

  private constructor(input: {
    readonly descriptor: IsolatedRoutingTargetDescriptor;
    readonly maxStateBytes: number;
    readonly maxStringBytes: number;
  }) {
    this.descriptor = prepareTargetDescriptor(input.descriptor);
    assertPositiveInteger(input.maxStateBytes, "Isolated routing target maxStateBytes");
    assertPositiveInteger(input.maxStringBytes, "Isolated routing target maxStringBytes");
    this.maxStateBytes = input.maxStateBytes;
    this.maxStringBytes = input.maxStringBytes;
    mkdirSync(resolve(this.descriptor.stateFilePath, ".."), { recursive: true });
  }

  static async initialize(input: {
    readonly descriptor: IsolatedRoutingTargetDescriptor;
    readonly state: IsolatedRoutingTargetStateInput;
    readonly maxStateBytes: number;
    readonly maxStringBytes: number;
  }): Promise<JsonFileIsolatedRoutingTarget> {
    const target = new JsonFileIsolatedRoutingTarget(input);
    if (existsSync(target.descriptor.stateFilePath)) throw new Error("Isolated routing target state file already exists");
    const state = await prepareIsolatedRoutingTargetState(input.state, target.descriptor, target.maxStateBytes, target.maxStringBytes);
    target.writeState(state, "wx");
    return target;
  }

  static async open(input: {
    readonly descriptor: IsolatedRoutingTargetDescriptor;
    readonly maxStateBytes: number;
    readonly maxStringBytes: number;
  }): Promise<JsonFileIsolatedRoutingTarget> {
    const target = new JsonFileIsolatedRoutingTarget(input);
    await target.read();
    return target;
  }

  async read(): Promise<IsolatedRoutingTargetState> {
    if (!existsSync(this.descriptor.stateFilePath)) throw new Error("Isolated routing target state file does not exist");
    const raw = readFileSync(this.descriptor.stateFilePath, "utf8");
    if (!raw.endsWith("\n")) throw new Error("Isolated routing target state is not newline-terminated; possible partial write");
    if (utf8ByteLength(raw) > this.maxStateBytes) throw new Error("Isolated routing target state exceeds maxStateBytes");
    let parsed: unknown;
    try { parsed = JSON.parse(raw.slice(0, -1)); }
    catch { throw new Error("Isolated routing target state is not valid JSON"); }
    await verifyIsolatedRoutingTargetState(parsed as IsolatedRoutingTargetState, this.descriptor, this.maxStateBytes, this.maxStringBytes);
    return deepFreeze(parsed as IsolatedRoutingTargetState);
  }

  async applyExact(before: IsolatedRoutingTargetState, after: IsolatedRoutingTargetState): Promise<void> {
    const current = await this.read();
    if (stableStringify(current) !== stableStringify(before)) throw new Error("Isolated routing target changed before mutation side effect");
    await verifyIsolatedRoutingTargetState(after, this.descriptor, this.maxStateBytes, this.maxStringBytes);
    if (after.payload.mutationCount !== before.payload.mutationCount + 1) throw new Error("Isolated routing mutation must increment mutationCount exactly once");
    if (after.payload.projectId !== before.payload.projectId || after.payload.routeId !== before.payload.routeId || after.payload.capability !== before.payload.capability || after.payload.targetId !== before.payload.targetId) {
      throw new Error("Isolated routing mutation cannot change target/project/route/capability identity");
    }
    this.writeState(after, "w");
  }

  private writeState(state: IsolatedRoutingTargetState, flags: string): void {
    const raw = `${JSON.stringify(state)}\n`;
    if (utf8ByteLength(raw) > this.maxStateBytes) throw new Error("Isolated routing target state exceeds maxStateBytes");
    const handle = openSync(this.descriptor.stateFilePath, flags, 0o600);
    try { writeFileSync(handle, raw, "utf8"); fsyncSync(handle); }
    finally { closeSync(handle); }
  }
}

export class JsonlRoutingMutationJournal {
  readonly filePath: string;
  private readonly maxFileBytes: number;
  private readonly maxEventBytes: number;
  private readonly maxStringBytes: number;
  private readonly events: RoutingMutationJournalEvent[] = [];
  private readonly latestByOperation = new Map<string, RoutingMutationJournalEvent>();
  private expectedFileSize = 0;
  private expectedFileSha256 = "";

  private constructor(options: RoutingMutationJournalOptions) {
    if (!options.filePath.trim()) throw new Error("Routing mutation journal filePath must not be empty");
    assertPositiveInteger(options.maxFileBytes, "Routing mutation journal maxFileBytes");
    assertPositiveInteger(options.maxEventBytes, "Routing mutation journal maxEventBytes");
    assertPositiveInteger(options.maxStringBytes, "Routing mutation journal maxStringBytes");
    if (options.maxEventBytes > options.maxFileBytes) throw new Error("Routing mutation journal maxEventBytes must not exceed maxFileBytes");
    this.filePath = resolve(options.filePath);
    this.maxFileBytes = options.maxFileBytes;
    this.maxEventBytes = options.maxEventBytes;
    this.maxStringBytes = options.maxStringBytes;
    mkdirSync(resolve(this.filePath, ".."), { recursive: true });
  }

  static async open(options: RoutingMutationJournalOptions): Promise<JsonlRoutingMutationJournal> {
    const journal = new JsonlRoutingMutationJournal(options);
    await journal.load();
    return journal;
  }

  latest(operationId: string): RoutingMutationJournalEvent | undefined {
    return this.latestByOperation.get(operationId);
  }

  list(): readonly RoutingMutationJournalEvent[] {
    return [...this.events];
  }

  inspect(): RoutingMutationJournalState {
    const committedOperationIds: string[] = [];
    const notAppliedOperationIds: string[] = [];
    const unresolvedOperationIds: string[] = [];
    const manualReconciliationOperationIds: string[] = [];
    for (const [operationId, event] of this.latestByOperation.entries()) {
      if (event.payload.eventType === "mutation_committed") committedOperationIds.push(operationId);
      else if (event.payload.eventType === "mutation_not_applied") notAppliedOperationIds.push(operationId);
      else if (event.payload.eventType === "mutation_reserved") unresolvedOperationIds.push(operationId);
      else manualReconciliationOperationIds.push(operationId);
    }
    return deepFreeze({
      eventCount: this.events.length,
      operationCount: this.latestByOperation.size,
      committedOperationIds: committedOperationIds.sort(),
      notAppliedOperationIds: notAppliedOperationIds.sort(),
      unresolvedOperationIds: unresolvedOperationIds.sort(),
      manualReconciliationOperationIds: manualReconciliationOperationIds.sort(),
      automaticRetryAllowed: false,
    });
  }

  async assertFreshRead(): Promise<void> {
    const raw = existsSync(this.filePath) ? readFileSync(this.filePath, "utf8") : "";
    const currentSize = utf8ByteLength(raw);
    if (currentSize > this.maxFileBytes) throw new Error("Routing mutation journal exceeds maxFileBytes");
    const currentSha256 = await sha256Text(raw);
    if (currentSize !== this.expectedFileSize || currentSha256 !== this.expectedFileSha256) {
      throw new Error("Routing mutation journal changed since this reader opened; reopen before evidence verification");
    }
  }

  async reserve(payload: Omit<RoutingMutationReservationPayload, "eventType" | "automaticRetryAllowed" | "automaticRollbackAllowed" | "productionRoutingMutationAllowed">): Promise<RoutingMutationJournalEvent> {
    this.assertStorageUnchanged();
    const normalized = normalizeJournalCommon(payload as unknown as RoutingMutationCommonPayload, this.maxStringBytes);
    const existing = this.latestByOperation.get(normalized.operationId);
    if (existing) throw new Error("Routing mutation authorization/operation has already been used; automatic retry is forbidden");
    const state = this.inspect();
    if (state.unresolvedOperationIds.length > 0 || state.manualReconciliationOperationIds.length > 0) {
      throw new Error("Routing mutation journal has unresolved/manual operation; reconciliation is required before any new mutation");
    }
    const eventPayload: RoutingMutationReservationPayload = deepFreeze({
      ...normalized,
      eventType: "mutation_reserved",
      reservedAt: prepareTimestamp(payload.reservedAt, "Routing mutation reservedAt"),
      automaticRetryAllowed: false,
      automaticRollbackAllowed: false,
      productionRoutingMutationAllowed: false,
    });
    return this.appendPrepared(eventPayload);
  }

  async recordCommit(input: { readonly operationId: string; readonly committedAt: string; readonly recoveredAfterRestart: boolean }): Promise<RoutingMutationJournalEvent> {
    this.assertStorageUnchanged();
    const reservation = this.requireReservation(input.operationId);
    const payload: RoutingMutationCommitPayload = deepFreeze({
      ...journalCommonFrom(reservation),
      eventType: "mutation_committed",
      committedAt: prepareTimestamp(input.committedAt, "Routing mutation committedAt"),
      recoveredAfterRestart: input.recoveredAfterRestart === true,
    });
    if (Date.parse(payload.committedAt) < Date.parse(reservation.reservedAt)) throw new Error("Routing mutation commit cannot predate reservation");
    return this.appendPrepared(payload);
  }

  async recordNotApplied(input: { readonly operationId: string; readonly observedAt: string; readonly reason: string }): Promise<RoutingMutationJournalEvent> {
    this.assertStorageUnchanged();
    const reservation = this.requireReservation(input.operationId);
    const payload: RoutingMutationNotAppliedPayload = deepFreeze({
      ...journalCommonFrom(reservation),
      eventType: "mutation_not_applied",
      observedAt: prepareTimestamp(input.observedAt, "Routing mutation not-applied observedAt"),
      reason: prepareSanitizedText(input.reason, "Routing mutation not-applied reason", this.maxStringBytes),
      explicitOperatorActionRequired: true,
    });
    if (Date.parse(payload.observedAt) < Date.parse(reservation.reservedAt)) throw new Error("Routing mutation not-applied observation cannot predate reservation");
    return this.appendPrepared(payload);
  }

  async recordManual(input: { readonly operationId: string; readonly observedAt: string; readonly reason: string }): Promise<RoutingMutationJournalEvent> {
    this.assertStorageUnchanged();
    const current = this.latestByOperation.get(prepareIdentity(input.operationId, "Routing mutation operationId", this.maxStringBytes));
    if (!current) throw new Error("Routing mutation manual reconciliation requires an existing operation");
    if (current.payload.eventType === "mutation_manual_reconciliation_required") return current;
    const payload: RoutingMutationManualPayload = deepFreeze({
      ...journalCommonFrom(current.payload),
      eventType: "mutation_manual_reconciliation_required",
      observedAt: prepareTimestamp(input.observedAt, "Routing mutation manual observedAt"),
      reason: prepareSanitizedText(input.reason, "Routing mutation manual reason", this.maxStringBytes),
      explicitOperatorActionRequired: true,
    });
    return this.appendPrepared(payload);
  }

  private requireReservation(operationIdInput: string): RoutingMutationReservationPayload {
    const operationId = prepareIdentity(operationIdInput, "Routing mutation operationId", this.maxStringBytes);
    const latest = this.latestByOperation.get(operationId);
    if (!latest || latest.payload.eventType !== "mutation_reserved") throw new Error("Routing mutation terminal event requires unresolved durable reservation");
    return latest.payload;
  }

  private async load(): Promise<void> {
    const raw = existsSync(this.filePath) ? readFileSync(this.filePath, "utf8") : "";
    const size = utf8ByteLength(raw);
    if (size > this.maxFileBytes) throw new Error("Routing mutation journal exceeds maxFileBytes");
    this.expectedFileSize = size;
    this.expectedFileSha256 = await sha256Text(raw);
    if (!raw) return;
    if (!raw.endsWith("\n")) throw new Error("Routing mutation journal is not newline-terminated; possible partial write");
    const lines = raw.slice(0, -1).split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].trim()) throw new Error(`Routing mutation journal contains empty record at line ${index + 1}`);
      let parsed: unknown;
      try { parsed = JSON.parse(lines[index]); }
      catch { throw new Error(`Routing mutation journal contains invalid JSON at line ${index + 1}`); }
      if (!isRecord(parsed)) throw new Error(`Routing mutation journal entry ${index + 1} is invalid`);
      assertExactFields(parsed, JOURNAL_ENTRY_FIELDS, `Routing mutation journal entry ${index + 1}`);
      const entry = parsed as unknown as PersistedRoutingMutationJournalEntry;
      if (entry.schemaVersion !== ROUTING_MUTATION_JOURNAL_SCHEMA_VERSION || entry.sequence !== index + 1) throw new Error(`Routing mutation journal sequence/schema mismatch at line ${index + 1}`);
      await verifyRoutingMutationJournalEvent(entry.event, this.maxEventBytes, this.maxStringBytes);
      this.assertTransition(entry.event, index + 1);
      this.admit(entry.event);
    }
  }

  private async appendPrepared(payload: RoutingMutationJournalPayload): Promise<RoutingMutationJournalEvent> {
    const eventSha256 = await sha256Canonical(payload);
    const event: RoutingMutationJournalEvent = deepFreeze({
      algorithm: "sha256",
      eventId: `m5routemutationevent:${eventSha256.slice(0, 32).toLowerCase()}`,
      eventSha256,
      payload,
    });
    await verifyRoutingMutationJournalEvent(event, this.maxEventBytes, this.maxStringBytes);
    this.assertTransition(event);
    const sequence = this.events.length + 1;
    const raw = `${JSON.stringify({ schemaVersion: ROUTING_MUTATION_JOURNAL_SCHEMA_VERSION, sequence, event })}\n`;
    const bytes = utf8ByteLength(raw);
    if (bytes > this.maxEventBytes) throw new Error("Routing mutation journal event exceeds maxEventBytes");
    if (this.expectedFileSize + bytes > this.maxFileBytes) throw new Error("Routing mutation journal append would exceed maxFileBytes");
    const handle = openSync(this.filePath, "a", 0o600);
    try { writeFileSync(handle, raw, "utf8"); fsyncSync(handle); }
    finally { closeSync(handle); }
    this.expectedFileSize += bytes;
    const persistedRaw = readFileSync(this.filePath, "utf8");
    if (utf8ByteLength(persistedRaw) !== this.expectedFileSize) {
      throw new Error("Routing mutation journal changed during append; reopen before continuing");
    }
    this.expectedFileSha256 = await sha256Text(persistedRaw);
    this.admit(event);
    return event;
  }

  private assertTransition(event: RoutingMutationJournalEvent, lineNumber?: number): void {
    const label = lineNumber === undefined ? "Routing mutation journal" : `Routing mutation journal line ${lineNumber}`;
    const previous = this.latestByOperation.get(event.payload.operationId);
    if (event.payload.eventType === "mutation_reserved") {
      if (previous) throw new Error(`${label} duplicates mutation reservation`);
      const state = this.inspect();
      if (state.unresolvedOperationIds.length > 0 || state.manualReconciliationOperationIds.length > 0) throw new Error(`${label} creates mutation while unresolved/manual operation exists`);
      return;
    }
    if (!previous) throw new Error(`${label} terminal mutation event requires prior operation`);
    if (previous.payload.eventType === "mutation_manual_reconciliation_required") throw new Error(`${label} cannot transition after manual reconciliation requirement`);
    if (event.payload.eventType !== "mutation_manual_reconciliation_required" && previous.payload.eventType !== "mutation_reserved") {
      throw new Error(`${label} mutation terminal event requires prior unresolved reservation`);
    }
    const expected = journalCommonFrom(previous.payload);
    const actual = journalCommonFrom(event.payload);
    if (stableStringify(expected) !== stableStringify(actual)) throw new Error(`${label} mutation terminal event drifts from durable operation identity`);
  }

  private admit(event: RoutingMutationJournalEvent): void {
    const frozen = deepFreeze(event);
    this.events.push(frozen);
    this.latestByOperation.set(frozen.payload.operationId, frozen);
  }

  private assertStorageUnchanged(): void {
    const current = existsSync(this.filePath) ? statSync(this.filePath).size : 0;
    if (current !== this.expectedFileSize) throw new Error("Routing mutation journal changed outside this writer; reopen before writing");
  }
}

export class IsolatedRoutingMutationCoordinator {
  constructor(
    private readonly target: JsonFileIsolatedRoutingTarget,
    private readonly journal: JsonlRoutingMutationJournal,
  ) {}

  async apply(input: {
    readonly authority: RoutingMutationAuthoritySources;
    readonly mutatedAt: string;
    readonly committedAt: string;
    readonly faultInjector?: RoutingMutationFaultInjector;
  }): Promise<IsolatedRoutingMutationReceipt> {
    await verifyMutationAuthority(input.authority);
    const before = await this.target.read();
    assertFreshTargetBeforeMutation(before, this.target.descriptor, input.authority);
    const mutatedAt = prepareTimestamp(input.mutatedAt, "Isolated routing mutation mutatedAt");
    const committedAt = prepareTimestamp(input.committedAt, "Isolated routing mutation committedAt");
    if (Date.parse(mutatedAt) < Date.parse(input.authority.authorization.payload.decidedAt)) throw new Error("Isolated routing mutation cannot predate promotion authorization");
    if (Date.parse(committedAt) < Date.parse(mutatedAt)) throw new Error("Isolated routing mutation commit cannot predate route apply");
    const after = await expectedAfterState(before, input.authority, mutatedAt, this.target.descriptor);
    const identity = mutationIdentity(input.authority.authorization.authorizationId);
    if (this.journal.latest(identity.operationId)) throw new Error("Routing mutation authorization/operation has already been used; automatic retry is forbidden");
    await this.journal.reserve({
      ...journalAuthorityPayload(input.authority, this.target.descriptor, before, after, identity),
      reservedAt: mutatedAt,
    });
    await input.faultInjector?.hit("after_reservation");
    await this.target.applyExact(before, after);
    await input.faultInjector?.hit("after_apply_before_commit");
    const confirmed = await this.target.read();
    if (stableStringify(confirmed) !== stableStringify(after)) {
      await this.journal.recordManual({ operationId: identity.operationId, observedAt: committedAt, reason: "Isolated router state does not match deterministic authorized after-state after mutation." });
      throw new Error("Isolated routing mutation after-state cannot be proven; manual reconciliation is required");
    }
    const commitEvent = await this.journal.recordCommit({ operationId: identity.operationId, committedAt, recoveredAfterRestart: false });
    return prepareReceipt(input.authority, this.target.descriptor, before, after, commitEvent);
  }

  async reconcile(input: {
    readonly authority: RoutingMutationAuthoritySources;
    readonly observedAt: string;
  }): Promise<RoutingMutationRecoveryReport> {
    await verifyMutationAuthority(input.authority);
    const observedAt = prepareTimestamp(input.observedAt, "Routing mutation recovery observedAt");
    const identity = mutationIdentity(input.authority.authorization.authorizationId);
    const latest = this.journal.latest(identity.operationId);
    if (!latest) {
      return prepareRecoveryReport(input.authority, this.target.descriptor, identity.operationId, observedAt, "NO_OPERATION", undefined, undefined, "No durable routing mutation operation exists for this authorization.", false);
    }

    let current: IsolatedRoutingTargetState;
    try { current = await this.target.read(); }
    catch (error) {
      if (latest.payload.eventType !== "mutation_manual_reconciliation_required") {
        await this.journal.recordManual({ operationId: identity.operationId, observedAt, reason: `Isolated router state cannot be verified during restart reconciliation: ${safeError(error)}` });
      }
      const manual = this.journal.latest(identity.operationId);
      return prepareRecoveryReport(input.authority, this.target.descriptor, identity.operationId, observedAt, "MANUAL_RECONCILIATION_REQUIRED", manual?.eventId, undefined, "Isolated router state cannot be verified; operator reconciliation is required.", true);
    }

    const beforeMatch = current.stateId === latest.payload.beforeStateId && current.stateSha256 === latest.payload.beforeStateSha256;
    const afterMatch = current.stateId === latest.payload.afterStateId && current.stateSha256 === latest.payload.afterStateSha256;

    if (latest.payload.eventType === "mutation_reserved") {
      if (afterMatch) {
        const commit = await this.journal.recordCommit({ operationId: identity.operationId, committedAt: observedAt, recoveredAfterRestart: true });
        return prepareRecoveryReport(input.authority, this.target.descriptor, identity.operationId, observedAt, "COMMITTED", commit.eventId, current.stateId, "Restart reconciliation proved the authorized candidate route was already applied; no second mutation was dispatched.", false);
      }
      if (beforeMatch) {
        const notApplied = await this.journal.recordNotApplied({ operationId: identity.operationId, observedAt, reason: "Restart reconciliation proved the isolated route is still the exact pre-mutation reference state; blind retry remains forbidden." });
        return prepareRecoveryReport(input.authority, this.target.descriptor, identity.operationId, observedAt, "NOT_APPLIED_SAFE", notApplied.eventId, current.stateId, "Mutation was not applied. A new explicitly authorized operation is required for any future attempt.", true);
      }
      const manual = await this.journal.recordManual({ operationId: identity.operationId, observedAt, reason: "Restart reconciliation observed a route state that is neither the exact before-state nor the deterministic authorized after-state." });
      return prepareRecoveryReport(input.authority, this.target.descriptor, identity.operationId, observedAt, "MANUAL_RECONCILIATION_REQUIRED", manual.eventId, current.stateId, "Route state is unexpected; no mutation or retry is permitted automatically.", true);
    }

    if (latest.payload.eventType === "mutation_committed") {
      if (afterMatch) {
        return prepareRecoveryReport(input.authority, this.target.descriptor, identity.operationId, observedAt, "COMMITTED", latest.eventId, current.stateId, "Committed routing mutation remains exact after restart; no second mutation was dispatched.", false);
      }
      const manual = await this.journal.recordManual({ operationId: identity.operationId, observedAt, reason: "Previously committed isolated route no longer matches the durable committed after-state." });
      return prepareRecoveryReport(input.authority, this.target.descriptor, identity.operationId, observedAt, "MANUAL_RECONCILIATION_REQUIRED", manual.eventId, current.stateId, "Committed route state drifted after mutation; operator reconciliation is required.", true);
    }

    if (latest.payload.eventType === "mutation_not_applied") {
      if (beforeMatch) {
        return prepareRecoveryReport(input.authority, this.target.descriptor, identity.operationId, observedAt, "NOT_APPLIED_SAFE", latest.eventId, current.stateId, "Prior interrupted operation is durably classified not-applied; automatic retry remains forbidden.", true);
      }
      const manual = await this.journal.recordManual({ operationId: identity.operationId, observedAt, reason: "Route state changed after a durable not-applied classification." });
      return prepareRecoveryReport(input.authority, this.target.descriptor, identity.operationId, observedAt, "MANUAL_RECONCILIATION_REQUIRED", manual.eventId, current.stateId, "Route state changed after not-applied classification; operator reconciliation is required.", true);
    }

    return prepareRecoveryReport(input.authority, this.target.descriptor, identity.operationId, observedAt, "MANUAL_RECONCILIATION_REQUIRED", latest.eventId, current.stateId, "Durable journal already requires manual reconciliation.", true);
  }
}

export async function prepareIsolatedRoutingTargetState(
  input: IsolatedRoutingTargetStateInput,
  descriptor: IsolatedRoutingTargetDescriptor,
  maxStateBytes = Number.MAX_SAFE_INTEGER,
  maxStringBytes = Number.MAX_SAFE_INTEGER,
): Promise<IsolatedRoutingTargetState> {
  const preparedDescriptor = prepareTargetDescriptor(descriptor);
  if (input.targetId !== preparedDescriptor.targetId) throw new Error("Isolated routing target state targetId does not match descriptor");
  if (!Number.isInteger(input.mutationCount) || input.mutationCount < 0) throw new Error("Isolated routing target mutationCount must be a non-negative integer");
  const payload: IsolatedRoutingTargetStatePayload = deepFreeze({
    targetId: prepareIdentity(input.targetId, "Isolated routing targetId", maxStringBytes),
    projectId: prepareIdentity(input.projectId, "Isolated routing projectId", maxStringBytes),
    routeId: prepareIdentity(input.routeId, "Isolated routing routeId", maxStringBytes),
    capability: prepareIdentity(input.capability, "Isolated routing capability", maxStringBytes),
    currentSubjectId: prepareIdentity(input.currentSubjectId, "Isolated routing currentSubjectId", maxStringBytes),
    routeRevision: prepareIdentity(input.routeRevision, "Isolated routing routeRevision", maxStringBytes),
    mutationCount: input.mutationCount,
    updatedAt: prepareTimestamp(input.updatedAt, "Isolated routing updatedAt"),
    targetKind: "isolated_local_test_router",
    productionRouter: false,
    providerSpecificStatePersisted: false,
    rawProviderOutputPersisted: false,
  });
  const stateSha256 = await sha256Canonical(payload);
  const state = deepFreeze({
    schemaVersion: ISOLATED_ROUTING_TARGET_STATE_SCHEMA_VERSION,
    algorithm: "sha256" as const,
    stateId: `m5isolatedroute:${stateSha256.slice(0, 32).toLowerCase()}`,
    stateSha256,
    payload,
  });
  if (utf8ByteLength(`${JSON.stringify(state)}\n`) > maxStateBytes) throw new Error("Isolated routing target state exceeds maxStateBytes");
  return state;
}

export async function verifyIsolatedRoutingTargetState(
  state: IsolatedRoutingTargetState,
  descriptor: IsolatedRoutingTargetDescriptor,
  maxStateBytes = Number.MAX_SAFE_INTEGER,
  maxStringBytes = Number.MAX_SAFE_INTEGER,
): Promise<void> {
  if (!isRecord(state)) throw new Error("Isolated routing target state envelope is invalid");
  assertExactFields(state, TARGET_STATE_FIELDS, "Isolated routing target state");
  if (state.schemaVersion !== ISOLATED_ROUTING_TARGET_STATE_SCHEMA_VERSION || state.algorithm !== "sha256" || !isRecord(state.payload)) throw new Error("Isolated routing target state envelope is invalid");
  assertExactFields(state.payload, TARGET_STATE_PAYLOAD_FIELDS, "Isolated routing target state payload");
  const p = state.payload as unknown as IsolatedRoutingTargetStatePayload;
  const preparedDescriptor = prepareTargetDescriptor(descriptor);
  if (p.targetKind !== "isolated_local_test_router" || p.productionRouter !== false || p.providerSpecificStatePersisted !== false || p.rawProviderOutputPersisted !== false) {
    throw new Error("Isolated routing target safety boundary is invalid");
  }
  if (p.targetId !== preparedDescriptor.targetId) throw new Error("Isolated routing target state targetId does not match descriptor");
  for (const [value, label] of [[p.targetId, "targetId"], [p.projectId, "projectId"], [p.routeId, "routeId"], [p.capability, "capability"], [p.currentSubjectId, "currentSubjectId"], [p.routeRevision, "routeRevision"]] as const) {
    prepareIdentity(value, `Isolated routing ${label}`, maxStringBytes);
  }
  if (!Number.isInteger(p.mutationCount) || p.mutationCount < 0) throw new Error("Isolated routing target mutationCount is invalid");
  prepareTimestamp(p.updatedAt, "Isolated routing updatedAt");
  const expected = await sha256Canonical(p);
  if (state.stateSha256 !== expected || state.stateId !== `m5isolatedroute:${expected.slice(0, 32).toLowerCase()}`) throw new Error("Isolated routing target state content address is invalid");
  if (utf8ByteLength(`${JSON.stringify(state)}\n`) > maxStateBytes) throw new Error("Isolated routing target state exceeds maxStateBytes");
}

export async function verifyRoutingMutationJournalEvent(
  event: RoutingMutationJournalEvent,
  maxEventBytes = Number.MAX_SAFE_INTEGER,
  maxStringBytes = Number.MAX_SAFE_INTEGER,
): Promise<void> {
  if (!isRecord(event)) throw new Error("Routing mutation journal event envelope is invalid");
  assertExactFields(event, JOURNAL_EVENT_FIELDS, "Routing mutation journal event");
  if (event.algorithm !== "sha256" || !isRecord(event.payload)) throw new Error("Routing mutation journal event envelope is invalid");
  validateJournalPayload(event.payload as RoutingMutationJournalPayload, maxStringBytes);
  const expected = await sha256Canonical(event.payload);
  if (event.eventSha256 !== expected || event.eventId !== `m5routemutationevent:${expected.slice(0, 32).toLowerCase()}`) throw new Error("Routing mutation journal event content address is invalid");
  if (utf8ByteLength(stableStringify(event)) > maxEventBytes) throw new Error("Routing mutation journal event exceeds maxEventBytes");
}

export async function verifyIsolatedRoutingMutationReceipt(
  receipt: IsolatedRoutingMutationReceipt,
  authority: RoutingMutationAuthoritySources,
  target: JsonFileIsolatedRoutingTarget,
  journal: JsonlRoutingMutationJournal,
): Promise<void> {
  await verifyMutationAuthority(authority);
  if (!isRecord(receipt)) throw new Error("Isolated routing mutation receipt must be an object");
  assertExactFields(receipt, RECEIPT_FIELDS, "Isolated routing mutation receipt");
  if (receipt.schemaVersion !== ISOLATED_ROUTING_MUTATION_RECEIPT_SCHEMA_VERSION || receipt.algorithm !== "sha256" || !isRecord(receipt.payload)) throw new Error("Isolated routing mutation receipt envelope is invalid");
  assertExactFields(receipt.payload, RECEIPT_PAYLOAD_FIELDS, "Isolated routing mutation receipt payload");
  const p = receipt.payload as unknown as IsolatedRoutingMutationReceiptPayload;
  validateReceiptPayload(p);
  const expectedDigest = await sha256Canonical(p);
  if (receipt.receiptSha256 !== expectedDigest || receipt.receiptId !== `m5routemutation:${expectedDigest.slice(0, 32).toLowerCase()}`) throw new Error("Isolated routing mutation receipt content address is invalid");
  const a = authority.authorization.payload;
  const proposal = authority.proposal.payload;
  if (
    p.authorizationId !== authority.authorization.authorizationId || p.authorizationSha256 !== authority.authorization.authorizationSha256 ||
    p.proposalId !== authority.proposal.proposalId || p.proposalSha256 !== authority.proposal.proposalSha256 ||
    p.preconditionSnapshotId !== authority.preconditionSnapshot.snapshotId || p.preconditionSnapshotSha256 !== authority.preconditionSnapshot.snapshotSha256 ||
    p.targetId !== target.descriptor.targetId || p.projectId !== a.projectId || p.routeId !== a.routeId || p.capability !== a.capability ||
    p.beforeSubjectId !== proposal.referenceSubjectId || p.afterSubjectId !== proposal.candidateSubjectId
  ) throw new Error("Isolated routing mutation receipt authority/scope drift detected");
  await journal.assertFreshRead();
  const event = journal.latest(p.operationId);
  if (!event || event.payload.eventType !== "mutation_committed" || event.eventId !== p.mutationJournalCommitEventId || event.eventSha256 !== p.mutationJournalCommitEventSha256) {
    throw new Error("Isolated routing mutation receipt lacks exact durable commit event");
  }
  const expectedFromJournal = receiptPayloadFromCommitEvent(event);
  if (stableStringify(p) !== stableStringify(expectedFromJournal)) {
    throw new Error("Isolated routing mutation receipt durable provenance does not exactly match committed journal event");
  }
  const current = await target.read();
  if (current.stateId !== p.afterStateId || current.stateSha256 !== p.afterStateSha256 || current.payload.currentSubjectId !== p.afterSubjectId || current.payload.routeRevision !== p.afterRouteRevision) {
    throw new Error("Isolated routing mutation receipt after-state is no longer authoritative");
  }
  await journal.assertFreshRead();
}

export async function verifyRoutingMutationRecoveryReport(report: RoutingMutationRecoveryReport): Promise<void> {
  if (!isRecord(report)) throw new Error("Routing mutation recovery report must be an object");
  assertExactFields(report, RECOVERY_REPORT_FIELDS, "Routing mutation recovery report");
  if (report.schemaVersion !== ROUTING_MUTATION_RECOVERY_REPORT_SCHEMA_VERSION || report.algorithm !== "sha256" || !isRecord(report.payload)) throw new Error("Routing mutation recovery report envelope is invalid");
  assertExactFieldsAllowUndefined(report.payload, RECOVERY_REPORT_PAYLOAD_FIELDS, "Routing mutation recovery report payload");
  const p = report.payload as unknown as RoutingMutationRecoveryReportPayload;
  for (const [value, label] of [[p.operationId, "operationId"], [p.authorizationId, "authorizationId"], [p.proposalId, "proposalId"], [p.targetId, "targetId"], [p.routeId, "routeId"], [p.reason, "reason"]] as const) prepareIdentity(value, `Routing mutation recovery ${label}`);
  if (!["NO_OPERATION", "COMMITTED", "NOT_APPLIED_SAFE", "MANUAL_RECONCILIATION_REQUIRED"].includes(p.classification)) throw new Error("Routing mutation recovery classification is invalid");
  prepareTimestamp(p.observedAt, "Routing mutation recovery observedAt");
  if (p.automaticRetryAllowed !== false || p.automaticMutationAllowed !== false || p.productionRoutingMutationAllowed !== false) throw new Error("Routing mutation recovery report cannot grant automatic/production authority");
  if (p.explicitOperatorActionRequired !== (p.classification === "NOT_APPLIED_SAFE" || p.classification === "MANUAL_RECONCILIATION_REQUIRED")) throw new Error("Routing mutation recovery operator-action flag is invalid");
  const expected = await sha256Canonical(p);
  if (report.reportSha256 !== expected || report.reportId !== `m5routemutationrecovery:${expected.slice(0, 32).toLowerCase()}`) throw new Error("Routing mutation recovery report content address is invalid");
}

export async function verifiedIsolatedRoutingMutationReceiptToEvidence(
  receipt: IsolatedRoutingMutationReceipt,
  authority: RoutingMutationAuthoritySources,
  target: JsonFileIsolatedRoutingTarget,
  journal: JsonlRoutingMutationJournal,
  collectedAt: string,
): Promise<EvidenceRecord> {
  await verifyIsolatedRoutingMutationReceipt(receipt, authority, target, journal);
  return deepFreeze({
    kind: "deterministic_check" as const,
    status: "passed" as const,
    reference: `isolated-routing-mutation:${receipt.receiptId}`,
    producer: "isolated-routing-mutation-adapter",
    collectedAt: prepareTimestamp(collectedAt, "Isolated routing mutation evidence collectedAt"),
    metadata: deepFreeze({
      authorizationId: receipt.payload.authorizationId,
      routeId: receipt.payload.routeId,
      targetId: receipt.payload.targetId,
      beforeSubjectId: receipt.payload.beforeSubjectId,
      afterSubjectId: receipt.payload.afterSubjectId,
      recoveredAfterRestart: String(receipt.payload.recoveredAfterRestart),
    }),
  });
}

async function verifyMutationAuthority(authority: RoutingMutationAuthoritySources): Promise<void> {
  await verifyRoutingPreconditionSnapshot(authority.preconditionSnapshot);
  await verifyRoutingPromotionAuthorization(
    authority.authorization,
    authority.proposal,
    authority.proposalContext,
    authority.preconditionSnapshot,
    authority.workflow,
  );
  const p = authority.authorization.payload;
  if (p.decision !== "allow" || p.routingMutationAuthorized !== true) throw new Error("Isolated routing mutation requires explicit allowed routing promotion authorization");
  if (p.automaticRoutingMutationAllowed !== false || p.automaticRollbackAllowed !== false || p.automaticRetryAllowed !== false || p.automaticRedispatchAllowed !== false) {
    throw new Error("Isolated routing mutation authority unexpectedly grants automatic action");
  }
  if (p.routeId !== authority.preconditionSnapshot.payload.routeId || p.capability !== authority.preconditionSnapshot.payload.capability || p.projectId !== authority.preconditionSnapshot.payload.projectId) {
    throw new Error("Isolated routing mutation authorization does not match exact route precondition scope");
  }
}

function assertFreshTargetBeforeMutation(
  state: IsolatedRoutingTargetState,
  descriptor: IsolatedRoutingTargetDescriptor,
  authority: RoutingMutationAuthoritySources,
): void {
  const p = authority.authorization.payload;
  const snapshot = authority.preconditionSnapshot.payload;
  const expectedTargetId = canonicalTargetId(p.projectId, p.routeId);
  if (descriptor.targetKind !== "isolated_local_test_router" || descriptor.targetId !== expectedTargetId) throw new Error("Routing mutation target is not the canonical isolated/local test router for this route");
  if (
    state.payload.targetKind !== "isolated_local_test_router" || state.payload.productionRouter !== false ||
    state.payload.targetId !== descriptor.targetId || state.payload.projectId !== p.projectId || state.payload.routeId !== p.routeId ||
    state.payload.capability !== p.capability || state.payload.currentSubjectId !== p.referenceSubjectId ||
    state.payload.currentSubjectId !== snapshot.currentSubjectId || state.payload.routeRevision !== p.routeRevision ||
    state.payload.routeRevision !== snapshot.routeRevision
  ) throw new Error("Isolated routing mutation route precondition is stale or target state drifted");
}

async function expectedAfterState(
  before: IsolatedRoutingTargetState,
  authority: RoutingMutationAuthoritySources,
  mutatedAt: string,
  descriptor: IsolatedRoutingTargetDescriptor,
): Promise<IsolatedRoutingTargetState> {
  return prepareIsolatedRoutingTargetState({
    targetId: before.payload.targetId,
    projectId: before.payload.projectId,
    routeId: before.payload.routeId,
    capability: before.payload.capability,
    currentSubjectId: authority.authorization.payload.candidateSubjectId,
    routeRevision: `isolated-route-revision:${authority.authorization.authorizationId}`,
    mutationCount: before.payload.mutationCount + 1,
    updatedAt: mutatedAt,
  }, descriptor);
}

function mutationIdentity(authorizationId: string): { readonly operationId: string; readonly idempotencyKey: string } {
  const prepared = prepareIdentity(authorizationId, "Routing mutation authorizationId");
  return deepFreeze({
    operationId: `routing-mutation:${prepared}`,
    idempotencyKey: `routing-mutation:${prepared}`,
  });
}

function journalAuthorityPayload(
  authority: RoutingMutationAuthoritySources,
  descriptor: IsolatedRoutingTargetDescriptor,
  before: IsolatedRoutingTargetState,
  after: IsolatedRoutingTargetState,
  identity: { readonly operationId: string; readonly idempotencyKey: string },
): Omit<RoutingMutationReservationPayload, "eventType" | "reservedAt"> {
  const a = authority.authorization.payload;
  return deepFreeze({
    operationId: identity.operationId,
    idempotencyKey: identity.idempotencyKey,
    targetKind: "isolated_local_test_router",
    targetId: descriptor.targetId,
    projectId: a.projectId,
    routeId: a.routeId,
    capability: a.capability,
    authorizationId: authority.authorization.authorizationId,
    authorizationSha256: authority.authorization.authorizationSha256,
    proposalId: authority.proposal.proposalId,
    proposalSha256: authority.proposal.proposalSha256,
    preconditionSnapshotId: authority.preconditionSnapshot.snapshotId,
    preconditionSnapshotSha256: authority.preconditionSnapshot.snapshotSha256,
    beforeStateId: before.stateId,
    beforeStateSha256: before.stateSha256,
    afterStateId: after.stateId,
    afterStateSha256: after.stateSha256,
    beforeSubjectId: before.payload.currentSubjectId,
    afterSubjectId: after.payload.currentSubjectId,
    beforeRouteRevision: before.payload.routeRevision,
    afterRouteRevision: after.payload.routeRevision,
    automaticRetryAllowed: false,
    automaticRollbackAllowed: false,
    productionRoutingMutationAllowed: false,
  });
}

async function prepareReceipt(
  authority: RoutingMutationAuthoritySources,
  descriptor: IsolatedRoutingTargetDescriptor,
  before: IsolatedRoutingTargetState,
  after: IsolatedRoutingTargetState,
  commitEvent: RoutingMutationJournalEvent,
): Promise<IsolatedRoutingMutationReceipt> {
  if (commitEvent.payload.eventType !== "mutation_committed") throw new Error("Isolated routing mutation receipt requires durable commit event");
  const p = authority.authorization.payload;
  const identity = mutationIdentity(authority.authorization.authorizationId);
  const payload: IsolatedRoutingMutationReceiptPayload = deepFreeze({
    operationId: identity.operationId,
    idempotencyKey: identity.idempotencyKey,
    authorizationId: authority.authorization.authorizationId,
    authorizationSha256: authority.authorization.authorizationSha256,
    proposalId: authority.proposal.proposalId,
    proposalSha256: authority.proposal.proposalSha256,
    preconditionSnapshotId: authority.preconditionSnapshot.snapshotId,
    preconditionSnapshotSha256: authority.preconditionSnapshot.snapshotSha256,
    targetKind: "isolated_local_test_router",
    targetId: descriptor.targetId,
    projectId: p.projectId,
    routeId: p.routeId,
    capability: p.capability,
    beforeStateId: before.stateId,
    beforeStateSha256: before.stateSha256,
    afterStateId: after.stateId,
    afterStateSha256: after.stateSha256,
    beforeSubjectId: before.payload.currentSubjectId,
    afterSubjectId: after.payload.currentSubjectId,
    beforeRouteRevision: before.payload.routeRevision,
    afterRouteRevision: after.payload.routeRevision,
    mutationJournalCommitEventId: commitEvent.eventId,
    mutationJournalCommitEventSha256: commitEvent.eventSha256,
    committedAt: commitEvent.payload.committedAt,
    recoveredAfterRestart: commitEvent.payload.recoveredAfterRestart,
    automaticRetryAllowed: false,
    automaticRollbackAllowed: false,
    productionRoutingMutationAllowed: false,
  });
  const receiptSha256 = await sha256Canonical(payload);
  return deepFreeze({
    schemaVersion: ISOLATED_ROUTING_MUTATION_RECEIPT_SCHEMA_VERSION,
    algorithm: "sha256" as const,
    receiptId: `m5routemutation:${receiptSha256.slice(0, 32).toLowerCase()}`,
    receiptSha256,
    payload,
  });
}

async function prepareRecoveryReport(
  authority: RoutingMutationAuthoritySources,
  descriptor: IsolatedRoutingTargetDescriptor,
  operationId: string,
  observedAt: string,
  classification: RoutingMutationRecoveryClassification,
  journalEventId: string | undefined,
  targetStateId: string | undefined,
  reason: string,
  explicitOperatorActionRequired: boolean,
): Promise<RoutingMutationRecoveryReport> {
  const payload: RoutingMutationRecoveryReportPayload = deepFreeze({
    operationId,
    authorizationId: authority.authorization.authorizationId,
    proposalId: authority.proposal.proposalId,
    targetId: descriptor.targetId,
    routeId: authority.authorization.payload.routeId,
    classification,
    journalEventId,
    targetStateId,
    observedAt,
    reason: prepareIdentity(reason, "Routing mutation recovery reason"),
    explicitOperatorActionRequired,
    automaticRetryAllowed: false,
    automaticMutationAllowed: false,
    productionRoutingMutationAllowed: false,
  });
  const reportSha256 = await sha256Canonical(payload);
  return deepFreeze({
    schemaVersion: ROUTING_MUTATION_RECOVERY_REPORT_SCHEMA_VERSION,
    algorithm: "sha256" as const,
    reportId: `m5routemutationrecovery:${reportSha256.slice(0, 32).toLowerCase()}`,
    reportSha256,
    payload,
  });
}

function canonicalTargetId(projectId: string, routeId: string): string {
  return `isolated-router:${prepareIdentity(projectId, "Isolated routing target projectId")}:${prepareIdentity(routeId, "Isolated routing target routeId")}`;
}

function prepareTargetDescriptor(input: IsolatedRoutingTargetDescriptor): IsolatedRoutingTargetDescriptor {
  if (!isRecord(input)) throw new Error("Isolated routing target descriptor must be an object");
  assertExactFields(input, TARGET_DESCRIPTOR_FIELDS, "Isolated routing target descriptor");
  if (input.targetKind !== "isolated_local_test_router") throw new Error("Production/live routing targets are forbidden in isolated routing mutation slice");
  return deepFreeze({
    targetKind: "isolated_local_test_router" as const,
    targetId: prepareIdentity(input.targetId, "Isolated routing targetId"),
    stateFilePath: resolve(prepareIdentity(input.stateFilePath, "Isolated routing target stateFilePath")),
  });
}

function normalizeJournalCommon(input: RoutingMutationCommonPayload, maxStringBytes: number): RoutingMutationCommonPayload {
  if (input.targetKind !== "isolated_local_test_router") throw new Error("Routing mutation journal only supports isolated/local test router targets");
  const output: RoutingMutationCommonPayload = deepFreeze({
    operationId: prepareIdentity(input.operationId, "Routing mutation operationId", maxStringBytes),
    idempotencyKey: prepareIdentity(input.idempotencyKey, "Routing mutation idempotencyKey", maxStringBytes),
    targetKind: "isolated_local_test_router",
    targetId: prepareIdentity(input.targetId, "Routing mutation targetId", maxStringBytes),
    projectId: prepareIdentity(input.projectId, "Routing mutation projectId", maxStringBytes),
    routeId: prepareIdentity(input.routeId, "Routing mutation routeId", maxStringBytes),
    capability: prepareIdentity(input.capability, "Routing mutation capability", maxStringBytes),
    authorizationId: prepareIdentity(input.authorizationId, "Routing mutation authorizationId", maxStringBytes),
    authorizationSha256: prepareSha256(input.authorizationSha256, "Routing mutation authorizationSha256"),
    proposalId: prepareIdentity(input.proposalId, "Routing mutation proposalId", maxStringBytes),
    proposalSha256: prepareSha256(input.proposalSha256, "Routing mutation proposalSha256"),
    preconditionSnapshotId: prepareIdentity(input.preconditionSnapshotId, "Routing mutation preconditionSnapshotId", maxStringBytes),
    preconditionSnapshotSha256: prepareSha256(input.preconditionSnapshotSha256, "Routing mutation preconditionSnapshotSha256"),
    beforeStateId: prepareIdentity(input.beforeStateId, "Routing mutation beforeStateId", maxStringBytes),
    beforeStateSha256: prepareSha256(input.beforeStateSha256, "Routing mutation beforeStateSha256"),
    afterStateId: prepareIdentity(input.afterStateId, "Routing mutation afterStateId", maxStringBytes),
    afterStateSha256: prepareSha256(input.afterStateSha256, "Routing mutation afterStateSha256"),
    beforeSubjectId: prepareIdentity(input.beforeSubjectId, "Routing mutation beforeSubjectId", maxStringBytes),
    afterSubjectId: prepareIdentity(input.afterSubjectId, "Routing mutation afterSubjectId", maxStringBytes),
    beforeRouteRevision: prepareIdentity(input.beforeRouteRevision, "Routing mutation beforeRouteRevision", maxStringBytes),
    afterRouteRevision: prepareIdentity(input.afterRouteRevision, "Routing mutation afterRouteRevision", maxStringBytes),
    automaticRetryAllowed: false,
    automaticRollbackAllowed: false,
    productionRoutingMutationAllowed: false,
  });
  return output;
}

function journalCommonFrom(payload: RoutingMutationJournalPayload): RoutingMutationCommonPayload {
  return deepFreeze({
    operationId: payload.operationId,
    idempotencyKey: payload.idempotencyKey,
    targetKind: payload.targetKind,
    targetId: payload.targetId,
    projectId: payload.projectId,
    routeId: payload.routeId,
    capability: payload.capability,
    authorizationId: payload.authorizationId,
    authorizationSha256: payload.authorizationSha256,
    proposalId: payload.proposalId,
    proposalSha256: payload.proposalSha256,
    preconditionSnapshotId: payload.preconditionSnapshotId,
    preconditionSnapshotSha256: payload.preconditionSnapshotSha256,
    beforeStateId: payload.beforeStateId,
    beforeStateSha256: payload.beforeStateSha256,
    afterStateId: payload.afterStateId,
    afterStateSha256: payload.afterStateSha256,
    beforeSubjectId: payload.beforeSubjectId,
    afterSubjectId: payload.afterSubjectId,
    beforeRouteRevision: payload.beforeRouteRevision,
    afterRouteRevision: payload.afterRouteRevision,
    automaticRetryAllowed: false,
    automaticRollbackAllowed: false,
    productionRoutingMutationAllowed: false,
  });
}

function receiptPayloadFromCommitEvent(event: RoutingMutationJournalEvent): IsolatedRoutingMutationReceiptPayload {
  if (event.payload.eventType !== "mutation_committed") throw new Error("Isolated routing mutation receipt requires durable committed journal event");
  const p = event.payload;
  return deepFreeze({
    operationId: p.operationId,
    idempotencyKey: p.idempotencyKey,
    authorizationId: p.authorizationId,
    authorizationSha256: p.authorizationSha256,
    proposalId: p.proposalId,
    proposalSha256: p.proposalSha256,
    preconditionSnapshotId: p.preconditionSnapshotId,
    preconditionSnapshotSha256: p.preconditionSnapshotSha256,
    targetKind: p.targetKind,
    targetId: p.targetId,
    projectId: p.projectId,
    routeId: p.routeId,
    capability: p.capability,
    beforeStateId: p.beforeStateId,
    beforeStateSha256: p.beforeStateSha256,
    afterStateId: p.afterStateId,
    afterStateSha256: p.afterStateSha256,
    beforeSubjectId: p.beforeSubjectId,
    afterSubjectId: p.afterSubjectId,
    beforeRouteRevision: p.beforeRouteRevision,
    afterRouteRevision: p.afterRouteRevision,
    mutationJournalCommitEventId: event.eventId,
    mutationJournalCommitEventSha256: event.eventSha256,
    committedAt: p.committedAt,
    recoveredAfterRestart: p.recoveredAfterRestart,
    automaticRetryAllowed: false,
    automaticRollbackAllowed: false,
    productionRoutingMutationAllowed: false,
  });
}

function validateJournalPayload(payload: RoutingMutationJournalPayload, maxStringBytes: number): void {
  if (!isRecord(payload)) throw new Error("Routing mutation journal payload must be an object");
  if (payload.eventType === "mutation_reserved") assertExactFields(payload, JOURNAL_RESERVATION_FIELDS, "Routing mutation reservation payload");
  else if (payload.eventType === "mutation_committed") assertExactFields(payload, JOURNAL_COMMIT_FIELDS, "Routing mutation commit payload");
  else if (payload.eventType === "mutation_not_applied") assertExactFields(payload, JOURNAL_NOT_APPLIED_FIELDS, "Routing mutation not-applied payload");
  else if (payload.eventType === "mutation_manual_reconciliation_required") assertExactFields(payload, JOURNAL_MANUAL_FIELDS, "Routing mutation manual payload");
  else throw new Error("Routing mutation journal eventType is invalid");
  normalizeJournalCommon(payload, maxStringBytes);
  if (payload.eventType === "mutation_reserved") prepareTimestamp(payload.reservedAt, "Routing mutation reservedAt");
  else if (payload.eventType === "mutation_committed") {
    prepareTimestamp(payload.committedAt, "Routing mutation committedAt");
    if (typeof payload.recoveredAfterRestart !== "boolean") throw new Error("Routing mutation recoveredAfterRestart must be boolean");
  } else {
    prepareTimestamp(payload.observedAt, "Routing mutation observedAt");
    prepareSanitizedText(payload.reason, "Routing mutation reason", maxStringBytes);
    if (payload.explicitOperatorActionRequired !== true) throw new Error("Routing mutation terminal safety classification requires operator action");
  }
  if (payload.automaticRetryAllowed !== false || payload.automaticRollbackAllowed !== false || payload.productionRoutingMutationAllowed !== false) throw new Error("Routing mutation journal cannot grant automatic/production authority");
}

function validateReceiptPayload(p: IsolatedRoutingMutationReceiptPayload): void {
  for (const [value, label] of [
    [p.operationId, "operationId"], [p.idempotencyKey, "idempotencyKey"], [p.authorizationId, "authorizationId"], [p.proposalId, "proposalId"],
    [p.preconditionSnapshotId, "preconditionSnapshotId"], [p.targetId, "targetId"], [p.projectId, "projectId"], [p.routeId, "routeId"],
    [p.capability, "capability"], [p.beforeStateId, "beforeStateId"], [p.afterStateId, "afterStateId"], [p.beforeSubjectId, "beforeSubjectId"],
    [p.afterSubjectId, "afterSubjectId"], [p.beforeRouteRevision, "beforeRouteRevision"], [p.afterRouteRevision, "afterRouteRevision"],
    [p.mutationJournalCommitEventId, "mutationJournalCommitEventId"],
  ] as const) prepareIdentity(value, `Isolated routing mutation receipt ${label}`);
  for (const [value, label] of [
    [p.authorizationSha256, "authorizationSha256"], [p.proposalSha256, "proposalSha256"], [p.preconditionSnapshotSha256, "preconditionSnapshotSha256"],
    [p.beforeStateSha256, "beforeStateSha256"], [p.afterStateSha256, "afterStateSha256"], [p.mutationJournalCommitEventSha256, "mutationJournalCommitEventSha256"],
  ] as const) prepareSha256(value, `Isolated routing mutation receipt ${label}`);
  if (p.targetKind !== "isolated_local_test_router") throw new Error("Isolated routing mutation receipt cannot represent production target");
  prepareTimestamp(p.committedAt, "Isolated routing mutation receipt committedAt");
  if (typeof p.recoveredAfterRestart !== "boolean") throw new Error("Isolated routing mutation receipt recoveredAfterRestart is invalid");
  if (p.automaticRetryAllowed !== false || p.automaticRollbackAllowed !== false || p.productionRoutingMutationAllowed !== false) throw new Error("Isolated routing mutation receipt cannot grant automatic/production authority");
}

function assertExactFields(value: Record<string, unknown>, fields: ReadonlySet<string>, label: string): void {
  const keys = Object.keys(value);
  for (const key of keys) if (!fields.has(key)) throw new Error(`${label}.${key} is not allowed`);
  for (const field of fields) if (!keys.includes(field)) throw new Error(`${label}.${field} is required`);
}

function assertExactFieldsAllowUndefined(value: Record<string, unknown>, fields: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(value)) if (!fields.has(key)) throw new Error(`${label}.${key} is not allowed`);
  for (const field of ["operationId", "authorizationId", "proposalId", "targetId", "routeId", "classification", "observedAt", "reason", "explicitOperatorActionRequired", "automaticRetryAllowed", "automaticMutationAllowed", "productionRoutingMutationAllowed"]) {
    if (!(field in value)) throw new Error(`${label}.${field} is required`);
  }
}

function prepareIdentity(value: unknown, label: string, maxStringBytes = Number.MAX_SAFE_INTEGER): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must not be empty`);
  if (value !== value.trim() || /\r|\n/.test(value)) throw new Error(`${label} must be canonical single-line text`);
  if (utf8ByteLength(value) > maxStringBytes) throw new Error(`${label} exceeds maxStringBytes`);
  if (containsSecretLikeMaterial(value)) throw new Error(`${label} contains secret-like material`);
  return value;
}

function prepareSanitizedText(value: unknown, label: string, maxStringBytes: number): string {
  const prepared = prepareIdentity(value, label, maxStringBytes);
  if (containsSecretLikeMaterial(prepared)) throw new Error(`${label} contains secret-like material`);
  return prepared;
}

function prepareSha256(value: unknown, label: string): string {
  const prepared = prepareIdentity(value, label).toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(prepared)) throw new Error(`${label} must be a SHA-256 digest`);
  return prepared;
}

function prepareTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`${label} must be a valid timestamp`);
  const normalized = new Date(value).toISOString();
  if (normalized !== value) throw new Error(`${label} must use canonical ISO-8601 UTC form`);
  return normalized;
}

function containsSecretLikeMaterial(value: string): boolean {
  return /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/i.test(value)
    || /(authorization|api[_-]?key|access[_-]?token|password|secret|credential|cookie)\s*[:=]/i.test(value)
    || /\bghp_[A-Za-z0-9]{20,}\b/.test(value)
    || /\bgithub_pat_[A-Za-z0-9_]{20,}\b/.test(value)
    || /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/.test(value);
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\bBearer\s+\S+/gi, "Bearer [redacted]").replace(/(authorization|api[_-]?key|access[_-]?token|password|secret|credential|cookie)\s*[:=]\s*\S+/gi, "$1=[redacted]");
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

async function sha256Text(value: string): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("Web Crypto SHA-256 is unavailable in this runtime");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
}

async function sha256Canonical(value: unknown): Promise<string> {
  return sha256Text(stableStringify(value));
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, sortJson(child)]));
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}
