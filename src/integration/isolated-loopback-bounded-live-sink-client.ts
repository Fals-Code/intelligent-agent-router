import type { BoundedLivePublicationSink } from "./bounded-live-publication.js";
import type { BoundedLiveReferenceRestoreSink } from "./bounded-live-reference-restore.js";

export interface IsolatedLoopbackBoundedLiveSinkClientOptions {
  readonly baseUrl: string;
  readonly timeoutMs?: number;
}

export class IsolatedLoopbackBoundedLiveSinkClient implements BoundedLivePublicationSink, BoundedLiveReferenceRestoreSink {
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

  async health(): Promise<{ readonly overall: "PASS"; readonly isolated: true }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/health`, { method: "GET", cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error(`Isolated bounded-live sink health returned HTTP ${response.status}`);
      const value = await response.json() as Record<string, unknown>;
      if (value.overall !== "PASS" || value.isolated !== true) throw new Error("Isolated bounded-live sink health response is invalid");
      return { overall: "PASS", isolated: true };
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
function prepareIdentity(value: unknown, label: string): string { if (typeof value !== "string" || !value.trim() || /[\r\n]/.test(value)) throw new Error(`${label} is invalid`); return value.trim(); }
function prepareTimestamp(value: unknown, label: string): string { if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`${label} is invalid`); return new Date(value).toISOString(); }
function prepareSha256(value: unknown, label: string): string { const prepared = prepareIdentity(value, label).toUpperCase(); if (!/^[0-9A-F]{64}$/.test(prepared)) throw new Error(`${label} must be SHA-256`); return prepared; }
function safeMessage(value: unknown): string { return typeof value === "string" ? value.replace(/[\r\n]+/g, " ").slice(0, 512) : "unknown_error"; }
