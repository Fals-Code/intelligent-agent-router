import type {
  ProviderHealth,
  ProviderVersion,
  RiskClass,
  SideEffectClass,
  TransportId,
} from "../control-plane/contracts.js";

export type ToolMode = "read" | "write" | "execute";
export type ToolIdempotency = "safe" | "conditional" | "unsafe";

export interface ToolDescriptor {
  readonly id: string;
  readonly sourceId: string;
  readonly providerToolName: string;
  readonly title: string;
  readonly description: string;
  readonly capabilities: readonly string[];
  readonly mode: ToolMode;
  readonly sideEffectClass: SideEffectClass;
  readonly riskCeiling: RiskClass;
  readonly requiredPermissions: readonly string[];
  readonly providerPermissions: readonly string[];
  readonly idempotency: ToolIdempotency;
  readonly defaultTimeoutMs?: number;
  readonly metadata?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface ToolDiscoverySnapshot {
  readonly sourceId: string;
  readonly transport: TransportId;
  readonly health: ProviderHealth;
  readonly version: ProviderVersion;
  readonly tools: readonly ToolDescriptor[];
  readonly discoveredAt: string;
}

export interface ToolSourceAdapter {
  readonly sourceId: string;
  readonly transport: TransportId;
  health(): ProviderHealth | Promise<ProviderHealth>;
  version(): ProviderVersion | Promise<ProviderVersion>;
  discover(): readonly ToolDescriptor[] | Promise<readonly ToolDescriptor[]>;
  execute(request: ToolSourceExecutionRequest): Promise<ToolSourceExecutionResult>;
}

export interface ToolSourceExecutionRequest {
  readonly tool: ToolDescriptor;
  readonly input: unknown;
  readonly traceId: string;
  readonly runId?: string;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly metadata?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface ToolExecutionUsage {
  readonly durationMs?: number;
  readonly providerRequestId?: string;
}

export type ToolErrorCategory =
  | "invalid_request"
  | "authentication"
  | "authorization"
  | "not_found"
  | "rate_limit"
  | "timeout"
  | "unavailable"
  | "incompatible"
  | "provider_error"
  | "aborted"
  | "unknown";

export interface NormalizedToolError {
  readonly name: string;
  readonly message: string;
  readonly category: ToolErrorCategory;
  readonly retryable: boolean;
  readonly code?: string;
  readonly sourceId?: string;
  readonly toolId?: string;
  readonly httpStatus?: number;
  readonly retryAfterMs?: number;
}

export type ToolSourceExecutionResult =
  | {
      readonly output: unknown;
      readonly usage?: ToolExecutionUsage;
      readonly metadata?: Readonly<Record<string, string | number | boolean | null>>;
    }
  | {
      readonly error: NormalizedToolError;
    };

export interface ToolSelectionRequest {
  readonly riskClass: RiskClass;
  readonly requiredCapabilities?: readonly string[];
  readonly requestedToolIds?: readonly string[];
  readonly allowedPermissions: readonly string[];
  readonly allowMutations: boolean;
  readonly approvalGranted?: boolean;
  readonly maxTools: number;
}

export interface ToolSelectionRejection {
  readonly toolId: string;
  readonly reason:
    | "source_unhealthy"
    | "source_incompatible"
    | "risk_ceiling"
    | "mutation_not_allowed"
    | "approval_required"
    | "permission_denied"
    | "capability_mismatch"
    | "not_requested";
  readonly details?: string;
}

export interface ToolGrant {
  readonly tool: ToolDescriptor;
  readonly providerPermissions: readonly string[];
  readonly sourceHealth: ProviderHealth;
  readonly sourceVersion: ProviderVersion;
  readonly reasons: readonly string[];
}

export interface ToolSelectionResult {
  readonly grants: readonly ToolGrant[];
  readonly rejections: readonly ToolSelectionRejection[];
  readonly discoveredToolCount: number;
  readonly exposedToolCount: number;
  readonly uncoveredCapabilities: readonly string[];
  readonly missingRequestedToolIds: readonly string[];
}

export interface ToolInvocationRequest {
  readonly grant: ToolGrant;
  readonly input: unknown;
  readonly traceId: string;
  readonly runId?: string;
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
  readonly retryOnTimeout?: boolean;
  readonly signal?: AbortSignal;
  readonly metadata?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface ToolInvocationAttempt {
  readonly attempt: number;
  readonly status: "succeeded" | "failed" | "timed_out" | "aborted";
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly error?: NormalizedToolError;
}

export interface ToolInvocationResult {
  readonly status: "succeeded" | "failed" | "timed_out" | "aborted";
  readonly output?: unknown;
  readonly error?: NormalizedToolError;
  readonly attempts: readonly ToolInvocationAttempt[];
  readonly sourceId: string;
  readonly toolId: string;
  readonly providerToolName: string;
  readonly traceId: string;
  readonly usage?: ToolExecutionUsage;
}
