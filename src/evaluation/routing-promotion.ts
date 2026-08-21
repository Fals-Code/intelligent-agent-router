import { existsSync, readFileSync } from "node:fs";
import type {
  CapabilityId,
  EvidenceRecord,
  RunLedgerRecord,
  WorkflowRun,
} from "../control-plane/contracts.js";
import { FROZEN_CAPABILITIES } from "../control-plane/contracts.js";
import type { EvalHistoryObservation } from "./eval-history.js";
import type { ExecutionMetricProjection } from "./execution-metrics-projection.js";
import type { EvalCohortSummary } from "./comparative-statistics.js";
import { buildEvalCohortSummary, verifyEvalCohortSummary } from "./comparative-statistics.js";
import type { ExecutionReliabilitySummary } from "./execution-reliability-statistics.js";
import {
  buildExecutionReliabilitySummary,
  verifyExecutionReliabilitySummary,
} from "./execution-reliability-statistics.js";
import type { M5AdmissionDecision } from "./m5-admission-gate.js";
import { verifyM5AdmissionDecision } from "./m5-admission-gate.js";
import type {
  ControlledExperimentAuthorization,
  ControlledExperimentDefinition,
} from "./controlled-experiment.js";
import {
  verifyControlledExperimentAuthorization,
  verifyControlledExperimentDefinition,
} from "./controlled-experiment.js";
import type {
  ControlledExperimentGuardrailDecision,
  ControlledExperimentProgressInput,
} from "./controlled-experiment-guardrails.js";
import {
  evaluateControlledExperimentGuardrails,
  verifyControlledExperimentGuardrailDecision,
} from "./controlled-experiment-guardrails.js";
import type {
  BoundedLiveSampleAuthorization,
  BoundedLiveSampleAuthorizationInput,
} from "./bounded-live-sample-authorization.js";
import { verifyBoundedLiveSampleAuthorization } from "./bounded-live-sample-authorization.js";
import type { BoundedLivePublicationReceipt } from "../integration/bounded-live-publication.js";
import { verifyBoundedLivePublicationReceipt } from "../integration/bounded-live-publication.js";
import type {
  BoundedLiveReferenceRestoreReceipt,
  BoundedLiveRollbackAuthorization,
} from "../integration/bounded-live-reference-restore.js";
import {
  verifyBoundedLiveReferenceRestoreReceipt,
  verifyBoundedLiveRollbackAuthorizationEnvelope,
} from "../integration/bounded-live-reference-restore.js";
import type { BoundedLiveSideEffectRecoveryReport } from "../integration/bounded-live-side-effect-reconciliation.js";
import { verifyBoundedLiveSideEffectRecoveryReport } from "../integration/bounded-live-side-effect-reconciliation.js";
import type { BoundedLiveSideEffectEvent } from "../integration/bounded-live-side-effect-journal.js";
import {
  BOUNDED_LIVE_SIDE_EFFECT_JOURNAL_SCHEMA_VERSION,
  JsonlBoundedLiveSideEffectJournal,
  verifyBoundedLiveSideEffectEvent,
} from "../integration/bounded-live-side-effect-journal.js";

export const ROUTING_PRECONDITION_SNAPSHOT_SCHEMA_VERSION = 1 as const;
export const ROUTING_PROMOTION_PROPOSAL_SCHEMA_VERSION = 1 as const;
export const ROUTING_PROMOTION_AUTHORIZATION_SCHEMA_VERSION = 1 as const;

export type RoutingPromotionClassification =
  | "PROMOTION_NOT_ELIGIBLE"
  | "PROMOTION_ELIGIBLE"
  | "MANUAL_RECONCILIATION_REQUIRED";

export interface RoutingPreconditionSnapshotInput {
  readonly projectId: string;
  readonly routeId: string;
  readonly capability: CapabilityId;
  readonly currentSubjectId: string;
  readonly routeRevision: string;
  readonly capturedAt: string;
  readonly policyReferences: readonly string[];
}

export interface RoutingPreconditionSnapshotPayload extends RoutingPreconditionSnapshotInput {
  readonly providerSpecificStatePersisted: false;
  readonly rawProviderOutputPersisted: false;
}

export interface RoutingPreconditionSnapshot {
  readonly schemaVersion: typeof ROUTING_PRECONDITION_SNAPSHOT_SCHEMA_VERSION;
  readonly algorithm: "sha256";
  readonly snapshotId: string;
  readonly snapshotSha256: string;
  readonly payload: RoutingPreconditionSnapshotPayload;
}

export interface RoutingPromotionCohortEvidence {
  readonly evalSummary: EvalCohortSummary;
  readonly executionSummary: ExecutionReliabilitySummary;
  readonly observations: readonly EvalHistoryObservation[];
  readonly projections: readonly ExecutionMetricProjection[];
  readonly runLedgerRecords: readonly RunLedgerRecord[];
}

export interface RoutingPromotionBoundedLivePublicationEvidence {
  readonly guardrailDecision: ControlledExperimentGuardrailDecision;
  readonly liveWorkflow: WorkflowRun;
  readonly authorizationInput: BoundedLiveSampleAuthorizationInput;
  readonly authorization: BoundedLiveSampleAuthorization;
  readonly receipt?: BoundedLivePublicationReceipt;
  readonly recoveryReport: BoundedLiveSideEffectRecoveryReport;
}

export interface RoutingPromotionReferenceRestoreEvidence {
  readonly authorization: BoundedLiveRollbackAuthorization;
  readonly receipt: BoundedLiveReferenceRestoreReceipt;
  readonly recoveryReport: BoundedLiveSideEffectRecoveryReport;
}

export interface RoutingPromotionContext {
  readonly admissionDecision: M5AdmissionDecision;
  readonly experiment: ControlledExperimentDefinition;
  readonly experimentAuthorization: ControlledExperimentAuthorization;
  readonly experimentWorkflow: WorkflowRun;
  readonly finalProgress: ControlledExperimentProgressInput;
  readonly finalGuardrailDecision: ControlledExperimentGuardrailDecision;
  /** The path identity is used, but cached journal state is never freshness authority. */
  readonly sideEffectJournal: JsonlBoundedLiveSideEffectJournal;
  readonly preconditionSnapshot: RoutingPreconditionSnapshot;
  readonly referenceCohort: RoutingPromotionCohortEvidence;
  readonly candidateCohort: RoutingPromotionCohortEvidence;
  /** Exactly one item for each final live sample, reference or candidate. */
  readonly publicationEvidence: readonly RoutingPromotionBoundedLivePublicationEvidence[];
  readonly referenceRestoreEvidence: readonly RoutingPromotionReferenceRestoreEvidence[];
}

export interface RoutingPromotionProposalInput {
  readonly routeId: string;
  readonly capability: CapabilityId;
  readonly proposedAt: string;
  readonly policyReferences: readonly string[];
}

export interface RoutingPromotionProposalPayload {
  readonly projectId: string;
  readonly routeId: string;
  readonly capability: CapabilityId;
  readonly referenceSubjectId: string;
  readonly candidateSubjectId: string;
  readonly admissionDecisionId: string;
  readonly admissionDecisionSha256: string;
  readonly experimentId: string;
  readonly experimentSha256: string;
  readonly experimentAuthorizationId: string;
  readonly experimentAuthorizationSha256: string;
  readonly experimentWorkflowRunId: string;
  readonly finalProgressSha256: string;
  readonly finalGuardrailDecisionId: string;
  readonly finalGuardrailDecisionSha256: string;
  readonly preconditionSnapshotId: string;
  readonly preconditionSnapshotSha256: string;
  readonly routeRevision: string;
  readonly beforeSubjectId: string;
  readonly afterSubjectId: string;
  readonly rollbackTargetSubjectId: string;
  readonly runLedgerEvidenceReferences: readonly string[];
  readonly evalEvidenceReferences: readonly string[];
  readonly boundedLiveEvidenceReferences: readonly string[];
  readonly proposedAt: string;
  readonly policyReferences: readonly string[];
  readonly classification: RoutingPromotionClassification;
  readonly reasons: readonly string[];
  readonly automaticRoutingMutationAllowed: false;
  readonly automaticRollbackAllowed: false;
  readonly automaticRetryAllowed: false;
  readonly automaticRedispatchAllowed: false;
}

export interface RoutingPromotionProposal {
  readonly schemaVersion: typeof ROUTING_PROMOTION_PROPOSAL_SCHEMA_VERSION;
  readonly algorithm: "sha256";
  readonly proposalId: string;
  readonly proposalSha256: string;
  readonly payload: RoutingPromotionProposalPayload;
}

export interface RoutingPromotionAuthorizationInput {
  readonly decision: "allow" | "deny";
  readonly actor: string;
  readonly decidedAt: string;
  readonly policyReferences: readonly string[];
  readonly approvalIds: readonly string[];
}

export interface RoutingPromotionAuthorizationPayload extends RoutingPromotionAuthorizationInput {
  readonly proposalId: string;
  readonly proposalSha256: string;
  readonly projectId: string;
  readonly routeId: string;
  readonly capability: CapabilityId;
  readonly referenceSubjectId: string;
  readonly candidateSubjectId: string;
  readonly preconditionSnapshotId: string;
  readonly preconditionSnapshotSha256: string;
  readonly routeRevision: string;
  readonly workflowRunId: string;
  readonly riskClass: "R3" | "R4";
  readonly routingMutationAuthorized: boolean;
  readonly automaticRoutingMutationAllowed: false;
  readonly automaticRollbackAllowed: false;
  readonly automaticRetryAllowed: false;
  readonly automaticRedispatchAllowed: false;
}

export interface RoutingPromotionAuthorization {
  readonly schemaVersion: typeof ROUTING_PROMOTION_AUTHORIZATION_SCHEMA_VERSION;
  readonly algorithm: "sha256";
  readonly authorizationId: string;
  readonly authorizationSha256: string;
  readonly payload: RoutingPromotionAuthorizationPayload;
}

type FreshJournalSnapshot = {
  readonly fingerprintSha256: string;
  readonly latestByOperation: ReadonlyMap<string, BoundedLiveSideEffectEvent>;
  readonly unresolvedOperationIds: readonly string[];
};

type DerivedPromotionEvidence = {
  readonly finalProgressSha256: string;
  readonly runLedgerEvidenceReferences: readonly string[];
  readonly evalEvidenceReferences: readonly string[];
  readonly boundedLiveEvidenceReferences: readonly string[];
  readonly classification: RoutingPromotionClassification;
  readonly reasons: readonly string[];
};

const SNAPSHOT_INPUT_FIELDS = new Set([
  "projectId", "routeId", "capability", "currentSubjectId", "routeRevision", "capturedAt", "policyReferences",
]);
const SNAPSHOT_ENVELOPE_FIELDS = new Set([
  "schemaVersion", "algorithm", "snapshotId", "snapshotSha256", "payload",
]);
const SNAPSHOT_PAYLOAD_FIELDS = new Set([
  ...SNAPSHOT_INPUT_FIELDS, "providerSpecificStatePersisted", "rawProviderOutputPersisted",
]);
const PROPOSAL_INPUT_FIELDS = new Set(["routeId", "capability", "proposedAt", "policyReferences"]);
const PROPOSAL_ENVELOPE_FIELDS = new Set([
  "schemaVersion", "algorithm", "proposalId", "proposalSha256", "payload",
]);
const PROPOSAL_PAYLOAD_FIELDS = new Set([
  "projectId", "routeId", "capability", "referenceSubjectId", "candidateSubjectId",
  "admissionDecisionId", "admissionDecisionSha256", "experimentId", "experimentSha256",
  "experimentAuthorizationId", "experimentAuthorizationSha256", "experimentWorkflowRunId",
  "finalProgressSha256", "finalGuardrailDecisionId", "finalGuardrailDecisionSha256",
  "preconditionSnapshotId", "preconditionSnapshotSha256", "routeRevision", "beforeSubjectId",
  "afterSubjectId", "rollbackTargetSubjectId", "runLedgerEvidenceReferences", "evalEvidenceReferences",
  "boundedLiveEvidenceReferences", "proposedAt", "policyReferences", "classification", "reasons",
  "automaticRoutingMutationAllowed", "automaticRollbackAllowed", "automaticRetryAllowed", "automaticRedispatchAllowed",
]);
const AUTH_INPUT_FIELDS = new Set(["decision", "actor", "decidedAt", "policyReferences", "approvalIds"]);
const AUTH_ENVELOPE_FIELDS = new Set([
  "schemaVersion", "algorithm", "authorizationId", "authorizationSha256", "payload",
]);
const AUTH_PAYLOAD_FIELDS = new Set([
  ...AUTH_INPUT_FIELDS, "proposalId", "proposalSha256", "projectId", "routeId", "capability",
  "referenceSubjectId", "candidateSubjectId", "preconditionSnapshotId", "preconditionSnapshotSha256",
  "routeRevision", "workflowRunId", "riskClass", "routingMutationAuthorized",
  "automaticRoutingMutationAllowed", "automaticRollbackAllowed", "automaticRetryAllowed", "automaticRedispatchAllowed",
]);

export async function prepareRoutingPreconditionSnapshot(
  input: RoutingPreconditionSnapshotInput,
): Promise<RoutingPreconditionSnapshot> {
  assertExactFields(input as unknown as Record<string, unknown>, SNAPSHOT_INPUT_FIELDS, "Routing precondition snapshot input");
  const payload: RoutingPreconditionSnapshotPayload = deepFreeze({
    projectId: prepareIdentity(input.projectId, "Routing precondition projectId"),
    routeId: prepareIdentity(input.routeId, "Routing precondition routeId"),
    capability: prepareCapability(input.capability),
    currentSubjectId: prepareIdentity(input.currentSubjectId, "Routing precondition currentSubjectId"),
    routeRevision: prepareIdentity(input.routeRevision, "Routing precondition routeRevision"),
    capturedAt: prepareTimestamp(input.capturedAt, "Routing precondition capturedAt"),
    policyReferences: normalizeSet(input.policyReferences, "Routing precondition policy reference", true),
    providerSpecificStatePersisted: false,
    rawProviderOutputPersisted: false,
  });
  const snapshotSha256 = await sha256Canonical(payload);
  return deepFreeze({
    schemaVersion: ROUTING_PRECONDITION_SNAPSHOT_SCHEMA_VERSION,
    algorithm: "sha256" as const,
    snapshotId: `m5routesnap:${snapshotSha256.slice(0, 32).toLowerCase()}`,
    snapshotSha256,
    payload,
  });
}

export async function verifyRoutingPreconditionSnapshot(snapshot: RoutingPreconditionSnapshot): Promise<void> {
  if (!isRecord(snapshot)) throw new Error("Routing precondition snapshot must be an object");
  assertExactFields(snapshot, SNAPSHOT_ENVELOPE_FIELDS, "Routing precondition snapshot");
  if (snapshot.schemaVersion !== 1 || snapshot.algorithm !== "sha256" || !isRecord(snapshot.payload)) {
    throw new Error("Routing precondition snapshot envelope is invalid");
  }
  assertExactFields(snapshot.payload, SNAPSHOT_PAYLOAD_FIELDS, "Routing precondition snapshot payload");
  const p = snapshot.payload as unknown as RoutingPreconditionSnapshotPayload;
  prepareIdentity(p.projectId, "Routing precondition projectId");
  prepareIdentity(p.routeId, "Routing precondition routeId");
  prepareCapability(p.capability);
  prepareIdentity(p.currentSubjectId, "Routing precondition currentSubjectId");
  prepareIdentity(p.routeRevision, "Routing precondition routeRevision");
  prepareTimestamp(p.capturedAt, "Routing precondition capturedAt");
  if (!sameArray(normalizeSet(p.policyReferences, "Routing precondition policy reference", true), p.policyReferences)) {
    throw new Error("Routing precondition policyReferences are not canonical");
  }
  if (p.providerSpecificStatePersisted !== false || p.rawProviderOutputPersisted !== false) {
    throw new Error("Routing precondition snapshot cannot persist provider state/raw output");
  }
  const expected = await sha256Canonical(p);
  if (snapshot.snapshotSha256 !== expected || snapshot.snapshotId !== `m5routesnap:${expected.slice(0, 32).toLowerCase()}`) {
    throw new Error("Routing precondition snapshot content address is invalid");
  }
}

export async function prepareRoutingPromotionProposal(input: {
  readonly context: RoutingPromotionContext;
  readonly proposal: RoutingPromotionProposalInput;
}): Promise<RoutingPromotionProposal> {
  const derived = await verifyPromotionContext(input.context);
  assertExactFields(input.proposal as unknown as Record<string, unknown>, PROPOSAL_INPUT_FIELDS, "Routing promotion proposal input");
  const routeId = prepareIdentity(input.proposal.routeId, "Routing promotion routeId");
  const capability = prepareCapability(input.proposal.capability);
  if (routeId !== input.context.preconditionSnapshot.payload.routeId || capability !== input.context.preconditionSnapshot.payload.capability) {
    throw new Error("Routing promotion route/capability does not match precondition snapshot");
  }
  const proposedAt = prepareTimestamp(input.proposal.proposedAt, "Routing promotion proposedAt");
  assertAtOrAfter(proposedAt, [input.context.finalGuardrailDecision.payload.observedAt, input.context.preconditionSnapshot.payload.capturedAt], "Routing promotion proposal predates authoritative evidence");
  const experiment = input.context.experiment;
  const payload: RoutingPromotionProposalPayload = deepFreeze({
    projectId: experiment.payload.projectId,
    routeId,
    capability,
    referenceSubjectId: experiment.payload.referenceSubjectId,
    candidateSubjectId: experiment.payload.candidateSubjectId,
    admissionDecisionId: input.context.admissionDecision.decisionId,
    admissionDecisionSha256: input.context.admissionDecision.decisionSha256,
    experimentId: experiment.experimentId,
    experimentSha256: experiment.experimentSha256,
    experimentAuthorizationId: input.context.experimentAuthorization.authorizationId,
    experimentAuthorizationSha256: input.context.experimentAuthorization.authorizationSha256,
    experimentWorkflowRunId: input.context.experimentWorkflow.id,
    finalProgressSha256: derived.finalProgressSha256,
    finalGuardrailDecisionId: input.context.finalGuardrailDecision.decisionId,
    finalGuardrailDecisionSha256: input.context.finalGuardrailDecision.decisionSha256,
    preconditionSnapshotId: input.context.preconditionSnapshot.snapshotId,
    preconditionSnapshotSha256: input.context.preconditionSnapshot.snapshotSha256,
    routeRevision: input.context.preconditionSnapshot.payload.routeRevision,
    beforeSubjectId: experiment.payload.referenceSubjectId,
    afterSubjectId: experiment.payload.candidateSubjectId,
    rollbackTargetSubjectId: experiment.payload.referenceSubjectId,
    runLedgerEvidenceReferences: derived.runLedgerEvidenceReferences,
    evalEvidenceReferences: derived.evalEvidenceReferences,
    boundedLiveEvidenceReferences: derived.boundedLiveEvidenceReferences,
    proposedAt,
    policyReferences: normalizeSet(input.proposal.policyReferences, "Routing promotion policy reference", true),
    classification: derived.classification,
    reasons: derived.reasons,
    automaticRoutingMutationAllowed: false,
    automaticRollbackAllowed: false,
    automaticRetryAllowed: false,
    automaticRedispatchAllowed: false,
  });
  validateProposalPayload(payload);
  const proposalSha256 = await sha256Canonical(payload);
  return deepFreeze({
    schemaVersion: ROUTING_PROMOTION_PROPOSAL_SCHEMA_VERSION,
    algorithm: "sha256" as const,
    proposalId: `m5routeproposal:${proposalSha256.slice(0, 32).toLowerCase()}`,
    proposalSha256,
    payload,
  });
}

export async function verifyRoutingPromotionProposal(
  proposal: RoutingPromotionProposal,
  context: RoutingPromotionContext,
): Promise<void> {
  const derived = await verifyPromotionContext(context);
  if (!isRecord(proposal)) throw new Error("Routing promotion proposal must be an object");
  assertExactFields(proposal, PROPOSAL_ENVELOPE_FIELDS, "Routing promotion proposal");
  if (proposal.schemaVersion !== 1 || proposal.algorithm !== "sha256" || !isRecord(proposal.payload)) {
    throw new Error("Routing promotion proposal envelope is invalid");
  }
  assertExactFields(proposal.payload, PROPOSAL_PAYLOAD_FIELDS, "Routing promotion proposal payload");
  const p = proposal.payload as unknown as RoutingPromotionProposalPayload;
  validateProposalPayload(p);
  const x = context.experiment;
  if (
    p.projectId !== x.payload.projectId || p.routeId !== context.preconditionSnapshot.payload.routeId ||
    p.capability !== context.preconditionSnapshot.payload.capability ||
    p.referenceSubjectId !== x.payload.referenceSubjectId || p.candidateSubjectId !== x.payload.candidateSubjectId ||
    p.admissionDecisionId !== context.admissionDecision.decisionId || p.admissionDecisionSha256 !== context.admissionDecision.decisionSha256 ||
    p.experimentId !== x.experimentId || p.experimentSha256 !== x.experimentSha256 ||
    p.experimentAuthorizationId !== context.experimentAuthorization.authorizationId ||
    p.experimentAuthorizationSha256 !== context.experimentAuthorization.authorizationSha256 ||
    p.experimentWorkflowRunId !== context.experimentWorkflow.id ||
    p.finalProgressSha256 !== derived.finalProgressSha256 ||
    p.finalGuardrailDecisionId !== context.finalGuardrailDecision.decisionId ||
    p.finalGuardrailDecisionSha256 !== context.finalGuardrailDecision.decisionSha256 ||
    p.preconditionSnapshotId !== context.preconditionSnapshot.snapshotId ||
    p.preconditionSnapshotSha256 !== context.preconditionSnapshot.snapshotSha256 ||
    p.routeRevision !== context.preconditionSnapshot.payload.routeRevision ||
    p.beforeSubjectId !== x.payload.referenceSubjectId || p.afterSubjectId !== x.payload.candidateSubjectId ||
    p.rollbackTargetSubjectId !== x.payload.referenceSubjectId ||
    p.classification !== derived.classification || !sameArray(p.reasons, derived.reasons) ||
    !sameArray(p.runLedgerEvidenceReferences, derived.runLedgerEvidenceReferences) ||
    !sameArray(p.evalEvidenceReferences, derived.evalEvidenceReferences) ||
    !sameArray(p.boundedLiveEvidenceReferences, derived.boundedLiveEvidenceReferences)
  ) throw new Error("Routing promotion proposal canonical source binding drift detected");
  assertAtOrAfter(p.proposedAt, [context.finalGuardrailDecision.payload.observedAt, context.preconditionSnapshot.payload.capturedAt], "Routing promotion proposal predates authoritative evidence");
  const expected = await sha256Canonical(p);
  if (proposal.proposalSha256 !== expected || proposal.proposalId !== `m5routeproposal:${expected.slice(0, 32).toLowerCase()}`) {
    throw new Error("Routing promotion proposal content address is invalid");
  }
}

export async function prepareRoutingPromotionAuthorization(input: {
  readonly proposal: RoutingPromotionProposal;
  readonly proposalContext: RoutingPromotionContext;
  readonly currentPreconditionSnapshot: RoutingPreconditionSnapshot;
  readonly workflow: WorkflowRun;
  readonly authorization: RoutingPromotionAuthorizationInput;
}): Promise<RoutingPromotionAuthorization> {
  await verifyRoutingPromotionProposal(input.proposal, input.proposalContext);
  await verifyRoutingPreconditionSnapshot(input.currentPreconditionSnapshot);
  assertFreshRoute(input.proposal, input.currentPreconditionSnapshot);
  assertPromotionWorkflow(input.workflow, input.proposal, input.proposalContext.experimentWorkflow.id);
  assertExactFields(input.authorization as unknown as Record<string, unknown>, AUTH_INPUT_FIELDS, "Routing promotion authorization input");
  if (input.authorization.decision !== "allow" && input.authorization.decision !== "deny") throw new Error("Routing promotion authorization decision is invalid");
  if (input.authorization.decision === "allow" && input.proposal.payload.classification !== "PROMOTION_ELIGIBLE") {
    throw new Error("Routing promotion allow authorization requires an eligible proposal");
  }
  const approvalIds = normalizeSet(input.authorization.approvalIds, "Routing promotion authorization approvalId", input.authorization.decision === "allow");
  const durableApprovals = normalizeSet(input.workflow.approvalIds, "Routing promotion durable workflow approvalId", input.authorization.decision === "allow");
  if (!sameArray(approvalIds, durableApprovals)) throw new Error("Routing promotion authorization approvalIds do not match durable WorkflowRun approvals");
  if (input.authorization.decision === "allow" && input.workflow.status !== "running") throw new Error("Routing promotion allow authorization requires an active workflow");
  const decidedAt = prepareTimestamp(input.authorization.decidedAt, "Routing promotion authorization decidedAt");
  assertAtOrAfter(decidedAt, [input.proposal.payload.proposedAt, input.workflow.updatedAt], "Routing promotion authorization predates proposal or workflow");
  const payload: RoutingPromotionAuthorizationPayload = deepFreeze({
    decision: input.authorization.decision,
    actor: prepareIdentity(input.authorization.actor, "Routing promotion authorization actor"),
    decidedAt,
    policyReferences: normalizeSet(input.authorization.policyReferences, "Routing promotion authorization policy reference", true),
    approvalIds,
    proposalId: input.proposal.proposalId,
    proposalSha256: input.proposal.proposalSha256,
    projectId: input.proposal.payload.projectId,
    routeId: input.proposal.payload.routeId,
    capability: input.proposal.payload.capability,
    referenceSubjectId: input.proposal.payload.referenceSubjectId,
    candidateSubjectId: input.proposal.payload.candidateSubjectId,
    preconditionSnapshotId: input.currentPreconditionSnapshot.snapshotId,
    preconditionSnapshotSha256: input.currentPreconditionSnapshot.snapshotSha256,
    routeRevision: input.currentPreconditionSnapshot.payload.routeRevision,
    workflowRunId: input.workflow.id,
    riskClass: input.workflow.riskClass as "R3" | "R4",
    routingMutationAuthorized: input.authorization.decision === "allow",
    automaticRoutingMutationAllowed: false,
    automaticRollbackAllowed: false,
    automaticRetryAllowed: false,
    automaticRedispatchAllowed: false,
  });
  validateAuthorizationPayload(payload);
  const authorizationSha256 = await sha256Canonical(payload);
  return deepFreeze({
    schemaVersion: ROUTING_PROMOTION_AUTHORIZATION_SCHEMA_VERSION,
    algorithm: "sha256" as const,
    authorizationId: `m5routeauth:${authorizationSha256.slice(0, 32).toLowerCase()}`,
    authorizationSha256,
    payload,
  });
}

export async function verifyRoutingPromotionAuthorization(
  authorization: RoutingPromotionAuthorization,
  proposal: RoutingPromotionProposal,
  proposalContext: RoutingPromotionContext,
  currentPreconditionSnapshot: RoutingPreconditionSnapshot,
  workflow: WorkflowRun,
): Promise<void> {
  await verifyRoutingPromotionProposal(proposal, proposalContext);
  await verifyRoutingPreconditionSnapshot(currentPreconditionSnapshot);
  assertFreshRoute(proposal, currentPreconditionSnapshot);
  assertPromotionWorkflow(workflow, proposal, proposalContext.experimentWorkflow.id);
  if (!isRecord(authorization)) throw new Error("Routing promotion authorization must be an object");
  assertExactFields(authorization, AUTH_ENVELOPE_FIELDS, "Routing promotion authorization");
  if (authorization.schemaVersion !== 1 || authorization.algorithm !== "sha256" || !isRecord(authorization.payload)) {
    throw new Error("Routing promotion authorization envelope is invalid");
  }
  assertExactFields(authorization.payload, AUTH_PAYLOAD_FIELDS, "Routing promotion authorization payload");
  const p = authorization.payload as unknown as RoutingPromotionAuthorizationPayload;
  validateAuthorizationPayload(p);
  if (
    p.proposalId !== proposal.proposalId || p.proposalSha256 !== proposal.proposalSha256 ||
    p.projectId !== proposal.payload.projectId || p.routeId !== proposal.payload.routeId ||
    p.capability !== proposal.payload.capability || p.referenceSubjectId !== proposal.payload.referenceSubjectId ||
    p.candidateSubjectId !== proposal.payload.candidateSubjectId
  ) throw new Error("Routing promotion authorization scope drift detected");
  if (
    p.preconditionSnapshotId !== currentPreconditionSnapshot.snapshotId ||
    p.preconditionSnapshotSha256 !== currentPreconditionSnapshot.snapshotSha256 ||
    p.routeRevision !== currentPreconditionSnapshot.payload.routeRevision
  ) throw new Error("Routing promotion authorization precondition snapshot drift detected");
  if (p.workflowRunId !== workflow.id || p.riskClass !== workflow.riskClass) throw new Error("Routing promotion authorization workflow identity drift detected");
  const approvals = normalizeSet(p.approvalIds, "Routing promotion authorization approvalId", p.decision === "allow");
  const durableApprovals = normalizeSet(workflow.approvalIds, "Routing promotion durable workflow approvalId", p.decision === "allow");
  if (!sameArray(approvals, p.approvalIds) || !sameArray(approvals, durableApprovals)) throw new Error("Routing promotion authorization approvals drift from durable WorkflowRun approvals");
  if (p.routingMutationAuthorized !== (p.decision === "allow") || (p.decision === "allow" && proposal.payload.classification !== "PROMOTION_ELIGIBLE") || (p.decision === "allow" && workflow.status !== "running")) {
    throw new Error("Routing promotion authorization decision/eligibility state is invalid");
  }
  assertAtOrAfter(p.decidedAt, [proposal.payload.proposedAt, workflow.updatedAt], "Routing promotion authorization predates proposal or workflow");
  const expected = await sha256Canonical(p);
  if (authorization.authorizationSha256 !== expected || authorization.authorizationId !== `m5routeauth:${expected.slice(0, 32).toLowerCase()}`) {
    throw new Error("Routing promotion authorization content address is invalid");
  }
}

export async function verifiedRoutingPromotionProposalToEvidence(
  proposal: RoutingPromotionProposal,
  context: RoutingPromotionContext,
  collectedAt: string,
): Promise<EvidenceRecord> {
  await verifyRoutingPromotionProposal(proposal, context);
  return deepFreeze({
    kind: "deterministic_check" as const,
    status: proposal.payload.classification === "PROMOTION_ELIGIBLE" ? "passed" as const : "failed" as const,
    reference: `routing-promotion-proposal:${proposal.proposalId}`,
    producer: "routing-promotion-contract",
    collectedAt: prepareTimestamp(collectedAt, "Routing promotion proposal evidence collectedAt"),
    metadata: deepFreeze({ projectId: proposal.payload.projectId, routeId: proposal.payload.routeId, capability: proposal.payload.capability, classification: proposal.payload.classification }),
  });
}

export async function verifiedRoutingPromotionAuthorizationToEvidence(
  authorization: RoutingPromotionAuthorization,
  proposal: RoutingPromotionProposal,
  proposalContext: RoutingPromotionContext,
  currentPreconditionSnapshot: RoutingPreconditionSnapshot,
  workflow: WorkflowRun,
  collectedAt: string,
): Promise<EvidenceRecord> {
  await verifyRoutingPromotionAuthorization(authorization, proposal, proposalContext, currentPreconditionSnapshot, workflow);
  return deepFreeze({
    kind: "approval" as const,
    status: authorization.payload.decision === "allow" ? "passed" as const : "failed" as const,
    reference: `routing-promotion-auth:${authorization.authorizationId}`,
    producer: "routing-promotion-contract",
    collectedAt: prepareTimestamp(collectedAt, "Routing promotion authorization evidence collectedAt"),
    metadata: deepFreeze({ proposalId: authorization.payload.proposalId, workflowRunId: authorization.payload.workflowRunId, routeId: authorization.payload.routeId, decision: authorization.payload.decision }),
  });
}

async function verifyPromotionContext(context: RoutingPromotionContext): Promise<DerivedPromotionEvidence> {
  await verifyAuthority(context);
  await verifyRoutingPreconditionSnapshot(context.preconditionSnapshot);
  if (!(context.sideEffectJournal instanceof JsonlBoundedLiveSideEffectJournal)) throw new Error("Routing promotion requires canonical durable bounded-live side-effect journal");
  if (context.preconditionSnapshot.payload.projectId !== context.experiment.payload.projectId || context.preconditionSnapshot.payload.currentSubjectId !== context.experiment.payload.referenceSubjectId) {
    throw new Error("Routing promotion precondition snapshot does not bind exact known-good reference route");
  }
  const reference = await verifyCohort("reference", context.referenceCohort, context);
  const candidate = await verifyCohort("candidate", context.candidateCohort, context);
  const finalProgressSha256 = await verifyFinalProgress(context);
  const journal = await freshJournalSnapshot(context.sideEffectJournal);
  const boundedLiveEvidenceReferences = await verifyBoundedLiveEvidence(context, journal);
  const classification = classifyPromotion(context, journal);
  const reasons = promotionReasons(classification, context, journal);
  await assertJournalUnchanged(context.sideEffectJournal, journal.fingerprintSha256);
  return deepFreeze({
    finalProgressSha256,
    runLedgerEvidenceReferences: deepFreeze([...reference.runLedgerReferences, ...candidate.runLedgerReferences].sort()),
    evalEvidenceReferences: deepFreeze([...reference.evalReferences, ...candidate.evalReferences].sort()),
    boundedLiveEvidenceReferences,
    classification,
    reasons,
  });
}

async function verifyAuthority(context: RoutingPromotionContext): Promise<void> {
  await verifyM5AdmissionDecision(context.admissionDecision);
  await verifyControlledExperimentDefinition(context.experiment, context.admissionDecision);
  await verifyControlledExperimentAuthorization(context.experimentAuthorization, context.experiment, context.admissionDecision, context.experimentWorkflow);
  if (context.admissionDecision.payload.classification !== "ELIGIBLE_FOR_CONTROLLED_EXPERIMENT" || context.admissionDecision.payload.experimentAdmissionEligible !== true) {
    throw new Error("Routing promotion requires eligible M5 admission");
  }
  if (context.experimentAuthorization.payload.decision !== "allow" || context.experimentAuthorization.payload.experimentContractAuthorized !== true) {
    throw new Error("Routing promotion requires allowed controlled experiment");
  }
}

async function verifyFinalProgress(context: RoutingPromotionContext): Promise<string> {
  const p = context.finalProgress;
  if (!p || typeof p !== "object") throw new Error("Routing promotion requires authoritative final ControlledExperimentProgressInput");
  if (
    stableStringify(p.referenceEvalSummary) !== stableStringify(context.referenceCohort.evalSummary) ||
    stableStringify(p.candidateEvalSummary) !== stableStringify(context.candidateCohort.evalSummary) ||
    stableStringify(p.referenceExecutionSummary) !== stableStringify(context.referenceCohort.executionSummary) ||
    stableStringify(p.candidateExecutionSummary) !== stableStringify(context.candidateCohort.executionSummary)
  ) throw new Error("Routing promotion final progress summaries drift from canonical Eval/Run Ledger cohorts");
  await verifyControlledExperimentGuardrailDecision(context.finalGuardrailDecision);
  const rederived = await evaluateControlledExperimentGuardrails({
    experiment: context.experiment,
    authorization: context.experimentAuthorization,
    admissionDecision: context.admissionDecision,
    workflow: context.experimentWorkflow,
    progress: p,
  });
  if (stableStringify(rederived) !== stableStringify(context.finalGuardrailDecision)) throw new Error("Routing promotion final guardrail does not match re-derived authoritative final progress");
  assertAtOrAfter(context.preconditionSnapshot.payload.capturedAt, [context.finalGuardrailDecision.payload.observedAt], "Routing promotion route snapshot predates final guardrail evidence");
  return sha256Canonical(p);
}

async function verifyCohort(
  role: "reference" | "candidate",
  cohort: RoutingPromotionCohortEvidence,
  context: RoutingPromotionContext,
): Promise<{ readonly runLedgerReferences: readonly string[]; readonly evalReferences: readonly string[] }> {
  await verifyEvalCohortSummary(cohort.evalSummary);
  await verifyExecutionReliabilitySummary(cohort.executionSummary);
  if (!cohort.observations.length || !cohort.projections.length || !cohort.runLedgerRecords.length) throw new Error(`Routing promotion ${role} cohort requires canonical Eval and Run Ledger provenance`);
  const rebuiltEval = await buildEvalCohortSummary(cohort.observations);
  if (stableStringify(rebuiltEval) !== stableStringify(cohort.evalSummary)) throw new Error(`Routing promotion ${role} Eval summary does not match canonical observations`);
  const rebuiltExecution = await buildExecutionReliabilitySummary(cohort.observations, cohort.projections, cohort.runLedgerRecords);
  if (stableStringify(rebuiltExecution) !== stableStringify(cohort.executionSummary)) throw new Error(`Routing promotion ${role} execution summary does not match canonical Run Ledger provenance`);
  const a = context.admissionDecision.payload;
  const subject = role === "reference" ? a.referenceSubjectId : a.candidateSubjectId;
  const evalId = role === "reference" ? a.referenceEvalSummaryId : a.candidateEvalSummaryId;
  const executionId = role === "reference" ? a.referenceExecutionSummaryId : a.candidateExecutionSummaryId;
  if (!executionId) throw new Error("Routing promotion requires execution reliability summaries in admission evidence");
  if (
    cohort.evalSummary.summaryId !== evalId || cohort.executionSummary.summaryId !== executionId ||
    cohort.evalSummary.payload.subjectId !== subject || cohort.executionSummary.payload.subjectId !== subject ||
    cohort.evalSummary.payload.suiteId !== a.suiteId || cohort.evalSummary.payload.suiteSha256 !== a.suiteSha256 ||
    cohort.evalSummary.payload.baselineId !== a.baselineId || cohort.executionSummary.payload.suiteId !== a.suiteId ||
    cohort.executionSummary.payload.suiteSha256 !== a.suiteSha256 || cohort.executionSummary.payload.baselineId !== a.baselineId ||
    !sameArray([...cohort.evalSummary.payload.observationIds].sort(), [...cohort.executionSummary.payload.observationIds].sort())
  ) throw new Error(`Routing promotion ${role} canonical Eval/Run Ledger identity drift detected`);
  const runLedgerReferences = deepFreeze((await Promise.all(cohort.runLedgerRecords.map(async (record) => {
    if (record.projectId !== context.experiment.payload.projectId) throw new Error(`Routing promotion ${role} Run Ledger projectId drift detected`);
    const runId = prepareIdentity(record.runId, `Routing promotion ${role} runId`);
    return `${role}:run-ledger:${runId}:${await sha256Canonical(record)}`;
  }))).sort());
  if (new Set(runLedgerReferences).size !== runLedgerReferences.length) throw new Error(`Routing promotion ${role} Run Ledger evidence contains duplicates`);
  const evalReferences = deepFreeze([
    `${role}:eval-summary:${cohort.evalSummary.summaryId}:${cohort.evalSummary.summarySha256}`,
    `${role}:execution-summary:${cohort.executionSummary.summaryId}:${cohort.executionSummary.summarySha256}`,
  ].sort());
  return { runLedgerReferences, evalReferences };
}

async function freshJournalSnapshot(journal: JsonlBoundedLiveSideEffectJournal): Promise<FreshJournalSnapshot> {
  const events = journal.list();
  const expectedRaw = events.map((event, index) => JSON.stringify({
    schemaVersion: BOUNDED_LIVE_SIDE_EFFECT_JOURNAL_SCHEMA_VERSION,
    sequence: index + 1,
    event,
  }) + "\n").join("");
  const raw = existsSync(journal.filePath) ? readFileSync(journal.filePath, "utf8") : "";
  if (raw !== expectedRaw) {
    throw new Error("Routing promotion durable side-effect journal changed outside the supplied reader; reopen and retry from fresh evidence");
  }
  const latest = new Map<string, BoundedLiveSideEffectEvent>();
  for (const event of events) {
    await verifyBoundedLiveSideEffectEvent(event);
    latest.set(event.payload.operationId, event);
  }
  const unresolvedOperationIds = [...latest.entries()]
    .filter(([, event]) => event.payload.eventType !== "operation_committed")
    .map(([operationId]) => operationId)
    .sort();
  return deepFreeze({
    fingerprintSha256: await sha256Text(raw),
    latestByOperation: latest,
    unresolvedOperationIds,
  });
}

async function assertJournalUnchanged(journal: JsonlBoundedLiveSideEffectJournal, fingerprint: string): Promise<void> {
  const raw = existsSync(journal.filePath) ? readFileSync(journal.filePath, "utf8") : "";
  if (await sha256Text(raw) !== fingerprint) throw new Error("Routing promotion durable side-effect journal changed during verification; fresh proof pass required");
}

async function verifyBoundedLiveEvidence(context: RoutingPromotionContext, journal: FreshJournalSnapshot): Promise<readonly string[]> {
  if (!Array.isArray(context.publicationEvidence) || !Array.isArray(context.referenceRestoreEvidence)) throw new Error("Routing promotion bounded-live evidence collections must be arrays");
  if (context.publicationEvidence.length !== context.finalProgress.liveSamples) {
    throw new Error("Routing promotion bounded-live evidence coverage does not match authoritative final liveSamples");
  }
  const ordered = [...context.publicationEvidence].sort((a, b) => a.authorization.payload.liveSamplesBeforeDispatch - b.authorization.payload.liveSamplesBeforeDispatch);
  const refs: string[] = [];
  const sampleIds = new Set<string>();
  const operationIds = new Set<string>();
  let candidateBefore = 0;
  let candidateCount = 0;
  let referenceCount = 0;
  let previousShadow = -1;

  for (let ordinal = 0; ordinal < ordered.length; ordinal += 1) {
    const evidence = ordered[ordinal];
    await verifyBoundedLiveSampleAuthorization(evidence.authorization, {
      experiment: context.experiment,
      experimentAuthorization: context.experimentAuthorization,
      admissionDecision: context.admissionDecision,
      experimentWorkflow: context.experimentWorkflow,
      guardrailDecision: evidence.guardrailDecision,
      liveWorkflow: evidence.liveWorkflow,
      authorization: evidence.authorizationInput,
    });
    await verifyBoundedLiveSideEffectRecoveryReport(evidence.recoveryReport);
    const auth = evidence.authorization.payload;
    const recovery = evidence.recoveryReport.payload;
    const expectedSubject = auth.liveAssignment === "candidate" ? context.experiment.payload.candidateSubjectId : context.experiment.payload.referenceSubjectId;
    if (
      auth.experimentId !== context.experiment.experimentId || auth.experimentSha256 !== context.experiment.experimentSha256 ||
      auth.experimentAuthorizationId !== context.experimentAuthorization.authorizationId ||
      auth.experimentAuthorizationSha256 !== context.experimentAuthorization.authorizationSha256 ||
      auth.experimentWorkflowRunId !== context.experimentWorkflow.id || auth.projectId !== context.experiment.payload.projectId ||
      auth.selectedSubjectId !== expectedSubject
    ) throw new Error("Routing promotion bounded-live authorization is not bound to exact experiment/assignment");
    if (
      auth.liveSamplesBeforeDispatch !== ordinal ||
      auth.candidateLiveSamplesBeforeDispatch !== candidateBefore ||
      auth.shadowSamplesBeforeLive > context.finalProgress.shadowSamples ||
      auth.shadowSamplesBeforeLive < previousShadow
    ) throw new Error("Routing promotion bounded-live authorization counters do not form exact final progress path");
    previousShadow = auth.shadowSamplesBeforeLive;
    if (auth.liveAssignment === "candidate") { candidateCount += 1; candidateBefore += 1; }
    else referenceCount += 1;
    if (sampleIds.has(auth.sampleId) || operationIds.has(recovery.operationId)) throw new Error("Routing promotion bounded-live sample/operation evidence must be unique");
    sampleIds.add(auth.sampleId);
    operationIds.add(recovery.operationId);
    const journalEvent = requireJournalEvent(journal, evidence.recoveryReport);
    assertPublicationRecoveryBinding(evidence.authorization, evidence.recoveryReport, journalEvent);
    refs.push(
      `m5liveauth-ref:${evidence.authorization.authorizationId}:${evidence.authorization.authorizationSha256}`,
      `m5liveeffect-ref:${journalEvent.eventId}:${journalEvent.eventSha256}`,
      `m5liverecovery-ref:${evidence.recoveryReport.reconciliationId}:${evidence.recoveryReport.reconciliationSha256}`,
    );
    if (recovery.classification === "consistent_committed") {
      if (!evidence.receipt) throw new Error("Routing promotion committed live sample requires exact publication receipt");
      await verifyBoundedLivePublicationReceipt(evidence.receipt);
      assertCommittedPublicationBinding(evidence, journalEvent);
      refs.push(`m5livepub-ref:${evidence.receipt.receiptId}:${evidence.receipt.receiptSha256}`);
    } else if (evidence.receipt !== undefined) {
      throw new Error("Routing promotion unresolved live sample must not claim committed receipt");
    }
  }
  const expectedCandidate = context.finalProgress.candidateLiveSamples;
  const expectedReference = context.finalProgress.liveSamples - expectedCandidate;
  if (candidateCount !== expectedCandidate || referenceCount !== expectedReference || candidateBefore !== expectedCandidate) {
    throw new Error("Routing promotion bounded-live candidate/reference evidence coverage does not match authoritative final progress");
  }

  for (const evidence of context.referenceRestoreEvidence) {
    await verifyBoundedLiveRollbackAuthorizationEnvelope(evidence.authorization);
    await verifyBoundedLiveReferenceRestoreReceipt(evidence.receipt);
    await verifyBoundedLiveSideEffectRecoveryReport(evidence.recoveryReport);
    const event = requireJournalEvent(journal, evidence.recoveryReport);
    const a = evidence.authorization.payload;
    const r = evidence.receipt.payload;
    const recovery = evidence.recoveryReport.payload;
    if (
      event.payload.eventType !== "operation_committed" ||
      a.experimentId !== context.experiment.experimentId || a.experimentSha256 !== context.experiment.experimentSha256 ||
      a.experimentAuthorizationId !== context.experimentAuthorization.authorizationId ||
      a.experimentAuthorizationSha256 !== context.experimentAuthorization.authorizationSha256 ||
      a.projectId !== context.experiment.payload.projectId || a.targetSubjectId !== context.experiment.payload.referenceSubjectId ||
      r.rollbackAuthorizationId !== evidence.authorization.authorizationId || r.rollbackAuthorizationSha256 !== evidence.authorization.authorizationSha256 ||
      r.experimentId !== context.experiment.experimentId || r.targetSubjectId !== context.experiment.payload.referenceSubjectId ||
      r.sideEffectCommitEventId !== event.eventId || recovery.kind !== "reference_restore" ||
      recovery.classification !== "consistent_committed" || recovery.authorityId !== evidence.authorization.authorizationId ||
      recovery.subjectId !== context.experiment.payload.referenceSubjectId || recovery.operationId !== r.sideEffectOperationId ||
      recovery.idempotencyKey !== r.restoreIdempotencyKey || recovery.sinkId !== r.sinkId || recovery.externalReference !== r.restoreReference
    ) throw new Error("Routing promotion reference restore evidence is not bound to exact durable experiment/operation state");
    if (operationIds.has(recovery.operationId)) throw new Error("Routing promotion bounded-live operation evidence must be unique");
    operationIds.add(recovery.operationId);
    refs.push(
      `m5rollbackauth-ref:${evidence.authorization.authorizationId}:${evidence.authorization.authorizationSha256}`,
      `m5restore-ref:${evidence.receipt.receiptId}:${evidence.receipt.receiptSha256}`,
      `m5liveeffect-ref:${event.eventId}:${event.eventSha256}`,
      `m5liverecovery-ref:${evidence.recoveryReport.reconciliationId}:${evidence.recoveryReport.reconciliationSha256}`,
    );
  }
  return normalizeSet(refs, "Routing promotion bounded-live evidence reference", false);
}

function requireJournalEvent(journal: FreshJournalSnapshot, report: BoundedLiveSideEffectRecoveryReport): BoundedLiveSideEffectEvent {
  const recovery = report.payload;
  const event = journal.latestByOperation.get(recovery.operationId);
  if (!event) throw new Error("Routing promotion recovery evidence has no canonical durable side-effect journal event");
  const p = event.payload;
  if (
    event.eventId !== recovery.journalEventId || p.eventType !== recovery.journalEventType || p.kind !== recovery.kind ||
    p.operationId !== recovery.operationId || p.idempotencyKey !== recovery.idempotencyKey || p.sinkId !== recovery.sinkId ||
    p.authorityId !== recovery.authorityId || p.subjectId !== recovery.subjectId || p.sampleId !== recovery.sampleId ||
    normalizeSha(p.outputSha256) !== normalizeSha(recovery.outputSha256)
  ) throw new Error("Routing promotion recovery report drifts from canonical durable side-effect journal event");
  if (p.eventType === "operation_committed") {
    if (recovery.classification !== "consistent_committed" || recovery.explicitOperatorActionRequired !== false || recovery.externalReference !== p.externalReference) {
      throw new Error("Routing promotion committed journal state does not match recovery report");
    }
  } else if (recovery.classification === "consistent_committed") {
    throw new Error("Routing promotion consistent_committed recovery requires durable operation_committed journal state");
  }
  return event;
}

function assertPublicationRecoveryBinding(
  authorization: BoundedLiveSampleAuthorization,
  report: BoundedLiveSideEffectRecoveryReport,
  event: BoundedLiveSideEffectEvent,
): void {
  const a = authorization.payload;
  const r = report.payload;
  const prefix = `publication:${authorization.authorizationId}:`;
  if (
    r.kind !== "publication" || r.authorityId !== authorization.authorizationId || r.subjectId !== a.selectedSubjectId ||
    r.sampleId !== a.sampleId || normalizeSha(r.outputSha256) === undefined || !r.operationId.startsWith(prefix) ||
    event.payload.operationId !== r.operationId
  ) throw new Error("Routing promotion recovery report is not bound to exact live publication authority/sample");
  const runtimeResultId = r.operationId.slice(prefix.length);
  if (!runtimeResultId || r.idempotencyKey !== `${authorization.authorizationId}:${runtimeResultId}`) throw new Error("Routing promotion publication operation/idempotency identity is invalid");
}

function assertCommittedPublicationBinding(evidence: RoutingPromotionBoundedLivePublicationEvidence, event: BoundedLiveSideEffectEvent): void {
  if (!evidence.receipt || event.payload.eventType !== "operation_committed") throw new Error("Routing promotion committed publication durable evidence is missing");
  const a = evidence.authorization.payload;
  const p = evidence.receipt.payload;
  const r = evidence.recoveryReport.payload;
  if (
    p.sampleAuthorizationId !== evidence.authorization.authorizationId || p.sampleAuthorizationSha256 !== evidence.authorization.authorizationSha256 ||
    p.sampleId !== a.sampleId || p.selectedSubjectId !== a.selectedSubjectId || p.selectedRole !== a.liveAssignment ||
    p.candidateOutputExternallyVisible !== (a.liveAssignment === "candidate") ||
    p.sideEffectCommitEventId !== event.eventId || r.journalEventId !== event.eventId ||
    r.operationId !== p.sideEffectOperationId || r.idempotencyKey !== p.publicationIdempotencyKey || r.sinkId !== p.sinkId ||
    normalizeSha(r.outputSha256) !== normalizeSha(p.outputSha256) || r.externalReference !== p.publicationReference ||
    event.payload.externalReference !== p.publicationReference
  ) throw new Error("Routing promotion recovery/receipt is not bound to exact durable publication authority/operation");
}

function classifyPromotion(context: RoutingPromotionContext, journal: FreshJournalSnapshot): RoutingPromotionClassification {
  const recoveries = [...context.publicationEvidence.map((x) => x.recoveryReport), ...context.referenceRestoreEvidence.map((x) => x.recoveryReport)];
  if (journal.unresolvedOperationIds.length > 0 || recoveries.some((r) => r.payload.classification !== "consistent_committed" || r.payload.explicitOperatorActionRequired !== false)) {
    return "MANUAL_RECONCILIATION_REQUIRED";
  }
  if (context.finalGuardrailDecision.payload.classification !== "COMPLETE") return "PROMOTION_NOT_ELIGIBLE";
  if (context.referenceRestoreEvidence.length > 0) return "PROMOTION_NOT_ELIGIBLE";
  if (context.finalProgress.candidateLiveSamples === 0) return "PROMOTION_NOT_ELIGIBLE";
  if (!context.publicationEvidence.some((x) => x.authorization.payload.liveAssignment === "candidate" && x.receipt !== undefined)) return "PROMOTION_NOT_ELIGIBLE";
  return "PROMOTION_ELIGIBLE";
}

function promotionReasons(classification: RoutingPromotionClassification, context: RoutingPromotionContext, journal: FreshJournalSnapshot): readonly string[] {
  const reasons: string[] = [];
  const recoveries = [...context.publicationEvidence.map((x) => x.recoveryReport), ...context.referenceRestoreEvidence.map((x) => x.recoveryReport)];
  if (journal.unresolvedOperationIds.length > 0 || recoveries.some((r) => r.payload.classification !== "consistent_committed" || r.payload.explicitOperatorActionRequired !== false)) reasons.push("bounded_live_side_effect_not_durably_reconciled");
  if (context.finalGuardrailDecision.payload.classification !== "COMPLETE") reasons.push("controlled_experiment_not_complete");
  if (context.referenceRestoreEvidence.length > 0) reasons.push("reference_restore_observed");
  if (context.finalProgress.candidateLiveSamples === 0 || !context.publicationEvidence.some((x) => x.authorization.payload.liveAssignment === "candidate" && x.receipt !== undefined)) reasons.push("candidate_publication_commit_missing");
  if (classification === "PROMOTION_ELIGIBLE") reasons.push("canonical_evidence_chain_complete_and_reconciled");
  return deepFreeze([...new Set(reasons)].sort());
}

function validateProposalPayload(p: RoutingPromotionProposalPayload): void {
  for (const [v, label] of [
    [p.projectId, "projectId"], [p.routeId, "routeId"], [p.referenceSubjectId, "referenceSubjectId"], [p.candidateSubjectId, "candidateSubjectId"],
    [p.admissionDecisionId, "admissionDecisionId"], [p.admissionDecisionSha256, "admissionDecisionSha256"], [p.experimentId, "experimentId"], [p.experimentSha256, "experimentSha256"],
    [p.experimentAuthorizationId, "experimentAuthorizationId"], [p.experimentAuthorizationSha256, "experimentAuthorizationSha256"], [p.experimentWorkflowRunId, "experimentWorkflowRunId"],
    [p.finalProgressSha256, "finalProgressSha256"], [p.finalGuardrailDecisionId, "finalGuardrailDecisionId"], [p.finalGuardrailDecisionSha256, "finalGuardrailDecisionSha256"],
    [p.preconditionSnapshotId, "preconditionSnapshotId"], [p.preconditionSnapshotSha256, "preconditionSnapshotSha256"], [p.routeRevision, "routeRevision"],
    [p.beforeSubjectId, "beforeSubjectId"], [p.afterSubjectId, "afterSubjectId"], [p.rollbackTargetSubjectId, "rollbackTargetSubjectId"],
  ] as const) prepareIdentity(v, `Routing promotion ${label}`);
  prepareCapability(p.capability);
  if (p.referenceSubjectId === p.candidateSubjectId || p.beforeSubjectId !== p.referenceSubjectId || p.afterSubjectId !== p.candidateSubjectId || p.rollbackTargetSubjectId !== p.referenceSubjectId) {
    throw new Error("Routing promotion before/after/rollback intent is invalid");
  }
  prepareTimestamp(p.proposedAt, "Routing promotion proposedAt");
  for (const [values, label, required] of [
    [p.runLedgerEvidenceReferences, "Run Ledger evidence reference", true], [p.evalEvidenceReferences, "Eval evidence reference", true],
    [p.boundedLiveEvidenceReferences, "bounded-live evidence reference", false], [p.policyReferences, "policy reference", true], [p.reasons, "reason", true],
  ] as const) if (!sameArray(normalizeSet(values, `Routing promotion ${label}`, required), values)) throw new Error(`Routing promotion ${label}s are not canonical`);
  if (!["PROMOTION_NOT_ELIGIBLE", "PROMOTION_ELIGIBLE", "MANUAL_RECONCILIATION_REQUIRED"].includes(p.classification)) throw new Error("Routing promotion classification is invalid");
  if (p.automaticRoutingMutationAllowed !== false || p.automaticRollbackAllowed !== false || p.automaticRetryAllowed !== false || p.automaticRedispatchAllowed !== false) throw new Error("Routing promotion proposal cannot grant automatic authority");
}

function validateAuthorizationPayload(p: RoutingPromotionAuthorizationPayload): void {
  if (p.decision !== "allow" && p.decision !== "deny") throw new Error("Routing promotion authorization decision is invalid");
  for (const [v, label] of [
    [p.actor, "actor"], [p.proposalId, "proposalId"], [p.proposalSha256, "proposalSha256"], [p.projectId, "projectId"], [p.routeId, "routeId"],
    [p.referenceSubjectId, "referenceSubjectId"], [p.candidateSubjectId, "candidateSubjectId"], [p.preconditionSnapshotId, "preconditionSnapshotId"],
    [p.preconditionSnapshotSha256, "preconditionSnapshotSha256"], [p.routeRevision, "routeRevision"], [p.workflowRunId, "workflowRunId"],
  ] as const) prepareIdentity(v, `Routing promotion authorization ${label}`);
  prepareCapability(p.capability);
  prepareTimestamp(p.decidedAt, "Routing promotion authorization decidedAt");
  if (!sameArray(normalizeSet(p.policyReferences, "Routing promotion authorization policy reference", true), p.policyReferences) ||
      !sameArray(normalizeSet(p.approvalIds, "Routing promotion authorization approvalId", p.decision === "allow"), p.approvalIds)) throw new Error("Routing promotion authorization references are not canonical");
  if (p.riskClass !== "R3" && p.riskClass !== "R4") throw new Error("Routing promotion authorization requires riskClass R3 or R4");
  if (p.routingMutationAuthorized !== (p.decision === "allow") || p.automaticRoutingMutationAllowed !== false || p.automaticRollbackAllowed !== false || p.automaticRetryAllowed !== false || p.automaticRedispatchAllowed !== false) throw new Error("Routing promotion authorization authority flags are invalid");
}

function assertFreshRoute(proposal: RoutingPromotionProposal, current: RoutingPreconditionSnapshot): void {
  if (current.snapshotId !== proposal.payload.preconditionSnapshotId || current.snapshotSha256 !== proposal.payload.preconditionSnapshotSha256 || current.payload.projectId !== proposal.payload.projectId || current.payload.routeId !== proposal.payload.routeId || current.payload.capability !== proposal.payload.capability || current.payload.currentSubjectId !== proposal.payload.referenceSubjectId || current.payload.routeRevision !== proposal.payload.routeRevision) {
    throw new Error("Routing promotion precondition snapshot is stale or route state drifted");
  }
}

function assertPromotionWorkflow(workflow: WorkflowRun, proposal: RoutingPromotionProposal, experimentWorkflowId: string): void {
  if (workflow.id === experimentWorkflowId) throw new Error("Routing promotion requires a separate workflow from experiment authorization");
  if (workflow.projectId !== proposal.payload.projectId) throw new Error("Routing promotion workflow projectId does not match proposal");
  if (workflow.riskClass !== "R3" && workflow.riskClass !== "R4") throw new Error("Routing promotion workflow requires riskClass R3 or R4");
  if (workflow.phase !== "publish") throw new Error("Routing promotion authorization requires workflow phase=publish after durable approval");
  prepareTimestamp(workflow.updatedAt, "Routing promotion workflow updatedAt");
}

function prepareCapability(value: CapabilityId): CapabilityId {
  if (!(FROZEN_CAPABILITIES as readonly string[]).includes(value)) throw new Error("Routing promotion capability is not in frozen capability taxonomy");
  return value;
}

function normalizeSet(values: readonly string[], label: string, nonEmpty: boolean): readonly string[] {
  if (!Array.isArray(values)) throw new Error(`${label}s must be an array`);
  const normalized = [...new Set(values.map((v) => prepareIdentity(v, label)))].sort();
  if (normalized.length !== values.length) throw new Error(`${label}s must not contain duplicates`);
  if (nonEmpty && normalized.length === 0) throw new Error(`${label}s must not be empty`);
  return deepFreeze(normalized);
}

function prepareIdentity(value: string, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must not be empty`);
  if (value !== value.trim() || /\r|\n/.test(value)) throw new Error(`${label} must be canonical single-line text`);
  if (new TextEncoder().encode(value).byteLength > 2048) throw new Error(`${label} exceeds 2048 bytes`);
  if (sanitizeText(value) !== value) throw new Error(`${label} contains secret-like material`);
  return value;
}

function prepareTimestamp(value: string, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`${label} must be a valid timestamp`);
  const normalized = new Date(value).toISOString();
  if (normalized !== value) throw new Error(`${label} must use canonical ISO-8601 UTC form`);
  return normalized;
}

function assertAtOrAfter(value: string, bounds: readonly string[], message: string): void {
  if (bounds.some((bound) => Date.parse(value) < Date.parse(bound))) throw new Error(message);
}

function assertExactFields(value: Record<string, unknown>, fields: ReadonlySet<string>, label: string): void {
  const keys = Object.keys(value);
  for (const key of keys) if (!fields.has(key)) throw new Error(`${label}.${key} is not allowed`);
  for (const field of fields) if (!keys.includes(field)) throw new Error(`${label}.${field} is required`);
}

function sameArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function normalizeSha(value: string | undefined): string | undefined { return value?.toUpperCase(); }

function sanitizeText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [redacted]")
    .replace(/(authorization|api[_-]?key|access[_-]?token|password|secret|credential|cookie)\s*[:=]\s*(Bearer\s+)?[^\s,;]+/gi, "$1=[redacted]")
    .replace(/\b(?:ghp_|github_pat_|sk-(?:proj-)?|sb_secret_)[A-Za-z0-9_-]{16,}\b/g, "[redacted]");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function sha256Text(value: string): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("Web Crypto SHA-256 is unavailable in this runtime");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

async function sha256Canonical(value: unknown): Promise<string> { return sha256Text(stableStringify(value)); }

function stableStringify(value: unknown): string { return JSON.stringify(sortJson(value)); }

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => [key, sortJson(child)]));
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}
