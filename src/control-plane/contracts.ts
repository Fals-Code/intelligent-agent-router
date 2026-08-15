export const FROZEN_CAPABILITIES = [
  "code.interactive",
  "code.autonomous",
  "code.intelligence",
  "code.review",
  "browser.verify",
  "design.product",
  "design.diagram",
  "design.tokens",
  "knowledge.docs",
  "knowledge.procedural",
  "knowledge.personal",
  "workflow.engineering",
  "workflow.external",
  "communication.channels",
  "data.operational",
  "apps.internal",
  "scheduling.booking",
] as const;

export type CapabilityId = (typeof FROZEN_CAPABILITIES)[number];
export type ProviderMode = "read" | "write" | "execute";
export type ProviderRole = "PRIMARY" | "FALLBACK" | "SHADOW";
export type SideEffectClass = "none" | "reversible" | "destructive";
export type RiskClass = "R0" | "R1" | "R2" | "R3" | "R4";
export type WorkflowStatus =
  | "queued"
  | "running"
  | "waiting_external"
  | "waiting_approval"
  | "retrying"
  | "failed"
  | "cancelled"
  | "succeeded";
export type WorkflowPhase =
  | "start"
  | "classify"
  | "compile_context"
  | "execute"
  | "verify"
  | "review"
  | "approval"
  | "publish";

export type TransportId =
  | "mcp"
  | "mcp-apps"
  | "acp"
  | "a2a"
  | "agent-skills"
  | "opentelemetry"
  | "native-http"
  | "native-api";

export interface ProviderHealth {
  readonly status: "healthy" | "degraded" | "unhealthy" | "incompatible";
  readonly checkedAt: string;
  readonly reason?: string;
  readonly quotaState?: "available" | "limited" | "exhausted" | "unknown";
}

export interface ProviderVersion {
  readonly version: string;
  readonly protocolVersion?: string;
  readonly compatible: boolean;
}

export interface CostProfile {
  readonly relativeTier: 1 | 2 | 3 | 4;
  readonly quotaAware: boolean;
  readonly notes?: readonly string[];
}

export interface ContextProfile {
  readonly supportsSelectiveContext: boolean;
  readonly maxContextTokens?: number;
  readonly notes?: readonly string[];
}

export interface CapabilityProvider {
  readonly id: string;
  readonly capabilities: readonly CapabilityId[];
  readonly modes: readonly ProviderMode[];
  readonly transports: readonly TransportId[];
  readonly requiredPermissions: readonly string[];
  readonly isolationRequirements: readonly string[];
  readonly costProfile: CostProfile;
  readonly contextProfile: ContextProfile;
  readonly sideEffectClass: SideEffectClass;
  health(): ProviderHealth | Promise<ProviderHealth>;
  version(): ProviderVersion | Promise<ProviderVersion>;
}

export interface CapabilityBinding {
  readonly capability: CapabilityId;
  readonly providerId: string;
  readonly role: ProviderRole;
  readonly canonicalWriteDomain?: string;
  readonly enabled: boolean;
}

export interface ResourcePolicyEnvelope {
  readonly maxActiveAgents?: number;
  readonly maxParallelWorktrees?: number;
  readonly maxRuntimeMs?: number;
  readonly maxToolCalls?: number;
  readonly maxRetries?: number;
  readonly maxContextTokens?: number;
  readonly maxConcurrentSteps?: number;
  readonly providerQuotaGuard?: boolean;
  readonly cpuLimit?: string;
  readonly memoryLimit?: string;
  readonly diskRetentionPolicy?: string;
  readonly networkEgressPolicy?: string;
}

export interface WorkflowRun {
  readonly id: string;
  readonly projectId: string;
  readonly riskClass: RiskClass;
  readonly phase: WorkflowPhase;
  readonly status: WorkflowStatus;
  readonly attempt: number;
  readonly approvalIds: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly failureReason?: string;
}

export type EvidenceKind =
  | "policy"
  | "isolation"
  | "deterministic_check"
  | "test"
  | "browser"
  | "review"
  | "independent_review"
  | "approval"
  | "backup"
  | "rollback"
  | "other";

export interface EvidenceRecord {
  readonly kind: EvidenceKind;
  readonly status: "passed" | "failed" | "not_applicable";
  readonly reference: string;
  readonly producer: string;
  readonly collectedAt: string;
  readonly metadata?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface RunLedgerRecord {
  readonly runId: string;
  readonly projectId: string;
  readonly task: string;
  readonly riskClass: RiskClass;
  readonly runtimeId: string;
  readonly modelRoute: readonly string[];
  readonly contextCompilerVersion: string;
  readonly skills: readonly string[];
  readonly toolsets: readonly string[];
  readonly workspace: string;
  readonly policyDecisions: readonly string[];
  readonly approvalIds: readonly string[];
  readonly changeReferences: readonly string[];
  readonly evidence: readonly EvidenceRecord[];
  readonly resourceMetrics: Readonly<Record<string, number>>;
  readonly traceId: string;
  readonly outcome: "failed" | "cancelled" | "succeeded";
  readonly failureReason?: string;
  readonly createdAt: string;
}
