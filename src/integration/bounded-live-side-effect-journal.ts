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

export const BOUNDED_LIVE_SIDE_EFFECT_JOURNAL_SCHEMA_VERSION = 1 as const;

export type BoundedLiveSideEffectKind = "publication" | "reference_restore";

export interface BoundedLiveSideEffectReservationInput {
  readonly kind: BoundedLiveSideEffectKind;
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly sinkId: string;
  readonly authorityId: string;
  readonly subjectId: string;
  readonly sampleId?: string;
  readonly outputSha256?: string;
  readonly reservedAt: string;
}

export interface BoundedLiveSideEffectCommitInput {
  readonly operationId: string;
  readonly externalReference: string;
  readonly committedAt: string;
}

export interface BoundedLiveSideEffectErrorInput {
  readonly operationId: string;
  readonly observedAt: string;
  readonly error: string;
}

type ReservationPayload = {
  readonly eventType: "operation_reserved";
  readonly kind: BoundedLiveSideEffectKind;
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly sinkId: string;
  readonly authorityId: string;
  readonly subjectId: string;
  readonly sampleId?: string;
  readonly outputSha256?: string;
  readonly reservedAt: string;
  readonly automaticRetryAllowed: false;
};

type CommitPayload = {
  readonly eventType: "operation_committed";
  readonly kind: BoundedLiveSideEffectKind;
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly sinkId: string;
  readonly authorityId: string;
  readonly subjectId: string;
  readonly sampleId?: string;
  readonly outputSha256?: string;
  readonly externalReference: string;
  readonly committedAt: string;
  readonly automaticRetryAllowed: false;
};

type ErrorPayload = {
  readonly eventType: "operation_error";
  readonly kind: BoundedLiveSideEffectKind;
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly sinkId: string;
  readonly authorityId: string;
  readonly subjectId: string;
  readonly sampleId?: string;
  readonly outputSha256?: string;
  readonly observedAt: string;
  readonly error: string;
  readonly sideEffectState: "unknown";
  readonly manualReconciliationRequired: true;
  readonly automaticRetryAllowed: false;
};

export type BoundedLiveSideEffectPayload = ReservationPayload | CommitPayload | ErrorPayload;

export interface BoundedLiveSideEffectEvent {
  readonly algorithm: "sha256";
  readonly eventId: string;
  readonly eventSha256: string;
  readonly payload: BoundedLiveSideEffectPayload;
}

export interface BoundedLiveSideEffectJournalOptions {
  readonly filePath: string;
  readonly maxFileBytes: number;
  readonly maxEventBytes: number;
  readonly maxStringBytes: number;
}

export interface BoundedLiveSideEffectJournalState {
  readonly eventCount: number;
  readonly operationCount: number;
  readonly committedOperationIds: readonly string[];
  readonly unresolvedOperationIds: readonly string[];
  readonly unknownSideEffectOperationIds: readonly string[];
  readonly automaticRetryAllowed: false;
}

interface PersistedEntry {
  readonly schemaVersion: typeof BOUNDED_LIVE_SIDE_EFFECT_JOURNAL_SCHEMA_VERSION;
  readonly sequence: number;
  readonly event: BoundedLiveSideEffectEvent;
}

export class JsonlBoundedLiveSideEffectJournal {
  readonly filePath: string;
  private readonly maxFileBytes: number;
  private readonly maxEventBytes: number;
  private readonly maxStringBytes: number;
  private readonly events: BoundedLiveSideEffectEvent[] = [];
  private readonly latestByOperation = new Map<string, BoundedLiveSideEffectEvent>();
  private readonly reservations = new Map<string, ReservationPayload>();
  private expectedFileSize = 0;

  private constructor(options: BoundedLiveSideEffectJournalOptions) {
    if (!options.filePath.trim()) throw new Error("Bounded-live side-effect journal filePath must not be empty");
    assertPositiveInteger(options.maxFileBytes, "Bounded-live side-effect maxFileBytes");
    assertPositiveInteger(options.maxEventBytes, "Bounded-live side-effect maxEventBytes");
    assertPositiveInteger(options.maxStringBytes, "Bounded-live side-effect maxStringBytes");
    if (options.maxEventBytes > options.maxFileBytes) throw new Error("Bounded-live side-effect maxEventBytes must not exceed maxFileBytes");
    this.filePath = resolve(options.filePath);
    this.maxFileBytes = options.maxFileBytes;
    this.maxEventBytes = options.maxEventBytes;
    this.maxStringBytes = options.maxStringBytes;
    mkdirSync(resolve(this.filePath, ".."), { recursive: true });
  }

  static async open(options: BoundedLiveSideEffectJournalOptions): Promise<JsonlBoundedLiveSideEffectJournal> {
    const journal = new JsonlBoundedLiveSideEffectJournal(options);
    await journal.load();
    return journal;
  }

  async reserve(input: BoundedLiveSideEffectReservationInput): Promise<BoundedLiveSideEffectEvent> {
    this.assertStorageUnchanged();
    const operationId = prepareIdentity(input.operationId, "Bounded-live side-effect operationId", this.maxStringBytes);
    if (this.latestByOperation.has(operationId)) throw new Error(`Bounded-live side-effect operation already exists: ${operationId}; automatic retry is forbidden`);
    const unresolved = this.inspect().unresolvedOperationIds;
    if (unresolved.length > 0) throw new Error(`Bounded-live side-effect journal has unresolved operation(s): ${unresolved.join(", ")}; manual reconciliation is required`);
    const kind = prepareKind(input.kind);
    const sampleId = input.sampleId === undefined ? undefined : prepareIdentity(input.sampleId, "Bounded-live side-effect sampleId", this.maxStringBytes);
    const outputSha256 = input.outputSha256 === undefined ? undefined : prepareSha256(input.outputSha256, "Bounded-live side-effect outputSha256");
    if (kind === "publication" && (sampleId === undefined || outputSha256 === undefined)) throw new Error("Bounded-live publication reservation requires sampleId and outputSha256");
    if (kind === "reference_restore" && (sampleId !== undefined || outputSha256 !== undefined)) throw new Error("Bounded-live reference restore reservation must not carry sample/output fields");
    const payload: ReservationPayload = deepFreeze({
      eventType: "operation_reserved",
      kind,
      operationId,
      idempotencyKey: prepareIdentity(input.idempotencyKey, "Bounded-live side-effect idempotencyKey", this.maxStringBytes),
      sinkId: prepareIdentity(input.sinkId, "Bounded-live side-effect sinkId", this.maxStringBytes),
      authorityId: prepareIdentity(input.authorityId, "Bounded-live side-effect authorityId", this.maxStringBytes),
      subjectId: prepareIdentity(input.subjectId, "Bounded-live side-effect subjectId", this.maxStringBytes),
      sampleId,
      outputSha256,
      reservedAt: prepareTimestamp(input.reservedAt, "Bounded-live side-effect reservedAt"),
      automaticRetryAllowed: false as const,
    });
    const event = await prepareEvent(payload, this.maxEventBytes);
    await this.append(event);
    return event;
  }

  async recordCommit(input: BoundedLiveSideEffectCommitInput): Promise<BoundedLiveSideEffectEvent> {
    this.assertStorageUnchanged();
    const reservation = this.requireReservation(input.operationId);
    const latest = this.latestByOperation.get(reservation.operationId);
    if (!latest || latest.payload.eventType !== "operation_reserved") throw new Error("Bounded-live side-effect commit requires unresolved reservation");
    const payload: CommitPayload = deepFreeze({
      eventType: "operation_committed",
      kind: reservation.kind,
      operationId: reservation.operationId,
      idempotencyKey: reservation.idempotencyKey,
      sinkId: reservation.sinkId,
      authorityId: reservation.authorityId,
      subjectId: reservation.subjectId,
      sampleId: reservation.sampleId,
      outputSha256: reservation.outputSha256,
      externalReference: prepareIdentity(input.externalReference, "Bounded-live side-effect externalReference", this.maxStringBytes),
      committedAt: prepareTimestamp(input.committedAt, "Bounded-live side-effect committedAt"),
      automaticRetryAllowed: false as const,
    });
    if (Date.parse(payload.committedAt) < Date.parse(reservation.reservedAt)) throw new Error("Bounded-live side-effect commit cannot predate reservation");
    const event = await prepareEvent(payload, this.maxEventBytes);
    await this.append(event);
    return event;
  }

  async recordError(input: BoundedLiveSideEffectErrorInput): Promise<BoundedLiveSideEffectEvent> {
    this.assertStorageUnchanged();
    const reservation = this.requireReservation(input.operationId);
    const latest = this.latestByOperation.get(reservation.operationId);
    if (!latest || latest.payload.eventType !== "operation_reserved") throw new Error("Bounded-live side-effect error requires unresolved reservation");
    const payload: ErrorPayload = deepFreeze({
      eventType: "operation_error",
      kind: reservation.kind,
      operationId: reservation.operationId,
      idempotencyKey: reservation.idempotencyKey,
      sinkId: reservation.sinkId,
      authorityId: reservation.authorityId,
      subjectId: reservation.subjectId,
      sampleId: reservation.sampleId,
      outputSha256: reservation.outputSha256,
      observedAt: prepareTimestamp(input.observedAt, "Bounded-live side-effect error observedAt"),
      error: prepareSanitizedText(input.error, "Bounded-live side-effect error", this.maxStringBytes),
      sideEffectState: "unknown" as const,
      manualReconciliationRequired: true as const,
      automaticRetryAllowed: false as const,
    });
    const event = await prepareEvent(payload, this.maxEventBytes);
    await this.append(event);
    return event;
  }

  latest(operationId: string): BoundedLiveSideEffectEvent | undefined {
    return this.latestByOperation.get(operationId);
  }

  list(): readonly BoundedLiveSideEffectEvent[] {
    return [...this.events];
  }

  inspect(): BoundedLiveSideEffectJournalState {
    const committedOperationIds: string[] = [];
    const unresolvedOperationIds: string[] = [];
    const unknownSideEffectOperationIds: string[] = [];
    for (const [operationId, event] of this.latestByOperation.entries()) {
      if (event.payload.eventType === "operation_committed") committedOperationIds.push(operationId);
      else {
        unresolvedOperationIds.push(operationId);
        if (event.payload.eventType === "operation_error") unknownSideEffectOperationIds.push(operationId);
      }
    }
    return deepFreeze({
      eventCount: this.events.length,
      operationCount: this.reservations.size,
      committedOperationIds: committedOperationIds.sort(),
      unresolvedOperationIds: unresolvedOperationIds.sort(),
      unknownSideEffectOperationIds: unknownSideEffectOperationIds.sort(),
      automaticRetryAllowed: false as const,
    });
  }

  private async load(): Promise<void> {
    if (!existsSync(this.filePath)) return;
    const size = statSync(this.filePath).size;
    if (size > this.maxFileBytes) throw new Error("Bounded-live side-effect journal exceeds maxFileBytes");
    const raw = readFileSync(this.filePath, "utf8");
    this.expectedFileSize = utf8ByteLength(raw);
    if (!raw) return;
    if (!raw.endsWith("\n")) throw new Error("Bounded-live side-effect journal is not newline-terminated; possible partial write");
    const lines = raw.slice(0, -1).split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].trim()) throw new Error(`Bounded-live side-effect journal contains empty record at line ${index + 1}`);
      const persisted = parsePersisted(lines[index], index + 1);
      if (persisted.sequence !== index + 1) throw new Error(`Bounded-live side-effect journal sequence mismatch at line ${index + 1}`);
      await verifyBoundedLiveSideEffectEvent(persisted.event, this.maxEventBytes, this.maxStringBytes);
      this.assertTransition(persisted.event, index + 1);
      this.admit(persisted.event);
    }
  }

  private async append(event: BoundedLiveSideEffectEvent): Promise<void> {
    await verifyBoundedLiveSideEffectEvent(event, this.maxEventBytes, this.maxStringBytes);
    this.assertTransition(event);
    const sequence = this.events.length + 1;
    const line = `${JSON.stringify({ schemaVersion: BOUNDED_LIVE_SIDE_EFFECT_JOURNAL_SCHEMA_VERSION, sequence, event })}\n`;
    const bytes = utf8ByteLength(line);
    if (bytes > this.maxEventBytes) throw new Error("Bounded-live side-effect event exceeds maxEventBytes");
    if (this.expectedFileSize + bytes > this.maxFileBytes) throw new Error("Bounded-live side-effect journal append would exceed maxFileBytes");
    const handle = openSync(this.filePath, "a", 0o600);
    try {
      writeFileSync(handle, line, "utf8");
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    this.expectedFileSize += bytes;
    this.admit(event);
  }

  private assertTransition(event: BoundedLiveSideEffectEvent, lineNumber?: number): void {
    const label = lineNumber === undefined ? "Bounded-live side-effect journal" : `Bounded-live side-effect journal line ${lineNumber}`;
    const previous = this.latestByOperation.get(event.payload.operationId);
    if (event.payload.eventType === "operation_reserved") {
      if (previous) throw new Error(`${label} duplicates operation reservation`);
      if ([...this.latestByOperation.values()].some((item) => item.payload.eventType !== "operation_committed")) throw new Error(`${label} creates concurrent side effect while another is unresolved`);
      return;
    }
    if (!previous || previous.payload.eventType !== "operation_reserved") throw new Error(`${label} terminal side-effect event requires prior unresolved reservation`);
    const reservation = previous.payload;
    if (event.payload.kind !== reservation.kind || event.payload.idempotencyKey !== reservation.idempotencyKey || event.payload.sinkId !== reservation.sinkId
      || event.payload.authorityId !== reservation.authorityId || event.payload.subjectId !== reservation.subjectId
      || event.payload.sampleId !== reservation.sampleId || event.payload.outputSha256 !== reservation.outputSha256) {
      throw new Error(`${label} side-effect terminal event drifts from reservation`);
    }
  }

  private admit(event: BoundedLiveSideEffectEvent): void {
    const frozen = deepFreeze(event);
    this.events.push(frozen);
    this.latestByOperation.set(frozen.payload.operationId, frozen);
    if (frozen.payload.eventType === "operation_reserved") this.reservations.set(frozen.payload.operationId, frozen.payload);
  }

  private requireReservation(operationIdInput: string): ReservationPayload {
    const operationId = prepareIdentity(operationIdInput, "Bounded-live side-effect operationId", this.maxStringBytes);
    const reservation = this.reservations.get(operationId);
    if (!reservation) throw new Error(`Bounded-live side-effect operation has no reservation: ${operationId}`);
    return reservation;
  }

  private assertStorageUnchanged(): void {
    const current = existsSync(this.filePath) ? statSync(this.filePath).size : 0;
    if (current !== this.expectedFileSize) throw new Error("Bounded-live side-effect journal changed outside this writer; reopen before writing");
  }
}

export async function verifyBoundedLiveSideEffectEvent(event: BoundedLiveSideEffectEvent, maxEventBytes = Number.MAX_SAFE_INTEGER, maxStringBytes = Number.MAX_SAFE_INTEGER): Promise<void> {
  if (!event || typeof event !== "object" || event.algorithm !== "sha256" || !event.payload || typeof event.payload !== "object") throw new Error("Bounded-live side-effect event envelope is invalid");
  normalizePayload(event.payload, maxStringBytes);
  const expected = await sha256Canonical(event.payload);
  if (event.eventSha256 !== expected || event.eventId !== `m5liveeffect:${expected.slice(0, 32).toLowerCase()}`) throw new Error("Bounded-live side-effect event digest is invalid");
  if (utf8ByteLength(stableStringify(event)) > maxEventBytes) throw new Error("Bounded-live side-effect event exceeds maxEventBytes");
}

async function prepareEvent(payload: BoundedLiveSideEffectPayload, maxEventBytes: number): Promise<BoundedLiveSideEffectEvent> {
  const eventSha256 = await sha256Canonical(payload);
  const event = deepFreeze({ algorithm: "sha256" as const, eventId: `m5liveeffect:${eventSha256.slice(0, 32).toLowerCase()}`, eventSha256, payload });
  if (utf8ByteLength(stableStringify(event)) > maxEventBytes) throw new Error("Bounded-live side-effect event exceeds maxEventBytes");
  return event;
}

function normalizePayload(payload: BoundedLiveSideEffectPayload, maxStringBytes: number): void {
  prepareKind(payload.kind);
  prepareIdentity(payload.operationId, "Bounded-live side-effect operationId", maxStringBytes);
  prepareIdentity(payload.idempotencyKey, "Bounded-live side-effect idempotencyKey", maxStringBytes);
  prepareIdentity(payload.sinkId, "Bounded-live side-effect sinkId", maxStringBytes);
  prepareIdentity(payload.authorityId, "Bounded-live side-effect authorityId", maxStringBytes);
  prepareIdentity(payload.subjectId, "Bounded-live side-effect subjectId", maxStringBytes);
  if (payload.sampleId !== undefined) prepareIdentity(payload.sampleId, "Bounded-live side-effect sampleId", maxStringBytes);
  if (payload.outputSha256 !== undefined) prepareSha256(payload.outputSha256, "Bounded-live side-effect outputSha256");
  if (payload.automaticRetryAllowed !== false) throw new Error("Bounded-live side-effect event cannot grant automatic retry");
  if (payload.eventType === "operation_reserved") prepareTimestamp(payload.reservedAt, "Bounded-live side-effect reservedAt");
  else if (payload.eventType === "operation_committed") {
    prepareIdentity(payload.externalReference, "Bounded-live side-effect externalReference", maxStringBytes);
    prepareTimestamp(payload.committedAt, "Bounded-live side-effect committedAt");
  } else if (payload.eventType === "operation_error") {
    prepareTimestamp(payload.observedAt, "Bounded-live side-effect observedAt");
    prepareSanitizedText(payload.error, "Bounded-live side-effect error", maxStringBytes);
    if (payload.sideEffectState !== "unknown" || payload.manualReconciliationRequired !== true) throw new Error("Bounded-live side-effect error must require manual reconciliation");
  } else throw new Error("Bounded-live side-effect eventType is invalid");
}

function parsePersisted(line: string, lineNumber: number): PersistedEntry {
  let value: unknown;
  try { value = JSON.parse(line); } catch (error) { throw new Error(`Bounded-live side-effect journal invalid JSON at line ${lineNumber}: ${safeError(error)}`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Bounded-live side-effect journal entry ${lineNumber} must be an object`);
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== BOUNDED_LIVE_SIDE_EFFECT_JOURNAL_SCHEMA_VERSION || !Number.isInteger(record.sequence) || Number(record.sequence) <= 0) throw new Error(`Bounded-live side-effect journal entry ${lineNumber} envelope is invalid`);
  return { schemaVersion: BOUNDED_LIVE_SIDE_EFFECT_JOURNAL_SCHEMA_VERSION, sequence: Number(record.sequence), event: record.event as BoundedLiveSideEffectEvent };
}

function prepareKind(value: unknown): BoundedLiveSideEffectKind {
  if (value !== "publication" && value !== "reference_restore") throw new Error("Bounded-live side-effect kind is invalid");
  return value;
}
function prepareIdentity(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must not be empty`);
  const prepared = value.trim();
  if (/\r|\n/.test(prepared)) throw new Error(`${label} must be single-line`);
  if (utf8ByteLength(prepared) > maxBytes) throw new Error(`${label} exceeds maxStringBytes`);
  if (sanitizeText(prepared) !== prepared) throw new Error(`${label} contains secret-like material`);
  return prepared;
}
function prepareSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9A-Fa-f]{64}$/.test(value)) throw new Error(`${label} must be a SHA-256 digest`);
  return value.toUpperCase();
}
function prepareTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`${label} must be a valid timestamp`);
  return new Date(value).toISOString();
}
function prepareSanitizedText(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must not be empty`);
  const prepared = sanitizeText(value).replace(/[\r\n]+/g, " ").trim();
  if (utf8ByteLength(prepared) > maxBytes) throw new Error(`${label} exceeds maxStringBytes`);
  return prepared;
}
function sanitizeText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [redacted]")
    .replace(/(authorization|api[_-]?key|access[_-]?token|password|secret|credential)\s*[:=]\s*(Bearer\s+)?[^\s,;]+/gi, "$1=[redacted]")
    .replace(/\b(?:ghp_|github_pat_|sk-(?:proj-)?|sb_secret_)[A-Za-z0-9_-]{16,}\b/g, "[redacted]");
}
function safeError(error: unknown): string { return sanitizeText(error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, " ").slice(0, 1024); }
function assertPositiveInteger(value: number, label: string): void { if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`); }
async function sha256Canonical(value: unknown): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("Web Crypto SHA-256 is unavailable in this runtime");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(stableStringify(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
}
function stableStringify(value: unknown): string { return JSON.stringify(sortJson(value)); }
function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, child]) => child !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, sortJson(child)]));
}
function utf8ByteLength(value: string): number { return new TextEncoder().encode(value).byteLength; }
function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}
