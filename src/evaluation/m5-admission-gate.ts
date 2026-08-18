import type { EvalCohortComparison, EvalCohortSummary } from "./comparative-statistics.js";
import { compareEvalCohorts, verifyEvalCohortSummary } from "./comparative-statistics.js";
import type { ExecutionReliabilityComparison, ExecutionReliabilitySummary } from "./execution-reliability-statistics.js";
import { compareExecutionReliabilitySummaries, verifyExecutionReliabilitySummary } from "./execution-reliability-statistics.js";
import type { MetricTaxonomy } from "./metric-taxonomy.js";
import { verifyMetricTaxonomy } from "./metric-taxonomy.js";

export const M5_ADMISSION_POLICY_SCHEMA_VERSION = 1 as const;
export const M5_ADMISSION_DECISION_SCHEMA_VERSION = 1 as const;

export type M5AdmissionClassification =
  | "INSUFFICIENT_EVIDENCE"
  | "MEASUREMENT_DRIFT"
  | "NOT_ELIGIBLE_FOR_CONTROLLED_EXPERIMENT"
  | "ELIGIBLE_FOR_CONTROLLED_EXPERIMENT";

export interface M5AdmissionPolicyInput {
  readonly name: string;
  readonly minimumObservationCount: number;
  readonly requireExecutionReliability: boolean;
  readonly requireFullExecutionProvenance: boolean;
  readonly minimumExecutionSampleCount: number;
  readonly minimumDecidedExecutionSampleCount: number;
  readonly minimumLatencyCoverageRatio: number;
  readonly minimumCostCoverageRatio: number;
  readonly maximumCoverageRegressionRatio: number;
  readonly maximumWeightedScoreMeanRegression: number;
  readonly maximumTaskPassRateMeanRegression: number;
  readonly maximumCriticalPassRateMeanRegression: number;
  readonly maximumBaselinePassRateRegression: number;
  readonly maximumExecutionSuccessRateRegression: number;
  readonly maximumCancellationRateIncrease: number;
  readonly maximumLatencyMeanIncreaseMs?: number;
  readonly maximumCostMeanIncreaseUsd?: number;
}

export interface M5AdmissionPolicyPayload extends M5AdmissionPolicyInput {
  readonly taxonomyId: string;
}

export interface M5AdmissionPolicy {
  readonly schemaVersion: typeof M5_ADMISSION_POLICY_SCHEMA_VERSION;
  readonly algorithm: "sha256";
  readonly policyId: string;
  readonly policySha256: string;
  readonly payload: M5AdmissionPolicyPayload;
}

export interface M5AdmissionCohortInput {
  readonly evalSummary: EvalCohortSummary;
  readonly executionSummary?: ExecutionReliabilitySummary;
}

export interface M5AdmissionEvidenceFacts {
  readonly referenceObservationCount: number;
  readonly candidateObservationCount: number;
  readonly referenceExecutionSampleCount: number;
  readonly candidateExecutionSampleCount: number;
  readonly referenceDecidedExecutionSampleCount: number;
  readonly candidateDecidedExecutionSampleCount: number;
  readonly referenceExecutionCoverageRatio: number;
  readonly candidateExecutionCoverageRatio: number;
  readonly referenceLatencyCoverageRatio: number;
  readonly candidateLatencyCoverageRatio: number;
  readonly referenceCostCoverageRatio: number;
  readonly candidateCostCoverageRatio: number;
}

export interface M5AdmissionDecisionPayload {
  readonly taxonomyId: string;
  readonly policyId: string;
  readonly policySha256: string;
  readonly suiteId: string;
  readonly suiteSha256: string;
  readonly baselineId: string;
  readonly referenceSubjectId: string;
  readonly candidateSubjectId: string;
  readonly referenceEvalSummaryId: string;
  readonly candidateEvalSummaryId: string;
  readonly referenceExecutionSummaryId?: string;
  readonly candidateExecutionSummaryId?: string;
  readonly classification: M5AdmissionClassification;
  readonly reasons: readonly string[];
  readonly facts: M5AdmissionEvidenceFacts;
  readonly evalDeltas: EvalCohortComparison["payload"]["deltas"];
  readonly executionDeltas?: ExecutionReliabilityComparison["payload"]["deltas"];
  readonly experimentAdmissionEligible: boolean;
  readonly controlledExperimentAutomaticallyAuthorized: false;
  readonly productionRoutingMutationAllowed: false;
  readonly automaticDispatchAllowed: false;
}

export interface M5AdmissionDecision {
  readonly schemaVersion: typeof M5_ADMISSION_DECISION_SCHEMA_VERSION;
  readonly algorithm: "sha256";
  readonly decisionId: string;
  readonly decisionSha256: string;
  readonly payload: M5AdmissionDecisionPayload;
}

const POLICY_INPUT_FIELDS = new Set([
  "name",
  "minimumObservationCount",
  "requireExecutionReliability",
  "requireFullExecutionProvenance",
  "minimumExecutionSampleCount",
  "minimumDecidedExecutionSampleCount",
  "minimumLatencyCoverageRatio",
  "minimumCostCoverageRatio",
  "maximumCoverageRegressionRatio",
  "maximumWeightedScoreMeanRegression",
  "maximumTaskPassRateMeanRegression",
  "maximumCriticalPassRateMeanRegression",
  "maximumBaselinePassRateRegression",
  "maximumExecutionSuccessRateRegression",
  "maximumCancellationRateIncrease",
  "maximumLatencyMeanIncreaseMs",
  "maximumCostMeanIncreaseUsd",
]);
const POLICY_PAYLOAD_FIELDS = new Set([...POLICY_INPUT_FIELDS, "taxonomyId"]);
const POLICY_ENVELOPE_FIELDS = new Set(["schemaVersion", "algorithm", "policyId", "policySha256", "payload"]);
const DECISION_ENVELOPE_FIELDS = new Set(["schemaVersion", "algorithm", "decisionId", "decisionSha256", "payload"]);
const DECISION_PAYLOAD_FIELDS = new Set([
  "taxonomyId",
  "policyId",
  "policySha256",
  "suiteId",
  "suiteSha256",
  "baselineId",
  "referenceSubjectId",
  "candidateSubjectId",
  "referenceEvalSummaryId",
  "candidateEvalSummaryId",
  "referenceExecutionSummaryId",
  "candidateExecutionSummaryId",
  "classification",
  "reasons",
  "facts",
  "evalDeltas",
  "executionDeltas",
  "experimentAdmissionEligible",
  "controlledExperimentAutomaticallyAuthorized",
  "productionRoutingMutationAllowed",
  "automaticDispatchAllowed",
]);
const FACT_FIELDS = new Set([
  "referenceObservationCount",
  "candidateObservationCount",
  "referenceExecutionSampleCount",
  "candidateExecutionSampleCount",
  "referenceDecidedExecutionSampleCount",
  "candidateDecidedExecutionSampleCount",
  "referenceExecutionCoverageRatio",
  "candidateExecutionCoverageRatio",
  "referenceLatencyCoverageRatio",
  "candidateLatencyCoverageRatio",
  "referenceCostCoverageRatio",
  "candidateCostCoverageRatio",
]);
const EVAL_DELTA_FIELDS = new Set([
  "weightedScoreMean",
  "taskPassRateMean",
  "criticalPassRateMean",
  "baselinePassRate",
  "latencyMeanMs",
  "costMeanUsd",
]);
const EXECUTION_DELTA_FIELDS = new Set([
  "successRateExcludingCancelled",
  "failureRateExcludingCancelled",
  "cancellationRate",
]);
const CLASSIFICATIONS = new Set<M5AdmissionClassification>([
  "INSUFFICIENT_EVIDENCE",
  "MEASUREMENT_DRIFT",
  "NOT_ELIGIBLE_FOR_CONTROLLED_EXPERIMENT",
  "ELIGIBLE_FOR_CONTROLLED_EXPERIMENT",
]);

export async function prepareM5AdmissionPolicy(
  taxonomy: MetricTaxonomy,
  input: M5AdmissionPolicyInput,
): Promise<M5AdmissionPolicy> {
  await verifyMetricTaxonomy(taxonomy);
  assertExactAllowedFields(input as unknown as Record<string, unknown>, POLICY_INPUT_FIELDS, "M5 admission policy input");
  const payload = normalizePolicyPayload(input, taxonomy.taxonomyId);
  const policySha256 = await sha256Canonical(payload);
  return deepFreeze({
    schemaVersion: M5_ADMISSION_POLICY_SCHEMA_VERSION,
    algorithm: "sha256" as const,
    policyId: `m5policy:${policySha256.slice(0, 32).toLowerCase()}`,
    policySha256,
    payload,
  });
}

export async function verifyM5AdmissionPolicy(policy: M5AdmissionPolicy, taxonomy: MetricTaxonomy): Promise<void> {
  await verifyMetricTaxonomy(taxonomy);
  if (!isRecord(policy)) throw new Error("M5 admission policy must be an object");
  assertExactAllowedFields(policy, POLICY_ENVELOPE_FIELDS, "M5 admission policy");
  if (policy.schemaVersion !== M5_ADMISSION_POLICY_SCHEMA_VERSION || policy.algorithm !== "sha256") throw new Error("M5 admission policy envelope is invalid");
  if (!isRecord(policy.payload)) throw new Error("M5 admission policy payload is invalid");
  assertExactAllowedFields(policy.payload, POLICY_PAYLOAD_FIELDS, "M5 admission policy payload");
  if (policy.payload.taxonomyId !== taxonomy.taxonomyId) throw new Error("M5 admission policy taxonomyId does not match canonical taxonomy");
  const normalized = normalizePolicyPayload(policy.payload as unknown as M5AdmissionPolicyInput, taxonomy.taxonomyId);
  if (stableStringify(normalized) !== stableStringify(policy.payload)) throw new Error("M5 admission policy payload is not canonically normalized");
  const expected = await sha256Canonical(policy.payload);
  if (policy.policySha256 !== expected) throw new Error("M5 admission policy digest does not match canonical payload");
  if (policy.policyId !== `m5policy:${expected.slice(0, 32).toLowerCase()}`) throw new Error("M5 admission policyId does not match canonical payload");
}

export async function assessM5ControlledExperimentAdmission(input: {
  readonly taxonomy: MetricTaxonomy;
  readonly policy: M5AdmissionPolicy;
  readonly reference: M5AdmissionCohortInput;
  readonly candidate: M5AdmissionCohortInput;
}): Promise<M5AdmissionDecision> {
  await verifyMetricTaxonomy(input.taxonomy);
  await verifyM5AdmissionPolicy(input.policy, input.taxonomy);
  await verifyEvalCohortSummary(input.reference.evalSummary);
  await verifyEvalCohortSummary(input.candidate.evalSummary);
  const evalComparison = await compareEvalCohorts(input.reference.evalSummary, input.candidate.evalSummary);

  const referenceExecution = input.reference.executionSummary;
  const candidateExecution = input.candidate.executionSummary;
  if ((referenceExecution === undefined) !== (candidateExecution === undefined)) throw new Error("M5 admission requires execution summaries for both cohorts or neither cohort");
  if (referenceExecution) {
    await verifyExecutionReliabilitySummary(referenceExecution);
    assertExecutionSummaryMatchesEval(input.reference.evalSummary, referenceExecution, "reference");
  }
  if (candidateExecution) {
    await verifyExecutionReliabilitySummary(candidateExecution);
    assertExecutionSummaryMatchesEval(input.candidate.evalSummary, candidateExecution, "candidate");
  }
  const executionComparison = referenceExecution && candidateExecution
    ? await compareExecutionReliabilitySummaries(referenceExecution, candidateExecution)
    : undefined;

  const facts = buildFacts(input.reference, input.candidate);
  const policy = input.policy.payload;
  const insufficiencyReasons = collectInsufficiencyReasons(policy, input.reference, input.candidate, facts, evalComparison, executionComparison);
  const driftReasons = insufficiencyReasons.length === 0 ? collectMeasurementDriftReasons(policy, facts) : [];
  const performanceReasons = insufficiencyReasons.length === 0 && driftReasons.length === 0
    ? collectPerformanceRegressionReasons(policy, evalComparison, executionComparison)
    : [];

  const classification = chooseClassification(insufficiencyReasons, driftReasons, performanceReasons);
  const reasons = classification === "ELIGIBLE_FOR_CONTROLLED_EXPERIMENT"
    ? ["evidence_sufficient_and_guardrails_satisfied"]
    : classification === "INSUFFICIENT_EVIDENCE"
      ? insufficiencyReasons
      : classification === "MEASUREMENT_DRIFT"
        ? driftReasons
        : performanceReasons;

  const referenceEval = input.reference.evalSummary.payload;
  const candidateEval = input.candidate.evalSummary.payload;
  const payload: M5AdmissionDecisionPayload = deepFreeze({
    taxonomyId: input.taxonomy.taxonomyId,
    policyId: input.policy.policyId,
    policySha256: input.policy.policySha256,
    suiteId: referenceEval.suiteId,
    suiteSha256: referenceEval.suiteSha256,
    baselineId: referenceEval.baselineId,
    referenceSubjectId: referenceEval.subjectId,
    candidateSubjectId: candidateEval.subjectId,
    referenceEvalSummaryId: input.reference.evalSummary.summaryId,
    candidateEvalSummaryId: input.candidate.evalSummary.summaryId,
    referenceExecutionSummaryId: referenceExecution?.summaryId,
    candidateExecutionSummaryId: candidateExecution?.summaryId,
    classification,
    reasons: [...new Set(reasons)].sort(),
    facts,
    evalDeltas: deepFreeze({ ...evalComparison.payload.deltas }),
    executionDeltas: executionComparison ? deepFreeze({ ...executionComparison.payload.deltas }) : undefined,
    experimentAdmissionEligible: classification === "ELIGIBLE_FOR_CONTROLLED_EXPERIMENT",
    controlledExperimentAutomaticallyAuthorized: false as const,
    productionRoutingMutationAllowed: false as const,
    automaticDispatchAllowed: false as const,
  });
  const decisionSha256 = await sha256Canonical(payload);
  return deepFreeze({
    schemaVersion: M5_ADMISSION_DECISION_SCHEMA_VERSION,
    algorithm: "sha256" as const,
    decisionId: `m5admit:${decisionSha256.slice(0, 32).toLowerCase()}`,
    decisionSha256,
    payload,
  });
}

export async function verifyM5AdmissionDecision(decision: M5AdmissionDecision): Promise<void> {
  if (!isRecord(decision)) throw new Error("M5 admission decision must be an object");
  assertExactAllowedFields(decision, DECISION_ENVELOPE_FIELDS, "M5 admission decision");
  if (decision.schemaVersion !== M5_ADMISSION_DECISION_SCHEMA_VERSION || decision.algorithm !== "sha256") throw new Error("M5 admission decision envelope is invalid");
  if (!isRecord(decision.payload)) throw new Error("M5 admission decision payload is invalid");
  assertExactAllowedFields(decision.payload, DECISION_PAYLOAD_FIELDS, "M5 admission decision payload");
  if (!CLASSIFICATIONS.has(decision.payload.classification)) throw new Error("M5 admission decision classification is invalid");
  for (const [value, label] of [
    [decision.payload.taxonomyId, "taxonomyId"],
    [decision.payload.policyId, "policyId"],
    [decision.payload.policySha256, "policySha256"],
    [decision.payload.suiteId, "suiteId"],
    [decision.payload.suiteSha256, "suiteSha256"],
    [decision.payload.baselineId, "baselineId"],
    [decision.payload.referenceSubjectId, "referenceSubjectId"],
    [decision.payload.candidateSubjectId, "candidateSubjectId"],
    [decision.payload.referenceEvalSummaryId, "referenceEvalSummaryId"],
    [decision.payload.candidateEvalSummaryId, "candidateEvalSummaryId"],
  ] as const) prepareIdentity(value, `M5 admission ${label}`);
  if (decision.payload.referenceExecutionSummaryId !== undefined) prepareIdentity(decision.payload.referenceExecutionSummaryId, "M5 admission referenceExecutionSummaryId");
  if (decision.payload.candidateExecutionSummaryId !== undefined) prepareIdentity(decision.payload.candidateExecutionSummaryId, "M5 admission candidateExecutionSummaryId");
  if ((decision.payload.referenceExecutionSummaryId === undefined) !== (decision.payload.candidateExecutionSummaryId === undefined)) throw new Error("M5 admission decision execution summary IDs must be paired");
  validateReasons(decision.payload.reasons);
  validateFacts(decision.payload.facts);
  validateEvalDeltas(decision.payload.evalDeltas);
  if (decision.payload.executionDeltas !== undefined) validateExecutionDeltas(decision.payload.executionDeltas);
  if (decision.payload.controlledExperimentAutomaticallyAuthorized !== false || decision.payload.productionRoutingMutationAllowed !== false || decision.payload.automaticDispatchAllowed !== false) throw new Error("M5 admission decision cannot grant automatic authority");
  if (decision.payload.experimentAdmissionEligible !== (decision.payload.classification === "ELIGIBLE_FOR_CONTROLLED_EXPERIMENT")) throw new Error("M5 admission eligibility flag does not match classification");
  const expected = await sha256Canonical(decision.payload);
  if (decision.decisionSha256 !== expected) throw new Error("M5 admission decision digest does not match canonical payload");
  if (decision.decisionId !== `m5admit:${expected.slice(0, 32).toLowerCase()}`) throw new Error("M5 admission decisionId does not match canonical payload");
}

function normalizePolicyPayload(input: M5AdmissionPolicyInput, taxonomyId: string): M5AdmissionPolicyPayload {
  validatePolicyValues(input);
  return deepFreeze({
    name: prepareIdentity(input.name, "M5 admission policy name"),
    minimumObservationCount: input.minimumObservationCount,
    requireExecutionReliability: input.requireExecutionReliability,
    requireFullExecutionProvenance: input.requireFullExecutionProvenance,
    minimumExecutionSampleCount: input.minimumExecutionSampleCount,
    minimumDecidedExecutionSampleCount: input.minimumDecidedExecutionSampleCount,
    minimumLatencyCoverageRatio: input.minimumLatencyCoverageRatio,
    minimumCostCoverageRatio: input.minimumCostCoverageRatio,
    maximumCoverageRegressionRatio: input.maximumCoverageRegressionRatio,
    maximumWeightedScoreMeanRegression: input.maximumWeightedScoreMeanRegression,
    maximumTaskPassRateMeanRegression: input.maximumTaskPassRateMeanRegression,
    maximumCriticalPassRateMeanRegression: input.maximumCriticalPassRateMeanRegression,
    maximumBaselinePassRateRegression: input.maximumBaselinePassRateRegression,
    maximumExecutionSuccessRateRegression: input.maximumExecutionSuccessRateRegression,
    maximumCancellationRateIncrease: input.maximumCancellationRateIncrease,
    maximumLatencyMeanIncreaseMs: input.maximumLatencyMeanIncreaseMs,
    maximumCostMeanIncreaseUsd: input.maximumCostMeanIncreaseUsd,
    taxonomyId: prepareIdentity(taxonomyId, "M5 admission taxonomyId"),
  });
}

function validatePolicyValues(input: M5AdmissionPolicyInput): void {
  assertPositiveInteger(input.minimumObservationCount, "minimumObservationCount");
  assertBoolean(input.requireExecutionReliability, "requireExecutionReliability");
  assertBoolean(input.requireFullExecutionProvenance, "requireFullExecutionProvenance");
  assertNonNegativeInteger(input.minimumExecutionSampleCount, "minimumExecutionSampleCount");
  assertNonNegativeInteger(input.minimumDecidedExecutionSampleCount, "minimumDecidedExecutionSampleCount");
  for (const [label, value] of [
    ["minimumLatencyCoverageRatio", input.minimumLatencyCoverageRatio],
    ["minimumCostCoverageRatio", input.minimumCostCoverageRatio],
    ["maximumCoverageRegressionRatio", input.maximumCoverageRegressionRatio],
    ["maximumWeightedScoreMeanRegression", input.maximumWeightedScoreMeanRegression],
    ["maximumTaskPassRateMeanRegression", input.maximumTaskPassRateMeanRegression],
    ["maximumCriticalPassRateMeanRegression", input.maximumCriticalPassRateMeanRegression],
    ["maximumBaselinePassRateRegression", input.maximumBaselinePassRateRegression],
    ["maximumExecutionSuccessRateRegression", input.maximumExecutionSuccessRateRegression],
    ["maximumCancellationRateIncrease", input.maximumCancellationRateIncrease],
  ] as const) assertRatio(value, label);
  if (input.maximumLatencyMeanIncreaseMs !== undefined) assertNonNegativeNumber(input.maximumLatencyMeanIncreaseMs, "maximumLatencyMeanIncreaseMs");
  if (input.maximumCostMeanIncreaseUsd !== undefined) assertNonNegativeNumber(input.maximumCostMeanIncreaseUsd, "maximumCostMeanIncreaseUsd");
  if (input.requireFullExecutionProvenance && !input.requireExecutionReliability) throw new Error("requireFullExecutionProvenance requires requireExecutionReliability");
  if (input.requireExecutionReliability && input.minimumExecutionSampleCount === 0) throw new Error("requireExecutionReliability requires minimumExecutionSampleCount > 0");
  if (input.requireExecutionReliability && input.minimumDecidedExecutionSampleCount === 0) throw new Error("requireExecutionReliability requires minimumDecidedExecutionSampleCount > 0");
  const usesEfficiencyEvidence = input.minimumLatencyCoverageRatio > 0
    || input.minimumCostCoverageRatio > 0
    || input.maximumLatencyMeanIncreaseMs !== undefined
    || input.maximumCostMeanIncreaseUsd !== undefined;
  if (usesEfficiencyEvidence && !input.requireFullExecutionProvenance) throw new Error("Efficiency admission metrics require full canonical execution provenance");
}

function collectInsufficiencyReasons(
  policy: M5AdmissionPolicyPayload,
  reference: M5AdmissionCohortInput,
  candidate: M5AdmissionCohortInput,
  facts: M5AdmissionEvidenceFacts,
  evalComparison: EvalCohortComparison,
  executionComparison?: ExecutionReliabilityComparison,
): string[] {
  const reasons: string[] = [];
  if (facts.referenceObservationCount < policy.minimumObservationCount) reasons.push("reference_observation_count_below_minimum");
  if (facts.candidateObservationCount < policy.minimumObservationCount) reasons.push("candidate_observation_count_below_minimum");
  if (policy.requireExecutionReliability && (!reference.executionSummary || !candidate.executionSummary)) reasons.push("execution_reliability_required");
  if (reference.executionSummary && facts.referenceExecutionSampleCount < policy.minimumExecutionSampleCount) reasons.push("reference_execution_sample_count_below_minimum");
  if (candidate.executionSummary && facts.candidateExecutionSampleCount < policy.minimumExecutionSampleCount) reasons.push("candidate_execution_sample_count_below_minimum");
  if (reference.executionSummary && facts.referenceDecidedExecutionSampleCount < policy.minimumDecidedExecutionSampleCount) reasons.push("reference_decided_execution_sample_count_below_minimum");
  if (candidate.executionSummary && facts.candidateDecidedExecutionSampleCount < policy.minimumDecidedExecutionSampleCount) reasons.push("candidate_decided_execution_sample_count_below_minimum");
  if (facts.referenceLatencyCoverageRatio < policy.minimumLatencyCoverageRatio) reasons.push("reference_latency_coverage_below_minimum");
  if (facts.candidateLatencyCoverageRatio < policy.minimumLatencyCoverageRatio) reasons.push("candidate_latency_coverage_below_minimum");
  if (facts.referenceCostCoverageRatio < policy.minimumCostCoverageRatio) reasons.push("reference_cost_coverage_below_minimum");
  if (facts.candidateCostCoverageRatio < policy.minimumCostCoverageRatio) reasons.push("candidate_cost_coverage_below_minimum");
  if (policy.requireFullExecutionProvenance) {
    if (!reference.executionSummary || !candidate.executionSummary) reasons.push("full_execution_provenance_requires_execution_summaries");
    else {
      if (!sameIdentitySet(reference.evalSummary.payload.observationIds, reference.executionSummary.payload.observationIds)) reasons.push("reference_execution_provenance_is_not_full_cohort");
      if (!sameIdentitySet(candidate.evalSummary.payload.observationIds, candidate.executionSummary.payload.observationIds)) reasons.push("candidate_execution_provenance_is_not_full_cohort");
    }
  }
  if (policy.maximumLatencyMeanIncreaseMs !== undefined && evalComparison.payload.deltas.latencyMeanMs === null) reasons.push("latency_delta_unavailable_for_configured_guardrail");
  if (policy.maximumCostMeanIncreaseUsd !== undefined && evalComparison.payload.deltas.costMeanUsd === null) reasons.push("cost_delta_unavailable_for_configured_guardrail");
  if (policy.requireExecutionReliability && !executionComparison) reasons.push("execution_delta_unavailable_for_configured_guardrail");
  return reasons;
}

function collectMeasurementDriftReasons(policy: M5AdmissionPolicyPayload, facts: M5AdmissionEvidenceFacts): string[] {
  const reasons: string[] = [];
  if (facts.candidateLatencyCoverageRatio + policy.maximumCoverageRegressionRatio < facts.referenceLatencyCoverageRatio) reasons.push("latency_measurement_coverage_regressed");
  if (facts.candidateCostCoverageRatio + policy.maximumCoverageRegressionRatio < facts.referenceCostCoverageRatio) reasons.push("cost_measurement_coverage_regressed");
  if (facts.candidateExecutionCoverageRatio + policy.maximumCoverageRegressionRatio < facts.referenceExecutionCoverageRatio) reasons.push("execution_provenance_coverage_regressed");
  return reasons;
}

function collectPerformanceRegressionReasons(
  policy: M5AdmissionPolicyPayload,
  evalComparison: EvalCohortComparison,
  executionComparison?: ExecutionReliabilityComparison,
): string[] {
  const reasons: string[] = [];
  const deltas = evalComparison.payload.deltas;
  if (deltas.weightedScoreMean < -policy.maximumWeightedScoreMeanRegression) reasons.push("weighted_score_regressed_beyond_guardrail");
  if (deltas.taskPassRateMean < -policy.maximumTaskPassRateMeanRegression) reasons.push("task_pass_rate_regressed_beyond_guardrail");
  if (deltas.criticalPassRateMean < -policy.maximumCriticalPassRateMeanRegression) reasons.push("critical_pass_rate_regressed_beyond_guardrail");
  if (deltas.baselinePassRate < -policy.maximumBaselinePassRateRegression) reasons.push("baseline_pass_rate_regressed_beyond_guardrail");
  if (policy.maximumLatencyMeanIncreaseMs !== undefined && deltas.latencyMeanMs !== null && deltas.latencyMeanMs > policy.maximumLatencyMeanIncreaseMs) reasons.push("latency_mean_increased_beyond_guardrail");
  if (policy.maximumCostMeanIncreaseUsd !== undefined && deltas.costMeanUsd !== null && deltas.costMeanUsd > policy.maximumCostMeanIncreaseUsd) reasons.push("cost_mean_increased_beyond_guardrail");
  if (executionComparison) {
    const execution = executionComparison.payload.deltas;
    if (execution.successRateExcludingCancelled !== null && execution.successRateExcludingCancelled < -policy.maximumExecutionSuccessRateRegression) reasons.push("execution_success_rate_regressed_beyond_guardrail");
    if (execution.cancellationRate > policy.maximumCancellationRateIncrease) reasons.push("cancellation_rate_increased_beyond_guardrail");
  }
  return reasons;
}

function chooseClassification(insufficient: readonly string[], drift: readonly string[], performance: readonly string[]): M5AdmissionClassification {
  if (insufficient.length > 0) return "INSUFFICIENT_EVIDENCE";
  if (drift.length > 0) return "MEASUREMENT_DRIFT";
  if (performance.length > 0) return "NOT_ELIGIBLE_FOR_CONTROLLED_EXPERIMENT";
  return "ELIGIBLE_FOR_CONTROLLED_EXPERIMENT";
}

function buildFacts(reference: M5AdmissionCohortInput, candidate: M5AdmissionCohortInput): M5AdmissionEvidenceFacts {
  const referenceObservationCount = reference.evalSummary.payload.observationCount;
  const candidateObservationCount = candidate.evalSummary.payload.observationCount;
  const referenceExecutionSampleCount = reference.executionSummary?.payload.sampleCount ?? 0;
  const candidateExecutionSampleCount = candidate.executionSummary?.payload.sampleCount ?? 0;
  return deepFreeze({
    referenceObservationCount,
    candidateObservationCount,
    referenceExecutionSampleCount,
    candidateExecutionSampleCount,
    referenceDecidedExecutionSampleCount: reference.executionSummary?.payload.decidedSampleCount ?? 0,
    candidateDecidedExecutionSampleCount: candidate.executionSummary?.payload.decidedSampleCount ?? 0,
    referenceExecutionCoverageRatio: referenceExecutionSampleCount / referenceObservationCount,
    candidateExecutionCoverageRatio: candidateExecutionSampleCount / candidateObservationCount,
    referenceLatencyCoverageRatio: (reference.evalSummary.payload.latencyMs?.sampleCount ?? 0) / referenceObservationCount,
    candidateLatencyCoverageRatio: (candidate.evalSummary.payload.latencyMs?.sampleCount ?? 0) / candidateObservationCount,
    referenceCostCoverageRatio: (reference.evalSummary.payload.costUsd?.sampleCount ?? 0) / referenceObservationCount,
    candidateCostCoverageRatio: (candidate.evalSummary.payload.costUsd?.sampleCount ?? 0) / candidateObservationCount,
  });
}

function assertExecutionSummaryMatchesEval(evalSummary: EvalCohortSummary, executionSummary: ExecutionReliabilitySummary, label: string): void {
  const evalPayload = evalSummary.payload;
  const executionPayload = executionSummary.payload;
  if (executionPayload.suiteId !== evalPayload.suiteId || executionPayload.suiteSha256 !== evalPayload.suiteSha256 || executionPayload.baselineId !== evalPayload.baselineId || executionPayload.subjectId !== evalPayload.subjectId) throw new Error(`M5 admission ${label} execution summary identity does not match eval summary`);
  const evalIds = new Set(evalPayload.observationIds);
  if (executionPayload.observationIds.some((id) => !evalIds.has(id))) throw new Error(`M5 admission ${label} execution summary references observations outside eval cohort`);
}

function validateReasons(reasons: readonly string[]): void {
  if (!Array.isArray(reasons) || reasons.length === 0) throw new Error("M5 admission decision requires reasons");
  if (new Set(reasons).size !== reasons.length) throw new Error("M5 admission decision reasons must be unique");
  if (stableStringify([...reasons].sort()) !== stableStringify(reasons)) throw new Error("M5 admission decision reasons must be canonically sorted");
  for (const reason of reasons) prepareIdentity(reason, "M5 admission reason");
}

function validateFacts(facts: M5AdmissionEvidenceFacts): void {
  if (!isRecord(facts)) throw new Error("M5 admission evidence facts are invalid");
  assertExactAllowedFields(facts, FACT_FIELDS, "M5 admission evidence facts");
  for (const value of [facts.referenceObservationCount, facts.candidateObservationCount]) if (!Number.isInteger(value) || value <= 0) throw new Error("M5 admission observation counts are invalid");
  for (const value of [facts.referenceExecutionSampleCount, facts.candidateExecutionSampleCount, facts.referenceDecidedExecutionSampleCount, facts.candidateDecidedExecutionSampleCount]) if (!Number.isInteger(value) || value < 0) throw new Error("M5 admission execution counts are invalid");
  for (const value of [facts.referenceExecutionCoverageRatio, facts.candidateExecutionCoverageRatio, facts.referenceLatencyCoverageRatio, facts.candidateLatencyCoverageRatio, facts.referenceCostCoverageRatio, facts.candidateCostCoverageRatio]) assertRatio(value, "M5 admission coverage ratio");
}

function validateEvalDeltas(value: EvalCohortComparison["payload"]["deltas"]): void {
  if (!isRecord(value)) throw new Error("M5 admission eval deltas are invalid");
  assertExactAllowedFields(value, EVAL_DELTA_FIELDS, "M5 admission eval deltas");
  for (const delta of [value.weightedScoreMean, value.taskPassRateMean, value.criticalPassRateMean, value.baselinePassRate]) assertFiniteNumber(delta, "M5 admission eval delta");
  if (value.latencyMeanMs !== null) assertFiniteNumber(value.latencyMeanMs, "M5 admission latency delta");
  if (value.costMeanUsd !== null) assertFiniteNumber(value.costMeanUsd, "M5 admission cost delta");
}

function validateExecutionDeltas(value: ExecutionReliabilityComparison["payload"]["deltas"]): void {
  if (!isRecord(value)) throw new Error("M5 admission execution deltas are invalid");
  assertExactAllowedFields(value, EXECUTION_DELTA_FIELDS, "M5 admission execution deltas");
  if (value.successRateExcludingCancelled !== null) assertFiniteNumber(value.successRateExcludingCancelled, "M5 admission execution success delta");
  if (value.failureRateExcludingCancelled !== null) assertFiniteNumber(value.failureRateExcludingCancelled, "M5 admission execution failure delta");
  assertFiniteNumber(value.cancellationRate, "M5 admission cancellation delta");
}

function sameIdentitySet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  return stableStringify([...left].sort()) === stableStringify([...right].sort());
}

function assertExactAllowedFields(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  for (const field of Object.keys(value)) if (!allowed.has(field)) throw new Error(`${label} contains unknown field: ${field}`);
}

function prepareIdentity(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must not be empty`);
  const prepared = value.trim();
  if (/\r|\n/.test(prepared)) throw new Error(`${label} must be single-line`);
  if (new TextEncoder().encode(prepared).byteLength > 256) throw new Error(`${label} exceeds 256 bytes`);
  if (/(authorization|api[_-]?key|access[_-]?token|password|secret|credential|cookie)\s*[:=]/i.test(prepared) || /\bBearer\s+/i.test(prepared)) throw new Error(`${label} contains secret-like material`);
  return prepared;
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
}

function assertRatio(value: number, label: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${label} must be a finite ratio between 0 and 1`);
}

function assertNonNegativeNumber(value: number, label: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${label} must be finite and non-negative`);
}

function assertFiniteNumber(value: number, label: string): void {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be finite`);
}

function assertBoolean(value: boolean, label: string): void {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
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
