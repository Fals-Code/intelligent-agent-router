import type { ResourcePolicyEnvelope, RiskClass } from "./contracts.js";

export interface MinimumRiskControl {
  readonly mutationAllowed: boolean;
  readonly isolatedWorkspaceRequired: boolean;
  readonly deterministicChecksRequired: boolean;
  readonly reviewRequired: boolean;
  readonly independentReviewRequired: boolean;
  readonly explicitApprovalRequired: boolean;
  readonly backupRollbackEvidenceRequired: boolean;
}

export const MINIMUM_RISK_CONTROLS: Readonly<Record<RiskClass, MinimumRiskControl>> = {
  R0: {
    mutationAllowed: false,
    isolatedWorkspaceRequired: false,
    deterministicChecksRequired: false,
    reviewRequired: false,
    independentReviewRequired: false,
    explicitApprovalRequired: false,
    backupRollbackEvidenceRequired: false,
  },
  R1: {
    mutationAllowed: true,
    isolatedWorkspaceRequired: true,
    deterministicChecksRequired: true,
    reviewRequired: false,
    independentReviewRequired: false,
    explicitApprovalRequired: false,
    backupRollbackEvidenceRequired: false,
  },
  R2: {
    mutationAllowed: true,
    isolatedWorkspaceRequired: true,
    deterministicChecksRequired: true,
    reviewRequired: true,
    independentReviewRequired: false,
    explicitApprovalRequired: false,
    backupRollbackEvidenceRequired: false,
  },
  R3: {
    mutationAllowed: true,
    isolatedWorkspaceRequired: true,
    deterministicChecksRequired: true,
    reviewRequired: true,
    independentReviewRequired: true,
    explicitApprovalRequired: true,
    backupRollbackEvidenceRequired: false,
  },
  R4: {
    mutationAllowed: true,
    isolatedWorkspaceRequired: true,
    deterministicChecksRequired: true,
    reviewRequired: true,
    independentReviewRequired: true,
    explicitApprovalRequired: true,
    backupRollbackEvidenceRequired: true,
  },
};

const REQUIRED_AUTONOMOUS_BOUNDS = [
  "maxRuntimeMs",
  "maxToolCalls",
  "maxRetries",
  "maxContextTokens",
  "maxConcurrentSteps",
] as const satisfies readonly (keyof ResourcePolicyEnvelope)[];

export function assertAutonomousRunBounded(envelope: ResourcePolicyEnvelope): void {
  const missing = REQUIRED_AUTONOMOUS_BOUNDS.filter((key) => envelope[key] === undefined);
  if (missing.length > 0) {
    throw new Error(`Autonomous run policy is unbounded: missing ${missing.join(", ")}`);
  }

  for (const key of REQUIRED_AUTONOMOUS_BOUNDS) {
    const value = envelope[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      throw new Error(`Autonomous run policy has invalid ${key}`);
    }
  }
}

export function minimumControlsFor(riskClass: RiskClass): MinimumRiskControl {
  return MINIMUM_RISK_CONTROLS[riskClass];
}
