import type { RunLedgerRecord } from "../control-plane/contracts.js";
import { InMemoryRunLedger } from "../control-plane/run-ledger.js";
import type { EvalHistoryObservation } from "./eval-history.js";
import { verifyEvalHistoryObservation } from "./eval-history.js";
import type { ExecutionMetricProjection } from "./execution-metrics-projection.js";
import { verifyExecutionMetricProjection } from "./execution-metrics-projection.js";

export const EXECUTION_RELIABILITY_SUMMARY_SCHEMA_VERSION = 1 as const;
export const EXECUTION_RELIABILITY_COMPARISON_SCHEMA_VERSION = 1 as const;

export interface ExecutionReliabilitySummaryPayload {
  readonly suiteId: string;
  readonly suiteSha256: string;
  readonly baselineId: string;
  readonly subjectId: string;
  readonly observationIds: readonly string[];
  readonly projectionIds: readonly string[];
  readonly sampleCount: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly decidedSampleCount: number;
  readonly successRateExcludingCancelled: number | null;
  readonly failureRateExcludingCancelled: number | null;
  readonly cancellationRate: number;
}

export interface ExecutionReliabilitySummary {
  readonly schemaVersion: typeof EXECUTION_RELIABILITY_SUMMARY_SCHEMA_VERSION;
  readonly algorithm: "sha256";
  readonly summaryId: string;
  readonly summarySha256: string;
  readonly payload: ExecutionReliabilitySummaryPayload;
}

export interface ExecutionReliabilityComparisonPayload {
  readonly suiteId: string;
  readonly suiteSha256: string;
  readonly baselineId: string;
  readonly referenceSummaryId: string;
  readonly candidateSummaryId: string;
  readonly referenceSubjectId: string;
  readonly candidateSubjectId: string;
  readonly deltas: {
    readonly successRateExcludingCancelled: number | null;
    readonly failureRateExcludingCancelled: number | null;
    readonly cancellationRate: number;
  };
}

export interface ExecutionReliabilityComparison {
  readonly schemaVersion: typeof EXECUTION_RELIABILITY_COMPARISON_SCHEMA_VERSION;
  readonly algorithm: "sha256";
  readonly comparisonId: string;
  readonly comparisonSha256: string;
  readonly payload: ExecutionReliabilityComparisonPayload;
}

export async function buildExecutionReliabilitySummary(
  observations: readonly EvalHistoryObservation[],
  projections: readonly ExecutionMetricProjection[],
  runLedgerRecords: readonly RunLedgerRecord[],
): Promise<ExecutionReliabilitySummary> {
  if (!Array.isArray(observations) || observations.length === 0) throw new Error("Execution reliability summary requires at least one Eval History observation");
  if (!Array.isArray(projections) || projections.length === 0) throw new Error("Execution reliability summary requires execution metric projections");
  if (!Array.isArray(runLedgerRecords) || runLedgerRecords.length === 0) throw new Error("Execution reliability summary requires canonical Run Ledger records");

  for (const observation of observations) await verifyEvalHistoryObservation(observation);
  for (const projection of projections) await verifyExecutionMetricProjection(projection);
  const records = validateRunLedgerSet(runLedgerRecords);
  const projectionById = new Map(projections.map((item) => [item.projectionId, item]));

  const first = observations[0].payload;
  for (const observation of observations.slice(1)) {
    if (observation.payload.report.payload.suiteId !== first.report.payload.suiteId) throw new Error("Execution reliability cohort mixes suiteId values");
    if (observation.payload.report.payload.suiteSha256 !== first.report.payload.suiteSha256) throw new Error("Execution reliability cohort mixes suiteSha256 values");
    if (observation.payload.baseline.baselineId !== first.baseline.baselineId) throw new Error("Execution reliability cohort mixes baselineId values");
    if (observation.payload.report.payload.subjectId !== first.report.payload.subjectId) throw new Error("Execution reliability cohort mixes subjectId values");
  }

  const resolved = observations.map((observation) => {
    const measurement = observation.payload.measurement;
    if (!measurement) throw new Error(`Execution reliability observation ${observation.observationId} has no measurement sample`);
    const projectionRefs = measurement.sourceReferences.filter((item: string) => item.startsWith("execution-metric:"));
    if (projectionRefs.length !== 1) throw new Error(`Execution reliability observation ${observation.observationId} must reference exactly one execution metric projection`);
    const projectionId = projectionRefs[0].slice("execution-metric:".length);
    const projection = projectionById.get(projectionId);
    if (!projection) throw new Error(`Execution reliability observation ${observation.observationId} references unknown projection ${projectionId}`);
    const runReference = `run-ledger:${projection.payload.runId}`;
    if (!measurement.sourceReferences.includes(runReference)) throw new Error(`Execution reliability observation ${observation.observationId} is missing matching ${runReference}`);
    const record = records.get(projection.payload.runId);
    if (!record) throw new Error(`Execution reliability projection ${projection.projectionId} references missing Run Ledger ${projection.payload.runId}`);
    if (record.projectId !== projection.payload.projectId || record.traceId !== projection.payload.traceId || record.runtimeId !== projection.payload.runtimeId || record.outcome !== projection.payload.outcome) {
      throw new Error(`Execution reliability projection ${projection.projectionId} does not match canonical Run Ledger identity/outcome`);
    }
    if (measurement.latencyMs !== projection.payload.latencyMs || measurement.costUsd !== projection.payload.costUsd) {
      throw new Error(`Execution reliability observation ${observation.observationId} measurement does not match execution metric projection`);
    }
    return { observation, projection, outcome: record.outcome };
  });

  const uniqueProjectionIds = new Set(resolved.map((item) => item.projection.projectionId));
  if (uniqueProjectionIds.size !== resolved.length) throw new Error("Execution reliability cohort reuses one execution projection across multiple observations");

  const succeeded = resolved.filter((item) => item.outcome === "succeeded").length;
  const failed = resolved.filter((item) => item.outcome === "failed").length;
  const cancelled = resolved.filter((item) => item.outcome === "cancelled").length;
  const decidedSampleCount = succeeded + failed;
  const sorted = [...resolved].sort((left, right) => left.observation.observationId.localeCompare(right.observation.observationId));
  const payload: ExecutionReliabilitySummaryPayload = deepFreeze({
    suiteId: first.report.payload.suiteId,
    suiteSha256: first.report.payload.suiteSha256,
    baselineId: first.baseline.baselineId,
    subjectId: first.report.payload.subjectId,
    observationIds: sorted.map((item) => item.observation.observationId),
    projectionIds: sorted.map((item) => item.projection.projectionId),
    sampleCount: resolved.length,
    succeeded,
    failed,
    cancelled,
    decidedSampleCount,
    successRateExcludingCancelled: decidedSampleCount === 0 ? null : succeeded / decidedSampleCount,
    failureRateExcludingCancelled: decidedSampleCount === 0 ? null : failed / decidedSampleCount,
    cancellationRate: cancelled / resolved.length,
  });
  const summarySha256 = await sha256Canonical(payload);
  return deepFreeze({
    schemaVersion: EXECUTION_RELIABILITY_SUMMARY_SCHEMA_VERSION,
    algorithm: "sha256" as const,
    summaryId: `execrel:${summarySha256.slice(0, 32).toLowerCase()}`,
    summarySha256,
    payload,
  });
}

export async function compareExecutionReliabilitySummaries(
  reference: ExecutionReliabilitySummary,
  candidate: ExecutionReliabilitySummary,
): Promise<ExecutionReliabilityComparison> {
  await verifyExecutionReliabilitySummary(reference);
  await verifyExecutionReliabilitySummary(candidate);
  if (reference.payload.suiteId !== candidate.payload.suiteId) throw new Error("Execution reliability comparison requires matching suiteId");
  if (reference.payload.suiteSha256 !== candidate.payload.suiteSha256) throw new Error("Execution reliability comparison requires matching suiteSha256");
  if (reference.payload.baselineId !== candidate.payload.baselineId) throw new Error("Execution reliability comparison requires matching baselineId");

  const payload: ExecutionReliabilityComparisonPayload = deepFreeze({
    suiteId: reference.payload.suiteId,
    suiteSha256: reference.payload.suiteSha256,
    baselineId: reference.payload.baselineId,
    referenceSummaryId: reference.summaryId,
    candidateSummaryId: candidate.summaryId,
    referenceSubjectId: reference.payload.subjectId,
    candidateSubjectId: candidate.payload.subjectId,
    deltas: {
      successRateExcludingCancelled: differenceOrNull(reference.payload.successRateExcludingCancelled, candidate.payload.successRateExcludingCancelled),
      failureRateExcludingCancelled: differenceOrNull(reference.payload.failureRateExcludingCancelled, candidate.payload.failureRateExcludingCancelled),
      cancellationRate: candidate.payload.cancellationRate - reference.payload.cancellationRate,
    },
  });
  const comparisonSha256 = await sha256Canonical(payload);
  return deepFreeze({
    schemaVersion: EXECUTION_RELIABILITY_COMPARISON_SCHEMA_VERSION,
    algorithm: "sha256" as const,
    comparisonId: `execrelcmp:${comparisonSha256.slice(0, 32).toLowerCase()}`,
    comparisonSha256,
    payload,
  });
}

export async function verifyExecutionReliabilitySummary(summary: ExecutionReliabilitySummary): Promise<void> {
  if (!isRecord(summary) || summary.schemaVersion !== EXECUTION_RELIABILITY_SUMMARY_SCHEMA_VERSION || summary.algorithm !== "sha256") throw new Error("Execution reliability summary envelope is invalid");
  const expected = await sha256Canonical(summary.payload);
  if (summary.summarySha256 !== expected) throw new Error("Execution reliability summary digest does not match canonical payload");
  if (summary.summaryId !== `execrel:${expected.slice(0, 32).toLowerCase()}`) throw new Error("Execution reliability summaryId does not match canonical payload");
  validateSummaryPayload(summary.payload);
}

export async function verifyExecutionReliabilityComparison(comparison: ExecutionReliabilityComparison): Promise<void> {
  if (!isRecord(comparison) || comparison.schemaVersion !== EXECUTION_RELIABILITY_COMPARISON_SCHEMA_VERSION || comparison.algorithm !== "sha256") throw new Error("Execution reliability comparison envelope is invalid");
  const expected = await sha256Canonical(comparison.payload);
  if (comparison.comparisonSha256 !== expected) throw new Error("Execution reliability comparison digest does not match canonical payload");
  if (comparison.comparisonId !== `execrelcmp:${expected.slice(0, 32).toLowerCase()}`) throw new Error("Execution reliability comparisonId does not match canonical payload");
}

function validateRunLedgerSet(records: readonly RunLedgerRecord[]): Map<string, RunLedgerRecord> {
  const ledger = new InMemoryRunLedger();
  for (const record of records) ledger.append(record);
  return new Map(ledger.list().map((record) => [record.runId, record]));
}

function validateSummaryPayload(payload: ExecutionReliabilitySummaryPayload): void {
  if (!isRecord(payload)) throw new Error("Execution reliability summary payload must be an object");
  if (!Number.isInteger(payload.sampleCount) || payload.sampleCount <= 0) throw new Error("Execution reliability sampleCount is invalid");
  if (!Number.isInteger(payload.succeeded) || !Number.isInteger(payload.failed) || !Number.isInteger(payload.cancelled)) throw new Error("Execution reliability outcome counts must be integers");
  if (payload.succeeded < 0 || payload.failed < 0 || payload.cancelled < 0) throw new Error("Execution reliability outcome counts must be non-negative");
  if (payload.succeeded + payload.failed + payload.cancelled !== payload.sampleCount) throw new Error("Execution reliability outcome counts do not match sampleCount");
  if (payload.decidedSampleCount !== payload.succeeded + payload.failed) throw new Error("Execution reliability decidedSampleCount mismatch");
  if (payload.cancellationRate !== payload.cancelled / payload.sampleCount) throw new Error("Execution reliability cancellationRate mismatch");
  if (payload.decidedSampleCount === 0) {
    if (payload.successRateExcludingCancelled !== null || payload.failureRateExcludingCancelled !== null) throw new Error("Execution reliability decided rates must be null when every sample is cancelled");
  } else {
    if (payload.successRateExcludingCancelled !== payload.succeeded / payload.decidedSampleCount) throw new Error("Execution reliability success rate mismatch");
    if (payload.failureRateExcludingCancelled !== payload.failed / payload.decidedSampleCount) throw new Error("Execution reliability failure rate mismatch");
  }
}

function differenceOrNull(reference: number | null, candidate: number | null): number | null {
  return reference === null || candidate === null ? null : candidate - reference;
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
