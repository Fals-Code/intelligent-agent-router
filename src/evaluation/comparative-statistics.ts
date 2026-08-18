import type { EvalHistoryObservation } from "./eval-history.js";
import { verifyEvalHistoryObservation } from "./eval-history.js";

export const EVAL_COHORT_SUMMARY_SCHEMA_VERSION = 1 as const;
export const EVAL_COHORT_COMPARISON_SCHEMA_VERSION = 1 as const;

export interface NumericDistributionSummary {
  readonly sampleCount: number;
  readonly min: number;
  readonly max: number;
  readonly mean: number;
  readonly p50: number;
  readonly p95: number;
}

export interface EvalCohortSummaryPayload {
  readonly suiteId: string;
  readonly suiteSha256: string;
  readonly baselineId: string;
  readonly subjectId: string;
  readonly observationIds: readonly string[];
  readonly observationCount: number;
  readonly quality: {
    readonly weightedScore: NumericDistributionSummary;
    readonly taskPassRate: NumericDistributionSummary;
    readonly criticalPassRate: NumericDistributionSummary;
  };
  readonly reliability: {
    readonly baselinePassRate: number;
    readonly passedObservations: number;
    readonly failedObservations: number;
  };
  readonly latencyMs: NumericDistributionSummary | null;
  readonly costUsd: NumericDistributionSummary | null;
}

export interface EvalCohortSummary {
  readonly schemaVersion: typeof EVAL_COHORT_SUMMARY_SCHEMA_VERSION;
  readonly algorithm: "sha256";
  readonly summaryId: string;
  readonly summarySha256: string;
  readonly payload: EvalCohortSummaryPayload;
}

export interface EvalCohortComparisonPayload {
  readonly suiteId: string;
  readonly suiteSha256: string;
  readonly baselineId: string;
  readonly referenceSummaryId: string;
  readonly candidateSummaryId: string;
  readonly referenceSubjectId: string;
  readonly candidateSubjectId: string;
  readonly deltas: {
    readonly weightedScoreMean: number;
    readonly taskPassRateMean: number;
    readonly criticalPassRateMean: number;
    readonly baselinePassRate: number;
    readonly latencyMeanMs: number | null;
    readonly costMeanUsd: number | null;
  };
}

export interface EvalCohortComparison {
  readonly schemaVersion: typeof EVAL_COHORT_COMPARISON_SCHEMA_VERSION;
  readonly algorithm: "sha256";
  readonly comparisonId: string;
  readonly comparisonSha256: string;
  readonly payload: EvalCohortComparisonPayload;
}

/**
 * Builds a descriptive, content-addressed cohort summary from durable history.
 * The cohort must use one exact suite digest, baseline, and subject. Optional
 * latency/cost dimensions only include observations that actually carry those
 * measurements; missing values are unavailable rather than coerced to zero.
 */
export async function buildEvalCohortSummary(observations: readonly EvalHistoryObservation[]): Promise<EvalCohortSummary> {
  if (!Array.isArray(observations) || observations.length === 0) throw new Error("Eval cohort requires at least one observation");
  for (const observation of observations) await verifyEvalHistoryObservation(observation);

  const first = observations[0].payload;
  for (const observation of observations.slice(1)) {
    const payload = observation.payload;
    if (payload.report.payload.suiteId !== first.report.payload.suiteId) throw new Error("Eval cohort mixes suiteId values");
    if (payload.report.payload.suiteSha256 !== first.report.payload.suiteSha256) throw new Error("Eval cohort mixes suiteSha256 values");
    if (payload.baseline.baselineId !== first.baseline.baselineId) throw new Error("Eval cohort mixes baselineId values");
    if (payload.report.payload.subjectId !== first.report.payload.subjectId) throw new Error("Eval cohort mixes subjectId values");
  }

  const sorted = [...observations].sort((left, right) => left.observationId.localeCompare(right.observationId));
  const weightedScores = sorted.map((item) => item.payload.report.payload.metrics.weightedScore);
  const taskPassRates = sorted.map((item) => item.payload.report.payload.metrics.taskPassRate);
  const criticalPassRates = sorted.map((item) => item.payload.report.payload.metrics.criticalPassRate);
  const latencySamples = sorted.flatMap((item) => item.payload.measurement?.latencyMs === undefined ? [] : [item.payload.measurement.latencyMs]);
  const costSamples = sorted.flatMap((item) => item.payload.measurement?.costUsd === undefined ? [] : [item.payload.measurement.costUsd]);
  const passedObservations = sorted.filter((item) => item.payload.comparison.passed).length;

  const payload: EvalCohortSummaryPayload = deepFreeze({
    suiteId: first.report.payload.suiteId,
    suiteSha256: first.report.payload.suiteSha256,
    baselineId: first.baseline.baselineId,
    subjectId: first.report.payload.subjectId,
    observationIds: sorted.map((item) => item.observationId),
    observationCount: sorted.length,
    quality: {
      weightedScore: summarizeNumeric(weightedScores),
      taskPassRate: summarizeNumeric(taskPassRates),
      criticalPassRate: summarizeNumeric(criticalPassRates),
    },
    reliability: {
      baselinePassRate: passedObservations / sorted.length,
      passedObservations,
      failedObservations: sorted.length - passedObservations,
    },
    latencyMs: latencySamples.length === 0 ? null : summarizeNumeric(latencySamples),
    costUsd: costSamples.length === 0 ? null : summarizeNumeric(costSamples),
  });
  const summarySha256 = await sha256Canonical(payload);
  return deepFreeze({
    schemaVersion: EVAL_COHORT_SUMMARY_SCHEMA_VERSION,
    algorithm: "sha256" as const,
    summaryId: `evalsummary:${summarySha256.slice(0, 32).toLowerCase()}`,
    summarySha256,
    payload,
  });
}

/**
 * Compares two descriptive summaries over the same suite digest and baseline.
 * Positive quality/reliability deltas favor the candidate. Positive latency/cost
 * deltas mean the candidate is slower/more expensive. This function performs no
 * significance testing and grants no authority to alter routing.
 */
export async function compareEvalCohorts(reference: EvalCohortSummary, candidate: EvalCohortSummary): Promise<EvalCohortComparison> {
  await verifyEvalCohortSummary(reference);
  await verifyEvalCohortSummary(candidate);
  if (reference.payload.suiteId !== candidate.payload.suiteId) throw new Error("Eval cohort comparison requires matching suiteId");
  if (reference.payload.suiteSha256 !== candidate.payload.suiteSha256) throw new Error("Eval cohort comparison requires matching suiteSha256");
  if (reference.payload.baselineId !== candidate.payload.baselineId) throw new Error("Eval cohort comparison requires matching baselineId");

  const payload: EvalCohortComparisonPayload = deepFreeze({
    suiteId: reference.payload.suiteId,
    suiteSha256: reference.payload.suiteSha256,
    baselineId: reference.payload.baselineId,
    referenceSummaryId: reference.summaryId,
    candidateSummaryId: candidate.summaryId,
    referenceSubjectId: reference.payload.subjectId,
    candidateSubjectId: candidate.payload.subjectId,
    deltas: {
      weightedScoreMean: candidate.payload.quality.weightedScore.mean - reference.payload.quality.weightedScore.mean,
      taskPassRateMean: candidate.payload.quality.taskPassRate.mean - reference.payload.quality.taskPassRate.mean,
      criticalPassRateMean: candidate.payload.quality.criticalPassRate.mean - reference.payload.quality.criticalPassRate.mean,
      baselinePassRate: candidate.payload.reliability.baselinePassRate - reference.payload.reliability.baselinePassRate,
      latencyMeanMs: differenceOrNull(reference.payload.latencyMs?.mean, candidate.payload.latencyMs?.mean),
      costMeanUsd: differenceOrNull(reference.payload.costUsd?.mean, candidate.payload.costUsd?.mean),
    },
  });
  const comparisonSha256 = await sha256Canonical(payload);
  return deepFreeze({
    schemaVersion: EVAL_COHORT_COMPARISON_SCHEMA_VERSION,
    algorithm: "sha256" as const,
    comparisonId: `evalcmp:${comparisonSha256.slice(0, 32).toLowerCase()}`,
    comparisonSha256,
    payload,
  });
}

export async function verifyEvalCohortSummary(summary: EvalCohortSummary): Promise<void> {
  if (!isRecord(summary) || summary.schemaVersion !== EVAL_COHORT_SUMMARY_SCHEMA_VERSION || summary.algorithm !== "sha256") throw new Error("Eval cohort summary envelope is invalid");
  const expected = await sha256Canonical(summary.payload);
  if (summary.summarySha256 !== expected) throw new Error("Eval cohort summary digest does not match canonical payload");
  if (summary.summaryId !== `evalsummary:${expected.slice(0, 32).toLowerCase()}`) throw new Error("Eval cohort summaryId does not match canonical payload");
  validateSummaryPayload(summary.payload);
}

export async function verifyEvalCohortComparison(comparison: EvalCohortComparison): Promise<void> {
  if (!isRecord(comparison) || comparison.schemaVersion !== EVAL_COHORT_COMPARISON_SCHEMA_VERSION || comparison.algorithm !== "sha256") throw new Error("Eval cohort comparison envelope is invalid");
  const expected = await sha256Canonical(comparison.payload);
  if (comparison.comparisonSha256 !== expected) throw new Error("Eval cohort comparison digest does not match canonical payload");
  if (comparison.comparisonId !== `evalcmp:${expected.slice(0, 32).toLowerCase()}`) throw new Error("Eval cohort comparisonId does not match canonical payload");
}

function summarizeNumeric(values: readonly number[]): NumericDistributionSummary {
  if (values.length === 0) throw new Error("Numeric distribution requires at least one sample");
  if (values.some((value) => !Number.isFinite(value))) throw new Error("Numeric distribution contains non-finite values");
  const sorted = [...values].sort((left, right) => left - right);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return deepFreeze({
    sampleCount: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: sum / sorted.length,
    p50: nearestRank(sorted, 0.5),
    p95: nearestRank(sorted, 0.95),
  });
}

function nearestRank(sorted: readonly number[], percentile: number): number {
  const rank = Math.max(1, Math.ceil(percentile * sorted.length));
  return sorted[Math.min(sorted.length - 1, rank - 1)];
}

function differenceOrNull(reference: number | undefined, candidate: number | undefined): number | null {
  return reference === undefined || candidate === undefined ? null : candidate - reference;
}

function validateSummaryPayload(payload: EvalCohortSummaryPayload): void {
  if (!isRecord(payload)) throw new Error("Eval cohort summary payload must be an object");
  if (!Array.isArray(payload.observationIds) || payload.observationIds.length === 0) throw new Error("Eval cohort summary requires observationIds");
  if (payload.observationCount !== payload.observationIds.length) throw new Error("Eval cohort summary observationCount mismatch");
  if (!Number.isFinite(payload.reliability.baselinePassRate) || payload.reliability.baselinePassRate < 0 || payload.reliability.baselinePassRate > 1) throw new Error("Eval cohort baselinePassRate is invalid");
  for (const summary of [payload.quality.weightedScore, payload.quality.taskPassRate, payload.quality.criticalPassRate]) validateDistribution(summary);
  if (payload.latencyMs !== null) validateDistribution(payload.latencyMs);
  if (payload.costUsd !== null) validateDistribution(payload.costUsd);
}

function validateDistribution(summary: NumericDistributionSummary): void {
  if (!Number.isInteger(summary.sampleCount) || summary.sampleCount <= 0) throw new Error("Eval numeric summary sampleCount is invalid");
  for (const value of [summary.min, summary.max, summary.mean, summary.p50, summary.p95]) if (!Number.isFinite(value)) throw new Error("Eval numeric summary contains non-finite values");
  if (summary.min > summary.max) throw new Error("Eval numeric summary min exceeds max");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function sha256Canonical(value: unknown): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("Web Crypto SHA-256 is unavailable in this runtime");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(stableStringify(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, sortJson(child)]));
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}
