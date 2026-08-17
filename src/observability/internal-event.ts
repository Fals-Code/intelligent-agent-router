export const INTERNAL_OBSERVABILITY_EVENT_SCHEMA_VERSION = 1 as const;

export type InternalObservabilityEventName =
  | "9router.runtime.reconciled"
  | "9router.verification.completed"
  | "9router.publication.completed"
  | "9router.run.terminal";

export type ObservabilitySeverity = "debug" | "info" | "warn" | "error";
export type ObservabilityAttributeValue = string | number | boolean | null;
export type ObservabilityLinkType =
  | "runtime_session"
  | "evidence_bundle"
  | "run_ledger"
  | "publication"
  | "source"
  | "other";

export interface ObservabilityLink {
  readonly type: ObservabilityLinkType;
  readonly reference: string;
}

export interface InternalObservabilityEventPayload {
  readonly name: InternalObservabilityEventName;
  readonly occurredAt: string;
  readonly severity: ObservabilitySeverity;
  readonly traceId: string;
  readonly runId?: string;
  readonly projectId?: string;
  readonly attributes: Readonly<Record<string, ObservabilityAttributeValue>>;
  readonly links: readonly ObservabilityLink[];
}

export interface InternalObservabilityEvent {
  readonly schemaVersion: typeof INTERNAL_OBSERVABILITY_EVENT_SCHEMA_VERSION;
  readonly algorithm: "sha256";
  readonly eventId: string;
  readonly payload: InternalObservabilityEventPayload;
}

export interface CreateInternalObservabilityEventInput {
  readonly name: InternalObservabilityEventName;
  readonly occurredAt: string;
  readonly severity?: ObservabilitySeverity;
  readonly traceId: string;
  readonly runId?: string;
  readonly projectId?: string;
  readonly attributes?: Readonly<Record<string, ObservabilityAttributeValue>>;
  readonly links?: readonly ObservabilityLink[];
}

export interface InternalObservabilityEventBuilderOptions {
  readonly maxEventBytes: number;
  readonly maxAttributes: number;
  readonly maxLinks: number;
  readonly maxStringBytes: number;
}

const TOP_LEVEL_FIELDS = new Set(["schemaVersion", "algorithm", "eventId", "payload"]);
const PAYLOAD_FIELDS = new Set([
  "name",
  "occurredAt",
  "severity",
  "traceId",
  "runId",
  "projectId",
  "attributes",
  "links",
]);
const EVENT_NAMES = new Set<InternalObservabilityEventName>([
  "9router.runtime.reconciled",
  "9router.verification.completed",
  "9router.publication.completed",
  "9router.run.terminal",
]);
const SEVERITIES = new Set<ObservabilitySeverity>(["debug", "info", "warn", "error"]);
const LINK_TYPES = new Set<ObservabilityLinkType>([
  "runtime_session",
  "evidence_bundle",
  "run_ledger",
  "publication",
  "source",
  "other",
]);
const FORBIDDEN_ATTRIBUTE_SEGMENTS = new Set([
  "task",
  "prompt",
  "workspace",
  "output",
  "patch",
  "body",
  "content",
  "password",
  "secret",
  "token",
  "credential",
  "authorization",
  "cookie",
]);

export class InternalObservabilityEventBuilder {
  constructor(private readonly options: InternalObservabilityEventBuilderOptions) {
    assertPositiveInteger(options.maxEventBytes, "Observability maxEventBytes");
    assertPositiveInteger(options.maxAttributes, "Observability maxAttributes");
    assertPositiveInteger(options.maxLinks, "Observability maxLinks");
    assertPositiveInteger(options.maxStringBytes, "Observability maxStringBytes");
  }

  async create(input: CreateInternalObservabilityEventInput): Promise<InternalObservabilityEvent> {
    assertEventName(input.name);
    assertTimestamp(input.occurredAt, "Observability occurredAt");
    const severity = input.severity ?? "info";
    if (!SEVERITIES.has(severity)) throw new Error(`Observability severity is invalid: ${String(severity)}`);

    const payload: InternalObservabilityEventPayload = deepFreeze({
      name: input.name,
      occurredAt: input.occurredAt,
      severity,
      traceId: prepareIdentity(input.traceId, "Observability traceId", this.options.maxStringBytes),
      runId: input.runId === undefined ? undefined : prepareIdentity(input.runId, "Observability runId", this.options.maxStringBytes),
      projectId: input.projectId === undefined ? undefined : prepareIdentity(input.projectId, "Observability projectId", this.options.maxStringBytes),
      attributes: prepareAttributes(input.attributes ?? {}, this.options),
      links: prepareLinks(input.links ?? [], this.options),
    });

    const digest = await sha256Canonical(payload);
    const event: InternalObservabilityEvent = deepFreeze({
      schemaVersion: INTERNAL_OBSERVABILITY_EVENT_SCHEMA_VERSION,
      algorithm: "sha256" as const,
      eventId: `obs:${digest.slice(0, 32).toLowerCase()}`,
      payload,
    });
    assertEventBytes(event, this.options.maxEventBytes);
    return event;
  }
}

export async function verifyInternalObservabilityEvent(event: InternalObservabilityEvent, options?: InternalObservabilityEventBuilderOptions): Promise<void> {
  assertExactFields(event as unknown as Record<string, unknown>, TOP_LEVEL_FIELDS, "Observability event");
  if (event.schemaVersion !== INTERNAL_OBSERVABILITY_EVENT_SCHEMA_VERSION) throw new Error(`Unsupported observability event schema version: ${String(event.schemaVersion)}`);
  if (event.algorithm !== "sha256") throw new Error("Observability event algorithm must be sha256");
  if (!isRecord(event.payload)) throw new Error("Observability event payload must be an object");
  assertExactFields(event.payload as unknown as Record<string, unknown>, PAYLOAD_FIELDS, "Observability payload");
  assertEventName(event.payload.name);
  assertTimestamp(event.payload.occurredAt, "Observability occurredAt");
  if (!SEVERITIES.has(event.payload.severity)) throw new Error("Observability severity is invalid");

  const verificationOptions = options ?? { maxEventBytes: Number.MAX_SAFE_INTEGER, maxAttributes: Number.MAX_SAFE_INTEGER, maxLinks: Number.MAX_SAFE_INTEGER, maxStringBytes: Number.MAX_SAFE_INTEGER };
  const prepared: InternalObservabilityEventPayload = deepFreeze({
    name: event.payload.name,
    occurredAt: event.payload.occurredAt,
    severity: event.payload.severity,
    traceId: prepareIdentity(event.payload.traceId, "Observability traceId", verificationOptions.maxStringBytes),
    runId: event.payload.runId === undefined ? undefined : prepareIdentity(event.payload.runId, "Observability runId", verificationOptions.maxStringBytes),
    projectId: event.payload.projectId === undefined ? undefined : prepareIdentity(event.payload.projectId, "Observability projectId", verificationOptions.maxStringBytes),
    attributes: prepareAttributes(event.payload.attributes, verificationOptions),
    links: prepareLinks(event.payload.links, verificationOptions),
  });
  if (stableStringify(prepared) !== stableStringify(event.payload)) throw new Error("Observability event payload is not canonically normalized");

  const expectedDigest = await sha256Canonical(event.payload);
  const expectedEventId = `obs:${expectedDigest.slice(0, 32).toLowerCase()}`;
  if (event.eventId !== expectedEventId) throw new Error("Observability eventId does not match canonical payload");
  assertEventBytes(event, verificationOptions.maxEventBytes);
}

function prepareAttributes(attributes: Readonly<Record<string, ObservabilityAttributeValue>>, options: InternalObservabilityEventBuilderOptions): Readonly<Record<string, ObservabilityAttributeValue>> {
  if (!isRecord(attributes)) throw new Error("Observability attributes must be an object");
  const entries = Object.entries(attributes);
  if (entries.length > options.maxAttributes) throw new Error(`Observability attributes exceed maxAttributes: count=${entries.length} max=${options.maxAttributes}`);
  const prepared: Record<string, ObservabilityAttributeValue> = {};
  for (const [rawKey, rawValue] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    const key = rawKey.trim().toLowerCase();
    if (!/^router\.[a-z0-9_.-]+$/.test(key)) throw new Error(`Observability attribute key must use router.* namespace: ${rawKey}`);
    const segments = key.split(/[._-]/g);
    if (segments.some((segment) => FORBIDDEN_ATTRIBUTE_SEGMENTS.has(segment))) throw new Error(`Observability attribute key may expose sensitive/raw payload data: ${key}`);
    if (rawValue !== null && typeof rawValue !== "string" && typeof rawValue !== "number" && typeof rawValue !== "boolean") throw new Error(`Observability attribute ${key} must be a scalar value`);
    if (typeof rawValue === "number" && !Number.isFinite(rawValue)) throw new Error(`Observability attribute ${key} must be finite`);
    prepared[key] = typeof rawValue === "string" ? preparePublicText(rawValue, `Observability attribute ${key}`, options.maxStringBytes) : rawValue;
  }
  return deepFreeze(prepared);
}

function prepareLinks(links: readonly ObservabilityLink[], options: InternalObservabilityEventBuilderOptions): readonly ObservabilityLink[] {
  if (!Array.isArray(links)) throw new Error("Observability links must be an array");
  if (links.length > options.maxLinks) throw new Error(`Observability links exceed maxLinks: count=${links.length} max=${options.maxLinks}`);
  const seen = new Set<string>();
  const prepared = links.map((link, index) => {
    if (!isRecord(link)) throw new Error(`Observability link[${index}] must be an object`);
    const fields = Object.keys(link);
    if (fields.some((field) => field !== "type" && field !== "reference")) throw new Error(`Observability link[${index}] contains unknown fields`);
    if (!LINK_TYPES.has(link.type as ObservabilityLinkType)) throw new Error(`Observability link[${index}] type is invalid`);
    const reference = prepareIdentity(String(link.reference ?? ""), `Observability link[${index}] reference`, options.maxStringBytes);
    const key = `${String(link.type)}:${reference}`;
    if (seen.has(key)) throw new Error(`Observability link is duplicated: ${key}`);
    seen.add(key);
    return Object.freeze({ type: link.type as ObservabilityLinkType, reference });
  });
  return deepFreeze(prepared);
}

function prepareIdentity(value: string, label: string, maxBytes: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must not be empty`);
  const trimmed = value.trim();
  assertStringBytes(trimmed, label, maxBytes);
  if (containsSecretLikeMaterial(trimmed)) throw new Error(`${label} contains secret-like material`);
  if (/[\r\n]/.test(trimmed)) throw new Error(`${label} must be single-line`);
  return trimmed;
}

function preparePublicText(value: string, label: string, maxBytes: number): string {
  const sanitized = sanitizeText(value);
  assertStringBytes(sanitized, label, maxBytes);
  return sanitized;
}

function sanitizeText(value: string): string {
  return value.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [redacted]").replace(/(authorization|api[_-]?key|access[_-]?token|password|secret|credential|cookie)\s*[:=]\s*(Bearer\s+)?[^\s,;]+/gi, "$1=[redacted]");
}

function containsSecretLikeMaterial(value: string): boolean {
  return /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/i.test(value) || /(authorization|api[_-]?key|access[_-]?token|password|secret|credential|cookie)\s*[:=]/i.test(value) || /\bghp_[A-Za-z0-9]{20,}\b/.test(value) || /\bgithub_pat_[A-Za-z0-9_]{20,}\b/.test(value) || /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/.test(value);
}

function assertEventName(value: InternalObservabilityEventName): void { if (!EVENT_NAMES.has(value)) throw new Error(`Observability event name is invalid: ${String(value)}`); }
function assertTimestamp(value: string, label: string): void { if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`${label} must be a valid timestamp`); }
function assertStringBytes(value: string, label: string, maxBytes: number): void { if (utf8ByteLength(value) > maxBytes) throw new Error(`${label} exceeds maxStringBytes: bytes=${utf8ByteLength(value)} max=${maxBytes}`); }
function assertEventBytes(event: InternalObservabilityEvent, maxBytes: number): void { const bytes = utf8ByteLength(stableStringify(event)); if (bytes > maxBytes) throw new Error(`Observability event exceeds maxEventBytes: bytes=${bytes} max=${maxBytes}`); }
function assertPositiveInteger(value: number, label: string): void { if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`); }
function assertExactFields(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void { for (const field of Object.keys(value)) if (!allowed.has(field)) throw new Error(`${label} contains unknown field: ${field}`); for (const field of allowed) if (!(field in value) && field !== "runId" && field !== "projectId") throw new Error(`${label} is missing field: ${field}`); }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
async function sha256Canonical(value: unknown): Promise<string> { if (!globalThis.crypto?.subtle) throw new Error("Web Crypto SHA-256 is unavailable in this runtime"); const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(stableStringify(value))); return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase(); }
function stableStringify(value: unknown): string { return JSON.stringify(sortJson(value)); }
function sortJson(value: unknown): unknown { if (Array.isArray(value)) return value.map(sortJson); if (!value || typeof value !== "object") return value; return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, child]) => child !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, sortJson(child)])); }
function utf8ByteLength(value: string): number { return new TextEncoder().encode(value).byteLength; }
function deepFreeze<T>(value: T): T { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value; Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); return value; }
