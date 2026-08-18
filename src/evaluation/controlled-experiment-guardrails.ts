import type { EvidenceRecord, WorkflowRun } from "../control-plane/contracts.js";
import type { EvalCohortComparison, EvalCohortSummary } from "./comparative-statistics.js";
import { compareEvalCohorts, verifyEvalCohortSummary } from "./comparative-statistics.js";
import type { ExecutionReliabilityComparison, ExecutionReliabilitySummary } from "./execution-reliability-statistics.js";
import { compareExecutionReliabilitySummaries, verifyExecutionReliabilitySummary } from "./execution-reliability-statistics.js";
import type { M5AdmissionDecision } from "./m5-admission-gate.js";
import type { ControlledExperimentAuthorization, ControlledExperimentDefinition } from "./controlled-experiment.js";
import { verifyControlledExperimentAuthorization, verifyControlledExperimentDefinition } from "./controlled-experiment.js";

export const CONTROLLED_EXPERIMENT_GUARDRAIL_DECISION_SCHEMA_VERSION = 1 as const;

export type ControlledExperimentGuardrailClassification =
  | "CONTINUE_SHADOW"
  | "ELIGIBLE_FOR_BOUNDED_LIVE"
  | "CONTINUE_BOUNDED_LIVE"
  | "STOP_REQUIRED"
  | "ROLLBACK_REQUIRED"
  | "COMPLETE";

export interface ControlledExperimentProgressInput {
  readonly observedAt: string;
  readonly shadowSamples: number;
  readonly liveSamples: number;
  readonly candidateLiveSamples: number;
  readonly referenceEvalSummary: EvalCohortSummary;
  readonly candidateEvalSummary: EvalCohortSummary;
  readonly referenceExecutionSummary: ExecutionReliabilitySummary;
  readonly candidateExecutionSummary: ExecutionReliabilitySummary;
}

export interface ControlledExperimentGuardrailDecisionPayload {
  readonly experimentId: string;
  readonly experimentSha256: string;
  readonly authorizationId: string;
  readonly authorizationSha256: string;
  readonly admissionDecisionId: string;
  readonly admissionDecisionSha256: string;
  readonly workflowRunId: string;
  readonly observedAt: string;
  readonly referenceEvalSummaryId: string;
  readonly candidateEvalSummaryId: string;
  readonly referenceExecutionSummaryId: string;
  readonly candidateExecutionSummaryId: string;
  readonly completedSamples: number;
  readonly shadowSamples: number;
  readonly liveSamples: number;
  readonly candidateLiveSamples: number;
  readonly candidateTrafficBasisPoints: number;
  readonly evalDeltas: EvalCohortComparison["payload"]["deltas"];
  readonly executionDeltas: ExecutionReliabilityComparison["payload"]["deltas"];
  readonly classification: ControlledExperimentGuardrailClassification;
  readonly reasons: readonly string[];
  readonly guardrailActionRequired: boolean;
  readonly boundedLiveAdmissionEligible: boolean;
  readonly automaticDispatchAllowed: false;
  readonly productionRoutingMutationAllowed: false;
  readonly automaticRollbackAllowed: false;
}

export interface ControlledExperimentGuardrailDecision {
  readonly schemaVersion: typeof CONTROLLED_EXPERIMENT_GUARDRAIL_DECISION_SCHEMA_VERSION;
  readonly algorithm: "sha256";
  readonly decisionId: string;
  readonly decisionSha256: string;
  readonly payload: ControlledExperimentGuardrailDecisionPayload;
}

const DECISION_ENVELOPE_FIELDS = new Set(["schemaVersion", "algorithm", "decisionId", "decisionSha256", "payload"]);
const DECISION_PAYLOAD_FIELDS = new Set([
  "experimentId", "experimentSha256", "authorizationId", "authorizationSha256", "admissionDecisionId", "admissionDecisionSha256", "workflowRunId",
  "observedAt", "referenceEvalSummaryId", "candidateEvalSummaryId", "referenceExecutionSummaryId", "candidateExecutionSummaryId", "completedSamples",
  "shadowSamples", "liveSamples", "candidateLiveSamples", "candidateTrafficBasisPoints", "evalDeltas", "executionDeltas", "classification", "reasons",
  "guardrailActionRequired", "boundedLiveAdmissionEligible", "automaticDispatchAllowed", "productionRoutingMutationAllowed", "automaticRollbackAllowed",
]);
const CLASSIFICATIONS = new Set<ControlledExperimentGuardrailClassification>([
  "CONTINUE_SHADOW", "ELIGIBLE_FOR_BOUNDED_LIVE", "CONTINUE_BOUNDED_LIVE", "STOP_REQUIRED", "ROLLBACK_REQUIRED", "COMPLETE",
]);

export async function evaluateControlledExperimentGuardrails(input: {
  readonly experiment: ControlledExperimentDefinition;
  readonly authorization: ControlledExperimentAuthorization;
  readonly admissionDecision: M5AdmissionDecision;
  readonly workflow: WorkflowRun;
  readonly progress: ControlledExperimentProgressInput;
}): Promise<ControlledExperimentGuardrailDecision> {
  const { experiment, authorization, admissionDecision, workflow, progress } = input;
  await verifyControlledExperimentDefinition(experiment, admissionDecision);
  await verifyControlledExperimentAuthorization(authorization, experiment, admissionDecision, workflow);
  if (authorization.payload.decision !== "allow" || authorization.payload.experimentContractAuthorized !== true) throw new Error("Controlled experiment guardrails require explicit allow authorization");
  assertTimestamp(progress.observedAt, "Controlled experiment progress observedAt");
  assertNonNegativeInteger(progress.shadowSamples, "Controlled experiment shadowSamples");
  assertNonNegativeInteger(progress.liveSamples, "Controlled experiment liveSamples");
  assertNonNegativeInteger(progress.candidateLiveSamples, "Controlled experiment candidateLiveSamples");
  if (progress.candidateLiveSamples > progress.liveSamples) throw new Error("Controlled experiment candidateLiveSamples must not exceed liveSamples");

  await verifyEvalCohortSummary(progress.referenceEvalSummary);
  await verifyEvalCohortSummary(progress.candidateEvalSummary);
  await verifyExecutionReliabilitySummary(progress.referenceExecutionSummary);
  await verifyExecutionReliabilitySummary(progress.candidateExecutionSummary);
  assertSummaryIdentity(experiment, progress);
  assertExecutionCoverage(progress.referenceEvalSummary, progress.referenceExecutionSummary, "reference");
  assertExecutionCoverage(progress.candidateEvalSummary, progress.candidateExecutionSummary, "candidate");

  const completedSamples = progress.candidateEvalSummary.payload.observationCount;
  if (progress.shadowSamples + progress.liveSamples !== completedSamples) throw new Error("Controlled experiment shadow/live sample counters must equal candidate Eval observationCount");
  const candidateTrafficBasisPoints = progress.liveSamples === 0 ? 0 : (progress.candidateLiveSamples / progress.liveSamples) * 10000;
  const evalComparison = await compareEvalCohorts(progress.referenceEvalSummary, progress.candidateEvalSummary);
  const executionComparison = await compareExecutionReliabilitySummaries(progress.referenceExecutionSummary, progress.candidateExecutionSummary);

  const reasons = collectGuardrailReasons(experiment, progress, completedSamples, candidateTrafficBasisPoints, evalComparison, executionComparison);
  const classification = chooseClassification(experiment, progress, completedSamples, reasons);
  const uniqueReasons = reasons.length > 0 ? [...new Set(reasons)].sort() : defaultReasons(classification);
  const payload: ControlledExperimentGuardrailDecisionPayload = deepFreeze({
    experimentId: experiment.experimentId,
    experimentSha256: experiment.experimentSha256,
    authorizationId: authorization.authorizationId,
    authorizationSha256: authorization.authorizationSha256,
    admissionDecisionId: admissionDecision.decisionId,
    admissionDecisionSha256: admissionDecision.decisionSha256,
    workflowRunId: workflow.id,
    observedAt: progress.observedAt,
    referenceEvalSummaryId: progress.referenceEvalSummary.summaryId,
    candidateEvalSummaryId: progress.candidateEvalSummary.summaryId,
    referenceExecutionSummaryId: progress.referenceExecutionSummary.summaryId,
    candidateExecutionSummaryId: progress.candidateExecutionSummary.summaryId,
    completedSamples,
    shadowSamples: progress.shadowSamples,
    liveSamples: progress.liveSamples,
    candidateLiveSamples: progress.candidateLiveSamples,
    candidateTrafficBasisPoints,
    evalDeltas: deepFreeze({ ...evalComparison.payload.deltas }),
    executionDeltas: deepFreeze({ ...executionComparison.payload.deltas }),
    classification,
    reasons: uniqueReasons,
    guardrailActionRequired: classification === "STOP_REQUIRED" || classification === "ROLLBACK_REQUIRED",
    boundedLiveAdmissionEligible: classification === "ELIGIBLE_FOR_BOUNDED_LIVE",
    automaticDispatchAllowed: false as const,
    productionRoutingMutationAllowed: false as const,
    automaticRollbackAllowed: false as const,
  });
  const decisionSha256 = await sha256Canonical(payload);
  return deepFreeze({
    schemaVersion: CONTROLLED_EXPERIMENT_GUARDRAIL_DECISION_SCHEMA_VERSION,
    algorithm: "sha256" as const,
    decisionId: `m5expguard:${decisionSha256.slice(0, 32).toLowerCase()}`,
    decisionSha256,
    payload,
  });
}

export async function verifyControlledExperimentGuardrailDecision(decision: ControlledExperimentGuardrailDecision): Promise<void> {
  if (!isRecord(decision)) throw new Error("Controlled experiment guardrail decision must be an object");
  assertExactAllowedFields(decision, DECISION_ENVELOPE_FIELDS, "Controlled experiment guardrail decision");
  if (decision.schemaVersion !== CONTROLLED_EXPERIMENT_GUARDRAIL_DECISION_SCHEMA_VERSION || decision.algorithm !== "sha256") throw new Error("Controlled experiment guardrail decision envelope is invalid");
  if (!isRecord(decision.payload)) throw new Error("Controlled experiment guardrail decision payload is invalid");
  assertExactAllowedFields(decision.payload, DECISION_PAYLOAD_FIELDS, "Controlled experiment guardrail decision payload");
  const payload = decision.payload;
  for (const [value, label] of [
    [payload.experimentId, "experimentId"], [payload.experimentSha256, "experimentSha256"], [payload.authorizationId, "authorizationId"],
    [payload.authorizationSha256, "authorizationSha256"], [payload.admissionDecisionId, "admissionDecisionId"], [payload.admissionDecisionSha256, "admissionDecisionSha256"],
    [payload.workflowRunId, "workflowRunId"], [payload.referenceEvalSummaryId, "referenceEvalSummaryId"], [payload.candidateEvalSummaryId, "candidateEvalSummaryId"],
    [payload.referenceExecutionSummaryId, "referenceExecutionSummaryId"], [payload.candidateExecutionSummaryId, "candidateExecutionSummaryId"],
  ] as const) assertIdentity(value, `Controlled experiment guardrail ${label}`);
  assertTimestamp(payload.observedAt, "Controlled experiment guardrail observedAt");
  for (const [value, label] of [
    [payload.completedSamples, "completedSamples"], [payload.shadowSamples, "shadowSamples"], [payload.liveSamples, "liveSamples"], [payload.candidateLiveSamples, "candidateLiveSamples"],
  ] as const) assertNonNegativeInteger(value, `Controlled experiment guardrail ${label}`);
  if (payload.shadowSamples + payload.liveSamples !== payload.completedSamples) throw new Error("Controlled experiment guardrail sample counters are inconsistent");
  if (payload.candidateLiveSamples > payload.liveSamples) throw new Error("Controlled experiment guardrail candidateLiveSamples exceeds liveSamples");
  const expectedBasisPoints = payload.liveSamples === 0 ? 0 : (payload.candidateLiveSamples / payload.liveSamples) * 10000;
  if (payload.candidateTrafficBasisPoints !== expectedBasisPoints) throw new Error("Controlled experiment guardrail candidateTrafficBasisPoints mismatch");
  if (!CLASSIFICATIONS.has(payload.classification)) throw new Error("Controlled experiment guardrail classification is invalid");
  validateReasons(payload.reasons);
  if (payload.guardrailActionRequired !== (payload.classification === "STOP_REQUIRED" || payload.classification === "ROLLBACK_REQUIRED")) throw new Error("Controlled experiment guardrail action flag mismatch");
  if (payload.boundedLiveAdmissionEligible !== (payload.classification === "ELIGIBLE_FOR_BOUNDED_LIVE")) throw new Error("Controlled experiment bounded-live eligibility flag mismatch");
  if (payload.automaticDispatchAllowed !== false || payload.productionRoutingMutationAllowed !== false || payload.automaticRollbackAllowed !== false) throw new Error("Controlled experiment guardrail decision cannot grant automatic authority");
  const expected = await sha256Canonical(payload);
  if (decision.decisionSha256 !== expected) throw new Error("Controlled experiment guardrail decision digest does not match canonical payload");
  if (decision.decisionId !== `m5expguard:${expected.slice(0, 32).toLowerCase()}`) throw new Error("Controlled experiment guardrail decisionId does not match canonical payload");
}

export function controlledExperimentGuardrailDecisionToEvidence(
  decision: ControlledExperimentGuardrailDecision,
  collectedAt: string,
): EvidenceRecord {
  assertTimestamp(collectedAt, "Controlled experiment guardrail evidence collectedAt");
  const failed = decision.payload.classification === "STOP_REQUIRED" || decision.payload.classification === "ROLLBACK_REQUIRED";
  return deepFreeze({
    kind: "deterministic_check" as const,
    status: failed ? "failed" as const : "passed" as const,
    reference: `controlled-experiment-guardrail:${decision.decisionId}`,
    producer: "controlled-experiment-guardrail",
    collectedAt,
    metadata: deepFreeze({
      experimentId: decision.payload.experimentId,
      classification: decision.payload.classification,
      completedSamples: decision.payload.completedSamples,
      liveSamples: decision.payload.liveSamples,
    }),
  });
}

function collectGuardrailReasons(
  experiment: ControlledExperimentDefinition,
  progress: ControlledExperimentProgressInput,
  completedSamples: number,
  candidateTrafficBasisPoints: number,
  evalComparison: EvalCohortComparison,
  executionComparison: ExecutionReliabilityComparison,
): string[] {
  const reasons: string[] = [];
  const budget = experiment.payload.budget;
  const stop = experiment.payload.stopConditions;
  if (completedSamples > budget.maxTotalSamples) reasons.push("total_sample_budget_exceeded");
  if (progress.liveSamples > budget.maxLiveSamples) reasons.push("live_sample_budget_exceeded");
  if (progress.candidateLiveSamples > budget.maxCandidateLiveSamples) reasons.push("candidate_live_sample_budget_exceeded");
  if (candidateTrafficBasisPoints > budget.maxCandidateTrafficBasisPoints) reasons.push("candidate_live_traffic_share_exceeded");
  if (progress.liveSamples > 0 && progress.shadowSamples < budget.minimumShadowSamplesBeforeLive) reasons.push("live_exposure_started_before_minimum_shadow_samples");
  if (experiment.payload.exposureMode === "shadow_only" && progress.liveSamples > 0) reasons.push("shadow_only_experiment_observed_live_exposure");

  const evalDeltas = evalComparison.payload.deltas;
  if (evalDeltas.weightedScoreMean < -stop.maximumWeightedScoreMeanRegression) reasons.push("weighted_score_regressed_beyond_stop_condition");
  if (evalDeltas.taskPassRateMean < -stop.maximumTaskPassRateMeanRegression) reasons.push("task_pass_rate_regressed_beyond_stop_condition");
  if (evalDeltas.criticalPassRateMean < -stop.maximumCriticalPassRateMeanRegression) reasons.push("critical_pass_rate_regressed_beyond_stop_condition");
  if (evalDeltas.baselinePassRate < -stop.maximumBaselinePassRateRegression) reasons.push("baseline_pass_rate_regressed_beyond_stop_condition");
  if (stop.maximumLatencyMeanIncreaseMs !== undefined) {
    if (evalDeltas.latencyMeanMs === null) reasons.push("latency_delta_unavailable_for_stop_condition");
    else if (evalDeltas.latencyMeanMs > stop.maximumLatencyMeanIncreaseMs) reasons.push("latency_increased_beyond_stop_condition");
  }
  if (stop.maximumCostMeanIncreaseUsd !== undefined) {
    if (evalDeltas.costMeanUsd === null) reasons.push("cost_delta_unavailable_for_stop_condition");
    else if (evalDeltas.costMeanUsd > stop.maximumCostMeanIncreaseUsd) reasons.push("cost_increased_beyond_stop_condition");
  }

  const candidateExecution = progress.candidateExecutionSummary.payload;
  if (candidateExecution.failed > stop.maxFailedExecutions) reasons.push("failed_execution_count_exceeded_stop_condition");
  if (candidateExecution.cancellationRate > stop.maximumCancellationRate) reasons.push("cancellation_rate_exceeded_stop_condition");
  const executionDeltas = executionComparison.payload.deltas;
  if (executionDeltas.successRateExcludingCancelled === null) reasons.push("execution_success_delta_unavailable_for_stop_condition");
  else if (executionDeltas.successRateExcludingCancelled < -stop.maximumExecutionSuccessRateRegression) reasons.push("execution_success_rate_regressed_beyond_stop_condition");
  return reasons;
}

function chooseClassification(
  experiment: ControlledExperimentDefinition,
  progress: ControlledExperimentProgressInput,
  completedSamples: number,
  reasons: readonly string[],
): ControlledExperimentGuardrailClassification {
  if (reasons.length > 0) return progress.liveSamples > 0 ? "ROLLBACK_REQUIRED" : "STOP_REQUIRED";
  const budget = experiment.payload.budget;
  if (completedSamples >= budget.maxTotalSamples) return "COMPLETE";
  if (experiment.payload.exposureMode === "shadow_only") return "CONTINUE_SHADOW";
  if (progress.liveSamples === 0 && progress.shadowSamples < budget.minimumShadowSamplesBeforeLive) return "CONTINUE_SHADOW";
  if (progress.liveSamples === 0) return "ELIGIBLE_FOR_BOUNDED_LIVE";
  if (progress.liveSamples >= budget.maxLiveSamples || progress.candidateLiveSamples >= budget.maxCandidateLiveSamples) return "COMPLETE";
  return "CONTINUE_BOUNDED_LIVE";
}

function defaultReasons(classification: ControlledExperimentGuardrailClassification): readonly string[] {
  switch (classification) {
    case "CONTINUE_SHADOW": return ["shadow_guardrails_satisfied_and_budget_remaining"];
    case "ELIGIBLE_FOR_BOUNDED_LIVE": return ["minimum_shadow_evidence_satisfied_but_live_dispatch_requires_separate_explicit_action"];
    case "CONTINUE_BOUNDED_LIVE": return ["bounded_live_guardrails_satisfied_and_budget_remaining"];
    case "COMPLETE": return ["experiment_budget_completed_without_guardrail_breach"];
    case "STOP_REQUIRED":
    case "ROLLBACK_REQUIRED": return ["guardrail_action_required"];
  }
}

function assertSummaryIdentity(experiment: ControlledExperimentDefinition, progress: ControlledExperimentProgressInput): void {
  const payload = experiment.payload;
  for (const summary of [progress.referenceEvalSummary, progress.candidateEvalSummary]) {
    if (summary.payload.suiteId !== payload.suiteId || summary.payload.suiteSha256 !== payload.suiteSha256 || summary.payload.baselineId !== payload.baselineId) throw new Error("Controlled experiment Eval summary does not match experiment suite/baseline provenance");
  }
  if (progress.referenceEvalSummary.payload.subjectId !== payload.referenceSubjectId) throw new Error("Controlled experiment reference Eval subject does not match experiment reference subject");
  if (progress.candidateEvalSummary.payload.subjectId !== payload.candidateSubjectId) throw new Error("Controlled experiment candidate Eval subject does not match experiment candidate subject");
  if (progress.referenceExecutionSummary.payload.subjectId !== payload.referenceSubjectId || progress.candidateExecutionSummary.payload.subjectId !== payload.candidateSubjectId) throw new Error("Controlled experiment execution summary subject does not match experiment subjects");
  for (const summary of [progress.referenceExecutionSummary, progress.candidateExecutionSummary]) {
    if (summary.payload.suiteId !== payload.suiteId || summary.payload.suiteSha256 !== payload.suiteSha256 || summary.payload.baselineId !== payload.baselineId) throw new Error("Controlled experiment execution summary does not match experiment suite/baseline provenance");
  }
}

function assertExecutionCoverage(evalSummary: EvalCohortSummary, executionSummary: ExecutionReliabilitySummary, label: string): void {
  if (!sameIdentitySet(evalSummary.payload.observationIds, executionSummary.payload.observationIds)) throw new Error(`Controlled experiment ${label} execution summary must cover exact Eval observation set`);
}

function sameIdentitySet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((value, index) => value === b[index]);
}

function validateReasons(reasons: readonly string[]): void {
  if (!Array.isArray(reasons) || reasons.length === 0) throw new Error("Controlled experiment guardrail decision requires reasons");
  if (new Set(reasons).size !== reasons.length) throw new Error("Controlled experiment guardrail reasons must be unique");
  const sorted = [...reasons].sort();
  if (sorted.some((value, index) => value !== reasons[index])) throw new Error("Controlled experiment guardrail reasons must be canonically sorted");
  reasons.forEach((reason) => assertIdentity(reason, "Controlled experiment guardrail reason"));
}

function assertIdentity(value: string, label: string): void {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must not be empty`);
  if (new TextEncoder().encode(value).byteLength > 2048) throw new Error(`${label} exceeds 2048 bytes`);
}

function assertTimestamp(value: string, label: string): void {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`${label} must be a valid timestamp`);
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
}

function assertExactAllowedFields(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${label}.${key} is not allowed`);
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
