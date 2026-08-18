import type { RunLedgerRecord } from "../control-plane/contracts.js";
import { InMemoryRunLedger } from "../control-plane/run-ledger.js";
import type { InternalObservabilityEvent } from "../observability/internal-event.js";
import { verifyInternalObservabilityEvent } from "../observability/internal-event.js";
import type { EvalMeasurementSample } from "./eval-history.js";

export const EXECUTION_METRIC_PROJECTION_SCHEMA_VERSION = 1 as const;

export interface ExecutionMetricProjectionPolicy {
  readonly latencyMetricKey?: string;
  readonly costMetricKey?: string;
  readonly requireLatency?: boolean;
  readonly requireCost?: boolean;
  readonly requireTerminalObservabilityEvent?: boolean;
  readonly maxMetricKeyBytes: number;
}

export interface ExecutionMetricProjectionPayload {
  readonly runId: string;
  readonly projectId: string;
  readonly traceId: string;
  readonly runtimeId: string;
  readonly outcome: "failed" | "cancelled" | "succeeded";
  readonly latencyMs?: number;
  readonly costUsd?: number;
  readonly metricKeys: {
    readonly latency?: string;
    readonly cost?: string;
  };
  readonly sourceReferences: readonly string[];
}

export interface ExecutionMetricProjection {
  readonly schemaVersion: typeof EXECUTION_METRIC_PROJECTION_SCHEMA_VERSION;
  readonly algorithm: "sha256";
  readonly projectionId: string;
  readonly projectionSha256: string;
  readonly payload: ExecutionMetricProjectionPayload;
}

const TOP_LEVEL_FIELDS = new Set(["schemaVersion", "algorithm", "projectionId", "projectionSha256", "payload"]);
const PAYLOAD_FIELDS = new Set(["runId", "projectId", "traceId", "runtimeId", "outcome", "latencyMs", "costUsd", "metricKeys", "sourceReferences"]);
const METRIC_KEY_FIELDS = new Set(["latency", "cost"]);

export class ExecutionMetricProjector {
  private readonly policy: ExecutionMetricProjectionPolicy;

  constructor(policy: ExecutionMetricProjectionPolicy) {
    assertPositiveInteger(policy.maxMetricKeyBytes, "Execution metric maxMetricKeyBytes");
    const latencyMetricKey = policy.latencyMetricKey === undefined
      ? undefined
      : prepareMetricKey(policy.latencyMetricKey, "Execution latency metric key", policy.maxMetricKeyBytes);
    const costMetricKey = policy.costMetricKey === undefined
      ? undefined
      : prepareMetricKey(policy.costMetricKey, "Execution cost metric key", policy.maxMetricKeyBytes);
    if (policy.requireLatency && !latencyMetricKey) throw new Error("Execution metric policy requireLatency needs latencyMetricKey");
    if (policy.requireCost && !costMetricKey) throw new Error("Execution metric policy requireCost needs costMetricKey");
    this.policy = Object.freeze({ ...policy, latencyMetricKey, costMetricKey });
  }

  async project(
    record: RunLedgerRecord,
    terminalEvent?: InternalObservabilityEvent,
  ): Promise<ExecutionMetricProjection> {
    const canonical = validateCanonicalRunLedger(record);
    if (this.policy.requireTerminalObservabilityEvent && !terminalEvent) {
      throw new Error(`Execution metric projection for ${canonical.runId} requires terminal observability evidence`);
    }

    const sourceReferences = [`run-ledger:${canonical.runId}`];
    if (terminalEvent) {
      await verifyTerminalEvent(terminalEvent, canonical);
      sourceReferences.push(`observability:${terminalEvent.eventId}`);
    }

    const latencyMs = this.policy.latencyMetricKey === undefined
      ? undefined
      : readMetric(canonical, this.policy.latencyMetricKey, "latency");
    const costUsd = this.policy.costMetricKey === undefined
      ? undefined
      : readMetric(canonical, this.policy.costMetricKey, "cost");

    if (this.policy.requireLatency && latencyMs === undefined) {
      throw new Error(`Run Ledger ${canonical.runId} is missing required latency metric ${this.policy.latencyMetricKey}`);
    }
    if (this.policy.requireCost && costUsd === undefined) {
      throw new Error(`Run Ledger ${canonical.runId} is missing required cost metric ${this.policy.costMetricKey}`);
    }
    if (latencyMs === undefined && costUsd === undefined) {
      throw new Error(`Run Ledger ${canonical.runId} has no configured execution metric sample to project`);
    }

    const payload: ExecutionMetricProjectionPayload = deepFreeze({
      runId: canonical.runId,
      projectId: canonical.projectId,
      traceId: canonical.traceId,
      runtimeId: canonical.runtimeId,
      outcome: canonical.outcome,
      latencyMs,
      costUsd,
      metricKeys: {
        latency: latencyMs === undefined ? undefined : this.policy.latencyMetricKey,
        cost: costUsd === undefined ? undefined : this.policy.costMetricKey,
      },
      sourceReferences: [...sourceReferences].sort(),
    });
    const projectionSha256 = await sha256Canonical(payload);
    return deepFreeze({
      schemaVersion: EXECUTION_METRIC_PROJECTION_SCHEMA_VERSION,
      algorithm: "sha256" as const,
      projectionId: `execmetric:${projectionSha256.slice(0, 32).toLowerCase()}`,
      projectionSha256,
      payload,
    });
  }
}

export async function verifyExecutionMetricProjection(projection: ExecutionMetricProjection): Promise<void> {
  if (!isRecord(projection)) throw new Error("Execution metric projection must be an object");
  assertAllowedFields(projection, TOP_LEVEL_FIELDS, "Execution metric projection");
  for (const field of TOP_LEVEL_FIELDS) if (!(field in projection)) throw new Error(`Execution metric projection is missing field: ${field}`);
  if (projection.schemaVersion !== EXECUTION_METRIC_PROJECTION_SCHEMA_VERSION) throw new Error("Unsupported execution metric projection schema version");
  if (projection.algorithm !== "sha256") throw new Error("Execution metric projection algorithm must be sha256");
  if (!isRecord(projection.payload)) throw new Error("Execution metric projection payload must be an object");
  assertAllowedFields(projection.payload, PAYLOAD_FIELDS, "Execution metric projection payload");
  for (const field of ["runId", "projectId", "traceId", "runtimeId", "outcome", "metricKeys", "sourceReferences"]) {
    if (!(field in projection.payload)) throw new Error(`Execution metric projection payload is missing field: ${field}`);
  }

  for (const [field, value] of [
    ["runId", projection.payload.runId],
    ["projectId", projection.payload.projectId],
    ["traceId", projection.payload.traceId],
    ["runtimeId", projection.payload.runtimeId],
  ] as const) prepareReferenceIdentity(value, `Execution metric projection ${field}`);

  if (!["failed", "cancelled", "succeeded"].includes(projection.payload.outcome)) throw new Error("Execution metric projection outcome is invalid");
  if (!isRecord(projection.payload.metricKeys)) throw new Error("Execution metric projection metricKeys must be an object");
  assertAllowedFields(projection.payload.metricKeys, METRIC_KEY_FIELDS, "Execution metric projection metricKeys");

  if (projection.payload.latencyMs !== undefined) {
    prepareNonNegative(projection.payload.latencyMs, "Execution metric projection latencyMs");
    if (projection.payload.metricKeys.latency === undefined) throw new Error("Execution metric projection latencyMs requires metricKeys.latency");
    prepareMetricKey(projection.payload.metricKeys.latency, "Execution metric projection latency metric key", Number.MAX_SAFE_INTEGER);
  } else if (projection.payload.metricKeys.latency !== undefined) {
    throw new Error("Execution metric projection metricKeys.latency requires latencyMs");
  }
  if (projection.payload.costUsd !== undefined) {
    prepareNonNegative(projection.payload.costUsd, "Execution metric projection costUsd");
    if (projection.payload.metricKeys.cost === undefined) throw new Error("Execution metric projection costUsd requires metricKeys.cost");
    prepareMetricKey(projection.payload.metricKeys.cost, "Execution metric projection cost metric key", Number.MAX_SAFE_INTEGER);
  } else if (projection.payload.metricKeys.cost !== undefined) {
    throw new Error("Execution metric projection metricKeys.cost requires costUsd");
  }
  if (projection.payload.latencyMs === undefined && projection.payload.costUsd === undefined) throw new Error("Execution metric projection has no projected metric sample");

  if (!Array.isArray(projection.payload.sourceReferences) || projection.payload.sourceReferences.length === 0) {
    throw new Error("Execution metric projection requires source references");
  }
  const preparedReferences = projection.payload.sourceReferences.map((reference, index) => prepareReferenceIdentity(reference, `Execution metric projection sourceReferences[${index}]`));
  if (new Set(preparedReferences).size !== preparedReferences.length) throw new Error("Execution metric projection sourceReferences contain duplicates");
  const sortedReferences = [...preparedReferences].sort();
  if (JSON.stringify(preparedReferences) !== JSON.stringify(sortedReferences)) throw new Error("Execution metric projection sourceReferences are not canonically sorted");
  if (!preparedReferences.includes(`run-ledger:${projection.payload.runId}`)) throw new Error("Execution metric projection requires canonical Run Ledger source reference");

  const expected = await sha256Canonical(projection.payload);
  if (projection.projectionSha256 !== expected) throw new Error("Execution metric projection digest does not match canonical payload");
  if (projection.projectionId !== `execmetric:${expected.slice(0, 32).toLowerCase()}`) throw new Error("Execution metric projectionId does not match canonical payload");
}

export async function executionProjectionToEvalMeasurement(
  projection: ExecutionMetricProjection,
): Promise<EvalMeasurementSample> {
  await verifyExecutionMetricProjection(projection);
  return deepFreeze({
    latencyMs: projection.payload.latencyMs,
    costUsd: projection.payload.costUsd,
    sourceReferences: [...projection.payload.sourceReferences, `execution-metric:${projection.projectionId}`].sort(),
  });
}

function validateCanonicalRunLedger(record: RunLedgerRecord): RunLedgerRecord {
  const ledger = new InMemoryRunLedger();
  ledger.append(record);
  const canonical = ledger.get(record.runId);
  if (!canonical) throw new Error(`Execution metric projector could not validate Run Ledger record ${record.runId}`);
  return canonical;
}

async function verifyTerminalEvent(event: InternalObservabilityEvent, record: RunLedgerRecord): Promise<void> {
  await verifyInternalObservabilityEvent(event);
  if (event.payload.name !== "9router.run.terminal") throw new Error("Execution metric projection requires 9router.run.terminal observability event");
  if (event.payload.runId !== record.runId) throw new Error("Execution metric terminal event runId does not match Run Ledger");
  if (event.payload.projectId !== record.projectId) throw new Error("Execution metric terminal event projectId does not match Run Ledger");
  if (event.payload.traceId !== record.traceId) throw new Error("Execution metric terminal event traceId does not match Run Ledger");
  if (event.payload.attributes["router.run.outcome"] !== record.outcome) throw new Error("Execution metric terminal event outcome does not match Run Ledger");
  if (event.payload.attributes["router.runtime.id"] !== record.runtimeId) throw new Error("Execution metric terminal event runtimeId does not match Run Ledger");
}

function readMetric(record: RunLedgerRecord, key: string, label: string): number | undefined {
  const value = record.resourceMetrics[key];
  if (value === undefined) return undefined;
  return prepareNonNegative(value, `Run Ledger ${record.runId} ${label} metric ${key}`);
}

function prepareMetricKey(value: string, label: string, maxBytes: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must not be empty`);
  const key = value.trim();
  if (!/^[A-Za-z0-9_.-]+$/.test(key)) throw new Error(`${label} contains unsupported characters`);
  if (utf8ByteLength(key) > maxBytes) throw new Error(`${label} exceeds maxMetricKeyBytes`);
  if (/(authorization|api[_-]?key|access[_-]?token|password|secret|credential|cookie)/i.test(key)) throw new Error(`${label} is sensitive and cannot be projected`);
  return key;
}

function prepareReferenceIdentity(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must not be empty`);
  const prepared = value.trim();
  if (/\r|\n/.test(prepared)) throw new Error(`${label} must be single-line`);
  if (containsSecretLikeMaterial(prepared)) throw new Error(`${label} contains secret-like material`);
  return prepared;
}

function containsSecretLikeMaterial(value: string): boolean {
  return /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/i.test(value)
    || /(authorization|api[_-]?key|access[_-]?token|password|secret|credential|cookie)\s*[:=]/i.test(value)
    || /\bghp_[A-Za-z0-9]{20,}\b/.test(value)
    || /\bgithub_pat_[A-Za-z0-9_]{20,}\b/.test(value)
    || /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/.test(value);
}

function prepareNonNegative(value: number, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${label} must be finite and non-negative`);
  return value;
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
}

function assertAllowedFields(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  for (const field of Object.keys(value)) if (!allowed.has(field)) throw new Error(`${label} contains unknown field: ${field}`);
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
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, sortJson(child)]));
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}
