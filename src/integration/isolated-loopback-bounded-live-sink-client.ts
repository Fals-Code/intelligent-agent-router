import type { BoundedLivePublicationSink } from "./bounded-live-publication.js";
import type { BoundedLiveReferenceRestoreSink } from "./bounded-live-reference-restore.js";
import type {
  BoundedLiveSideEffectProbeObservation,
  BoundedLiveSideEffectProbeRequest,
  BoundedLiveSideEffectReconciliationProbe,
} from "./bounded-live-side-effect-reconciliation.js";

export interface IsolatedLoopbackBoundedLiveSinkClientOptions {
  readonly baseUrl: string;
  readonly timeoutMs?: number;
}

export class IsolatedLoopbackBoundedLiveSinkClient implements BoundedLivePublicationSink, BoundedLiveReferenceRestoreSink, BoundedLiveSideEffectReconciliationProbe {
  readonly id = "isolated-loopback-bounded-live-sink";
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: IsolatedLoopbackBoundedLiveSinkClientOptions) {
    const url = new URL(options.baseUrl);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") throw new Error("Isolated bounded-live sink client requires http://127.0.0.1 loopback baseUrl");
    if (url.username || url.password || url.search || url.hash) throw new Error("Isolated bounded-live sink client baseUrl cannot contain credentials/query/hash");
    this.baseUrl = url.origin;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs <= 0) throw new Error("Isolated bounded-live sink client timeoutMs must be a positive integer");
  }

  async publish(input: Parameters<BoundedLivePublicationSink["publish"]>[0]): Promise<Awaited<ReturnType<BoundedLivePublicationSink["publish"]>>> {
    const response = await this.request("/publish", input);
    assertExactFields(response, new Set(["sinkId", "idempotencyKey", "publicationReference", "publishedAt", "selectedRole", "outputSha256", "externallyVisible"]), "isolated publication response");
    if (response.sinkId !== this.id || response.idempotencyKey !== input.idempotencyKey || response.selectedRole !== input.selectedRole || response.outputSha256 !== input.outputSha256 || response.externallyVisible !== true) throw new Error("Isolated bounded-live publication response does not match request");
    return {
      sinkId: this.id,
      idempotencyKey: prepareIdentity(response.idempotencyKey, "isolated publication idempotencyKey"),
      publicationReference: prepareIdentity(response.publicationReference, "isolated publication reference"),
      publishedAt: prepareTimestamp(response.publishedAt, "isolated publication publishedAt"),
      selectedRole: response.selectedRole as "reference" | "candidate",
      outputSha256: prepareSha256(response.outputSha256, "isolated publication outputSha256"),
      externallyVisible: true,
    };
  }

  async restore(input: Parameters<BoundedLiveReferenceRestoreSink["restore"]>[0]): Promise<Awaited<ReturnType<BoundedLiveReferenceRestoreSink["restore"]>>> {
    const response = await this.request("/restore", input);
    assertExactFields(response, new Set(["sinkId", "idempotencyKey", "restoreReference", "restoredAt", "activeSubjectId"]), "isolated restore response");
    if (response.sinkId !== this.id || response.idempotencyKey !== input.idempotencyKey || response.activeSubjectId !== input.targetSubjectId) throw new Error("Isolated bounded-live restore response does not match request");
    return {
      sinkId: this.id,
      idempotencyKey: prepareIdentity(response.idempotencyKey, "isolated restore idempotencyKey"),
      restoreReference: prepareIdentity(response.restoreReference, "isolated restore reference"),
      restoredAt: prepareTimestamp(response.restoredAt, "isolated restore restoredAt"),
      activeSubjectId: prepareIdentity(response.activeSubjectId, "isolated restore activeSubjectId"),
    };
  }

  /** GET-only authoritative observation of the isolated sink's durable state. */
  async inspect(request: BoundedLiveSideEffectProbeRequest): Promise<BoundedLiveSideEffectProbeObservation> {
    if (request.sinkId !== this.id) throw new Error(`Isolated recovery probe cannot inspect sinkId=${request.sinkId}`);
    const state = await this.getState();
    const observedAt = new Date().toISOString();

    if (request.kind === "publication") {
      const publications = asRecordArray(state.publications, "isolated sink publications");
      const entry = publications.find((item) => item.idempotencyKey === request.idempotencyKey);
      if (!entry) return { status: "absent", kind: request.kind, idempotencyKey: request.idempotencyKey, sinkId: this.id, authoritative: true, observedAt };
      return {
        status: "applied",
        kind: request.kind,
        idempotencyKey: request.idempotencyKey,
        sinkId: this.id,
        subjectId: prepareIdentity(entry.selectedSubjectId, "isolated recovery publication selectedSubjectId"),
        sampleId: prepareIdentity(entry.sampleId, "isolated recovery publication sampleId"),
        outputSha256: prepareSha256(entry.outputSha256, "isolated recovery publication outputSha256"),
        externalReference: prepareIdentity(entry.publicationReference, "isolated recovery publication reference"),
        observedAt: prepareTimestamp(entry.publishedAt, "isolated recovery publication publishedAt"),
      };
    }

    const restores = asRecordArray(state.restores, "isolated sink restores");
    const entry = restores.find((item) => item.idempotencyKey === request.idempotencyKey);
    if (!entry) return { status: "absent", kind: request.kind, idempotencyKey: request.idempotencyKey, sinkId: this.id, authoritative: true, observedAt };
    return {
      status: "applied",
      kind: request.kind,
      idempotencyKey: request.idempotencyKey,
      sinkId: this.id,
      subjectId: prepareIdentity(entry.targetSubjectId, "isolated recovery restore targetSubjectId"),
      externalReference: prepareIdentity(entry.restoreReference, "isolated recovery restore reference"),
      observedAt: prepareTimestamp(entry.restoredAt, "isolated recovery restore restoredAt"),
    };
  }

  async health(): Promise<{ readonly overall: "PASS"; readonly isolated: true }> {
    const value = await this.get("/health");
    if (value.overall !== "PASS" || value.isolated !== true) throw new Error("Isolated bounded-live sink health response is invalid");
    return { overall: "PASS", isolated: true };
  }

  private async getState(): Promise<Record<string, unknown>> {
    const state = await this.get("/state");
    if (state.schemaVersion !== 1 || state.rawOutputPersisted !== false) throw new Error("Isolated bounded-live sink state is invalid");
    if (JSON.stringify(state).includes('"output"')) throw new Error("Isolated bounded-live sink state appears to persist raw provider output");
    asRecordArray(state.publications, "isolated sink publications");
    asRecordArray(state.restores, "isolated sink restores");
    return state;
  }

  private async get(path: string): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, { method: "GET", cache: "no-store", signal: controller.signal });
      const value = await response.json() as Record<string, unknown>;
      if (!response.ok) throw new Error(`Isolated bounded-live sink ${path} returned HTTP ${response.status}: ${safeMessage(value.error)}`);
      return value;
    } finally {
      clearTimeout(timer);
    }
  }

  private async request(path: string, body: unknown): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        cache: "no-store",
        signal: controller.signal,
      });
      const value = await response.json() as Record<string, unknown>;
      if (!response.ok) throw new Error(`Isolated bounded-live sink ${path} returned HTTP ${response.status}: ${safeMessage(value.error)}`);
      return value;
    } finally {
      clearTimeout(timer);
    }
  }
}

function assertExactFields(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const keys = Object.keys(value);
  for (const key of keys) if (!allowed.has(key)) throw new Error(`${label}.${key} is not allowed`);
  for (const key of allowed) if (!Object.prototype.hasOwnProperty.call(value, key)) throw new Error(`${label}.${key} is required`);
}
function asRecordArray(value: unknown, label: string): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.some((item) => !item || typeof item !== "object" || Array.isArray(item))) throw new Error(`${label} must be an array of objects`);
  return value as Record<string, unknown>[];
}
function prepareIdentity(value: unknown, label: string): string { if (typeof value !== "string" || !value.trim() || /[\r\n]/.test(value)) throw new Error(`${label} is invalid`); return value.trim(); }
function prepareTimestamp(value: unknown, label: string): string { if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`${label} is invalid`); return new Date(value).toISOString(); }
function prepareSha256(value: unknown, label: string): string { const prepared = prepareIdentity(value, label).toUpperCase(); if (!/^[0-9A-F]{64}$/.test(prepared)) throw new Error(`${label} must be SHA-256`); return prepared; }
function safeMessage(value: unknown): string { return typeof value === "string" ? value.replace(/[\r\n]+/g, " ").slice(0, 512) : "unknown_error"; }
