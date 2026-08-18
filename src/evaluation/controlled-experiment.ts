import type { EvidenceRecord, RiskClass, WorkflowRun } from "../control-plane/contracts.js";
import type { M5AdmissionDecision } from "./m5-admission-gate.js";
import { verifyM5AdmissionDecision } from "./m5-admission-gate.js";

export const CONTROLLED_EXPERIMENT_SCHEMA_VERSION = 1 as const;
export const CONTROLLED_EXPERIMENT_AUTHORIZATION_SCHEMA_VERSION = 1 as const;

export type ControlledExperimentExposureMode = "shadow_only" | "shadow_then_bounded_live";

export interface ControlledExperimentBudget {
  readonly maxTotalSamples: number;
  readonly minimumShadowSamplesBeforeLive: number;
  readonly maxLiveSamples: number;
  readonly maxCandidateLiveSamples: number;
  readonly maxCandidateTrafficBasisPoints: number;
}

export interface ControlledExperimentStopConditions {
  readonly maxFailedExecutions: number;
  readonly maximumCancellationRate: number;
  readonly maximumWeightedScoreMeanRegression: number;
  readonly maximumTaskPassRateMeanRegression: number;
  readonly maximumCriticalPassRateMeanRegression: number;
  readonly maximumBaselinePassRateRegression: number;
  readonly maximumExecutionSuccessRateRegression: number;
  readonly maximumLatencyMeanIncreaseMs?: number;
  readonly maximumCostMeanIncreaseUsd?: number;
}

export interface ControlledExperimentDefinitionInput {
  readonly name: string;
  readonly projectId: string;
  readonly riskClass: RiskClass;
  readonly exposureMode: ControlledExperimentExposureMode;
  readonly budget: ControlledExperimentBudget;
  readonly stopConditions: ControlledExperimentStopConditions;
  readonly rollbackPolicyReference: string;
}

export interface ControlledExperimentDefinitionPayload {
  readonly name: string;
  readonly projectId: string;
  readonly riskClass: RiskClass;
  readonly admissionDecisionId: string;
  readonly admissionDecisionSha256: string;
  readonly taxonomyId: string;
  readonly admissionPolicyId: string;
  readonly suiteId: string;
  readonly suiteSha256: string;
  readonly baselineId: string;
  readonly referenceSubjectId: string;
  readonly candidateSubjectId: string;
  readonly exposureMode: ControlledExperimentExposureMode;
  readonly shadowFirstRequired: true;
  readonly budget: ControlledExperimentBudget;
  readonly stopConditions: ControlledExperimentStopConditions;
  readonly rollback: {
    readonly strategy: "restore_reference_subject";
    readonly targetSubjectId: string;
    readonly policyReference: string;
    readonly requiredForLiveGuardrailBreach: true;
    readonly automaticRollbackAllowed: false;
  };
  readonly automaticDispatchAllowed: false;
  readonly productionRoutingMutationAllowed: false;
}

export interface ControlledExperimentDefinition {
  readonly schemaVersion: typeof CONTROLLED_EXPERIMENT_SCHEMA_VERSION;
  readonly algorithm: "sha256";
  readonly experimentId: string;
  readonly experimentSha256: string;
  readonly payload: ControlledExperimentDefinitionPayload;
}

export interface ControlledExperimentAuthorizationInput {
  readonly decision: "allow" | "deny";
  readonly actor: string;
  readonly decidedAt: string;
  readonly policyReferences: readonly string[];
  readonly approvalIds: readonly string[];
}

export interface ControlledExperimentAuthorizationPayload extends ControlledExperimentAuthorizationInput {
  readonly experimentId: string;
  readonly experimentSha256: string;
  readonly admissionDecisionId: string;
  readonly admissionDecisionSha256: string;
  readonly workflowRunId: string;
  readonly projectId: string;
  readonly riskClass: RiskClass;
  readonly experimentContractAuthorized: boolean;
  readonly automaticDispatchAllowed: false;
  readonly productionRoutingMutationAllowed: false;
}

export interface ControlledExperimentAuthorization {
  readonly schemaVersion: typeof CONTROLLED_EXPERIMENT_AUTHORIZATION_SCHEMA_VERSION;
  readonly algorithm: "sha256";
  readonly authorizationId: string;
  readonly authorizationSha256: string;
  readonly payload: ControlledExperimentAuthorizationPayload;
}

const DEFINITION_INPUT_FIELDS = new Set(["name", "projectId", "riskClass", "exposureMode", "budget", "stopConditions", "rollbackPolicyReference"]);
const BUDGET_FIELDS = new Set(["maxTotalSamples", "minimumShadowSamplesBeforeLive", "maxLiveSamples", "maxCandidateLiveSamples", "maxCandidateTrafficBasisPoints"]);
const STOP_FIELDS = new Set([
  "maxFailedExecutions",
  "maximumCancellationRate",
  "maximumWeightedScoreMeanRegression",
  "maximumTaskPassRateMeanRegression",
  "maximumCriticalPassRateMeanRegression",
  "maximumBaselinePassRateRegression",
  "maximumExecutionSuccessRateRegression",
  "maximumLatencyMeanIncreaseMs",
  "maximumCostMeanIncreaseUsd",
]);
const DEFINITION_ENVELOPE_FIELDS = new Set(["schemaVersion", "algorithm", "experimentId", "experimentSha256", "payload"]);
const DEFINITION_PAYLOAD_FIELDS = new Set([
  "name", "projectId", "riskClass", "admissionDecisionId", "admissionDecisionSha256", "taxonomyId", "admissionPolicyId",
  "suiteId", "suiteSha256", "baselineId", "referenceSubjectId", "candidateSubjectId", "exposureMode", "shadowFirstRequired",
  "budget", "stopConditions", "rollback", "automaticDispatchAllowed", "productionRoutingMutationAllowed",
]);
const ROLLBACK_FIELDS = new Set(["strategy", "targetSubjectId", "policyReference", "requiredForLiveGuardrailBreach", "automaticRollbackAllowed"]);
const AUTH_INPUT_FIELDS = new Set(["decision", "actor", "decidedAt", "policyReferences", "approvalIds"]);
const AUTH_ENVELOPE_FIELDS = new Set(["schemaVersion", "algorithm", "authorizationId", "authorizationSha256", "payload"]);
const AUTH_PAYLOAD_FIELDS = new Set([
  ...AUTH_INPUT_FIELDS,
  "experimentId", "experimentSha256", "admissionDecisionId", "admissionDecisionSha256", "workflowRunId", "projectId", "riskClass",
  "experimentContractAuthorized", "automaticDispatchAllowed", "productionRoutingMutationAllowed",
]);

export async function prepareControlledExperimentDefinition(
  admissionDecision: M5AdmissionDecision,
  input: ControlledExperimentDefinitionInput,
): Promise<ControlledExperimentDefinition> {
  await verifyM5AdmissionDecision(admissionDecision);
  assertEligibleAdmission(admissionDecision);
  assertExactAllowedFields(input as unknown as Record<string, unknown>, DEFINITION_INPUT_FIELDS, "Controlled experiment input");
  const normalized = normalizeDefinitionInput(input);
  const admission = admissionDecision.payload;
  const payload: ControlledExperimentDefinitionPayload = deepFreeze({
    name: normalized.name,
    projectId: normalized.projectId,
    riskClass: normalized.riskClass,
    admissionDecisionId: admissionDecision.decisionId,
    admissionDecisionSha256: admissionDecision.decisionSha256,
    taxonomyId: admission.taxonomyId,
    admissionPolicyId: admission.policyId,
    suiteId: admission.suiteId,
    suiteSha256: admission.suiteSha256,
    baselineId: admission.baselineId,
    referenceSubjectId: admission.referenceSubjectId,
    candidateSubjectId: admission.candidateSubjectId,
    exposureMode: normalized.exposureMode,
    shadowFirstRequired: true,
    budget: normalized.budget,
    stopConditions: normalized.stopConditions,
    rollback: deepFreeze({
      strategy: "restore_reference_subject" as const,
      targetSubjectId: admission.referenceSubjectId,
      policyReference: normalized.rollbackPolicyReference,
      requiredForLiveGuardrailBreach: true as const,
      automaticRollbackAllowed: false as const,
    }),
    automaticDispatchAllowed: false as const,
    productionRoutingMutationAllowed: false as const,
  });
  const experimentSha256 = await sha256Canonical(payload);
  return deepFreeze({
    schemaVersion: CONTROLLED_EXPERIMENT_SCHEMA_VERSION,
    algorithm: "sha256" as const,
    experimentId: `m5experiment:${experimentSha256.slice(0, 32).toLowerCase()}`,
    experimentSha256,
    payload,
  });
}

export async function verifyControlledExperimentDefinition(
  experiment: ControlledExperimentDefinition,
  admissionDecision: M5AdmissionDecision,
): Promise<void> {
  await verifyM5AdmissionDecision(admissionDecision);
  assertEligibleAdmission(admissionDecision);
  if (!isRecord(experiment)) throw new Error("Controlled experiment definition must be an object");
  assertExactAllowedFields(experiment, DEFINITION_ENVELOPE_FIELDS, "Controlled experiment definition");
  if (experiment.schemaVersion !== CONTROLLED_EXPERIMENT_SCHEMA_VERSION || experiment.algorithm !== "sha256") throw new Error("Controlled experiment definition envelope is invalid");
  if (!isRecord(experiment.payload)) throw new Error("Controlled experiment definition payload is invalid");
  assertExactAllowedFields(experiment.payload, DEFINITION_PAYLOAD_FIELDS, "Controlled experiment definition payload");
  assertDefinitionAdmissionBinding(experiment.payload, admissionDecision);
  validateDefinitionPayload(experiment.payload);
  const expected = await sha256Canonical(experiment.payload);
  if (experiment.experimentSha256 !== expected) throw new Error("Controlled experiment definition digest does not match canonical payload");
  if (experiment.experimentId !== `m5experiment:${expected.slice(0, 32).toLowerCase()}`) throw new Error("Controlled experiment experimentId does not match canonical payload");
}

export async function prepareControlledExperimentAuthorization(
  experiment: ControlledExperimentDefinition,
  admissionDecision: M5AdmissionDecision,
  workflow: WorkflowRun,
  input: ControlledExperimentAuthorizationInput,
): Promise<ControlledExperimentAuthorization> {
  await verifyControlledExperimentDefinition(experiment, admissionDecision);
  assertExactAllowedFields(input as unknown as Record<string, unknown>, AUTH_INPUT_FIELDS, "Controlled experiment authorization input");
  assertWorkflowBinding(experiment, workflow);
  const decision = input.decision;
  if (decision !== "allow" && decision !== "deny") throw new Error("Controlled experiment authorization decision is invalid");
  const actor = prepareIdentity(input.actor, "Controlled experiment authorization actor");
  assertTimestamp(input.decidedAt, "Controlled experiment authorization decidedAt");
  const policyReferences = normalizeSafeSet(input.policyReferences, "Controlled experiment authorization policy reference", true);
  const approvalIds = normalizeSafeSet(input.approvalIds, "Controlled experiment authorization approvalId", decision === "allow");
  const durableApprovals = normalizeSafeSet(workflow.approvalIds, "Controlled experiment durable workflow approvalId", decision === "allow");
  if (!sameArray(approvalIds, durableApprovals)) throw new Error("Controlled experiment authorization approvalIds do not match durable WorkflowRun approvals");
  if (decision === "allow" && workflow.status !== "running") throw new Error("Controlled experiment allow authorization requires an active approved workflow");

  const payload: ControlledExperimentAuthorizationPayload = deepFreeze({
    decision,
    actor,
    decidedAt: input.decidedAt,
    policyReferences,
    approvalIds,
    experimentId: experiment.experimentId,
    experimentSha256: experiment.experimentSha256,
    admissionDecisionId: admissionDecision.decisionId,
    admissionDecisionSha256: admissionDecision.decisionSha256,
    workflowRunId: workflow.id,
    projectId: workflow.projectId,
    riskClass: workflow.riskClass,
    experimentContractAuthorized: decision === "allow",
    automaticDispatchAllowed: false as const,
    productionRoutingMutationAllowed: false as const,
  });
  const authorizationSha256 = await sha256Canonical(payload);
  return deepFreeze({
    schemaVersion: CONTROLLED_EXPERIMENT_AUTHORIZATION_SCHEMA_VERSION,
    algorithm: "sha256" as const,
    authorizationId: `m5expauth:${authorizationSha256.slice(0, 32).toLowerCase()}`,
    authorizationSha256,
    payload,
  });
}

export async function verifyControlledExperimentAuthorization(
  authorization: ControlledExperimentAuthorization,
  experiment: ControlledExperimentDefinition,
  admissionDecision: M5AdmissionDecision,
  workflow: WorkflowRun,
): Promise<void> {
  await verifyControlledExperimentDefinition(experiment, admissionDecision);
  assertWorkflowBinding(experiment, workflow);
  if (!isRecord(authorization)) throw new Error("Controlled experiment authorization must be an object");
  assertExactAllowedFields(authorization, AUTH_ENVELOPE_FIELDS, "Controlled experiment authorization");
  if (authorization.schemaVersion !== CONTROLLED_EXPERIMENT_AUTHORIZATION_SCHEMA_VERSION || authorization.algorithm !== "sha256") throw new Error("Controlled experiment authorization envelope is invalid");
  if (!isRecord(authorization.payload)) throw new Error("Controlled experiment authorization payload is invalid");
  assertExactAllowedFields(authorization.payload, AUTH_PAYLOAD_FIELDS, "Controlled experiment authorization payload");
  const payload = authorization.payload;
  if (payload.experimentId !== experiment.experimentId || payload.experimentSha256 !== experiment.experimentSha256) throw new Error("Controlled experiment authorization does not match exact experiment definition");
  if (payload.admissionDecisionId !== admissionDecision.decisionId || payload.admissionDecisionSha256 !== admissionDecision.decisionSha256) throw new Error("Controlled experiment authorization does not match exact admission decision");
  if (payload.workflowRunId !== workflow.id || payload.projectId !== workflow.projectId || payload.riskClass !== workflow.riskClass) throw new Error("Controlled experiment authorization does not match durable workflow identity");
  if (payload.decision !== "allow" && payload.decision !== "deny") throw new Error("Controlled experiment authorization decision is invalid");
  prepareIdentity(payload.actor, "Controlled experiment authorization actor");
  assertTimestamp(payload.decidedAt, "Controlled experiment authorization decidedAt");
  const policies = normalizeSafeSet(payload.policyReferences, "Controlled experiment authorization policy reference", true);
  const approvals = normalizeSafeSet(payload.approvalIds, "Controlled experiment authorization approvalId", payload.decision === "allow");
  if (!sameArray(policies, payload.policyReferences)) throw new Error("Controlled experiment authorization policyReferences must be unique and canonically sorted");
  if (!sameArray(approvals, payload.approvalIds)) throw new Error("Controlled experiment authorization approvalIds must be unique and canonically sorted");
  const durableApprovals = normalizeSafeSet(workflow.approvalIds, "Controlled experiment durable workflow approvalId", payload.decision === "allow");
  if (!sameArray(approvals, durableApprovals)) throw new Error("Controlled experiment authorization approvalIds do not match durable WorkflowRun approvals");
  if (payload.experimentContractAuthorized !== (payload.decision === "allow")) throw new Error("Controlled experiment authorization contract flag does not match decision");
  if (payload.automaticDispatchAllowed !== false || payload.productionRoutingMutationAllowed !== false) throw new Error("Controlled experiment authorization cannot grant automatic dispatch or production routing mutation authority");
  if (payload.decision === "allow" && workflow.status !== "running") throw new Error("Controlled experiment allow authorization requires an active approved workflow");
  const expected = await sha256Canonical(payload);
  if (authorization.authorizationSha256 !== expected) throw new Error("Controlled experiment authorization digest does not match canonical payload");
  if (authorization.authorizationId !== `m5expauth:${expected.slice(0, 32).toLowerCase()}`) throw new Error("Controlled experiment authorizationId does not match canonical payload");
}

export function controlledExperimentAuthorizationToEvidence(
  authorization: ControlledExperimentAuthorization,
  collectedAt: string,
): EvidenceRecord {
  assertTimestamp(collectedAt, "Controlled experiment authorization evidence collectedAt");
  return deepFreeze({
    kind: "approval" as const,
    status: authorization.payload.decision === "allow" ? "passed" as const : "failed" as const,
    reference: `controlled-experiment-authorization:${authorization.authorizationId}`,
    producer: "controlled-experiment-contract",
    collectedAt,
    metadata: deepFreeze({
      experimentId: authorization.payload.experimentId,
      workflowRunId: authorization.payload.workflowRunId,
      decision: authorization.payload.decision,
    }),
  });
}

function normalizeDefinitionInput(input: ControlledExperimentDefinitionInput): ControlledExperimentDefinitionInput {
  const name = prepareIdentity(input.name, "Controlled experiment name");
  const projectId = prepareIdentity(input.projectId, "Controlled experiment projectId");
  const rollbackPolicyReference = prepareSafeReference(input.rollbackPolicyReference, "Controlled experiment rollbackPolicyReference");
  if (!["R1", "R2", "R3", "R4"].includes(input.riskClass)) throw new Error("Controlled experiment riskClass must be R1-R4");
  if (input.exposureMode !== "shadow_only" && input.exposureMode !== "shadow_then_bounded_live") throw new Error("Controlled experiment exposureMode is invalid");
  if (!isRecord(input.budget)) throw new Error("Controlled experiment budget must be an object");
  assertExactAllowedFields(input.budget, BUDGET_FIELDS, "Controlled experiment budget");
  if (!isRecord(input.stopConditions)) throw new Error("Controlled experiment stopConditions must be an object");
  assertExactAllowedFields(input.stopConditions, STOP_FIELDS, "Controlled experiment stopConditions");
  const budget = normalizeBudget(input.budget as unknown as ControlledExperimentBudget, input.exposureMode, input.riskClass);
  const stopConditions = normalizeStopConditions(input.stopConditions as unknown as ControlledExperimentStopConditions);
  return deepFreeze({ name, projectId, riskClass: input.riskClass, exposureMode: input.exposureMode, budget, stopConditions, rollbackPolicyReference });
}

function normalizeBudget(budget: ControlledExperimentBudget, mode: ControlledExperimentExposureMode, riskClass: RiskClass): ControlledExperimentBudget {
  assertPositiveInteger(budget.maxTotalSamples, "Controlled experiment maxTotalSamples");
  assertNonNegativeInteger(budget.minimumShadowSamplesBeforeLive, "Controlled experiment minimumShadowSamplesBeforeLive");
  assertNonNegativeInteger(budget.maxLiveSamples, "Controlled experiment maxLiveSamples");
  assertNonNegativeInteger(budget.maxCandidateLiveSamples, "Controlled experiment maxCandidateLiveSamples");
  assertBasisPoints(budget.maxCandidateTrafficBasisPoints, "Controlled experiment maxCandidateTrafficBasisPoints");
  if (budget.maxCandidateLiveSamples > budget.maxLiveSamples) throw new Error("Controlled experiment maxCandidateLiveSamples must not exceed maxLiveSamples");
  if (mode === "shadow_only") {
    if (budget.maxLiveSamples !== 0 || budget.maxCandidateLiveSamples !== 0 || budget.maxCandidateTrafficBasisPoints !== 0) throw new Error("Shadow-only experiment cannot allocate live traffic");
  } else {
    if (riskClass !== "R3" && riskClass !== "R4") throw new Error("Bounded-live experiment requires riskClass R3 or R4");
    if (budget.minimumShadowSamplesBeforeLive <= 0) throw new Error("Bounded-live experiment requires at least one shadow sample before live exposure");
    if (budget.maxLiveSamples <= 0 || budget.maxCandidateLiveSamples <= 0 || budget.maxCandidateTrafficBasisPoints <= 0) throw new Error("Bounded-live experiment requires positive live sample and traffic budgets");
    if (budget.maxTotalSamples < budget.minimumShadowSamplesBeforeLive + budget.maxLiveSamples) throw new Error("Controlled experiment maxTotalSamples must cover shadow-first plus maxLiveSamples budget");
  }
  return deepFreeze({ ...budget });
}

function normalizeStopConditions(stop: ControlledExperimentStopConditions): ControlledExperimentStopConditions {
  assertNonNegativeInteger(stop.maxFailedExecutions, "Controlled experiment maxFailedExecutions");
  assertRate(stop.maximumCancellationRate, "Controlled experiment maximumCancellationRate");
  assertRate(stop.maximumWeightedScoreMeanRegression, "Controlled experiment maximumWeightedScoreMeanRegression");
  assertRate(stop.maximumTaskPassRateMeanRegression, "Controlled experiment maximumTaskPassRateMeanRegression");
  assertRate(stop.maximumCriticalPassRateMeanRegression, "Controlled experiment maximumCriticalPassRateMeanRegression");
  assertRate(stop.maximumBaselinePassRateRegression, "Controlled experiment maximumBaselinePassRateRegression");
  assertRate(stop.maximumExecutionSuccessRateRegression, "Controlled experiment maximumExecutionSuccessRateRegression");
  if (stop.maximumLatencyMeanIncreaseMs !== undefined) assertNonNegativeFinite(stop.maximumLatencyMeanIncreaseMs, "Controlled experiment maximumLatencyMeanIncreaseMs");
  if (stop.maximumCostMeanIncreaseUsd !== undefined) assertNonNegativeFinite(stop.maximumCostMeanIncreaseUsd, "Controlled experiment maximumCostMeanIncreaseUsd");
  return deepFreeze({ ...stop });
}

function validateDefinitionPayload(payload: ControlledExperimentDefinitionPayload): void {
  prepareIdentity(payload.name, "Controlled experiment name");
  prepareIdentity(payload.projectId, "Controlled experiment projectId");
  for (const [value, label] of [
    [payload.admissionDecisionId, "admissionDecisionId"], [payload.admissionDecisionSha256, "admissionDecisionSha256"], [payload.taxonomyId, "taxonomyId"],
    [payload.admissionPolicyId, "admissionPolicyId"], [payload.suiteId, "suiteId"], [payload.suiteSha256, "suiteSha256"], [payload.baselineId, "baselineId"],
    [payload.referenceSubjectId, "referenceSubjectId"], [payload.candidateSubjectId, "candidateSubjectId"],
  ] as const) prepareIdentity(value, `Controlled experiment ${label}`);
  if (!["R1", "R2", "R3", "R4"].includes(payload.riskClass)) throw new Error("Controlled experiment riskClass must be R1-R4");
  if (payload.exposureMode !== "shadow_only" && payload.exposureMode !== "shadow_then_bounded_live") throw new Error("Controlled experiment exposureMode is invalid");
  if (payload.shadowFirstRequired !== true) throw new Error("Controlled experiment shadowFirstRequired must remain true");
  if (!isRecord(payload.budget)) throw new Error("Controlled experiment budget is invalid");
  assertExactAllowedFields(payload.budget, BUDGET_FIELDS, "Controlled experiment budget");
  normalizeBudget(payload.budget as unknown as ControlledExperimentBudget, payload.exposureMode, payload.riskClass);
  if (!isRecord(payload.stopConditions)) throw new Error("Controlled experiment stopConditions are invalid");
  assertExactAllowedFields(payload.stopConditions, STOP_FIELDS, "Controlled experiment stopConditions");
  normalizeStopConditions(payload.stopConditions as unknown as ControlledExperimentStopConditions);
  if (!isRecord(payload.rollback)) throw new Error("Controlled experiment rollback is invalid");
  assertExactAllowedFields(payload.rollback, ROLLBACK_FIELDS, "Controlled experiment rollback");
  if (payload.rollback.strategy !== "restore_reference_subject" || payload.rollback.targetSubjectId !== payload.referenceSubjectId || payload.rollback.requiredForLiveGuardrailBreach !== true || payload.rollback.automaticRollbackAllowed !== false) throw new Error("Controlled experiment rollback contract is invalid");
  prepareSafeReference(payload.rollback.policyReference, "Controlled experiment rollback policy reference");
  if (payload.automaticDispatchAllowed !== false || payload.productionRoutingMutationAllowed !== false) throw new Error("Controlled experiment definition cannot grant automatic authority");
}

function assertDefinitionAdmissionBinding(payload: ControlledExperimentDefinitionPayload, admissionDecision: M5AdmissionDecision): void {
  const admission = admissionDecision.payload;
  if (payload.admissionDecisionId !== admissionDecision.decisionId || payload.admissionDecisionSha256 !== admissionDecision.decisionSha256) throw new Error("Controlled experiment definition does not match exact admission decision");
  if (payload.taxonomyId !== admission.taxonomyId || payload.admissionPolicyId !== admission.policyId || payload.suiteId !== admission.suiteId || payload.suiteSha256 !== admission.suiteSha256 || payload.baselineId !== admission.baselineId || payload.referenceSubjectId !== admission.referenceSubjectId || payload.candidateSubjectId !== admission.candidateSubjectId) throw new Error("Controlled experiment definition admission provenance drift detected");
}

function assertEligibleAdmission(admissionDecision: M5AdmissionDecision): void {
  if (admissionDecision.payload.classification !== "ELIGIBLE_FOR_CONTROLLED_EXPERIMENT" || admissionDecision.payload.experimentAdmissionEligible !== true) throw new Error("Controlled experiment definition requires an eligible M5 admission decision");
  if (admissionDecision.payload.controlledExperimentAutomaticallyAuthorized !== false || admissionDecision.payload.productionRoutingMutationAllowed !== false || admissionDecision.payload.automaticDispatchAllowed !== false) throw new Error("M5 admission decision unexpectedly grants authority");
}

function assertWorkflowBinding(experiment: ControlledExperimentDefinition, workflow: WorkflowRun): void {
  if (workflow.projectId !== experiment.payload.projectId) throw new Error("Controlled experiment workflow projectId does not match experiment projectId");
  if (workflow.riskClass !== experiment.payload.riskClass) throw new Error("Controlled experiment workflow riskClass does not match experiment riskClass");
  if (workflow.phase !== "publish") throw new Error("Controlled experiment authorization requires workflow phase=publish after durable approval");
}

function normalizeSafeSet(values: readonly string[], label: string, requireNonEmpty: boolean): readonly string[] {
  if (!Array.isArray(values)) throw new Error(`${label}s must be an array`);
  const normalized = [...new Set(values.map((item) => prepareSafeReference(item, label)))].sort();
  if (normalized.length !== values.length) throw new Error(`${label}s must not contain duplicates`);
  if (requireNonEmpty && normalized.length === 0) throw new Error(`${label}s must not be empty`);
  return deepFreeze(normalized);
}

function prepareIdentity(value: string, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must not be empty`);
  if (utf8ByteLength(value) > 2048) throw new Error(`${label} exceeds 2048 bytes`);
  if (sanitizeText(value) !== value) throw new Error(`${label} contains secret-like material`);
  return value.trim();
}

function prepareSafeReference(value: string, label: string): string {
  return prepareIdentity(value, label);
}

function assertTimestamp(value: string, label: string): void {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`${label} must be a valid timestamp`);
}

function assertExactAllowedFields(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${label}.${key} is not allowed`);
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
}

function assertRate(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${label} must be between 0 and 1`);
}

function assertBasisPoints(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 10000) throw new Error(`${label} must be an integer between 0 and 10000`);
}

function assertNonNegativeFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be finite and non-negative`);
}

function sameArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sanitizeText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [redacted]")
    .replace(/(authorization|api[_-]?key|access[_-]?token|password|secret|credential)\s*[:=]\s*(Bearer\s+)?[^\s,;]+/gi, "$1=[redacted]")
    .replace(/\b(?:ghp_|github_pat_|sk-(?:proj-)?|sb_secret_)[A-Za-z0-9_-]{16,}\b/g, "[redacted]");
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

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}
