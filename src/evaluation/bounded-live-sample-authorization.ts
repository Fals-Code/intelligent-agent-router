import type { RiskClass, WorkflowRun } from "../control-plane/contracts.js";
import type { ControlledExperimentGuardrailDecision } from "./controlled-experiment-guardrails.js";
import { verifyControlledExperimentGuardrailDecision } from "./controlled-experiment-guardrails.js";
import type { M5AdmissionDecision } from "./m5-admission-gate.js";
import type {
  ControlledExperimentAuthorization,
  ControlledExperimentDefinition,
} from "./controlled-experiment.js";
import {
  verifyControlledExperimentAuthorization,
  verifyControlledExperimentDefinition,
} from "./controlled-experiment.js";

export const BOUNDED_LIVE_SAMPLE_AUTHORIZATION_SCHEMA_VERSION = 1 as const;

export type BoundedLiveAssignment = "reference" | "candidate";

export interface BoundedLiveSampleAuthorizationInput {
  readonly sampleId: string;
  readonly inputReference: string;
  readonly liveAssignment: BoundedLiveAssignment;
  readonly actor: string;
  readonly approvedAt: string;
  readonly policyReferences: readonly string[];
  readonly approvalIds: readonly string[];
}

export interface BoundedLiveSampleAuthorizationPayload extends BoundedLiveSampleAuthorizationInput {
  readonly experimentId: string;
  readonly experimentSha256: string;
  readonly experimentAuthorizationId: string;
  readonly experimentAuthorizationSha256: string;
  readonly guardrailDecisionId: string;
  readonly guardrailDecisionSha256: string;
  readonly experimentWorkflowRunId: string;
  readonly liveWorkflowRunId: string;
  readonly projectId: string;
  readonly riskClass: "R3" | "R4";
  readonly selectedSubjectId: string;
  readonly shadowSamplesBeforeLive: number;
  readonly liveSamplesBeforeDispatch: number;
  readonly candidateLiveSamplesBeforeDispatch: number;
  readonly candidateTrafficAfterDispatchBasisPoints: number;
  readonly candidateOutputMayBeExternallyVisible: boolean;
  readonly singleSampleAuthority: true;
  readonly automaticDispatchAllowed: false;
  readonly automaticRedispatchAllowed: false;
  readonly productionRoutingMutationAllowed: false;
  readonly automaticRollbackAllowed: false;
}

export interface BoundedLiveSampleAuthorization {
  readonly schemaVersion: typeof BOUNDED_LIVE_SAMPLE_AUTHORIZATION_SCHEMA_VERSION;
  readonly algorithm: "sha256";
  readonly authorizationId: string;
  readonly authorizationSha256: string;
  readonly payload: BoundedLiveSampleAuthorizationPayload;
}

const ENVELOPE_FIELDS = new Set(["schemaVersion", "algorithm", "authorizationId", "authorizationSha256", "payload"]);
const PAYLOAD_FIELDS = new Set([
  "sampleId", "inputReference", "liveAssignment", "actor", "approvedAt", "policyReferences", "approvalIds",
  "experimentId", "experimentSha256", "experimentAuthorizationId", "experimentAuthorizationSha256",
  "guardrailDecisionId", "guardrailDecisionSha256", "experimentWorkflowRunId", "liveWorkflowRunId",
  "projectId", "riskClass", "selectedSubjectId", "shadowSamplesBeforeLive", "liveSamplesBeforeDispatch",
  "candidateLiveSamplesBeforeDispatch", "candidateTrafficAfterDispatchBasisPoints", "candidateOutputMayBeExternallyVisible",
  "singleSampleAuthority", "automaticDispatchAllowed", "automaticRedispatchAllowed", "productionRoutingMutationAllowed",
  "automaticRollbackAllowed",
]);

export async function prepareBoundedLiveSampleAuthorization(input: {
  readonly experiment: ControlledExperimentDefinition;
  readonly experimentAuthorization: ControlledExperimentAuthorization;
  readonly admissionDecision: M5AdmissionDecision;
  readonly experimentWorkflow: WorkflowRun;
  readonly guardrailDecision: ControlledExperimentGuardrailDecision;
  readonly liveWorkflow: WorkflowRun;
  readonly authorization: BoundedLiveSampleAuthorizationInput;
}): Promise<BoundedLiveSampleAuthorization> {
  const { experiment, experimentAuthorization, admissionDecision, experimentWorkflow, guardrailDecision, liveWorkflow } = input;
  await verifyControlledExperimentDefinition(experiment, admissionDecision);
  await verifyControlledExperimentAuthorization(experimentAuthorization, experiment, admissionDecision, experimentWorkflow);
  await verifyControlledExperimentGuardrailDecision(guardrailDecision);
  assertExperimentAuthority(experiment, experimentAuthorization, experimentWorkflow, guardrailDecision);
  assertLiveWorkflow(experiment, liveWorkflow);

  const authorization = normalizeInput(input.authorization);
  const durableApprovals = normalizeSafeSet(liveWorkflow.approvalIds, "Bounded-live durable approvalId", true);
  if (!sameArray(authorization.approvalIds, durableApprovals)) {
    throw new Error("Bounded-live sample approvalIds do not match durable live workflow approvals");
  }

  const counters = nextCounters(experiment, guardrailDecision, authorization.liveAssignment);
  const selectedSubjectId = authorization.liveAssignment === "candidate"
    ? experiment.payload.candidateSubjectId
    : experiment.payload.referenceSubjectId;
  const payload: BoundedLiveSampleAuthorizationPayload = deepFreeze({
    ...authorization,
    experimentId: experiment.experimentId,
    experimentSha256: experiment.experimentSha256,
    experimentAuthorizationId: experimentAuthorization.authorizationId,
    experimentAuthorizationSha256: experimentAuthorization.authorizationSha256,
    guardrailDecisionId: guardrailDecision.decisionId,
    guardrailDecisionSha256: guardrailDecision.decisionSha256,
    experimentWorkflowRunId: experimentWorkflow.id,
    liveWorkflowRunId: liveWorkflow.id,
    projectId: experiment.payload.projectId,
    riskClass: experiment.payload.riskClass as "R3" | "R4",
    selectedSubjectId,
    shadowSamplesBeforeLive: guardrailDecision.payload.shadowSamples,
    liveSamplesBeforeDispatch: guardrailDecision.payload.liveSamples,
    candidateLiveSamplesBeforeDispatch: guardrailDecision.payload.candidateLiveSamples,
    candidateTrafficAfterDispatchBasisPoints: counters.candidateTrafficBasisPoints,
    candidateOutputMayBeExternallyVisible: authorization.liveAssignment === "candidate",
    singleSampleAuthority: true as const,
    automaticDispatchAllowed: false as const,
    automaticRedispatchAllowed: false as const,
    productionRoutingMutationAllowed: false as const,
    automaticRollbackAllowed: false as const,
  });
  const authorizationSha256 = await sha256Canonical(payload);
  return deepFreeze({
    schemaVersion: BOUNDED_LIVE_SAMPLE_AUTHORIZATION_SCHEMA_VERSION,
    algorithm: "sha256" as const,
    authorizationId: `m5liveauth:${authorizationSha256.slice(0, 32).toLowerCase()}`,
    authorizationSha256,
    payload,
  });
}

export async function verifyBoundedLiveSampleAuthorization(
  authorization: BoundedLiveSampleAuthorization,
  sources: Parameters<typeof prepareBoundedLiveSampleAuthorization>[0],
): Promise<void> {
  if (!isRecord(authorization)) throw new Error("Bounded-live sample authorization must be an object");
  assertExactFields(authorization, ENVELOPE_FIELDS, "Bounded-live sample authorization");
  if (authorization.schemaVersion !== BOUNDED_LIVE_SAMPLE_AUTHORIZATION_SCHEMA_VERSION || authorization.algorithm !== "sha256") {
    throw new Error("Bounded-live sample authorization envelope is invalid");
  }
  if (!isRecord(authorization.payload)) throw new Error("Bounded-live sample authorization payload is invalid");
  assertExactFields(authorization.payload, PAYLOAD_FIELDS, "Bounded-live sample authorization payload");
  const expected = await prepareBoundedLiveSampleAuthorization(sources);
  if (authorization.authorizationId !== expected.authorizationId || authorization.authorizationSha256 !== expected.authorizationSha256) {
    throw new Error("Bounded-live sample authorization digest does not match authoritative sources");
  }
  if (stableStringify(authorization.payload) !== stableStringify(expected.payload)) {
    throw new Error("Bounded-live sample authorization payload does not match authoritative sources");
  }
}

function assertExperimentAuthority(
  experiment: ControlledExperimentDefinition,
  authorization: ControlledExperimentAuthorization,
  workflow: WorkflowRun,
  guardrail: ControlledExperimentGuardrailDecision,
): void {
  if (authorization.payload.decision !== "allow" || authorization.payload.experimentContractAuthorized !== true) {
    throw new Error("Bounded-live sample requires an explicit allow experiment authorization");
  }
  if (experiment.payload.exposureMode !== "shadow_then_bounded_live") {
    throw new Error("Bounded-live sample requires shadow_then_bounded_live experiment mode");
  }
  if (experiment.payload.riskClass !== "R3" && experiment.payload.riskClass !== "R4") {
    throw new Error("Bounded-live sample requires R3 or R4 experiment risk class");
  }
  if (guardrail.payload.experimentId !== experiment.experimentId
    || guardrail.payload.experimentSha256 !== experiment.experimentSha256
    || guardrail.payload.authorizationId !== authorization.authorizationId
    || guardrail.payload.authorizationSha256 !== authorization.authorizationSha256
    || guardrail.payload.workflowRunId !== workflow.id) {
    throw new Error("Bounded-live guardrail decision does not match exact experiment authority");
  }
  const expectedClassification = guardrail.payload.liveSamples === 0
    ? "ELIGIBLE_FOR_BOUNDED_LIVE"
    : "CONTINUE_BOUNDED_LIVE";
  if (guardrail.payload.classification !== expectedClassification) {
    throw new Error(`Bounded-live sample requires ${expectedClassification}; received ${guardrail.payload.classification}`);
  }
  if (guardrail.payload.guardrailActionRequired !== false
    || guardrail.payload.automaticDispatchAllowed !== false
    || guardrail.payload.productionRoutingMutationAllowed !== false
    || guardrail.payload.automaticRollbackAllowed !== false) {
    throw new Error("Bounded-live guardrail decision unexpectedly grants automatic or production-routing authority");
  }
  if (guardrail.payload.shadowSamples < experiment.payload.budget.minimumShadowSamplesBeforeLive) {
    throw new Error("Bounded-live sample requires minimum completed shadow evidence");
  }
}

function assertLiveWorkflow(experiment: ControlledExperimentDefinition, workflow: WorkflowRun): void {
  if (workflow.projectId !== experiment.payload.projectId) throw new Error("Bounded-live live workflow projectId mismatch");
  if (workflow.riskClass !== experiment.payload.riskClass) throw new Error("Bounded-live live workflow riskClass mismatch");
  if (workflow.riskClass !== "R3" && workflow.riskClass !== "R4") throw new Error("Bounded-live live workflow must be R3 or R4");
  if (workflow.phase !== "publish" || workflow.status !== "running") {
    throw new Error("Bounded-live live workflow must be active in publish phase after durable approval");
  }
  normalizeSafeSet(workflow.approvalIds, "Bounded-live durable approvalId", true);
}

function nextCounters(
  experiment: ControlledExperimentDefinition,
  guardrail: ControlledExperimentGuardrailDecision,
  assignment: BoundedLiveAssignment,
): { readonly liveSamples: number; readonly candidateLiveSamples: number; readonly candidateTrafficBasisPoints: number } {
  const liveSamples = guardrail.payload.liveSamples + 1;
  const candidateLiveSamples = guardrail.payload.candidateLiveSamples + (assignment === "candidate" ? 1 : 0);
  const budget = experiment.payload.budget;
  if (liveSamples > budget.maxLiveSamples) throw new Error("Bounded-live sample would exceed maxLiveSamples");
  if (candidateLiveSamples > budget.maxCandidateLiveSamples) throw new Error("Bounded-live sample would exceed maxCandidateLiveSamples");
  const candidateTrafficBasisPoints = (candidateLiveSamples / liveSamples) * 10000;
  if (candidateTrafficBasisPoints > budget.maxCandidateTrafficBasisPoints) {
    throw new Error("Bounded-live sample would exceed candidate traffic basis-point ceiling");
  }
  if (guardrail.payload.completedSamples + 1 > budget.maxTotalSamples) {
    throw new Error("Bounded-live sample would exceed total experiment sample budget");
  }
  return { liveSamples, candidateLiveSamples, candidateTrafficBasisPoints };
}

function normalizeInput(input: BoundedLiveSampleAuthorizationInput): BoundedLiveSampleAuthorizationInput {
  if (input.liveAssignment !== "reference" && input.liveAssignment !== "candidate") {
    throw new Error("Bounded-live assignment must be reference or candidate");
  }
  const sampleId = prepareIdentity(input.sampleId, "Bounded-live sampleId");
  const inputReference = prepareSafeReference(input.inputReference, "Bounded-live inputReference");
  const actor = prepareIdentity(input.actor, "Bounded-live actor");
  const approvedAt = prepareTimestamp(input.approvedAt, "Bounded-live approvedAt");
  const policyReferences = normalizeSafeSet(input.policyReferences, "Bounded-live policy reference", true);
  const approvalIds = normalizeSafeSet(input.approvalIds, "Bounded-live approvalId", true);
  return deepFreeze({ sampleId, inputReference, liveAssignment: input.liveAssignment, actor, approvedAt, policyReferences, approvalIds });
}

function normalizeSafeSet(values: readonly string[], label: string, requireNonEmpty: boolean): readonly string[] {
  if (!Array.isArray(values)) throw new Error(`${label}s must be an array`);
  const normalized = [...new Set(values.map((value) => prepareSafeReference(value, label)))].sort();
  if (normalized.length !== values.length) throw new Error(`${label}s must not contain duplicates`);
  if (requireNonEmpty && normalized.length === 0) throw new Error(`${label}s must not be empty`);
  return deepFreeze(normalized);
}

function prepareIdentity(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must not be empty`);
  const prepared = value.trim();
  if (/\r|\n/.test(prepared)) throw new Error(`${label} must be single-line`);
  if (containsSecretLikeMaterial(prepared)) throw new Error(`${label} contains secret-like material`);
  return prepared;
}

function prepareSafeReference(value: unknown, label: string): string {
  return prepareIdentity(value, label);
}

function prepareTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`${label} must be a valid timestamp`);
  return new Date(value).toISOString();
}

function assertExactFields(value: Record<string, unknown>, fields: ReadonlySet<string>, label: string): void {
  const keys = Object.keys(value);
  for (const key of keys) if (!fields.has(key)) throw new Error(`${label}.${key} is not allowed`);
  for (const field of fields) if (!keys.includes(field)) throw new Error(`${label}.${field} is required`);
}

function sameArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function containsSecretLikeMaterial(value: string): boolean {
  return /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/i.test(value)
    || /(authorization|api[_-]?key|access[_-]?token|password|secret|credential|cookie)\s*[:=]/i.test(value)
    || /\bghp_[A-Za-z0-9]{20,}\b/.test(value)
    || /\bgithub_pat_[A-Za-z0-9_]{20,}\b/.test(value)
    || /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/.test(value);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}
