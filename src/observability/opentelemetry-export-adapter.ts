import { verifyInternalObservabilityEvent, type InternalObservabilityEvent, type ObservabilityAttributeValue } from "./internal-event.js";

export type OpenTelemetryAttributeValue = string | number | boolean;
export interface OpenTelemetryResource { readonly attributes: Readonly<Record<string, OpenTelemetryAttributeValue>>; }
export interface OpenTelemetryInstrumentationScope { readonly name: string; readonly version: string; }
export interface OpenTelemetrySpanEventRecord { readonly name: string; readonly time: string; readonly attributes: Readonly<Record<string, OpenTelemetryAttributeValue>>; }
export interface OpenTelemetrySpanRecord {
  readonly name: string;
  readonly kind: "INTERNAL";
  readonly startTime: string;
  readonly endTime: string;
  readonly status: Readonly<{ code: "UNSET" | "OK" | "ERROR" }>;
  readonly attributes: Readonly<Record<string, OpenTelemetryAttributeValue>>;
  readonly events: readonly OpenTelemetrySpanEventRecord[];
}
export interface OpenTelemetryExportRequest { readonly resource: OpenTelemetryResource; readonly instrumentationScope: OpenTelemetryInstrumentationScope; readonly spans: readonly OpenTelemetrySpanRecord[]; }
export interface OpenTelemetryExportResult { readonly reference?: string; }
export interface OpenTelemetryExportClient { export(request: OpenTelemetryExportRequest): Promise<OpenTelemetryExportResult>; }
export interface OpenTelemetryExportAdapterOptions {
  readonly serviceName: string;
  readonly instrumentationScopeName?: string;
  readonly instrumentationScopeVersion: string;
  readonly maxExportBytes: number;
  readonly now?: () => string;
}
export interface OpenTelemetryExportReceipt { readonly exporter: "opentelemetry"; readonly eventId: string; readonly eventName: string; readonly reference?: string; readonly exportedAt: string; }

export class OpenTelemetryExportAdapter {
  private readonly now: () => string;
  constructor(private readonly client: OpenTelemetryExportClient, private readonly options: OpenTelemetryExportAdapterOptions) {
    assertNonEmptyString(options.serviceName, "OpenTelemetry serviceName");
    assertNonEmptyString(options.instrumentationScopeVersion, "OpenTelemetry instrumentationScopeVersion");
    assertPositiveInteger(options.maxExportBytes, "OpenTelemetry maxExportBytes");
    if (options.instrumentationScopeName !== undefined) assertNonEmptyString(options.instrumentationScopeName, "OpenTelemetry instrumentationScopeName");
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async export(event: InternalObservabilityEvent): Promise<OpenTelemetryExportReceipt> {
    await verifyInternalObservabilityEvent(event);
    const request = toOpenTelemetryExportRequest(event, this.options);
    const bytes = utf8ByteLength(JSON.stringify(request));
    if (bytes > this.options.maxExportBytes) throw new Error(`OpenTelemetry export exceeds maxExportBytes: bytes=${bytes} max=${this.options.maxExportBytes}`);
    const result = await this.client.export(request);
    const reference = result.reference === undefined ? undefined : safeExternalReference(result.reference, "OpenTelemetry export reference");
    const exportedAt = this.now();
    assertTimestamp(exportedAt, "OpenTelemetry exportedAt");
    return Object.freeze({ exporter: "opentelemetry" as const, eventId: event.eventId, eventName: event.payload.name, reference, exportedAt });
  }
}

export function toOpenTelemetryExportRequest(event: InternalObservabilityEvent, options: Pick<OpenTelemetryExportAdapterOptions, "serviceName" | "instrumentationScopeName" | "instrumentationScopeVersion">): OpenTelemetryExportRequest {
  const spanAttributes: Record<string, OpenTelemetryAttributeValue> = {};
  for (const [key, value] of Object.entries(event.payload.attributes)) if (value !== null) spanAttributes[key] = toOtelScalar(value, `OpenTelemetry attribute ${key}`);
  spanAttributes["router.event.id"] = event.eventId;
  spanAttributes["router.event.schema_version"] = event.schemaVersion;
  spanAttributes["router.event.name"] = event.payload.name;
  spanAttributes["router.event.severity"] = event.payload.severity;
  spanAttributes["router.trace.id"] = event.payload.traceId;
  if (event.payload.runId) spanAttributes["router.run.id"] = event.payload.runId;
  if (event.payload.projectId) spanAttributes["router.project.id"] = event.payload.projectId;
  const referenceEvents = event.payload.links.map((link) => Object.freeze({ name: "9router.reference", time: event.payload.occurredAt, attributes: Object.freeze({ "router.link.type": link.type, "router.link.reference": link.reference }) }));
  return deepFreeze({
    resource: { attributes: { "service.name": options.serviceName } },
    instrumentationScope: { name: options.instrumentationScopeName ?? "9router.observability", version: options.instrumentationScopeVersion },
    spans: [{ name: event.payload.name, kind: "INTERNAL" as const, startTime: event.payload.occurredAt, endTime: event.payload.occurredAt, status: { code: spanStatus(event) }, attributes: spanAttributes, events: referenceEvents }],
  });
}

function spanStatus(event: InternalObservabilityEvent): "UNSET" | "OK" | "ERROR" {
  if (event.payload.severity === "error") return "ERROR";
  const verificationPassed = event.payload.attributes["router.verification.passed"];
  if (verificationPassed === false) return "ERROR";
  if (verificationPassed === true) return "OK";
  const outcome = event.payload.attributes["router.run.outcome"];
  if (outcome === "failed") return "ERROR";
  if (outcome === "succeeded") return "OK";
  return "UNSET";
}
function toOtelScalar(value: ObservabilityAttributeValue, label: string): OpenTelemetryAttributeValue { if (typeof value === "string" || typeof value === "boolean") return value; if (typeof value === "number" && Number.isFinite(value)) return value; throw new Error(`${label} must be a non-null OpenTelemetry scalar`); }
function safeExternalReference(value: string, label: string): string { assertNonEmptyString(value, label); const trimmed = value.trim(); if (/[\r\n]/.test(trimmed)) throw new Error(`${label} must be single-line`); if (/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/i.test(trimmed) || /(authorization|api[_-]?key|access[_-]?token|password|secret|credential|cookie)\s*[:=]/i.test(trimmed)) throw new Error(`${label} contains secret-like material`); return trimmed; }
function assertTimestamp(value: string, label: string): void { if (!Number.isFinite(Date.parse(value))) throw new Error(`${label} must be a valid timestamp`); }
function assertNonEmptyString(value: string, label: string): void { if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must not be empty`); }
function assertPositiveInteger(value: number, label: string): void { if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`); }
function utf8ByteLength(value: string): number { return new TextEncoder().encode(value).byteLength; }
function deepFreeze<T>(value: T): T { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value; Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); return value; }
