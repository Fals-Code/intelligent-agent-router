import type { Complexity, PrivacyTier, RiskLevel } from "../domain/types.js";

export const complexityRank: Record<Complexity, number> = {
  simple: 1,
  moderate: 2,
  complex: 3,
  expert: 4,
};

export const riskRank: Record<RiskLevel, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export const privacyRank: Record<PrivacyTier, number> = {
  public: 1,
  internal: 2,
  confidential: 3,
  restricted: 4,
};

export function jaccard(left: string[], right: string[]): number {
  const a = new Set(left);
  const b = new Set(right);
  const union = new Set([...a, ...b]);
  if (union.size === 0) return 1;
  let intersection = 0;
  for (const value of a) if (b.has(value)) intersection += 1;
  return intersection / union.size;
}

export function overlapRatio(required: string[], actual: string[]): number {
  if (required.length === 0) return 1;
  const set = new Set(actual);
  return required.filter((item) => set.has(item)).length / required.length;
}

export function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}
