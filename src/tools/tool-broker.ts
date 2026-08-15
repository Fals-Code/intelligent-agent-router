import type {
  NormalizedToolError,
  ToolDescriptor,
  ToolDiscoverySnapshot,
  ToolGrant,
  ToolInvocationAttempt,
  ToolInvocationRequest,
  ToolInvocationResult,
  ToolSelectionRejection,
  ToolSelectionRequest,
  ToolSelectionResult,
  ToolSourceAdapter,
  ToolSourceExecutionResult,
} from "./contracts.js";
import type { ProviderHealth, ProviderVersion, RiskClass } from "../control-plane/contracts.js";

const RISK_RANK: Readonly<Record<RiskClass, number>> = {
  R0: 0,
  R1: 1,
  R2: 2,
  R3: 3,
  R4: 4,
};

export interface ToolBrokerOptions {
  readonly now?: () => string;
  readonly defaultTimeoutMs?: number;
  readonly maxRetryDelayMs?: number;
  readonly maxAttemptsCeiling?: number;
}

interface Candidate {
  readonly tool: ToolDescriptor;
  readonly snapshot: ToolDiscoverySnapshot;
}

export class ToolBroker {
  private readonly sources = new Map<string, ToolSourceAdapter>();
  private readonly now: () => string;
  private readonly defaultTimeoutMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly maxAttemptsCeiling: number;

  constructor(options: ToolBrokerOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.defaultTimeoutMs = positiveInteger(options.defaultTimeoutMs ?? 30_000, "defaultTimeoutMs");
    this.maxRetryDelayMs = positiveInteger(options.maxRetryDelayMs ?? 1_000, "maxRetryDelayMs");
    this.maxAttemptsCeiling = positiveInteger(options.maxAttemptsCeiling ?? 10, "maxAttemptsCeiling");
  }

  registerSource(source: ToolSourceAdapter): this {
    const sourceId = source.sourceId.trim();
    if (!sourceId) throw new Error("Tool source id must not be empty");
    if (this.sources.has(sourceId)) throw new Error(`Tool source already registered: ${sourceId}`);
    this.sources.set(sourceId, source);
    return this;
  }

  listSources(): readonly ToolSourceAdapter[] {
    return [...this.sources.values()];
  }

  async discover(): Promise<readonly ToolDiscoverySnapshot[]> {
    return Promise.all([...this.sources.values()].map((source) => this.discoverSource(source)));
  }

  async select(request: ToolSelectionRequest): Promise<ToolSelectionResult> {
    if (!Number.isInteger(request.maxTools) || request.maxTools <= 0) {
      throw new Error("Tool selection maxTools must be a positive integer");
    }

    const requestedIds = unique(request.requestedToolIds ?? []);
    const requiredCapabilities = unique(request.requiredCapabilities ?? []);
    const allowedPermissions = new Set(unique(request.allowedPermissions));
    const snapshots = await this.discover();
    const candidates: Candidate[] = snapshots.flatMap((snapshot) =>
      snapshot.tools.map((tool) => ({ tool, snapshot })),
    );
    const discoveredToolCount = candidates.length;
    const duplicateIds = duplicateToolIds(candidates);
    const rejections: ToolSelectionRejection[] = [];
    const eligible: Candidate[] = [];

    for (const candidate of candidates) {
      const { tool, snapshot } = candidate;
      const explicitlyRequested = requestedIds.includes(tool.id);
      const capabilityRelevant = requiredCapabilities.some((capability) => tool.capabilities.includes(capability));
      if (!explicitlyRequested && !capabilityRelevant) continue;

      if (duplicateIds.has(tool.id)) {
        rejections.push({
          toolId: tool.id,
          reason: "source_incompatible",
          details: "Duplicate logical tool id was discovered from more than one source",
        });
        continue;
      }
      if (snapshot.health.status === "unhealthy") {
        rejections.push({ toolId: tool.id, reason: "source_unhealthy", details: snapshot.health.reason });
        continue;
      }
      if (snapshot.health.status === "incompatible" || !snapshot.version.compatible) {
        rejections.push({
          toolId: tool.id,
          reason: "source_incompatible",
          details: snapshot.health.reason ?? `Source version ${snapshot.version.version} is not compatible`,
        });
        continue;
      }
      if (RISK_RANK[request.riskClass] > RISK_RANK[tool.riskCeiling]) {
        rejections.push({
          toolId: tool.id,
          reason: "risk_ceiling",
          details: `${request.riskClass} exceeds ${tool.riskCeiling}`,
        });
        continue;
      }

      const mutates = tool.mode === "write" || tool.sideEffectClass !== "none";
      if (mutates && (request.riskClass === "R0" || !request.allowMutations)) {
        rejections.push({ toolId: tool.id, reason: "mutation_not_allowed" });
        continue;
      }
      if (mutates && (request.riskClass === "R3" || request.riskClass === "R4") && !request.approvalGranted) {
        rejections.push({
          toolId: tool.id,
          reason: "approval_required",
          details: `${request.riskClass} mutation requires explicit approval`,
        });
        continue;
      }
      if (tool.sideEffectClass === "destructive" && !request.approvalGranted) {
        rejections.push({ toolId: tool.id, reason: "approval_required", details: "Destructive tool requires approval" });
        continue;
      }
      const denied = tool.requiredPermissions.filter(
        (permission) => !allowedPermissions.has("*") && !allowedPermissions.has(permission),
      );
      if (denied.length > 0) {
        rejections.push({
          toolId: tool.id,
          reason: "permission_denied",
          details: `Missing permissions: ${denied.join(", ")}`,
        });
        continue;
      }
      eligible.push(candidate);
    }

    const selected: Candidate[] = [];
    for (const requestedId of requestedIds) {
      const candidate = eligible.find((item) => item.tool.id === requestedId);
      if (!candidate || selected.includes(candidate)) continue;
      if (selected.length >= request.maxTools) break;
      selected.push(candidate);
    }

    const covered = new Set<string>();
    for (const candidate of selected) {
      for (const capability of candidate.tool.capabilities) covered.add(capability);
    }

    while (selected.length < request.maxTools) {
      const uncovered = requiredCapabilities.filter((capability) => !covered.has(capability));
      if (uncovered.length === 0) break;
      const remaining = eligible.filter((candidate) => !selected.includes(candidate));
      const best = remaining
        .map((candidate) => ({
          candidate,
          coverage: uncovered.filter((capability) => candidate.tool.capabilities.includes(capability)).length,
        }))
        .filter((item) => item.coverage > 0)
        .sort((a, b) => {
          if (b.coverage !== a.coverage) return b.coverage - a.coverage;
          const aMutation = a.candidate.tool.sideEffectClass === "none" ? 0 : 1;
          const bMutation = b.candidate.tool.sideEffectClass === "none" ? 0 : 1;
          if (aMutation !== bMutation) return aMutation - bMutation;
          return a.candidate.tool.id.localeCompare(b.candidate.tool.id);
        })[0];
      if (!best) break;
      selected.push(best.candidate);
      for (const capability of best.candidate.tool.capabilities) covered.add(capability);
    }

    const grants = selected.map(({ tool, snapshot }) =>
      Object.freeze({
        tool,
        providerPermissions: Object.freeze([...tool.providerPermissions]),
        sourceHealth: snapshot.health,
        sourceVersion: snapshot.version,
        reasons: Object.freeze([
          ...(requestedIds.includes(tool.id) ? ["Explicitly requested tool"] : []),
          ...tool.capabilities
            .filter((capability) => requiredCapabilities.includes(capability))
            .map((capability) => `Covers capability ${capability}`),
          ...(snapshot.health.status === "degraded" ? ["Source is degraded but policy-eligible"] : []),
        ]),
      }) satisfies ToolGrant,
    );

    const grantedIds = new Set(grants.map((grant) => grant.tool.id));
    const grantedCapabilities = new Set(grants.flatMap((grant) => [...grant.tool.capabilities]));
    const missingRequestedToolIds = requestedIds.filter((id) => !grantedIds.has(id));
    const uncoveredCapabilities = requiredCapabilities.filter((capability) => !grantedCapabilities.has(capability));

    return Object.freeze({
      grants: Object.freeze(grants),
      rejections: Object.freeze(rejections),
      discoveredToolCount,
      exposedToolCount: grants.length,
      uncoveredCapabilities: Object.freeze(uncoveredCapabilities),
      missingRequestedToolIds: Object.freeze(missingRequestedToolIds),
    });
  }

  async invoke(request: ToolInvocationRequest): Promise<ToolInvocationResult> {
    if (!request.traceId.trim()) throw new Error("Tool invocation traceId must not be empty");
    const source = this.sources.get(request.grant.tool.sourceId);
    if (!source) throw new Error(`Tool source is not registered: ${request.grant.tool.sourceId}`);
    if (source.sourceId !== request.grant.tool.sourceId) throw new Error("Tool grant source mismatch");

    const maxAttempts = positiveInteger(request.maxAttempts ?? 1, "maxAttempts");
    if (maxAttempts > this.maxAttemptsCeiling) {
      throw new Error(`Tool invocation maxAttempts exceeds broker ceiling ${this.maxAttemptsCeiling}`);
    }
    const timeoutMs = positiveInteger(
      request.timeoutMs ?? request.grant.tool.defaultTimeoutMs ?? this.defaultTimeoutMs,
      "timeoutMs",
    );

    const health = await this.safeHealth(source);
    const version = await this.safeVersion(source);
    if (health.status === "unhealthy" || health.status === "incompatible" || !version.compatible) {
      const error: NormalizedToolError = {
        name: "ToolSourceUnavailable",
        message: sanitize(
          health.reason ??
            (version.compatible ? `Tool source ${source.sourceId} is ${health.status}` : `Tool source ${source.sourceId} is incompatible`),
        ),
        category: version.compatible ? "unavailable" : "incompatible",
        retryable: false,
        sourceId: source.sourceId,
        toolId: request.grant.tool.id,
      };
      return this.finalResult(request, "failed", [], error);
    }

    const attempts: ToolInvocationAttempt[] = [];
    let lastError: NormalizedToolError | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (request.signal?.aborted) {
        const error = this.abortedError(request.grant.tool, source.sourceId);
        return this.finalResult(request, "aborted", attempts, error);
      }

      const startedAt = Date.now();
      const startedIso = new Date(startedAt).toISOString();
      const timeout = createTimeoutSignal(timeoutMs, request.signal);
      let outcome:
        | { kind: "result"; result: ToolSourceExecutionResult }
        | { kind: "error"; error: unknown }
        | { kind: "timeout" };
      try {
        const execution = source
          .execute({
            tool: request.grant.tool,
            input: request.input,
            traceId: request.traceId,
            runId: request.runId,
            timeoutMs,
            signal: timeout.signal,
            metadata: request.metadata,
          })
          .then((result) => ({ kind: "result" as const, result }))
          .catch((error) => ({ kind: "error" as const, error }));
        outcome = await Promise.race([execution, timeout.promise]);
      } finally {
        timeout.cleanup();
      }

      const finishedAt = Date.now();
      const finishedIso = new Date(finishedAt).toISOString();
      const durationMs = Math.max(0, finishedAt - startedAt);

      if (outcome.kind === "timeout") {
        const error: NormalizedToolError = {
          name: "ToolTimeoutError",
          message: `Tool ${request.grant.tool.id} timed out after ${timeoutMs}ms`,
          category: "timeout",
          retryable: this.canAutomaticallyRetry(request.grant.tool, request.retryOnTimeout === true),
          code: "TOOL_TIMEOUT",
          sourceId: source.sourceId,
          toolId: request.grant.tool.id,
        };
        attempts.push({ attempt, status: "timed_out", startedAt: startedIso, finishedAt: finishedIso, durationMs, error });
        lastError = error;
        if (!this.shouldRetry(error, request.grant.tool, attempt, maxAttempts, request.retryOnTimeout === true)) {
          return this.finalResult(request, "timed_out", attempts, error);
        }
        continue;
      }

      if (outcome.kind === "error") {
        const aborted = timeout.signal.aborted && request.signal?.aborted;
        const error = aborted
          ? this.abortedError(request.grant.tool, source.sourceId)
          : this.normalizeThrownError(outcome.error, request.grant.tool, source.sourceId);
        const status = error.category === "aborted" ? "aborted" : error.category === "timeout" ? "timed_out" : "failed";
        attempts.push({ attempt, status, startedAt: startedIso, finishedAt: finishedIso, durationMs, error });
        lastError = error;
        if (status === "aborted") return this.finalResult(request, "aborted", attempts, error);
        if (!this.shouldRetry(error, request.grant.tool, attempt, maxAttempts, request.retryOnTimeout === true)) {
          return this.finalResult(request, status, attempts, error);
        }
        await this.retryDelay(error.retryAfterMs);
        continue;
      }

      if ("error" in outcome.result) {
        const error = this.normalizeAdapterError(outcome.result.error, request.grant.tool, source.sourceId);
        const status = error.category === "aborted" ? "aborted" : error.category === "timeout" ? "timed_out" : "failed";
        attempts.push({ attempt, status, startedAt: startedIso, finishedAt: finishedIso, durationMs, error });
        lastError = error;
        if (status === "aborted") return this.finalResult(request, "aborted", attempts, error);
        if (!this.shouldRetry(error, request.grant.tool, attempt, maxAttempts, request.retryOnTimeout === true)) {
          return this.finalResult(request, status, attempts, error);
        }
        await this.retryDelay(error.retryAfterMs);
        continue;
      }

      attempts.push({ attempt, status: "succeeded", startedAt: startedIso, finishedAt: finishedIso, durationMs });
      return Object.freeze({
        status: "succeeded",
        output: outcome.result.output,
        attempts: Object.freeze(attempts),
        sourceId: source.sourceId,
        toolId: request.grant.tool.id,
        providerToolName: request.grant.tool.providerToolName,
        traceId: request.traceId,
        usage: outcome.result.usage,
      });
    }

    return this.finalResult(
      request,
      lastError?.category === "timeout" ? "timed_out" : "failed",
      attempts,
      lastError ?? {
        name: "ToolExecutionError",
        message: "Tool execution exhausted attempts",
        category: "unknown",
        retryable: false,
        sourceId: source.sourceId,
        toolId: request.grant.tool.id,
      },
    );
  }

  private async discoverSource(source: ToolSourceAdapter): Promise<ToolDiscoverySnapshot> {
    const [health, version] = await Promise.all([this.safeHealth(source), this.safeVersion(source)]);
    if (health.status === "unhealthy" || health.status === "incompatible" || !version.compatible) {
      return Object.freeze({
        sourceId: source.sourceId,
        transport: source.transport,
        health,
        version,
        tools: Object.freeze([]),
        discoveredAt: this.now(),
      });
    }

    try {
      const raw = await source.discover();
      const tools = raw.map((tool) => this.validateToolDescriptor(tool, source));
      return Object.freeze({
        sourceId: source.sourceId,
        transport: source.transport,
        health,
        version,
        tools: Object.freeze(tools),
        discoveredAt: this.now(),
      });
    } catch (error) {
      return Object.freeze({
        sourceId: source.sourceId,
        transport: source.transport,
        health: {
          status: "unhealthy",
          checkedAt: this.now(),
          reason: `Tool discovery failed: ${sanitize(error instanceof Error ? error.message : String(error))}`,
        },
        version,
        tools: Object.freeze([]),
        discoveredAt: this.now(),
      });
    }
  }

  private validateToolDescriptor(tool: ToolDescriptor, source: ToolSourceAdapter): ToolDescriptor {
    if (!tool.id.trim()) throw new Error("Tool id must not be empty");
    if (tool.sourceId !== source.sourceId) throw new Error(`Tool ${tool.id} sourceId does not match adapter ${source.sourceId}`);
    if (!tool.providerToolName.trim()) throw new Error(`Tool ${tool.id} providerToolName must not be empty`);
    if (!tool.title.trim()) throw new Error(`Tool ${tool.id} title must not be empty`);
    if (tool.defaultTimeoutMs !== undefined) positiveInteger(tool.defaultTimeoutMs, `Tool ${tool.id} defaultTimeoutMs`);
    return Object.freeze({
      ...tool,
      capabilities: Object.freeze(unique(tool.capabilities)),
      requiredPermissions: Object.freeze(unique(tool.requiredPermissions)),
      providerPermissions: Object.freeze(unique(tool.providerPermissions)),
      metadata: tool.metadata ? Object.freeze({ ...tool.metadata }) : undefined,
    });
  }

  private async safeHealth(source: ToolSourceAdapter): Promise<ProviderHealth> {
    try {
      return await source.health();
    } catch (error) {
      return {
        status: "unhealthy",
        checkedAt: this.now(),
        reason: `Health check failed: ${sanitize(error instanceof Error ? error.message : String(error))}`,
      };
    }
  }

  private async safeVersion(source: ToolSourceAdapter): Promise<ProviderVersion> {
    try {
      return await source.version();
    } catch {
      return { version: "unknown", protocolVersion: source.transport, compatible: false };
    }
  }

  private normalizeAdapterError(error: NormalizedToolError, tool: ToolDescriptor, sourceId: string): NormalizedToolError {
    return Object.freeze({
      ...error,
      message: sanitize(error.message),
      sourceId,
      toolId: tool.id,
      retryAfterMs: normalizeRetryAfter(error.retryAfterMs),
    });
  }

  private normalizeThrownError(error: unknown, tool: ToolDescriptor, sourceId: string): NormalizedToolError {
    const message = sanitize(error instanceof Error ? error.message : String(error));
    return {
      name: error instanceof Error ? error.name : "ToolProviderError",
      message,
      category: "provider_error",
      retryable: false,
      sourceId,
      toolId: tool.id,
    };
  }

  private abortedError(tool: ToolDescriptor, sourceId: string): NormalizedToolError {
    return {
      name: "ToolAbortedError",
      message: `Tool ${tool.id} invocation was aborted`,
      category: "aborted",
      retryable: false,
      code: "TOOL_ABORTED",
      sourceId,
      toolId: tool.id,
    };
  }

  private shouldRetry(
    error: NormalizedToolError,
    tool: ToolDescriptor,
    attempt: number,
    maxAttempts: number,
    retryOnTimeout: boolean,
  ): boolean {
    if (attempt >= maxAttempts || !error.retryable) return false;
    if (!this.canAutomaticallyRetry(tool, error.category !== "timeout" || retryOnTimeout)) return false;
    if (error.category === "timeout" && !retryOnTimeout) return false;
    return true;
  }

  private canAutomaticallyRetry(tool: ToolDescriptor, enabled: boolean): boolean {
    return enabled && tool.idempotency === "safe" && tool.sideEffectClass !== "destructive";
  }

  private async retryDelay(retryAfterMs?: number): Promise<void> {
    const normalized = normalizeRetryAfter(retryAfterMs);
    if (!normalized) return;
    const delay = Math.min(normalized, this.maxRetryDelayMs);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  private finalResult(
    request: ToolInvocationRequest,
    status: ToolInvocationResult["status"],
    attempts: readonly ToolInvocationAttempt[],
    error: NormalizedToolError,
  ): ToolInvocationResult {
    return Object.freeze({
      status,
      error,
      attempts: Object.freeze([...attempts]),
      sourceId: request.grant.tool.sourceId,
      toolId: request.grant.tool.id,
      providerToolName: request.grant.tool.providerToolName,
      traceId: request.traceId,
    });
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function duplicateToolIds(candidates: readonly Candidate[]): Set<string> {
  const counts = new Map<string, number>();
  for (const candidate of candidates) counts.set(candidate.tool.id, (counts.get(candidate.tool.id) ?? 0) + 1);
  return new Set([...counts.entries()].filter(([, count]) => count > 1).map(([id]) => id));
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}

function normalizeRetryAfter(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.trunc(value);
}

function sanitize(value: string): string {
  return value
    .replace(/(authorization|api[_-]?key|access[_-]?token|password|secret|credential)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .slice(0, 2_000);
}

function createTimeoutSignal(
  timeoutMs: number,
  parent?: AbortSignal,
): { signal: AbortSignal; promise: Promise<{ kind: "timeout" }>; cleanup: () => void } {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent?.reason);
  if (parent) {
    if (parent.aborted) controller.abort(parent.reason);
    else parent.addEventListener("abort", onAbort, { once: true });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<{ kind: "timeout" }>((resolve) => {
    timer = setTimeout(() => {
      controller.abort(new Error("Tool invocation timed out"));
      resolve({ kind: "timeout" });
    }, timeoutMs);
  });
  return {
    signal: controller.signal,
    promise,
    cleanup: () => {
      if (timer) clearTimeout(timer);
      parent?.removeEventListener("abort", onAbort);
    },
  };
}
