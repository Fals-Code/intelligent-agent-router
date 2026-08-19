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
import type {
  ControlledExperimentLiveAssignment,
  ControlledExperimentSampleExposure,
} from "./controlled-experiment-execution-adapter.js";

export const CONTROLLED_EXPERIMENT_EXECUTION_JOURNAL_SCHEMA_VERSION = 1 as const;

export type ControlledExperimentExecutionEventType =
  | "sample_reserved"
  | "sample_dispatched"
  | "dispatch_error"
  | "sample_completed";

export interface ControlledExperimentSampleReservationInput {
  readonly sampleId: string;
  readonly exposure: ControlledExperimentSampleExposure;
  readonly liveAssignment: ControlledExperimentLiveAssignment;
  readonly inputReference: string;
  readonly reservedAt: string;
}

export interface ControlledExperimentDispatchRecordInput {
  readonly sampleId: string;
  readonly adapterId: string;
  readonly acceptedAt: string;
  readonly referenceExecutionReference: string;
  readonly candidateExecutionReference: string;
  readonly candidateOutputExternallyVisible: boolean;
}

export interface ControlledExperimentDispatchErrorInput {
  readonly sampleId: string;
  readonly adapterId: string;
  readonly observedAt: string;
  readonly error: string;
}

export interface ControlledExperimentSampleCompletionInput {
  readonly sampleId: string;
  readonly completedAt: string;
  readonly referenceObservationId: string;
  readonly candidateObservationId: string;
}

export type ControlledExperimentExecutionEventPayload =
  | {
      readonly eventType: "sample_reserved";
      readonly experimentId: string;
      readonly sampleId: string;
      readonly exposure: ControlledExperimentSampleExposure;
      readonly liveAssignment: ControlledExperimentLiveAssignment;
      readonly inputReference: string;
      readonly reservedAt: string;
      readonly automaticRedispatchAllowed: false;
    }
  | {
      readonly eventType: "sample_dispatched";
      readonly experimentId: string;
      readonly sampleId: string;
      readonly adapterId: string;
      readonly acceptedAt: string;
      readonly referenceExecutionReference: string;
      readonly candidateExecutionReference: string;
      readonly candidateOutputExternallyVisible: boolean;
      readonly automaticRedispatchAllowed: false;
    }
  | {
      readonly eventType: "dispatch_error";
      readonly experimentId: string;
      readonly sampleId: string;
      readonly adapterId: string;
      readonly observedAt: string;
      readonly error: string;
      readonly sideEffectState: "unknown";
      readonly manualReconciliationRequired: true;
      readonly automaticRedispatchAllowed: false;
    }
  | {
      readonly eventType: "sample_completed";
      readonly experimentId: string;
      readonly sampleId: string;
      readonly completedAt: string;
      readonly referenceObservationId: string;
      readonly candidateObservationId: string;
      readonly automaticRedispatchAllowed: false;
    };

export interface ControlledExperimentExecutionJournalEvent {
  readonly algorithm: "sha256";
  readonly eventId: string;
  readonly eventSha256: string;
  readonly payload: ControlledExperimentExecutionEventPayload;
}

export interface ControlledExperimentExecutionJournalOptions {
  readonly filePath: string;
  readonly experimentId: string;
  readonly maxFileBytes: number;
  readonly maxEventBytes: number;
  readonly maxStringBytes: number;
}

export interface ControlledExperimentExecutionJournalState {
  readonly experimentId: string;
  readonly eventCount: number;
  readonly reservedSampleCount: number;
  readonly reservedLiveSamples: number;
  readonly reservedCandidateLiveSamples: number;
  readonly completedSampleCount: number;
  readonly completedShadowSamples: number;
  readonly completedLiveSamples: number;
  readonly completedCandidateLiveSamples: number;
  readonly unresolvedSampleIds: readonly string[];
  readonly dispatchErrorSampleIds: readonly string[];
  readonly completedReferenceObservationIds: readonly string[];
  readonly completedCandidateObservationIds: readonly string[];
  readonly automaticRedispatchAllowed: false;
}

interface PersistedExecutionJournalEntry {
  readonly schemaVersion: typeof CONTROLLED_EXPERIMENT_EXECUTION_JOURNAL_SCHEMA_VERSION;
  readonly sequence: number;
  readonly event: ControlledExperimentExecutionJournalEvent;
}

/**
 * Local append-only single-writer journal for bounded experiment dispatch.
 *
 * A reservation is persisted before the adapter call. Any process loss after
 * reservation therefore leaves an unresolved sample and automatic redispatch is
 * forbidden. Adapter exceptions are recorded as sideEffectState=unknown rather
 * than assumed safe failures. v1 intentionally allows only one in-flight sample.
 */
export class JsonlControlledExperimentExecutionJournal {
  readonly filePath: string;
  readonly experimentId: string;
  private readonly maxFileBytes: number;
  private readonly maxEventBytes: number;
  private readonly maxStringBytes: number;
  private readonly events: ControlledExperimentExecutionJournalEvent[] = [];
  private readonly latestBySample = new Map<string, ControlledExperimentExecutionJournalEvent>();
  private readonly reservations = new Map<string, Extract<ControlledExperimentExecutionEventPayload, { eventType: "sample_reserved" }>>();
  private expectedFileSize = 0;

  private constructor(options: ControlledExperimentExecutionJournalOptions) {
    if (!options.filePath.trim()) throw new Error("Controlled experiment execution journal filePath must not be empty");
    this.experimentId = prepareIdentity(options.experimentId, "Controlled experiment execution journal experimentId", options.maxStringBytes);
    assertPositiveInteger(options.maxFileBytes, "Controlled experiment execution journal maxFileBytes");
    assertPositiveInteger(options.maxEventBytes, "Controlled experiment execution journal maxEventBytes");
    assertPositiveInteger(options.maxStringBytes, "Controlled experiment execution journal maxStringBytes");
    if (options.maxEventBytes > options.maxFileBytes) throw new Error("Controlled experiment execution journal maxEventBytes must not exceed maxFileBytes");
    this.filePath = resolve(options.filePath);
    this.maxFileBytes = options.maxFileBytes;
    this.maxEventBytes = options.maxEventBytes;
    this.maxStringBytes = options.maxStringBytes;
    mkdirSync(resolve(this.filePath, ".."), { recursive: true });
  }

  static async open(options: ControlledExperimentExecutionJournalOptions): Promise<JsonlControlledExperimentExecutionJournal> {
    const journal = new JsonlControlledExperimentExecutionJournal(options);
    await journal.load();
    return journal;
  }

  async reserveSample(input: ControlledExperimentSampleReservationInput): Promise<ControlledExperimentExecutionJournalEvent> {
    this.assertStorageUnchanged();
    if (this.latestBySample.has(input.sampleId)) throw new Error(`Controlled experiment sample already exists: ${input.sampleId}`);
    const unresolved = this.inspect().unresolvedSampleIds;
    if (unresolved.length > 0) throw new Error(`Controlled experiment has unresolved sample(s): ${unresolved.join(", ")}; automatic concurrent or recovery dispatch is forbidden`);
    const event = await prepareEvent({
      eventType: "sample_reserved",
      experimentId: this.experimentId,
      sampleId: prepareIdentity(input.sampleId, "Controlled experiment sampleId", this.maxStringBytes),
      exposure: prepareExposure(input.exposure),
      liveAssignment: prepareLiveAssignment(input.exposure, input.liveAssignment),
      inputReference: prepareSafeReference(input.inputReference, "Controlled experiment inputReference", this.maxStringBytes),
      reservedAt: prepareTimestamp(input.reservedAt, "Controlled experiment reservedAt"),
      automaticRedispatchAllowed: false,
    }, this.maxEventBytes);
    await this.append(event);
    return event;
  }

  async recordDispatch(input: ControlledExperimentDispatchRecordInput): Promise<ControlledExperimentExecutionJournalEvent> {
    this.assertStorageUnchanged();
    const previous = this.requireLatest(input.sampleId, "sample_reserved");
    const reservation = previous.payload as Extract<ControlledExperimentExecutionEventPayload, { eventType: "sample_reserved" }>;
    const visible = Boolean(input.candidateOutputExternallyVisible);
    const expectedVisible = reservation.exposure === "bounded_live" && reservation.liveAssignment === "candidate";
    if (visible !== expectedVisible) throw new Error("Controlled experiment dispatch visibility does not match reserved exposure/live assignment");
    const event = await prepareEvent({
      eventType: "sample_dispatched",
      experimentId: this.experimentId,
      sampleId: reservation.sampleId,
      adapterId: prepareIdentity(input.adapterId, "Controlled experiment adapterId", this.maxStringBytes),
      acceptedAt: prepareTimestamp(input.acceptedAt, "Controlled experiment acceptedAt"),
      referenceExecutionReference: prepareSafeReference(input.referenceExecutionReference, "Controlled experiment reference execution reference", this.maxStringBytes),
      candidateExecutionReference: prepareSafeReference(input.candidateExecutionReference, "Controlled experiment candidate execution reference", this.maxStringBytes),
      candidateOutputExternallyVisible: visible,
      automaticRedispatchAllowed: false,
    }, this.maxEventBytes);
    await this.append(event);
    return event;
  }

  async recordDispatchError(input: ControlledExperimentDispatchErrorInput): Promise<ControlledExperimentExecutionJournalEvent> {
    this.assertStorageUnchanged();
    const previous = this.requireLatest(input.sampleId, "sample_reserved");
    const reservation = previous.payload as Extract<ControlledExperimentExecutionEventPayload, { eventType: "sample_reserved" }>;
    const event = await prepareEvent({
      eventType: "dispatch_error",
      experimentId: this.experimentId,
      sampleId: reservation.sampleId,
      adapterId: prepareIdentity(input.adapterId, "Controlled experiment adapterId", this.maxStringBytes),
      observedAt: prepareTimestamp(input.observedAt, "Controlled experiment dispatch error observedAt"),
      error: prepareSanitizedText(input.error, "Controlled experiment dispatch error", this.maxStringBytes),
      sideEffectState: "unknown",
      manualReconciliationRequired: true,
      automaticRedispatchAllowed: false,
    }, this.maxEventBytes);
    await this.append(event);
    return event;
  }

  async recordCompletion(input: ControlledExperimentSampleCompletionInput): Promise<ControlledExperimentExecutionJournalEvent> {
    this.assertStorageUnchanged();
    const previous = this.requireLatest(input.sampleId, "sample_dispatched");
    const sampleId = previous.payload.sampleId;
    const referenceObservationId = prepareSafeReference(input.referenceObservationId, "Controlled experiment reference observationId", this.maxStringBytes);
    const candidateObservationId = prepareSafeReference(input.candidateObservationId, "Controlled experiment candidate observationId", this.maxStringBytes);
    if (referenceObservationId === candidateObservationId) throw new Error("Controlled experiment reference/candidate observation IDs must be distinct");
    const state = this.inspect();
    if (state.completedReferenceObservationIds.includes(referenceObservationId) || state.completedCandidateObservationIds.includes(candidateObservationId)) {
      throw new Error("Controlled experiment completion reuses an existing observation ID");
    }
    const event = await prepareEvent({
      eventType: "sample_completed",
      experimentId: this.experimentId,
      sampleId,
      completedAt: prepareTimestamp(input.completedAt, "Controlled experiment completedAt"),
      referenceObservationId,
      candidateObservationId,
      automaticRedispatchAllowed: false,
    }, this.maxEventBytes);
    await this.append(event);
    return event;
  }

  list(): readonly ControlledExperimentExecutionJournalEvent[] {
    return [...this.events];
  }

  latest(sampleId: string): ControlledExperimentExecutionJournalEvent | undefined {
    return this.latestBySample.get(sampleId);
  }

  reservation(sampleId: string): Extract<ControlledExperimentExecutionEventPayload, { eventType: "sample_reserved" }> | undefined {
    return this.reservations.get(sampleId);
  }

  inspect(): ControlledExperimentExecutionJournalState {
    const reservations = [...this.reservations.values()];
    const completed = [...this.latestBySample.values()].filter((event) => event.payload.eventType === "sample_completed");
    const completedIds = new Set(completed.map((event) => event.payload.sampleId));
    const completedReservations = reservations.filter((reservation) => completedIds.has(reservation.sampleId));
    const unresolved = [...this.latestBySample.entries()]
      .filter(([, event]) => event.payload.eventType !== "sample_completed")
      .map(([sampleId]) => sampleId)
      .sort();
    const dispatchErrors = [...this.latestBySample.entries()]
      .filter(([, event]) => event.payload.eventType === "dispatch_error")
      .map(([sampleId]) => sampleId)
      .sort();
    const completedPayloads = completed.map((event) => event.payload as Extract<ControlledExperimentExecutionEventPayload, { eventType: "sample_completed" }>);
    return deepFreeze({
      experimentId: this.experimentId,
      eventCount: this.events.length,
      reservedSampleCount: reservations.length,
      reservedLiveSamples: reservations.filter((item) => item.exposure === "bounded_live").length,
      reservedCandidateLiveSamples: reservations.filter((item) => item.exposure === "bounded_live" && item.liveAssignment === "candidate").length,
      completedSampleCount: completedReservations.length,
      completedShadowSamples: completedReservations.filter((item) => item.exposure === "shadow").length,
      completedLiveSamples: completedReservations.filter((item) => item.exposure === "bounded_live").length,
      completedCandidateLiveSamples: completedReservations.filter((item) => item.exposure === "bounded_live" && item.liveAssignment === "candidate").length,
      unresolvedSampleIds: unresolved,
      dispatchErrorSampleIds: dispatchErrors,
      completedReferenceObservationIds: completedPayloads.map((item) => item.referenceObservationId).sort(),
      completedCandidateObservationIds: completedPayloads.map((item) => item.candidateObservationId).sort(),
      automaticRedispatchAllowed: false as const,
    });
  }

  private async load(): Promise<void> {
    if (!existsSync(this.filePath)) return;
    const size = statSync(this.filePath).size;
    if (size > this.maxFileBytes) throw new Error(`Controlled experiment execution journal exceeds maxFileBytes: bytes=${size} max=${this.maxFileBytes}`);
    const raw = readFileSync(this.filePath, "utf8");
    this.expectedFileSize = utf8ByteLength(raw);
    if (raw.length === 0) return;
    if (!raw.endsWith("\n")) throw new Error(`Controlled experiment execution journal is not newline-terminated; possible partial write: ${this.filePath}`);
    const lines = raw.slice(0, -1).split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const lineNumber = index + 1;
      const line = lines[index];
      if (!line.trim()) throw new Error(`Controlled experiment execution journal contains an empty record at line ${lineNumber}`);
      if (utf8ByteLength(`${line}\n`) > this.maxEventBytes) throw new Error(`Controlled experiment execution journal record at line ${lineNumber} exceeds maxEventBytes`);
      const persisted = parsePersisted(line, lineNumber);
      if (persisted.sequence !== lineNumber) throw new Error(`Controlled experiment execution journal sequence mismatch at line ${lineNumber}: sequence=${persisted.sequence}`);
      await verifyControlledExperimentExecutionJournalEvent(persisted.event, this.maxEventBytes, this.maxStringBytes);
      if (persisted.event.payload.experimentId !== this.experimentId) throw new Error(`Controlled experiment execution journal event at line ${lineNumber} belongs to another experiment`);
      this.assertTransition(persisted.event, lineNumber);
      this.admit(persisted.event);
    }
  }

  private async append(event: ControlledExperimentExecutionJournalEvent): Promise<void> {
    await verifyControlledExperimentExecutionJournalEvent(event, this.maxEventBytes, this.maxStringBytes);
    this.assertTransition(event);
    const sequence = this.events.length + 1;
    const line = `${JSON.stringify({ schemaVersion: CONTROLLED_EXPERIMENT_EXECUTION_JOURNAL_SCHEMA_VERSION, sequence, event })}\n`;
    const lineBytes = utf8ByteLength(line);
    if (lineBytes > this.maxEventBytes) throw new Error(`Controlled experiment execution journal event exceeds maxEventBytes: bytes=${lineBytes} max=${this.maxEventBytes}`);
    if (this.expectedFileSize + lineBytes > this.maxFileBytes) throw new Error(`Controlled experiment execution journal append would exceed maxFileBytes: current=${this.expectedFileSize} append=${lineBytes} max=${this.maxFileBytes}`);
    const handle = openSync(this.filePath, "a", 0o600);
    try {
      writeFileSync(handle, line, "utf8");
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    this.expectedFileSize += lineBytes;
    this.admit(event);
  }

  private assertTransition(event: ControlledExperimentExecutionJournalEvent, lineNumber?: number): void {
    const label = lineNumber === undefined ? "Controlled experiment execution journal" : `Controlled experiment execution journal line ${lineNumber}`;
    const sampleId = event.payload.sampleId;
    const previous = this.latestBySample.get(sampleId);
    switch (event.payload.eventType) {
      case "sample_reserved":
        if (previous) throw new Error(`${label} duplicates sample reservation: ${sampleId}`);
        if ([...this.latestBySample.values()].some((item) => item.payload.eventType !== "sample_completed")) {
          throw new Error(`${label} creates a concurrent sample while another sample is unresolved`);
        }
        break;
      case "sample_dispatched":
      case "dispatch_error":
        if (!previous || previous.payload.eventType !== "sample_reserved") throw new Error(`${label} ${event.payload.eventType} requires prior sample_reserved`);
        break;
      case "sample_completed":
        if (!previous || previous.payload.eventType !== "sample_dispatched") throw new Error(`${label} sample_completed requires prior sample_dispatched`);
        if ([...this.latestBySample.values()].some((item) => item.payload.eventType === "sample_completed" && (item.payload as Extract<ControlledExperimentExecutionEventPayload, { eventType: "sample_completed" }>).referenceObservationId === event.payload.referenceObservationId)) {
          throw new Error(`${label} reuses reference observation ID`);
        }
        if ([...this.latestBySample.values()].some((item) => item.payload.eventType === "sample_completed" && (item.payload as Extract<ControlledExperimentExecutionEventPayload, { eventType: "sample_completed" }>).candidateObservationId === event.payload.candidateObservationId)) {
          throw new Error(`${label} reuses candidate observation ID`);
        }
        break;
    }
  }

  private admit(event: ControlledExperimentExecutionJournalEvent): void {
    this.events.push(deepFreeze(deepClone(event)));
    this.latestBySample.set(event.payload.sampleId, event);
    if (event.payload.eventType === "sample_reserved") this.reservations.set(event.payload.sampleId, event.payload);
  }

  private requireLatest(sampleIdInput: string, eventType: ControlledExperimentExecutionEventType): ControlledExperimentExecutionJournalEvent {
    const sampleId = prepareIdentity(sampleIdInput, "Controlled experiment sampleId", this.maxStringBytes);
    const latest = this.latestBySample.get(sampleId);
    if (!latest || latest.payload.eventType !== eventType) throw new Error(`Controlled experiment sample ${sampleId} must currently be ${eventType}`);
    return latest;
  }

  private assertStorageUnchanged(): void {
    const currentSize = existsSync(this.filePath) ? statSync(this.filePath).size : 0;
    if (currentSize !== this.expectedFileSize) throw new Error(`Controlled experiment execution journal changed outside this writer; reopen before writing: expectedBytes=${this.expectedFileSize} actualBytes=${currentSize}`);
  }
}

export async function verifyControlledExperimentExecutionJournalEvent(
  event: ControlledExperimentExecutionJournalEvent,
  maxEventBytes = Number.MAX_SAFE_INTEGER,
  maxStringBytes = Number.MAX_SAFE_INTEGER,
): Promise<void> {
  if (!isRecord(event)) throw new Error("Controlled experiment execution event must be an object");
  assertExactFields(event, new Set(["algorithm", "eventId", "eventSha256", "payload"]), "Controlled experiment execution event");
  if (event.algorithm !== "sha256" || !isRecord(event.payload)) throw new Error("Controlled experiment execution event envelope is invalid");
  const payload = normalizePayload(event.payload as unknown as ControlledExperimentExecutionEventPayload, maxStringBytes);
  if (stableStringify(payload) !== stableStringify(event.payload)) throw new Error("Controlled experiment execution event payload is not canonically normalized");
  const expected = await sha256Canonical(payload);
  if (event.eventSha256 !== expected) throw new Error("Controlled experiment execution event digest does not match canonical payload");
  if (event.eventId !== `m5execevent:${expected.slice(0, 32).toLowerCase()}`) throw new Error("Controlled experiment execution eventId does not match canonical payload");
  if (utf8ByteLength(stableStringify(event)) > maxEventBytes) throw new Error("Controlled experiment execution event exceeds maxEventBytes");
}

async function prepareEvent(payload: ControlledExperimentExecutionEventPayload, maxEventBytes: number): Promise<ControlledExperimentExecutionJournalEvent> {
  const eventSha256 = await sha256Canonical(payload);
  const event = deepFreeze({
    algorithm: "sha256" as const,
    eventId: `m5execevent:${eventSha256.slice(0, 32).toLowerCase()}`,
    eventSha256,
    payload: deepFreeze(payload),
  });
  if (utf8ByteLength(stableStringify(event)) > maxEventBytes) throw new Error("Controlled experiment execution event exceeds maxEventBytes");
  return event;
}

function normalizePayload(payload: ControlledExperimentExecutionEventPayload, maxStringBytes: number): ControlledExperimentExecutionEventPayload {
  if (!isRecord(payload)) throw new Error("Controlled experiment execution event payload must be an object");
  const commonExperimentId = prepareIdentity(payload.experimentId, "Controlled experiment execution event experimentId", maxStringBytes);
  const sampleId = prepareIdentity(payload.sampleId, "Controlled experiment execution event sampleId", maxStringBytes);
  if (payload.automaticRedispatchAllowed !== false) throw new Error("Controlled experiment execution event cannot grant automatic redispatch authority");
  switch (payload.eventType) {
    case "sample_reserved":
      assertExactFields(payload, new Set(["eventType", "experimentId", "sampleId", "exposure", "liveAssignment", "inputReference", "reservedAt", "automaticRedispatchAllowed"]), "Controlled experiment reservation payload");
      return deepFreeze({ eventType: "sample_reserved", experimentId: commonExperimentId, sampleId, exposure: prepareExposure(payload.exposure), liveAssignment: prepareLiveAssignment(payload.exposure, payload.liveAssignment), inputReference: prepareSafeReference(payload.inputReference, "Controlled experiment inputReference", maxStringBytes), reservedAt: prepareTimestamp(payload.reservedAt, "Controlled experiment reservedAt"), automaticRedispatchAllowed: false as const });
    case "sample_dispatched":
      assertExactFields(payload, new Set(["eventType", "experimentId", "sampleId", "adapterId", "acceptedAt", "referenceExecutionReference", "candidateExecutionReference", "candidateOutputExternallyVisible", "automaticRedispatchAllowed"]), "Controlled experiment dispatched payload");
      return deepFreeze({ eventType: "sample_dispatched", experimentId: commonExperimentId, sampleId, adapterId: prepareIdentity(payload.adapterId, "Controlled experiment adapterId", maxStringBytes), acceptedAt: prepareTimestamp(payload.acceptedAt, "Controlled experiment acceptedAt"), referenceExecutionReference: prepareSafeReference(payload.referenceExecutionReference, "Controlled experiment reference execution reference", maxStringBytes), candidateExecutionReference: prepareSafeReference(payload.candidateExecutionReference, "Controlled experiment candidate execution reference", maxStringBytes), candidateOutputExternallyVisible: Boolean(payload.candidateOutputExternallyVisible), automaticRedispatchAllowed: false as const });
    case "dispatch_error":
      assertExactFields(payload, new Set(["eventType", "experimentId", "sampleId", "adapterId", "observedAt", "error", "sideEffectState", "manualReconciliationRequired", "automaticRedispatchAllowed"]), "Controlled experiment dispatch error payload");
      if (payload.sideEffectState !== "unknown" || payload.manualReconciliationRequired !== true) throw new Error("Controlled experiment dispatch error must remain manual-reconciliation unknown state");
      return deepFreeze({ eventType: "dispatch_error", experimentId: commonExperimentId, sampleId, adapterId: prepareIdentity(payload.adapterId, "Controlled experiment adapterId", maxStringBytes), observedAt: prepareTimestamp(payload.observedAt, "Controlled experiment dispatch error observedAt"), error: prepareSanitizedText(payload.error, "Controlled experiment dispatch error", maxStringBytes), sideEffectState: "unknown" as const, manualReconciliationRequired: true as const, automaticRedispatchAllowed: false as const });
    case "sample_completed":
      assertExactFields(payload, new Set(["eventType", "experimentId", "sampleId", "completedAt", "referenceObservationId", "candidateObservationId", "automaticRedispatchAllowed"]), "Controlled experiment completion payload");
      return deepFreeze({ eventType: "sample_completed", experimentId: commonExperimentId, sampleId, completedAt: prepareTimestamp(payload.completedAt, "Controlled experiment completedAt"), referenceObservationId: prepareSafeReference(payload.referenceObservationId, "Controlled experiment reference observationId", maxStringBytes), candidateObservationId: prepareSafeReference(payload.candidateObservationId, "Controlled experiment candidate observationId", maxStringBytes), automaticRedispatchAllowed: false as const });
    default:
      throw new Error(`Controlled experiment execution event type is invalid: ${String((payload as { eventType?: unknown }).eventType)}`);
  }
}

function parsePersisted(line: string, lineNumber: number): PersistedExecutionJournalEntry {
  let value: unknown;
  try { value = JSON.parse(line) as unknown; } catch (error) { throw new Error(`Controlled experiment execution journal contains invalid JSON at line ${lineNumber}: ${safeErrorMessage(error)}`); }
  if (!isRecord(value)) throw new Error(`Controlled experiment execution journal entry at line ${lineNumber} must be an object`);
  assertExactFields(value, new Set(["schemaVersion", "sequence", "event"]), `Controlled experiment execution journal entry at line ${lineNumber}`);
  if (value.schemaVersion !== CONTROLLED_EXPERIMENT_EXECUTION_JOURNAL_SCHEMA_VERSION) throw new Error(`Unsupported controlled experiment execution journal schema at line ${lineNumber}`);
  if (!Number.isInteger(value.sequence) || Number(value.sequence) <= 0) throw new Error(`Controlled experiment execution journal sequence at line ${lineNumber} is invalid`);
  return { schemaVersion: CONTROLLED_EXPERIMENT_EXECUTION_JOURNAL_SCHEMA_VERSION, sequence: Number(value.sequence), event: value.event as ControlledExperimentExecutionJournalEvent };
}

function prepareExposure(value: unknown): ControlledExperimentSampleExposure {
  if (value !== "shadow" && value !== "bounded_live") throw new Error("Controlled experiment sample exposure is invalid");
  return value;
}

function prepareLiveAssignment(exposure: unknown, value: unknown): ControlledExperimentLiveAssignment {
  if (value !== "none" && value !== "reference" && value !== "candidate") throw new Error("Controlled experiment live assignment is invalid");
  if (exposure === "shadow" && value !== "none") throw new Error("Shadow controlled experiment sample must use liveAssignment=none");
  if (exposure === "bounded_live" && value === "none") throw new Error("Bounded-live controlled experiment sample requires reference or candidate live assignment");
  return value;
}

function prepareIdentity(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must not be empty`);
  const normalized = value.trim();
  if (utf8ByteLength(normalized) > maxBytes) throw new Error(`${label} exceeds maxStringBytes`);
  if (sanitizeText(normalized) !== normalized) throw new Error(`${label} contains secret-like material`);
  if (/\r|\n/.test(normalized)) throw new Error(`${label} must be single-line`);
  return normalized;
}

function prepareSafeReference(value: unknown, label: string, maxBytes: number): string {
  return prepareIdentity(value, label, maxBytes);
}

function prepareSanitizedText(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must not be empty`);
  const sanitized = sanitizeText(value).replace(/[\r\n]+/g, " ").trim();
  return truncateUtf8(sanitized, maxBytes);
}

function prepareTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`${label} must be a valid timestamp`);
  return new Date(value).toISOString();
}

function assertExactFields(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${label}.${key} is not allowed`);
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
}

function sanitizeText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [redacted]")
    .replace(/(authorization|api[_-]?key|access[_-]?token|password|secret|credential)\s*[:=]\s*(Bearer\s+)?[^\s,;]+/gi, "$1=[redacted]")
    .replace(/\b(?:ghp_|github_pat_|sk-(?:proj-)?|sb_secret_)[A-Za-z0-9_-]{16,}\b/g, "[redacted]");
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (utf8ByteLength(value) <= maxBytes) return value;
  let output = "";
  for (const char of value) {
    if (utf8ByteLength(`${output}${char}`) > maxBytes) break;
    output += char;
  }
  return output || "[truncated]";
}

function safeErrorMessage(error: unknown): string {
  return sanitizeText(error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, " ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function sha256Canonical(value: unknown): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("Web Crypto SHA-256 is unavailable in this runtime");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(stableStringify(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, child]) => child !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, sortJson(child)]));
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
