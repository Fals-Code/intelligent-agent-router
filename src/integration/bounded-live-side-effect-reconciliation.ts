import type {
  BoundedLiveSideEffectEvent,
  BoundedLiveSideEffectKind,
  JsonlBoundedLiveSideEffectJournal,
} from "./bounded-live-side-effect-journal.js";

export const BOUNDED_LIVE_SIDE_EFFECT_RECONCILIATION_SCHEMA_VERSION = 1 as const;

export interface BoundedLiveSideEffectProbeRequest {
  readonly kind: BoundedLiveSideEffectKind;
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly sinkId: string;
  readonly authorityId: string;
  readonly subjectId: string;
  readonly sampleId?: string;
  readonly outputSha256?: string;
}

export type BoundedLiveSideEffectProbeObservation =
  | {
      readonly status: "applied";
      readonly kind: BoundedLiveSideEffectKind;
      readonly idempotencyKey: string;
      readonly sinkId: string;
      readonly subjectId: string;
      readonly sampleId?: string;
      readonly outputSha256?: string;
      readonly externalReference: string;
      readonly observedAt: string;
    }
  | {
      readonly status: "absent";
      readonly kind: BoundedLiveSideEffectKind;
      readonly idempotencyKey: string;
      readonly sinkId: string;
      readonly authoritative: true;
      readonly observedAt: string;
    }
  | {
      readonly status: "unknown";
      readonly kind: BoundedLiveSideEffectKind;
      readonly idempotencyKey: string;
      readonly sinkId: string;
      readonly reason: string;
      readonly observedAt: string;
    };

export interface BoundedLiveSideEffectReconciliationProbe {
  readonly id: string;
  inspect(request: BoundedLiveSideEffectProbeRequest): Promise<BoundedLiveSideEffectProbeObservation>;
}

export type BoundedLiveSideEffectRecoveryClassification =
  | "consistent_committed"
  | "external_commit_observed"
  | "explicit_retry_eligible"
  | "manual_reconciliation_required";

export interface BoundedLiveSideEffectRecoveryPayload {
  readonly operationId: string;
  readonly kind: BoundedLiveSideEffectKind;
  readonly journalEventId: string;
  readonly journalEventType: "operation_reserved" | "operation_committed" | "operation_error";
  readonly idempotencyKey: string;
  readonly sinkId: string;
  readonly authorityId: string;
  readonly subjectId: string;
  readonly sampleId?: string;
  readonly outputSha256?: string;
  readonly probeId?: string;
  readonly probeStatus?: "applied" | "absent" | "unknown";
  readonly externalReference?: string;
  readonly classification: BoundedLiveSideEffectRecoveryClassification;
  readonly automaticRetryAllowed: false;
  readonly automaticMutationAllowed: false;
  readonly explicitOperatorActionRequired: boolean;
  readonly observedAt: string;
  readonly reason: string;
}

export interface BoundedLiveSideEffectRecoveryReport {
  readonly schemaVersion: typeof BOUNDED_LIVE_SIDE_EFFECT_RECONCILIATION_SCHEMA_VERSION;
  readonly algorithm: "sha256";
  readonly reconciliationId: string;
  readonly reconciliationSha256: string;
  readonly payload: BoundedLiveSideEffectRecoveryPayload;
}

/**
 * Read-only restart/crash reconciliation for bounded-live publication/restore effects.
 *
 * This coordinator never republishes, retries, restores, or mutates the durable
 * side-effect journal. It only correlates durable reservation/error/commit state
 * with an injected sink-specific observation and emits a content-addressed report.
 */
export class BoundedLiveSideEffectRecoveryCoordinator {
  async reconcile(input: {
    readonly journal: JsonlBoundedLiveSideEffectJournal;
    readonly operationId: string;
    readonly probe: BoundedLiveSideEffectReconciliationProbe;
  }): Promise<BoundedLiveSideEffectRecoveryReport> {
    const operationId = prepareIdentity(input.operationId, "Bounded-live recovery operationId");
    const probeId = prepareIdentity(input.probe.id, "Bounded-live recovery probe id");
    const latest = input.journal.latest(operationId);
    if (!latest) throw new Error(`Bounded-live recovery operation is not present in durable journal: ${operationId}`);

    if (latest.payload.eventType === "operation_committed") {
      return prepareReport({
        event: latest,
        classification: "consistent_committed",
        externalReference: latest.payload.externalReference,
        observedAt: latest.payload.committedAt,
        explicitOperatorActionRequired: false,
        reason: "Durable side-effect journal already contains an exact committed terminal event.",
      });
    }

    const request = requestFromEvent(latest);
    let observation: BoundedLiveSideEffectProbeObservation;
    try {
      observation = await input.probe.inspect(request);
      validateObservation(observation, request);
    } catch (error) {
      return prepareReport({
        event: latest,
        probeId,
        probeStatus: "unknown",
        classification: "manual_reconciliation_required",
        observedAt: new Date().toISOString(),
        explicitOperatorActionRequired: true,
        reason: `Recovery probe failed or returned invalid evidence: ${safeError(error)}`,
      });
    }

    if (observation.status === "applied") {
      const drift = appliedObservationDrift(observation, request);
      if (drift) {
        return prepareReport({
          event: latest,
          probeId,
          probeStatus: observation.status,
          classification: "manual_reconciliation_required",
          observedAt: observation.observedAt,
          explicitOperatorActionRequired: true,
          reason: `Sink reports an applied side effect but authoritative facts drift from durable reservation: ${drift}`,
        });
      }
      return prepareReport({
        event: latest,
        probeId,
        probeStatus: observation.status,
        classification: "external_commit_observed",
        externalReference: observation.externalReference,
        observedAt: observation.observedAt,
        explicitOperatorActionRequired: true,
        reason: "Sink proves the exact reserved side effect already occurred; durable journal closure requires explicit reconciliation and must not republish.",
      });
    }

    if (observation.status === "absent") {
      if (latest.payload.eventType === "operation_reserved" && observation.authoritative === true) {
        return prepareReport({
          event: latest,
          probeId,
          probeStatus: observation.status,
          classification: "explicit_retry_eligible",
          observedAt: observation.observedAt,
          explicitOperatorActionRequired: true,
          reason: "Authoritative sink state confirms the reserved side effect is absent. Any retry remains explicit and must reuse the sink idempotency contract; automatic retry is forbidden.",
        });
      }
      return prepareReport({
        event: latest,
        probeId,
        probeStatus: observation.status,
        classification: "manual_reconciliation_required",
        observedAt: observation.observedAt,
        explicitOperatorActionRequired: true,
        reason: "A prior operation_error recorded unknown side-effect state; absence evidence alone does not automatically clear that uncertainty.",
      });
    }

    return prepareReport({
      event: latest,
      probeId,
      probeStatus: observation.status,
      classification: "manual_reconciliation_required",
      observedAt: observation.observedAt,
      explicitOperatorActionRequired: true,
      reason: `Sink could not prove whether the side effect occurred: ${prepareText(observation.reason, "Bounded-live recovery unknown reason")}`,
    });
  }
}

export async function verifyBoundedLiveSideEffectRecoveryReport(report: BoundedLiveSideEffectRecoveryReport): Promise<void> {
  if (!report || typeof report !== "object") throw new Error("Bounded-live recovery report must be an object");
  if (report.schemaVersion !== BOUNDED_LIVE_SIDE_EFFECT_RECONCILIATION_SCHEMA_VERSION || report.algorithm !== "sha256") {
    throw new Error("Bounded-live recovery report envelope is invalid");
  }
  validatePayload(report.payload);
  const expected = await sha256Canonical(report.payload);
  if (report.reconciliationSha256 !== expected || report.reconciliationId !== `m5livereconcile:${expected.slice(0, 32).toLowerCase()}`) {
    throw new Error("Bounded-live recovery report digest is invalid");
  }
}

function requestFromEvent(event: BoundedLiveSideEffectEvent): BoundedLiveSideEffectProbeRequest {
  const payload = event.payload;
  return Object.freeze({
    kind: payload.kind,
    operationId: payload.operationId,
    idempotencyKey: payload.idempotencyKey,
    sinkId: payload.sinkId,
    authorityId: payload.authorityId,
    subjectId: payload.subjectId,
    sampleId: payload.sampleId,
    outputSha256: payload.outputSha256,
  });
}

function validateObservation(observation: BoundedLiveSideEffectProbeObservation, request: BoundedLiveSideEffectProbeRequest): void {
  if (!observation || typeof observation !== "object") throw new Error("Bounded-live recovery probe observation must be an object");
  if (!["applied", "absent", "unknown"].includes(observation.status)) throw new Error("Bounded-live recovery probe status is invalid");
  if (observation.kind !== request.kind || observation.idempotencyKey !== request.idempotencyKey || observation.sinkId !== request.sinkId) {
    throw new Error("Bounded-live recovery probe identity does not match durable reservation");
  }
  prepareTimestamp(observation.observedAt, "Bounded-live recovery probe observedAt");
  if (observation.status === "applied") {
    prepareIdentity(observation.subjectId, "Bounded-live recovery applied subjectId");
    prepareIdentity(observation.externalReference, "Bounded-live recovery applied externalReference");
    if (observation.sampleId !== undefined) prepareIdentity(observation.sampleId, "Bounded-live recovery applied sampleId");
    if (observation.outputSha256 !== undefined) prepareSha256(observation.outputSha256, "Bounded-live recovery applied outputSha256");
  } else if (observation.status === "absent") {
    if (observation.authoritative !== true) throw new Error("Bounded-live recovery absent observation must be authoritative");
  } else {
    prepareText(observation.reason, "Bounded-live recovery unknown reason");
  }
}

function appliedObservationDrift(observation: Extract<BoundedLiveSideEffectProbeObservation, { status: "applied" }>, request: BoundedLiveSideEffectProbeRequest): string | undefined {
  if (observation.subjectId !== request.subjectId) return "subjectId";
  if (observation.sampleId !== request.sampleId) return "sampleId";
  if (normalizeOptionalSha(observation.outputSha256) !== normalizeOptionalSha(request.outputSha256)) return "outputSha256";
  return undefined;
}

async function prepareReport(input: {
  readonly event: BoundedLiveSideEffectEvent;
  readonly probeId?: string;
  readonly probeStatus?: "applied" | "absent" | "unknown";
  readonly externalReference?: string;
  readonly classification: BoundedLiveSideEffectRecoveryClassification;
  readonly observedAt: string;
  readonly explicitOperatorActionRequired: boolean;
  readonly reason: string;
}): Promise<BoundedLiveSideEffectRecoveryReport> {
  const event = input.event;
  const payload: BoundedLiveSideEffectRecoveryPayload = deepFreeze({
    operationId: event.payload.operationId,
    kind: event.payload.kind,
    journalEventId: event.eventId,
    journalEventType: event.payload.eventType,
    idempotencyKey: event.payload.idempotencyKey,
    sinkId: event.payload.sinkId,
    authorityId: event.payload.authorityId,
    subjectId: event.payload.subjectId,
    sampleId: event.payload.sampleId,
    outputSha256: event.payload.outputSha256,
    probeId: input.probeId,
    probeStatus: input.probeStatus,
    externalReference: input.externalReference,
    classification: input.classification,
    automaticRetryAllowed: false,
    automaticMutationAllowed: false,
    explicitOperatorActionRequired: input.explicitOperatorActionRequired,
    observedAt: prepareTimestamp(input.observedAt, "Bounded-live recovery observedAt"),
    reason: prepareText(input.reason, "Bounded-live recovery reason"),
  });
  validatePayload(payload);
  const reconciliationSha256 = await sha256Canonical(payload);
  return deepFreeze({
    schemaVersion: BOUNDED_LIVE_SIDE_EFFECT_RECONCILIATION_SCHEMA_VERSION,
    algorithm: "sha256" as const,
    reconciliationId: `m5livereconcile:${reconciliationSha256.slice(0, 32).toLowerCase()}`,
    reconciliationSha256,
    payload,
  });
}

function validatePayload(payload: BoundedLiveSideEffectRecoveryPayload): void {
  prepareIdentity(payload.operationId, "Bounded-live recovery payload operationId");
  if (payload.kind !== "publication" && payload.kind !== "reference_restore") throw new Error("Bounded-live recovery payload kind is invalid");
  prepareIdentity(payload.journalEventId, "Bounded-live recovery payload journalEventId");
  if (!["operation_reserved", "operation_committed", "operation_error"].includes(payload.journalEventType)) throw new Error("Bounded-live recovery payload journalEventType is invalid");
  prepareIdentity(payload.idempotencyKey, "Bounded-live recovery payload idempotencyKey");
  prepareIdentity(payload.sinkId, "Bounded-live recovery payload sinkId");
  prepareIdentity(payload.authorityId, "Bounded-live recovery payload authorityId");
  prepareIdentity(payload.subjectId, "Bounded-live recovery payload subjectId");
  if (payload.sampleId !== undefined) prepareIdentity(payload.sampleId, "Bounded-live recovery payload sampleId");
  if (payload.outputSha256 !== undefined) prepareSha256(payload.outputSha256, "Bounded-live recovery payload outputSha256");
  if (payload.probeId !== undefined) prepareIdentity(payload.probeId, "Bounded-live recovery payload probeId");
  if (payload.probeStatus !== undefined && !["applied", "absent", "unknown"].includes(payload.probeStatus)) throw new Error("Bounded-live recovery payload probeStatus is invalid");
  if (payload.externalReference !== undefined) prepareIdentity(payload.externalReference, "Bounded-live recovery payload externalReference");
  if (!["consistent_committed", "external_commit_observed", "explicit_retry_eligible", "manual_reconciliation_required"].includes(payload.classification)) throw new Error("Bounded-live recovery classification is invalid");
  if (payload.automaticRetryAllowed !== false || payload.automaticMutationAllowed !== false) throw new Error("Bounded-live recovery automatic action flags must remain false");
  if (typeof payload.explicitOperatorActionRequired !== "boolean") throw new Error("Bounded-live recovery explicitOperatorActionRequired must be boolean");
  prepareTimestamp(payload.observedAt, "Bounded-live recovery payload observedAt");
  prepareText(payload.reason, "Bounded-live recovery payload reason");
}

function normalizeOptionalSha(value: string | undefined): string | undefined {
  return value === undefined ? undefined : prepareSha256(value, "Bounded-live recovery SHA-256");
}
function prepareSha256(value: unknown, label: string): string {
  const prepared = prepareIdentity(value, label).toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(prepared)) throw new Error(`${label} must be SHA-256`);
  return prepared;
}
function prepareIdentity(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || /[\r\n]/.test(value)) throw new Error(`${label} is invalid`);
  const prepared = value.trim();
  if (new TextEncoder().encode(prepared).byteLength > 2048) throw new Error(`${label} exceeds 2048 bytes`);
  return prepared;
}
function prepareText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must not be empty`);
  const prepared = value.replace(/[\r\n]+/g, " ").trim();
  if (new TextEncoder().encode(prepared).byteLength > 4096) throw new Error(`${label} exceeds 4096 bytes`);
  return prepared;
}
function prepareTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`${label} must be a valid timestamp`);
  return new Date(value).toISOString();
}
function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [redacted]")
    .replace(/(authorization|api[_-]?key|access[_-]?token|password|secret|credential)\s*[:=]\s*(Bearer\s+)?[^\s,;]+/gi, "$1=[redacted]")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 2048);
}
async function sha256Canonical(value: unknown): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("Web Crypto SHA-256 is unavailable in this runtime");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(stableStringify(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
}
function stableStringify(value: unknown): string { return JSON.stringify(sortJson(value)); }
function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sortJson(item)]));
}
function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}
