import type { WorkflowRun } from "../control-plane/contracts.js";
import type { ControlledExperimentGuardrailDecision } from "../evaluation/controlled-experiment-guardrails.js";
import { verifyControlledExperimentGuardrailDecision } from "../evaluation/controlled-experiment-guardrails.js";
import type { M5AdmissionDecision } from "../evaluation/m5-admission-gate.js";
import type { ControlledExperimentAuthorization, ControlledExperimentDefinition } from "../evaluation/controlled-experiment.js";
import { verifyControlledExperimentAuthorization, verifyControlledExperimentDefinition } from "../evaluation/controlled-experiment.js";
import type { JsonlBoundedLiveSideEffectJournal } from "./bounded-live-side-effect-journal.js";

export const BOUNDED_LIVE_ROLLBACK_AUTHORIZATION_SCHEMA_VERSION = 1 as const;
export const BOUNDED_LIVE_REFERENCE_RESTORE_RECEIPT_SCHEMA_VERSION = 1 as const;

export interface BoundedLiveRollbackAuthorizationInput { readonly actor: string; readonly approvedAt: string; readonly policyReferences: readonly string[]; readonly approvalIds: readonly string[]; }
export interface BoundedLiveRollbackAuthorizationPayload extends BoundedLiveRollbackAuthorizationInput {
  readonly experimentId: string; readonly experimentSha256: string; readonly experimentAuthorizationId: string; readonly experimentAuthorizationSha256: string;
  readonly guardrailDecisionId: string; readonly guardrailDecisionSha256: string; readonly experimentWorkflowRunId: string; readonly rollbackWorkflowRunId: string;
  readonly projectId: string; readonly riskClass: "R3" | "R4"; readonly strategy: "restore_reference_subject"; readonly targetSubjectId: string;
  readonly guardrailClassification: "ROLLBACK_REQUIRED"; readonly explicitReferenceRestoreAuthorized: true; readonly automaticRollbackAllowed: false; readonly generalProductionRoutingMutationAllowed: false;
}
export interface BoundedLiveRollbackAuthorization { readonly schemaVersion: typeof BOUNDED_LIVE_ROLLBACK_AUTHORIZATION_SCHEMA_VERSION; readonly algorithm: "sha256"; readonly authorizationId: string; readonly authorizationSha256: string; readonly payload: BoundedLiveRollbackAuthorizationPayload; }
export interface BoundedLiveReferenceRestoreSink {
  readonly id: string;
  restore(input: { readonly idempotencyKey: string; readonly experimentId: string; readonly targetSubjectId: string }): Promise<{ readonly sinkId: string; readonly idempotencyKey: string; readonly restoreReference: string; readonly restoredAt: string; readonly activeSubjectId: string }>;
}
export interface BoundedLiveReferenceRestoreReceiptPayload {
  readonly rollbackAuthorizationId: string; readonly rollbackAuthorizationSha256: string; readonly experimentId: string; readonly targetSubjectId: string; readonly sinkId: string;
  readonly restoreReference: string; readonly restoreIdempotencyKey: string; readonly sideEffectOperationId: string; readonly sideEffectCommitEventId: string;
  readonly restoredAt: string; readonly activeSubjectId: string; readonly referenceSubjectRestored: true; readonly automaticRollbackAllowed: false; readonly automaticRetryAllowed: false; readonly generalProductionRoutingMutationAllowed: false;
}
export interface BoundedLiveReferenceRestoreReceipt { readonly schemaVersion: typeof BOUNDED_LIVE_REFERENCE_RESTORE_RECEIPT_SCHEMA_VERSION; readonly algorithm: "sha256"; readonly receiptId: string; readonly receiptSha256: string; readonly payload: BoundedLiveReferenceRestoreReceiptPayload; }

export async function prepareBoundedLiveRollbackAuthorization(input: {
  readonly experiment: ControlledExperimentDefinition; readonly experimentAuthorization: ControlledExperimentAuthorization; readonly admissionDecision: M5AdmissionDecision;
  readonly experimentWorkflow: WorkflowRun; readonly guardrailDecision: ControlledExperimentGuardrailDecision; readonly rollbackWorkflow: WorkflowRun; readonly authorization: BoundedLiveRollbackAuthorizationInput;
}): Promise<BoundedLiveRollbackAuthorization> {
  const { experiment, experimentAuthorization, admissionDecision, experimentWorkflow, guardrailDecision, rollbackWorkflow } = input;
  await verifyControlledExperimentDefinition(experiment, admissionDecision);
  await verifyControlledExperimentAuthorization(experimentAuthorization, experiment, admissionDecision, experimentWorkflow);
  await verifyControlledExperimentGuardrailDecision(guardrailDecision);
  if (experiment.payload.exposureMode !== "shadow_then_bounded_live" || (experiment.payload.riskClass !== "R3" && experiment.payload.riskClass !== "R4")) throw new Error("Bounded-live rollback requires an R3/R4 shadow_then_bounded_live experiment");
  if (experiment.payload.referenceSubjectId === experiment.payload.candidateSubjectId) throw new Error("Bounded-live rollback requires distinct reference and candidate subjects");
  if (experimentAuthorization.payload.decision !== "allow" || experimentAuthorization.payload.experimentContractAuthorized !== true) throw new Error("Bounded-live rollback requires exact allow experiment authorization");
  if (guardrailDecision.payload.experimentId !== experiment.experimentId || guardrailDecision.payload.experimentSha256 !== experiment.experimentSha256 || guardrailDecision.payload.authorizationId !== experimentAuthorization.authorizationId || guardrailDecision.payload.authorizationSha256 !== experimentAuthorization.authorizationSha256 || guardrailDecision.payload.workflowRunId !== experimentWorkflow.id) throw new Error("Bounded-live rollback guardrail does not match exact experiment authority");
  if (guardrailDecision.payload.classification !== "ROLLBACK_REQUIRED" || guardrailDecision.payload.guardrailActionRequired !== true) throw new Error("Bounded-live rollback requires ROLLBACK_REQUIRED guardrail decision");
  if (guardrailDecision.payload.automaticRollbackAllowed !== false || experiment.payload.rollback.automaticRollbackAllowed !== false) throw new Error("Bounded-live rollback must remain explicitly authorized and non-automatic");
  assertWorkflow(experiment, rollbackWorkflow);
  const authorization = normalizeInput(input.authorization);
  if (Date.parse(authorization.approvedAt) < Date.parse(guardrailDecision.payload.observedAt)) throw new Error("Bounded-live rollback approval cannot predate ROLLBACK_REQUIRED evidence");
  if (Date.parse(authorization.approvedAt) < Date.parse(rollbackWorkflow.updatedAt)) throw new Error("Bounded-live rollback approval timestamp cannot predate durable rollback workflow approval state");
  const durableApprovals = normalizeSafeSet(rollbackWorkflow.approvalIds, "Bounded-live rollback durable approvalId", true);
  if (!sameArray(authorization.approvalIds, durableApprovals)) throw new Error("Bounded-live rollback approvalIds do not match durable rollback workflow approvals");
  const payload: BoundedLiveRollbackAuthorizationPayload = deepFreeze({ ...authorization, experimentId: experiment.experimentId, experimentSha256: experiment.experimentSha256, experimentAuthorizationId: experimentAuthorization.authorizationId, experimentAuthorizationSha256: experimentAuthorization.authorizationSha256, guardrailDecisionId: guardrailDecision.decisionId, guardrailDecisionSha256: guardrailDecision.decisionSha256, experimentWorkflowRunId: experimentWorkflow.id, rollbackWorkflowRunId: rollbackWorkflow.id, projectId: experiment.payload.projectId, riskClass: experiment.payload.riskClass as "R3" | "R4", strategy: "restore_reference_subject" as const, targetSubjectId: experiment.payload.referenceSubjectId, guardrailClassification: "ROLLBACK_REQUIRED" as const, explicitReferenceRestoreAuthorized: true as const, automaticRollbackAllowed: false as const, generalProductionRoutingMutationAllowed: false as const });
  const authorizationSha256 = await sha256Canonical(payload);
  return deepFreeze({ schemaVersion: BOUNDED_LIVE_ROLLBACK_AUTHORIZATION_SCHEMA_VERSION, algorithm: "sha256" as const, authorizationId: `m5rollbackauth:${authorizationSha256.slice(0, 32).toLowerCase()}`, authorizationSha256, payload });
}

export async function verifyBoundedLiveRollbackAuthorizationEnvelope(authorization: BoundedLiveRollbackAuthorization): Promise<void> {
  if (!authorization || typeof authorization !== "object" || authorization.schemaVersion !== BOUNDED_LIVE_ROLLBACK_AUTHORIZATION_SCHEMA_VERSION || authorization.algorithm !== "sha256") throw new Error("Bounded-live rollback authorization envelope is invalid");
  const payload = authorization.payload;
  if (!payload || typeof payload !== "object") throw new Error("Bounded-live rollback authorization payload is invalid");
  if (payload.riskClass !== "R3" && payload.riskClass !== "R4") throw new Error("Bounded-live rollback authorization riskClass is invalid");
  if (payload.strategy !== "restore_reference_subject" || payload.guardrailClassification !== "ROLLBACK_REQUIRED" || payload.explicitReferenceRestoreAuthorized !== true || payload.automaticRollbackAllowed !== false || payload.generalProductionRoutingMutationAllowed !== false) throw new Error("Bounded-live rollback authorization safety flags are invalid");
  prepareTimestamp(payload.approvedAt, "Bounded-live rollback authorization approvedAt");
  const expected = await sha256Canonical(payload);
  if (authorization.authorizationSha256 !== expected || authorization.authorizationId !== `m5rollbackauth:${expected.slice(0, 32).toLowerCase()}`) throw new Error("Bounded-live rollback authorization digest is invalid");
}

export async function verifyBoundedLiveRollbackAuthorization(authorization: BoundedLiveRollbackAuthorization, sources: Parameters<typeof prepareBoundedLiveRollbackAuthorization>[0]): Promise<void> {
  await verifyBoundedLiveRollbackAuthorizationEnvelope(authorization);
  const expected = await prepareBoundedLiveRollbackAuthorization(sources);
  if (authorization.authorizationId !== expected.authorizationId || authorization.authorizationSha256 !== expected.authorizationSha256 || stableStringify(authorization.payload) !== stableStringify(expected.payload)) throw new Error("Bounded-live rollback authorization does not match authoritative sources");
}

export class BoundedLiveReferenceRestoreCoordinator {
  constructor(private readonly sink: BoundedLiveReferenceRestoreSink, private readonly sideEffects: JsonlBoundedLiveSideEffectJournal) { prepareIdentity(sink.id, "Bounded-live reference restore sink id"); }

  async restore(authorization: BoundedLiveRollbackAuthorization): Promise<BoundedLiveReferenceRestoreReceipt> {
    await verifyBoundedLiveRollbackAuthorizationEnvelope(authorization);
    const idempotencyKey = `${authorization.authorizationId}:${authorization.payload.targetSubjectId}`;
    const operationId = `restore:${authorization.authorizationId}`;
    await this.sideEffects.reserve({ kind: "reference_restore", operationId, idempotencyKey, sinkId: this.sink.id, authorityId: authorization.authorizationId, subjectId: authorization.payload.targetSubjectId, reservedAt: authorization.payload.approvedAt });
    let sinkReceipt: Awaited<ReturnType<BoundedLiveReferenceRestoreSink["restore"]>>;
    try {
      sinkReceipt = await this.sink.restore({ idempotencyKey, experimentId: authorization.payload.experimentId, targetSubjectId: authorization.payload.targetSubjectId });
      if (!sinkReceipt || typeof sinkReceipt !== "object" || sinkReceipt.sinkId !== this.sink.id || sinkReceipt.idempotencyKey !== idempotencyKey || sinkReceipt.activeSubjectId !== authorization.payload.targetSubjectId) throw new Error("Bounded-live reference restore sink receipt does not prove exact reference restoration");
    } catch (error) {
      const message = safeError(error);
      try {
        const errorEvent = await this.sideEffects.recordError({ operationId, observedAt: authorization.payload.approvedAt, error: message });
        throw new Error(`Bounded-live reference restore side effect is unknown; manual reconciliation is required and automatic retry is forbidden; journal=${errorEvent.eventId}: ${message}`);
      } catch (journalError) {
        if (journalError instanceof Error && journalError.message.includes("manual reconciliation is required")) throw journalError;
        throw new Error(`Bounded-live reference restore side effect is unknown and error persistence failed; manual reconciliation is required and automatic retry is forbidden: ${message}; journalError=${safeError(journalError)}`);
      }
    }
    const restoredAt = prepareTimestamp(sinkReceipt.restoredAt, "Bounded-live restoredAt");
    if (Date.parse(restoredAt) < Date.parse(authorization.payload.approvedAt)) throw new Error("Bounded-live reference restore cannot predate rollback authorization");
    let commitEvent;
    try {
      commitEvent = await this.sideEffects.recordCommit({ operationId, externalReference: sinkReceipt.restoreReference, committedAt: restoredAt });
    } catch (error) {
      throw new Error(`Bounded-live reference restore sink accepted operation but durable side-effect commit failed; external side effect may have occurred, manual reconciliation is required, and automatic retry is forbidden: ${safeError(error)}`);
    }
    const payload: BoundedLiveReferenceRestoreReceiptPayload = deepFreeze({ rollbackAuthorizationId: authorization.authorizationId, rollbackAuthorizationSha256: authorization.authorizationSha256, experimentId: authorization.payload.experimentId, targetSubjectId: authorization.payload.targetSubjectId, sinkId: sinkReceipt.sinkId, restoreReference: prepareIdentity(sinkReceipt.restoreReference, "Bounded-live restore reference"), restoreIdempotencyKey: idempotencyKey, sideEffectOperationId: operationId, sideEffectCommitEventId: commitEvent.eventId, restoredAt, activeSubjectId: sinkReceipt.activeSubjectId, referenceSubjectRestored: true as const, automaticRollbackAllowed: false as const, automaticRetryAllowed: false as const, generalProductionRoutingMutationAllowed: false as const });
    const receiptSha256 = await sha256Canonical(payload);
    return deepFreeze({ schemaVersion: BOUNDED_LIVE_REFERENCE_RESTORE_RECEIPT_SCHEMA_VERSION, algorithm: "sha256" as const, receiptId: `m5restore:${receiptSha256.slice(0, 32).toLowerCase()}`, receiptSha256, payload });
  }
}

export async function verifyBoundedLiveReferenceRestoreReceipt(receipt: BoundedLiveReferenceRestoreReceipt): Promise<void> {
  if (!receipt || typeof receipt !== "object" || receipt.schemaVersion !== BOUNDED_LIVE_REFERENCE_RESTORE_RECEIPT_SCHEMA_VERSION || receipt.algorithm !== "sha256") throw new Error("Bounded-live reference restore receipt envelope is invalid");
  const expected = await sha256Canonical(receipt.payload);
  if (receipt.receiptSha256 !== expected || receipt.receiptId !== `m5restore:${expected.slice(0, 32).toLowerCase()}`) throw new Error("Bounded-live reference restore receipt digest is invalid");
  if (receipt.payload.referenceSubjectRestored !== true || receipt.payload.activeSubjectId !== receipt.payload.targetSubjectId || receipt.payload.automaticRollbackAllowed !== false || receipt.payload.automaticRetryAllowed !== false || receipt.payload.generalProductionRoutingMutationAllowed !== false) throw new Error("Bounded-live reference restore receipt safety invariants are invalid");
  prepareIdentity(receipt.payload.sideEffectOperationId, "Bounded-live restore side-effect operationId");
  prepareIdentity(receipt.payload.sideEffectCommitEventId, "Bounded-live restore side-effect commit eventId");
}

function assertWorkflow(experiment: ControlledExperimentDefinition, workflow: WorkflowRun): void {
  if (workflow.projectId !== experiment.payload.projectId || workflow.riskClass !== experiment.payload.riskClass) throw new Error("Bounded-live rollback workflow does not match experiment project/risk");
  if ((workflow.riskClass !== "R3" && workflow.riskClass !== "R4") || workflow.phase !== "publish" || workflow.status !== "running") throw new Error("Bounded-live rollback workflow must be approved R3/R4 publish/running");
  prepareTimestamp(workflow.updatedAt, "Bounded-live rollback workflow updatedAt"); normalizeSafeSet(workflow.approvalIds, "Bounded-live rollback durable approvalId", true);
}
function normalizeInput(input: BoundedLiveRollbackAuthorizationInput): BoundedLiveRollbackAuthorizationInput { return deepFreeze({ actor: prepareIdentity(input.actor, "Bounded-live rollback actor"), approvedAt: prepareTimestamp(input.approvedAt, "Bounded-live rollback approvedAt"), policyReferences: normalizeSafeSet(input.policyReferences, "Bounded-live rollback policy reference", true), approvalIds: normalizeSafeSet(input.approvalIds, "Bounded-live rollback approvalId", true) }); }
function normalizeSafeSet(values: readonly string[], label: string, requireNonEmpty: boolean): readonly string[] { if (!Array.isArray(values)) throw new Error(`${label}s must be an array`); const normalized = [...new Set(values.map((value) => prepareIdentity(value, label)))].sort(); if (normalized.length !== values.length) throw new Error(`${label}s must not contain duplicates`); if (requireNonEmpty && normalized.length === 0) throw new Error(`${label}s must not be empty`); return deepFreeze(normalized); }
function prepareIdentity(value: unknown, label: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must not be empty`); const prepared = value.trim(); if (/\r|\n/.test(prepared)) throw new Error(`${label} must be single-line`); if (containsSecretLikeMaterial(prepared)) throw new Error(`${label} contains secret-like material`); return prepared; }
function prepareTimestamp(value: unknown, label: string): string { if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`${label} must be a valid timestamp`); return new Date(value).toISOString(); }
function sameArray(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length && left.every((value, index) => value === right[index]); }
function containsSecretLikeMaterial(value: string): boolean { return /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/i.test(value) || /(authorization|api[_-]?key|access[_-]?token|password|secret|credential|cookie)\s*[:=]/i.test(value) || /\bghp_[A-Za-z0-9]{20,}\b/.test(value) || /\bgithub_pat_[A-Za-z0-9_]{20,}\b/.test(value) || /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/.test(value); }
function safeError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [redacted]").replace(/(authorization|api[_-]?key|access[_-]?token|password|secret|credential)\s*[:=]\s*(Bearer\s+)?[^\s,;]+/gi, "$1=[redacted]"); }
async function sha256Canonical(value: unknown): Promise<string> { if (!globalThis.crypto?.subtle) throw new Error("Web Crypto SHA-256 is unavailable in this runtime"); const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(stableStringify(value))); return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase(); }
function stableStringify(value: unknown): string { return JSON.stringify(sortJson(value)); }
function sortJson(value: unknown): unknown { if (Array.isArray(value)) return value.map(sortJson); if (!value || typeof value !== "object") return value; return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, child]) => child !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, sortJson(child)])); }
function deepFreeze<T>(value: T): T { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value; Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); return value; }
