export type Modality = "text" | "image" | "audio" | "video" | "file" | "code";
export type RiskLevel = "low" | "medium" | "high" | "critical";
export type Complexity = "simple" | "moderate" | "complex" | "expert";
export type CostTier = 1 | 2 | 3 | 4;
export type LatencyTier = 1 | 2 | 3 | 4;
export type PrivacyTier = "public" | "internal" | "confidential" | "restricted";

export interface TaskConstraints {
  maxCostTier?: CostTier;
  maxLatencyTier?: LatencyTier;
  privacy?: PrivacyTier;
  preferredProvider?: string;
  disallowedProviders?: string[];
  requireHumanApprovalForWrites?: boolean;
}

export interface TaskAnalysis {
  rawPrompt: string;
  normalizedPrompt: string;
  intent: string;
  domain: string;
  complexity: Complexity;
  risk: RiskLevel;
  modalities: Modality[];
  requiredCapabilities: string[];
  preferredCapabilities: string[];
  requiredSkills: string[];
  outputFormat: string;
  requiresFreshData: boolean;
  requiresExternalAction: boolean;
  requiresVerification: boolean;
  canParallelize: boolean;
  estimatedContextTokens: number;
  confidence: number;
  ambiguities: string[];
  constraints: TaskConstraints;
}

export interface ModelProfile {
  id: string;
  provider: string;
  apiModelEnv: string;
  label: string;
  capabilities: string[];
  modalities: Modality[];
  maxContextTokens: number;
  toolUse: boolean;
  structuredOutput: boolean;
  reasoningLevel: Complexity;
  reliability: number;
  costTier: CostTier;
  latencyTier: LatencyTier;
  privacySupport: PrivacyTier[];
  enabled: boolean;
}

export interface SkillProfile {
  id: string;
  label: string;
  description: string;
  domains: string[];
  capabilities: string[];
  inputModalities: Modality[];
  outputModalities: Modality[];
  sideEffect: "none" | "reversible" | "destructive";
  riskCeiling: RiskLevel;
  requiresAuth: boolean;
  enabled: boolean;
  costTier: CostTier;
  latencyTier: LatencyTier;
  tags: string[];
}

export interface RankedCandidate<T> {
  candidate: T;
  score: number;
  reasons: string[];
  penalties: string[];
}

export interface RouteStep {
  id: string;
  purpose: "analyze" | "retrieve" | "execute" | "verify" | "synthesize";
  skillIds: string[];
  modelId: string;
  dependsOn: string[];
  parallelGroup?: string;
  humanApprovalRequired: boolean;
  timeoutMs?: number;
  retryable?: boolean;
  maxAttempts?: number;
  instructions: string;
}

export interface RoutingDecision {
  analysis: TaskAnalysis;
  primaryModel: RankedCandidate<ModelProfile>;
  fallbackModels: RankedCandidate<ModelProfile>[];
  selectedSkills: RankedCandidate<SkillProfile>[];
  plan: RouteStep[];
  explanation: string[];
  traceId: string;
}

export interface RouteStepExecutionMetadata {
  [key: string]: string | number | boolean | null | undefined | RouteStepExecutionMetadata | Array<string | number | boolean | null>;
}
