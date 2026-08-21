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
import {
  buildEvalCohortSummary,
  verifyEvalCohortSummary,
} from "./comparative-statistics.js";
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
import type { ControlledExperimentGuardrailDecision } from "./controlled-experiment-guardrails.js";
import { verifyControlledExperimentGuardrailDecision } from "./controlled-experiment-guardrails.js";
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
  readonly receipt: BoundedLivePublicationReceipt;
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
  readonly finalGuardrailDecision: ControlledExperimentGuardrailDecision;
  readonly preconditionSnapshot: RoutingPreconditionSnapshot;
  readonly referenceCohort: RoutingPromotionCohortEvidence;
  readonly candidateCohort: RoutingPromotionCohortEvidence;
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

const SNAPSHOT_INPUT_FIELDS = new Set([
  "projectId",
  "routeId",
  "capability",
  "currentSubjectId",
  "routeRevision",
  "capturedAt",
  "policyReferences",
]);
const SNAPSHOT_ENVELOPE_FIELDS = new Set([
  "schemaVersion",
  "algorithm",
  "snapshotId",
  "snapshotSha256",
  "payload",
]);
const SNAPSHOT_PAYLOAD_FIELDS = new Set([
  ...SNAPSHOT_INPUT_FIELDS,
  "providerSpecificStatePersisted",
  "rawProviderOutputPersisted",
]);
const PROPOSAL_INPUT_FIELDS = new Set([
  "routeId",
  "capability",
  "proposedAt",
  "policyReferences",
]);
const PROPOSAL_ENVELOPE_FIELDS = new Set([
  "schemaVersion",
  "algorithm",
  "proposalId",
  "proposalSha256",
  "payload",
]);
const PROPOSAL_PAYLOAD_FIELDS = new Set([
  "projectId",
  "routeId",
  "capability",
  "referenceSubjectId",
  "candidateSubjectId",
  "admissionDecisionId",
  "admissionDecisionSha256",
  "experimentId",
  "experimentSha256",
  "experimentAuthorizationId",
  "experimentAuthorizationSha256",
  "experimentWorkflowRunId",
  "finalGuardrailDecisionId",
  "finalGuardrailDecisionSha256",
  "preconditionSnapshotId",
  "preconditionSnapshotSha256",
  "routeRevision",
  "beforeSubjectId",
  "afterSubjectId",
  "rollbackTargetSubjectId",
  "runLedgerEvidenceReferences",
  "evalEvidenceReferences",
  "boundedLiveEvidenceReferences",
  "proposedAt",
  "policyReferences",
  "classification",
  "reasons",
  "automaticRoutingMutationAllowed",
  "automaticRollbackAllowed",
  "automaticRetryAllowed",
  "automaticRedispatchAllowed",
]);
const AUTH_INPUT_FIELDS = new Set([
  "decision",
  "actor",
  "decidedAt",
  "policyReferences",
  "approvalIds",
]);
const AUTH_ENVELOPE_FIELDS = new Set([
  "schemaVersion",
  "algorithm",
  "authorizationId",
  "authorizationSha256",
  "payload",
]);
const AUTH_PAYLOAD_FIELDS = new Set([
  ...AUTH_INPUT_FIELDS,
  "proposalId",
  "proposalSha256",
  "projectId",
  "routeId",
  "capability",
  "referenceSubjectId",
  "candidateSubjectId",
  "preconditionSnapshotId",
  "preconditionSnapshotSha256",
  "routeRevision",
  "workflowRunId",
  "riskClass",
  "routingMutationAuthorized",
  "automaticRoutingMutationAllowed",
  "automaticRollbackAllowed",
  "automaticRetryAllowed",
  "automaticRedispatchAllowed",
]);

export async function prepareRoutingPreconditionSnapshot(
  input: RoutingPreconditionSnapshotInput,
): Promise<RoutingPreconditionSnapshot> {
  assertExactFields(
    input as unknown as Record<string, unknown>,
    SNAPSHOT_INPUT_FIELDS,
    "Routing precondition snapshot input",
  );
  const payload: RoutingPreconditionSnapshotPayload = deepFreeze({
    projectId: prepareIdentity(input.projectId, "Routing precondition projectId"),
    routeId: prepareIdentity(input.routeId, "Routing precondition routeId"),
    capability: prepareCapability(input.capability),
    currentSubjectId: prepareIdentity(
      input.currentSubjectId,
      "Routing precondition currentSubjectId",
    ),
    routeRevision: prepareSafeReference(
      input.routeRevision,
      "Routing precondition routeRevision",
    ),
    capturedAt: prepareTimestamp(
      input.capturedAt,
      "Routing precondition capturedAt",
    ),
    policyReferences: normalizeSafeSet(
      input.policyReferences,
      "Routing precondition policy reference",
      true,
    ),
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

export async function verifyRoutingPreconditionSnapshot(
  snapshot: RoutingPreconditionSnapshot,
): Promise<void> {
  if (!isRecord(snapshot)) throw new Error("Routing precondition snapshot must be an object");
  assertExactFields(snapshot, SNAPSHOT_ENVELOPE_FIELDS, "Routing precondition snapshot");
  if (
    snapshot.schemaVersion !== ROUTING_PRECONDITION_SNAPSHOT_SCHEMA_VERSION ||
    snapshot.algorithm !== "sha256"
  ) {
    throw new Error("Routing precondition snapshot envelope is invalid");
  }
  if (!isRecord(snapshot.payload)) throw new Error("Routing precondition snapshot payload must be an object");
  assertExactFields(snapshot.payload, SNAPSHOT_PAYLOAD_FIELDS, "Routing precondition snapshot payload");
  validateSnapshotPayload(snapshot.payload as unknown as RoutingPreconditionSnapshotPayload);
  const expected = await sha256Canonical(snapshot.payload);
  if (snapshot.snapshotSha256 !== expected) {
    throw new Error("Routing precondition snapshot digest does not match canonical payload");
  }
  if (snapshot.snapshotId !== `m5routesnap:${expected.slice(0, 32).toLowerCase()}`) {
    throw new Error("Routing precondition snapshotId does not match canonical payload");
  }
}

export async function prepareRoutingPromotionProposal(input: {
  readonly context: RoutingPromotionContext;
  readonly proposal: RoutingPromotionProposalInput;
}): Promise<RoutingPromotionProposal> {
  const { context, proposal } = input;
  const derived = await verifyPromotionContext(context);
  assertExactFields(
    proposal as unknown as Record<string, unknown>,
    PROPOSAL_INPUT_FIELDS,
    "Routing promotion proposal input",
  );
  const routeId = prepareIdentity(proposal.routeId, "Routing promotion routeId");
  const capability = prepareCapability(proposal.capability);
  if (routeId !== context.preconditionSnapshot.payload.routeId) {
    throw new Error("Routing promotion routeId does not match precondition snapshot");
  }
  if (capability !== context.preconditionSnapshot.payload.capability) {
    throw new Error("Routing promotion capability does not match precondition snapshot");
  }
  const proposedAt = prepareTimestamp(proposal.proposedAt, "Routing promotion proposedAt");
  if (
    Date.parse(proposedAt) < Date.parse(context.finalGuardrailDecision.payload.observedAt) ||
    Date.parse(proposedAt) < Date.parse(context.preconditionSnapshot.payload.capturedAt)
  ) {
    throw new Error("Routing promotion proposal cannot predate final evidence or route snapshot");
  }
  const policyReferences = normalizeSafeSet(
    proposal.policyReferences,
    "Routing promotion policy reference",
    true,
  );
  const classification = classifyPromotion(context);
  const reasons = promotionReasons(classification, context);
  const experiment = context.experiment;
  const payload: RoutingPromotionProposalPayload = deepFreeze({
    projectId: experiment.payload.projectId,
    routeId,
    capability,
    referenceSubjectId: experiment.payload.referenceSubjectId,
    candidateSubjectId: experiment.payload.candidateSubjectId,
    admissionDecisionId: context.admissionDecision.decisionId,
    admissionDecisionSha256: context.admissionDecision.decisionSha256,
    experimentId: experiment.experimentId,
    experimentSha256: experiment.experimentSha256,
    experimentAuthorizationId: context.experimentAuthorization.authorizationId,
    experimentAuthorizationSha256: context.experimentAuthorization.authorizationSha256,
    experimentWorkflowRunId: context.experimentWorkflow.id,
    finalGuardrailDecisionId: context.finalGuardrailDecision.decisionId,
    finalGuardrailDecisionSha256: context.finalGuardrailDecision.decisionSha256,
    preconditionSnapshotId: context.preconditionSnapshot.snapshotId,
    preconditionSnapshotSha256: context.preconditionSnapshot.snapshotSha256,
    routeRevision: context.preconditionSnapshot.payload.routeRevision,
    beforeSubjectId: experiment.payload.referenceSubjectId,
    afterSubjectId: experiment.payload.candidateSubjectId,
    rollbackTargetSubjectId: experiment.payload.referenceSubjectId,
    runLedgerEvidenceReferences: derived.runLedgerEvidenceReferences,
    evalEvidenceReferences: derived.evalEvidenceReferences,
    boundedLiveEvidenceReferences: derived.boundedLiveEvidenceReferences,
    proposedAt,
    policyReferences,
    classification,
    reasons,
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
  if (
    proposal.schemaVersion !== ROUTING_PROMOTION_PROPOSAL_SCHEMA_VERSION ||
    proposal.algorithm !== "sha256"
  ) {
    throw new Error("Routing promotion proposal envelope is invalid");
  }
  if (!isRecord(proposal.payload)) throw new Error("Routing promotion proposal payload must be an object");
  assertExactFields(proposal.payload, PROPOSAL_PAYLOAD_FIELDS, "Routing promotion proposal payload");
  const payload = proposal.payload as unknown as RoutingPromotionProposalPayload;
  validateProposalPayload(payload);
  assertProposalMatchesContext(payload, context, derived);
  const expected = await sha256Canonical(payload);
  if (proposal.proposalSha256 !== expected) {
    throw new Error("Routing promotion proposal digest does not match canonical payload");
  }
  if (proposal.proposalId !== `m5routeproposal:${expected.slice(0, 32).toLowerCase()}`) {
    throw new Error("Routing promotion proposalId does not match canonical payload");
  }
}

export async function prepareRoutingPromotionAuthorization(input: {
  readonly proposal: RoutingPromotionProposal;
  readonly proposalContext: RoutingPromotionContext;
  readonly currentPreconditionSnapshot: RoutingPreconditionSnapshot;
  readonly workflow: WorkflowRun;
  readonly authorization: RoutingPromotionAuthorizationInput;
}): Promise<RoutingPromotionAuthorization> {
  const {
    proposal,
    proposalContext,
    currentPreconditionSnapshot,
    workflow,
    authorization,
  } = input;
  await verifyRoutingPromotionProposal(proposal, proposalContext);
  await verifyRoutingPreconditionSnapshot(currentPreconditionSnapshot);
  assertFreshSnapshot(proposal, currentPreconditionSnapshot);
  assertPromotionWorkflow(workflow, proposal, proposalContext.experimentWorkflow.id);
  assertExactFields(
    authorization as unknown as Record<string, unknown>,
    AUTH_INPUT_FIELDS,
    "Routing promotion authorization input",
  );
  if (authorization.decision !== "allow" && authorization.decision !== "deny") {
    throw new Error("Routing promotion authorization decision is invalid");
  }
  if (
    authorization.decision === "allow" &&
    proposal.payload.classification !== "PROMOTION_ELIGIBLE"
  ) {
    throw new Error("Routing promotion allow authorization requires an eligible proposal");
  }
  const actor = prepareIdentity(authorization.actor, "Routing promotion authorization actor");
  const decidedAt = prepareTimestamp(
    authorization.decidedAt,
    "Routing promotion authorization decidedAt",
  );
  if (
    Date.parse(decidedAt) < Date.parse(proposal.payload.proposedAt) ||
    Date.parse(decidedAt) < Date.parse(workflow.updatedAt)
  ) {
    throw new Error("Routing promotion authorization cannot predate proposal or durable workflow state");
  }
  const policyReferences = normalizeSafeSet(
    authorization.policyReferences,
    "Routing promotion authorization policy reference",
    true,
  );
  const approvalIds = normalizeSafeSet(
    authorization.approvalIds,
    "Routing promotion authorization approvalId",
    authorization.decision === "allow",
  );
  const durableApprovals = normalizeSafeSet(
    workflow.approvalIds,
    "Routing promotion durable workflow approvalId",
    authorization.decision === "allow",
  );
  if (!sameArray(approvalIds, durableApprovals)) {
    throw new Error("Routing promotion authorization approvalIds do not match durable WorkflowRun approvals");
  }
  if (authorization.decision === "allow" && workflow.status !== "running") {
    throw new Error("Routing promotion allow authorization requires an active workflow");
  }
  const payload: RoutingPromotionAuthorizationPayload = deepFreeze({
    decision: authorization.decision,
    actor,
    decidedAt,
    policyReferences,
    approvalIds,
    proposalId: proposal.proposalId,
    proposalSha256: proposal.proposalSha256,
    projectId: proposal.payload.projectId,
    routeId: proposal.payload.routeId,
    capability: proposal.payload.capability,
    referenceSubjectId: proposal.payload.referenceSubjectId,
    candidateSubjectId: proposal.payload.candidateSubjectId,
    preconditionSnapshotId: currentPreconditionSnapshot.snapshotId,
    preconditionSnapshotSha256: currentPreconditionSnapshot.snapshotSha256,
    routeRevision: currentPreconditionSnapshot.payload.routeRevision,
    workflowRunId: workflow.id,
    riskClass: workflow.riskClass as "R3" | "R4",
    routingMutationAuthorized: authorization.decision === "allow",
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
  assertFreshSnapshot(proposal, currentPreconditionSnapshot);
  assertPromotionWorkflow(workflow, proposal, proposalContext.experimentWorkflow.id);
  if (!isRecord(authorization)) throw new Error("Routing promotion authorization must be an object");
  assertExactFields(authorization, AUTH_ENVELOPE_FIELDS, "Routing promotion authorization");
  if (
    authorization.schemaVersion !== ROUTING_PROMOTION_AUTHORIZATION_SCHEMA_VERSION ||
    authorization.algorithm !== "sha256"
  ) {
    throw new Error("Routing promotion authorization envelope is invalid");
  }
  if (!isRecord(authorization.payload)) throw new Error("Routing promotion authorization payload must be an object");
  assertExactFields(authorization.payload, AUTH_PAYLOAD_FIELDS, "Routing promotion authorization payload");
  const payload = authorization.payload as unknown as RoutingPromotionAuthorizationPayload;
  validateAuthorizationPayload(payload);
  if (
    payload.proposalId !== proposal.proposalId ||
    payload.proposalSha256 !== proposal.proposalSha256
  ) {
    throw new Error("Routing promotion authorization does not match exact proposal");
  }
  if (
    payload.projectId !== proposal.payload.projectId ||
    payload.routeId !== proposal.payload.routeId ||
    payload.capability !== proposal.payload.capability ||
    payload.referenceSubjectId !== proposal.payload.referenceSubjectId ||
    payload.candidateSubjectId !== proposal.payload.candidateSubjectId
  ) {
    throw new Error("Routing promotion authorization scope drift detected");
  }
  if (
    payload.preconditionSnapshotId !== currentPreconditionSnapshot.snapshotId ||
    payload.preconditionSnapshotSha256 !== currentPreconditionSnapshot.snapshotSha256 ||
    payload.routeRevision !== currentPreconditionSnapshot.payload.routeRevision
  ) {
    throw new Error("Routing promotion authorization precondition snapshot drift detected");
  }
  if (payload.workflowRunId !== workflow.id || payload.riskClass !== workflow.riskClass) {
    throw new Error("Routing promotion authorization workflow identity drift detected");
  }
  const approvalIds = normalizeSafeSet(
    payload.approvalIds,
    "Routing promotion authorization approvalId",
    payload.decision === "allow",
  );
  const durableApprovals = normalizeSafeSet(
    workflow.approvalIds,
    "Routing promotion durable workflow approvalId",
    payload.decision === "allow",
  );
  if (!sameArray(approvalIds, payload.approvalIds) || !sameArray(approvalIds, durableApprovals)) {
    throw new Error("Routing promotion authorization approvals drift from durable WorkflowRun approvals");
  }
  if (payload.routingMutationAuthorized !== (payload.decision === "allow")) {
    throw new Error("Routing promotion authorization decision flag mismatch");
  }
  if (
    payload.decision === "allow" &&
    proposal.payload.classification !== "PROMOTION_ELIGIBLE"
  ) {
    throw new Error("Routing promotion authorization cannot allow an ineligible proposal");
  }
  if (payload.decision === "allow" && workflow.status !== "running") {
    throw new Error("Routing promotion allow authorization requires an active workflow");
  }
  if (
    Date.parse(payload.decidedAt) < Date.parse(proposal.payload.proposedAt) ||
    Date.parse(payload.decidedAt) < Date.parse(workflow.updatedAt)
  ) {
    throw new Error("Routing promotion authorization predates proposal or durable workflow state");
  }
  const expected = await sha256Canonical(payload);
  if (authorization.authorizationSha256 !== expected) {
    throw new Error("Routing promotion authorization digest does not match canonical payload");
  }
  if (authorization.authorizationId !== `m5routeauth:${expected.slice(0, 32).toLowerCase()}`) {
    throw new Error("Routing promotion authorizationId does not match canonical payload");
  }
}

export async function verifiedRoutingPromotionProposalToEvidence(
  proposal: RoutingPromotionProposal,
  context: RoutingPromotionContext,
  collectedAt: string,
): Promise<EvidenceRecord> {
  await verifyRoutingPromotionProposal(proposal, context);
  const normalizedCollectedAt = prepareTimestamp(
    collectedAt,
    "Routing promotion proposal evidence collectedAt",
  );
  return deepFreeze({
    kind: "deterministic_check" as const,
    status:
      proposal.payload.classification === "PROMOTION_ELIGIBLE"
        ? ("passed" as const)
        : ("failed" as const),
    reference: `routing-promotion-proposal:${proposal.proposalId}`,
    producer: "routing-promotion-contract",
    collectedAt: normalizedCollectedAt,
    metadata: deepFreeze({
      projectId: proposal.payload.projectId,
      routeId: proposal.payload.routeId,
      capability: proposal.payload.capability,
      classification: proposal.payload.classification,
    }),
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
  await verifyRoutingPromotionAuthorization(
    authorization,
    proposal,
    proposalContext,
    currentPreconditionSnapshot,
    workflow,
  );
  const normalizedCollectedAt = prepareTimestamp(
    collectedAt,
    "Routing promotion authorization evidence collectedAt",
  );
  return deepFreeze({
    kind: "approval" as const,
    status:
      authorization.payload.decision === "allow"
        ? ("passed" as const)
        : ("failed" as const),
    reference: `routing-promotion-authorization:${authorization.authorizationId}`,
    producer: "routing-promotion-contract",
    collectedAt: normalizedCollectedAt,
    metadata: deepFreeze({
      proposalId: authorization.payload.proposalId,
      workflowRunId: authorization.payload.workflowRunId,
      routeId: authorization.payload.routeId,
      decision: authorization.payload.decision,
    }),
  });
}

async function verifyPromotionContext(context: RoutingPromotionContext): Promise<{
  readonly runLedgerEvidenceReferences: readonly string[];
  readonly evalEvidenceReferences: readonly string[];
  readonly boundedLiveEvidenceReferences: readonly string[];
}> {
  await verifyAuthorityChain(context);
  await verifyRoutingPreconditionSnapshot(context.preconditionSnapshot);
  await verifyControlledExperimentGuardrailDecision(context.finalGuardrailDecision);
  assertFinalGuardrailBinding(context);
  if (
    context.preconditionSnapshot.payload.projectId !== context.experiment.payload.projectId ||
    context.preconditionSnapshot.payload.currentSubjectId !== context.experiment.payload.referenceSubjectId
  ) {
    throw new Error("Routing promotion precondition snapshot does not bind the exact known-good reference route");
  }
  if (
    Date.parse(context.preconditionSnapshot.payload.capturedAt) <
    Date.parse(context.finalGuardrailDecision.payload.observedAt)
  ) {
    throw new Error("Routing promotion route snapshot cannot predate final guardrail evidence");
  }

  const reference = await verifyCohortEvidence(
    "reference",
    context.referenceCohort,
    context,
  );
  const candidate = await verifyCohortEvidence(
    "candidate",
    context.candidateCohort,
    context,
  );
  const boundedLiveEvidenceReferences = await verifyBoundedLiveEvidence(context);

  return deepFreeze({
    runLedgerEvidenceReferences: deepFreeze(
      [...reference.runLedgerReferences, ...candidate.runLedgerReferences].sort(),
    ),
    evalEvidenceReferences: deepFreeze(
      [...reference.evalReferences, ...candidate.evalReferences].sort(),
    ),
    boundedLiveEvidenceReferences,
  });
}

async function verifyAuthorityChain(context: RoutingPromotionContext): Promise<void> {
  await verifyM5AdmissionDecision(context.admissionDecision);
  await verifyControlledExperimentDefinition(
    context.experiment,
    context.admissionDecision,
  );
  await verifyControlledExperimentAuthorization(
    context.experimentAuthorization,
    context.experiment,
    context.admissionDecision,
    context.experimentWorkflow,
  );
  if (
    context.admissionDecision.payload.classification !== "ELIGIBLE_FOR_CONTROLLED_EXPERIMENT" ||
    context.admissionDecision.payload.experimentAdmissionEligible !== true
  ) {
    throw new Error("Routing promotion requires an eligible M5 admission decision");
  }
  if (
    context.experimentAuthorization.payload.decision !== "allow" ||
    context.experimentAuthorization.payload.experimentContractAuthorized !== true
  ) {
    throw new Error("Routing promotion requires an allowed controlled experiment");
  }
}

function assertFinalGuardrailBinding(context: RoutingPromotionContext): void {
  const guardrail = context.finalGuardrailDecision.payload;
  if (
    guardrail.experimentId !== context.experiment.experimentId ||
    guardrail.experimentSha256 !== context.experiment.experimentSha256 ||
    guardrail.authorizationId !== context.experimentAuthorization.authorizationId ||
    guardrail.authorizationSha256 !== context.experimentAuthorization.authorizationSha256 ||
    guardrail.admissionDecisionId !== context.admissionDecision.decisionId ||
    guardrail.admissionDecisionSha256 !== context.admissionDecision.decisionSha256 ||
    guardrail.workflowRunId !== context.experimentWorkflow.id
  ) {
    throw new Error("Routing promotion final guardrail authority binding drift detected");
  }
}

async function verifyCohortEvidence(
  role: "reference" | "candidate",
  cohort: RoutingPromotionCohortEvidence,
  context: RoutingPromotionContext,
): Promise<{
  readonly runLedgerReferences: readonly string[];
  readonly evalReferences: readonly string[];
}> {
  await verifyEvalCohortSummary(cohort.evalSummary);
  await verifyExecutionReliabilitySummary(cohort.executionSummary);
  if (!Array.isArray(cohort.observations) || cohort.observations.length === 0) {
    throw new Error(`Routing promotion ${role} cohort requires canonical Eval observations`);
  }
  if (!Array.isArray(cohort.projections) || cohort.projections.length === 0) {
    throw new Error(`Routing promotion ${role} cohort requires execution projections`);
  }
  if (!Array.isArray(cohort.runLedgerRecords) || cohort.runLedgerRecords.length === 0) {
    throw new Error(`Routing promotion ${role} cohort requires canonical Run Ledger records`);
  }
  const rebuiltEval = await buildEvalCohortSummary(cohort.observations);
  if (stableStringify(rebuiltEval) !== stableStringify(cohort.evalSummary)) {
    throw new Error(`Routing promotion ${role} Eval summary does not match canonical observations`);
  }
  const rebuiltExecution = await buildExecutionReliabilitySummary(
    cohort.observations,
    cohort.projections,
    cohort.runLedgerRecords,
  );
  if (stableStringify(rebuiltExecution) !== stableStringify(cohort.executionSummary)) {
    throw new Error(`Routing promotion ${role} execution summary does not match canonical Run Ledger provenance`);
  }

  const admission = context.admissionDecision.payload;
  const expectedSubject =
    role === "reference" ? admission.referenceSubjectId : admission.candidateSubjectId;
  const expectedEvalSummaryId =
    role === "reference" ? admission.referenceEvalSummaryId : admission.candidateEvalSummaryId;
  const expectedExecutionSummaryId =
    role === "reference"
      ? admission.referenceExecutionSummaryId
      : admission.candidateExecutionSummaryId;
  if (!expectedExecutionSummaryId) {
    throw new Error("Routing promotion requires admission evidence with canonical execution reliability summaries");
  }
  if (
    cohort.evalSummary.summaryId !== expectedEvalSummaryId ||
    cohort.executionSummary.summaryId !== expectedExecutionSummaryId ||
    cohort.evalSummary.payload.subjectId !== expectedSubject ||
    cohort.executionSummary.payload.subjectId !== expectedSubject ||
    cohort.evalSummary.payload.suiteId !== admission.suiteId ||
    cohort.evalSummary.payload.suiteSha256 !== admission.suiteSha256 ||
    cohort.evalSummary.payload.baselineId !== admission.baselineId ||
    cohort.executionSummary.payload.suiteId !== admission.suiteId ||
    cohort.executionSummary.payload.suiteSha256 !== admission.suiteSha256 ||
    cohort.executionSummary.payload.baselineId !== admission.baselineId ||
    !sameArray(
      [...cohort.evalSummary.payload.observationIds].sort(),
      [...cohort.executionSummary.payload.observationIds].sort(),
    )
  ) {
    throw new Error(`Routing promotion ${role} canonical Eval/Run Ledger identity drift detected`);
  }

  for (const record of cohort.runLedgerRecords) {
    if (record.projectId !== context.experiment.payload.projectId) {
      throw new Error(`Routing promotion ${role} Run Ledger projectId drift detected`);
    }
  }
  const runLedgerReferences = deepFreeze(
    (
      await Promise.all(
        cohort.runLedgerRecords.map(async (record) => {
          const runId = prepareIdentity(record.runId, `Routing promotion ${role} runId`);
          const digest = await sha256Canonical(record);
          return `${role}:run-ledger:${runId}:${digest}`;
        }),
      )
    ).sort(),
  );
  if (new Set(runLedgerReferences).size !== runLedgerReferences.length) {
    throw new Error(`Routing promotion ${role} Run Ledger evidence contains duplicates`);
  }
  const evalReferences = deepFreeze([
    `${role}:eval-summary:${cohort.evalSummary.summaryId}:${cohort.evalSummary.summarySha256}`,
    `${role}:execution-summary:${cohort.executionSummary.summaryId}:${cohort.executionSummary.summarySha256}`,
  ].sort());
  return { runLedgerReferences, evalReferences };
}

async function verifyBoundedLiveEvidence(
  context: RoutingPromotionContext,
): Promise<readonly string[]> {
  if (!Array.isArray(context.publicationEvidence)) {
    throw new Error("Routing promotion publication evidence must be an array");
  }
  if (!Array.isArray(context.referenceRestoreEvidence)) {
    throw new Error("Routing promotion reference restore evidence must be an array");
  }
  const references: string[] = [];
  const sampleIds = new Set<string>();
  const operations = new Set<string>();

  for (const evidence of context.publicationEvidence) {
    await verifyBoundedLiveSampleAuthorization(evidence.authorization, {
      experiment: context.experiment,
      experimentAuthorization: context.experimentAuthorization,
      admissionDecision: context.admissionDecision,
      experimentWorkflow: context.experimentWorkflow,
      guardrailDecision: evidence.guardrailDecision,
      liveWorkflow: evidence.liveWorkflow,
      authorization: evidence.authorizationInput,
    });
    await verifyBoundedLivePublicationReceipt(evidence.receipt);
    await verifyBoundedLiveSideEffectRecoveryReport(evidence.recoveryReport);
    const auth = evidence.authorization.payload;
    const receipt = evidence.receipt.payload;
    const recovery = evidence.recoveryReport.payload;
    if (
      auth.experimentId !== context.experiment.experimentId ||
      auth.experimentSha256 !== context.experiment.experimentSha256 ||
      auth.experimentAuthorizationId !== context.experimentAuthorization.authorizationId ||
      auth.experimentAuthorizationSha256 !== context.experimentAuthorization.authorizationSha256 ||
      auth.experimentWorkflowRunId !== context.experimentWorkflow.id ||
      auth.projectId !== context.experiment.payload.projectId ||
      auth.liveAssignment !== "candidate" ||
      auth.selectedSubjectId !== context.experiment.payload.candidateSubjectId
    ) {
      throw new Error("Routing promotion bounded-live authorization is not bound to this exact candidate experiment");
    }
    if (
      receipt.sampleAuthorizationId !== evidence.authorization.authorizationId ||
      receipt.sampleAuthorizationSha256 !== evidence.authorization.authorizationSha256 ||
      receipt.sampleId !== auth.sampleId ||
      receipt.selectedSubjectId !== auth.selectedSubjectId ||
      receipt.selectedRole !== "candidate" ||
      receipt.candidateOutputExternallyVisible !== true
    ) {
      throw new Error("Routing promotion publication receipt does not match exact bounded-live authorization");
    }
    if (
      recovery.kind !== "publication" ||
      recovery.authorityId !== evidence.authorization.authorizationId ||
      recovery.subjectId !== auth.selectedSubjectId ||
      recovery.sampleId !== auth.sampleId ||
      recovery.operationId !== receipt.sideEffectOperationId ||
      recovery.idempotencyKey !== receipt.publicationIdempotencyKey ||
      recovery.sinkId !== receipt.sinkId ||
      normalizeOptionalSha(recovery.outputSha256) !== normalizeOptionalSha(receipt.outputSha256) ||
      recovery.externalReference !== receipt.publicationReference
    ) {
      throw new Error("Routing promotion recovery report is not bound to the exact publication authority/operation");
    }
    if (sampleIds.has(auth.sampleId) || operations.has(recovery.operationId)) {
      throw new Error("Routing promotion bounded-live publication evidence must be unique");
    }
    sampleIds.add(auth.sampleId);
    operations.add(recovery.operationId);
    references.push(
      `bounded-live-authorization:${evidence.authorization.authorizationId}:${evidence.authorization.authorizationSha256}`,
      `bounded-live-publication:${evidence.receipt.receiptId}:${evidence.receipt.receiptSha256}`,
      `bounded-live-recovery:${evidence.recoveryReport.reconciliationId}:${evidence.recoveryReport.reconciliationSha256}`,
    );
  }

  for (const evidence of context.referenceRestoreEvidence) {
    await verifyBoundedLiveRollbackAuthorizationEnvelope(evidence.authorization);
    await verifyBoundedLiveReferenceRestoreReceipt(evidence.receipt);
    await verifyBoundedLiveSideEffectRecoveryReport(evidence.recoveryReport);
    const auth = evidence.authorization.payload;
    const receipt = evidence.receipt.payload;
    const recovery = evidence.recoveryReport.payload;
    if (
      auth.experimentId !== context.experiment.experimentId ||
      auth.experimentSha256 !== context.experiment.experimentSha256 ||
      auth.experimentAuthorizationId !== context.experimentAuthorization.authorizationId ||
      auth.experimentAuthorizationSha256 !== context.experimentAuthorization.authorizationSha256 ||
      auth.targetSubjectId !== context.experiment.payload.referenceSubjectId ||
      receipt.rollbackAuthorizationId !== evidence.authorization.authorizationId ||
      receipt.rollbackAuthorizationSha256 !== evidence.authorization.authorizationSha256 ||
      receipt.experimentId !== context.experiment.experimentId ||
      receipt.targetSubjectId !== context.experiment.payload.referenceSubjectId ||
      recovery.kind !== "reference_restore" ||
      recovery.authorityId !== evidence.authorization.authorizationId ||
      recovery.subjectId !== context.experiment.payload.referenceSubjectId ||
      recovery.operationId !== receipt.sideEffectOperationId ||
      recovery.idempotencyKey !== receipt.restoreIdempotencyKey ||
      recovery.sinkId !== receipt.sinkId ||
      recovery.externalReference !== receipt.restoreReference
    ) {
      throw new Error("Routing promotion reference restore evidence is not bound to this exact experiment/operation");
    }
    if (operations.has(recovery.operationId)) {
      throw new Error("Routing promotion bounded-live operation evidence must be unique");
    }
    operations.add(recovery.operationId);
    references.push(
      `bounded-live-rollback-authorization:${evidence.authorization.authorizationId}:${evidence.authorization.authorizationSha256}`,
      `bounded-live-reference-restore:${evidence.receipt.receiptId}:${evidence.receipt.receiptSha256}`,
      `bounded-live-recovery:${evidence.recoveryReport.reconciliationId}:${evidence.recoveryReport.reconciliationSha256}`,
    );
  }

  return normalizeSafeSet(references, "Routing promotion bounded-live evidence reference", false);
}

function classifyPromotion(context: RoutingPromotionContext): RoutingPromotionClassification {
  const recoveries = [
    ...context.publicationEvidence.map((item) => item.recoveryReport),
    ...context.referenceRestoreEvidence.map((item) => item.recoveryReport),
  ];
  if (
    recoveries.some(
      (report) =>
        report.payload.classification !== "consistent_committed" ||
        report.payload.explicitOperatorActionRequired !== false,
    )
  ) {
    return "MANUAL_RECONCILIATION_REQUIRED";
  }
  if (context.finalGuardrailDecision.payload.classification !== "COMPLETE") {
    return "PROMOTION_NOT_ELIGIBLE";
  }
  if (context.referenceRestoreEvidence.length > 0) {
    return "PROMOTION_NOT_ELIGIBLE";
  }
  if (context.publicationEvidence.length === 0) {
    return "PROMOTION_NOT_ELIGIBLE";
  }
  return "PROMOTION_ELIGIBLE";
}

function promotionReasons(
  classification: RoutingPromotionClassification,
  context: RoutingPromotionContext,
): readonly string[] {
  const reasons: string[] = [];
  const recoveries = [
    ...context.publicationEvidence.map((item) => item.recoveryReport),
    ...context.referenceRestoreEvidence.map((item) => item.recoveryReport),
  ];
  if (
    recoveries.some(
      (report) =>
        report.payload.classification !== "consistent_committed" ||
        report.payload.explicitOperatorActionRequired !== false,
    )
  ) {
    reasons.push("bounded_live_side_effect_not_durably_reconciled");
  }
  if (context.finalGuardrailDecision.payload.classification !== "COMPLETE") {
    reasons.push("controlled_experiment_not_complete");
  }
  if (context.referenceRestoreEvidence.length > 0) {
    reasons.push("reference_restore_observed");
  }
  if (context.publicationEvidence.length === 0) {
    reasons.push("candidate_publication_commit_missing");
  }
  if (classification === "PROMOTION_ELIGIBLE") {
    reasons.push("canonical_evidence_chain_complete_and_reconciled");
  }
  return deepFreeze([...new Set(reasons)].sort());
}

function assertProposalMatchesContext(
  payload: RoutingPromotionProposalPayload,
  context: RoutingPromotionContext,
  derived: {
    readonly runLedgerEvidenceReferences: readonly string[];
    readonly evalEvidenceReferences: readonly string[];
    readonly boundedLiveEvidenceReferences: readonly string[];
  },
): void {
  const experiment = context.experiment;
  const expectedClassification = classifyPromotion(context);
  const expectedReasons = promotionReasons(expectedClassification, context);
  if (
    payload.projectId !== experiment.payload.projectId ||
    payload.referenceSubjectId !== experiment.payload.referenceSubjectId ||
    payload.candidateSubjectId !== experiment.payload.candidateSubjectId ||
    payload.admissionDecisionId !== context.admissionDecision.decisionId ||
    payload.admissionDecisionSha256 !== context.admissionDecision.decisionSha256 ||
    payload.experimentId !== experiment.experimentId ||
    payload.experimentSha256 !== experiment.experimentSha256 ||
    payload.experimentAuthorizationId !== context.experimentAuthorization.authorizationId ||
    payload.experimentAuthorizationSha256 !== context.experimentAuthorization.authorizationSha256 ||
    payload.experimentWorkflowRunId !== context.experimentWorkflow.id ||
    payload.finalGuardrailDecisionId !== context.finalGuardrailDecision.decisionId ||
    payload.finalGuardrailDecisionSha256 !== context.finalGuardrailDecision.decisionSha256 ||
    payload.preconditionSnapshotId !== context.preconditionSnapshot.snapshotId ||
    payload.preconditionSnapshotSha256 !== context.preconditionSnapshot.snapshotSha256 ||
    payload.routeId !== context.preconditionSnapshot.payload.routeId ||
    payload.capability !== context.preconditionSnapshot.payload.capability ||
    payload.routeRevision !== context.preconditionSnapshot.payload.routeRevision ||
    payload.beforeSubjectId !== experiment.payload.referenceSubjectId ||
    payload.afterSubjectId !== experiment.payload.candidateSubjectId ||
    payload.rollbackTargetSubjectId !== experiment.payload.referenceSubjectId ||
    payload.classification !== expectedClassification ||
    !sameArray(payload.reasons, expectedReasons) ||
    !sameArray(payload.runLedgerEvidenceReferences, derived.runLedgerEvidenceReferences) ||
    !sameArray(payload.evalEvidenceReferences, derived.evalEvidenceReferences) ||
    !sameArray(payload.boundedLiveEvidenceReferences, derived.boundedLiveEvidenceReferences)
  ) {
    throw new Error("Routing promotion proposal canonical source binding drift detected");
  }
  if (
    Date.parse(payload.proposedAt) < Date.parse(context.finalGuardrailDecision.payload.observedAt) ||
    Date.parse(payload.proposedAt) < Date.parse(context.preconditionSnapshot.payload.capturedAt)
  ) {
    throw new Error("Routing promotion proposal predates authoritative evidence");
  }
}

function validateSnapshotPayload(payload: RoutingPreconditionSnapshotPayload): void {
  prepareIdentity(payload.projectId, "Routing precondition projectId");
  prepareIdentity(payload.routeId, "Routing precondition routeId");
  prepareCapability(payload.capability);
  prepareIdentity(payload.currentSubjectId, "Routing precondition currentSubjectId");
  prepareSafeReference(payload.routeRevision, "Routing precondition routeRevision");
  prepareTimestamp(payload.capturedAt, "Routing precondition capturedAt");
  const policies = normalizeSafeSet(
    payload.policyReferences,
    "Routing precondition policy reference",
    true,
  );
  if (!sameArray(policies, payload.policyReferences)) {
    throw new Error("Routing precondition policyReferences must be unique and canonically sorted");
  }
  if (
    payload.providerSpecificStatePersisted !== false ||
    payload.rawProviderOutputPersisted !== false
  ) {
    throw new Error("Routing precondition snapshot cannot persist provider-specific state or raw output");
  }
}

function validateProposalPayload(payload: RoutingPromotionProposalPayload): void {
  for (const [value, label] of [
    [payload.projectId, "projectId"],
    [payload.routeId, "routeId"],
    [payload.referenceSubjectId, "referenceSubjectId"],
    [payload.candidateSubjectId, "candidateSubjectId"],
    [payload.admissionDecisionId, "admissionDecisionId"],
    [payload.admissionDecisionSha256, "admissionDecisionSha256"],
    [payload.experimentId, "experimentId"],
    [payload.experimentSha256, "experimentSha256"],
    [payload.experimentAuthorizationId, "experimentAuthorizationId"],
    [payload.experimentAuthorizationSha256, "experimentAuthorizationSha256"],
    [payload.experimentWorkflowRunId, "experimentWorkflowRunId"],
    [payload.finalGuardrailDecisionId, "finalGuardrailDecisionId"],
    [payload.finalGuardrailDecisionSha256, "finalGuardrailDecisionSha256"],
    [payload.preconditionSnapshotId, "preconditionSnapshotId"],
    [payload.preconditionSnapshotSha256, "preconditionSnapshotSha256"],
    [payload.routeRevision, "routeRevision"],
    [payload.beforeSubjectId, "beforeSubjectId"],
    [payload.afterSubjectId, "afterSubjectId"],
    [payload.rollbackTargetSubjectId, "rollbackTargetSubjectId"],
  ] as const) {
    prepareIdentity(value, `Routing promotion ${label}`);
  }
  prepareCapability(payload.capability);
  if (payload.referenceSubjectId === payload.candidateSubjectId) {
    throw new Error("Routing promotion reference and candidate subjects must differ");
  }
  if (
    payload.beforeSubjectId !== payload.referenceSubjectId ||
    payload.afterSubjectId !== payload.candidateSubjectId ||
    payload.rollbackTargetSubjectId !== payload.referenceSubjectId
  ) {
    throw new Error("Routing promotion before/after/rollback intent is invalid");
  }
  prepareTimestamp(payload.proposedAt, "Routing promotion proposedAt");
  for (const [values, label, required] of [
    [payload.runLedgerEvidenceReferences, "Run Ledger evidence reference", true],
    [payload.evalEvidenceReferences, "Eval evidence reference", true],
    [payload.boundedLiveEvidenceReferences, "bounded-live evidence reference", false],
    [payload.policyReferences, "policy reference", true],
    [payload.reasons, "reason", true],
  ] as const) {
    const normalized = normalizeSafeSet(values, `Routing promotion ${label}`, required);
    if (!sameArray(normalized, values)) {
      throw new Error(`Routing promotion ${label}s must be unique and canonically sorted`);
    }
  }
  if (
    ![
      "PROMOTION_NOT_ELIGIBLE",
      "PROMOTION_ELIGIBLE",
      "MANUAL_RECONCILIATION_REQUIRED",
    ].includes(payload.classification)
  ) {
    throw new Error("Routing promotion classification is invalid");
  }
  if (
    payload.automaticRoutingMutationAllowed !== false ||
    payload.automaticRollbackAllowed !== false ||
    payload.automaticRetryAllowed !== false ||
    payload.automaticRedispatchAllowed !== false
  ) {
    throw new Error("Routing promotion proposal cannot grant automatic authority");
  }
}

function validateAuthorizationPayload(payload: RoutingPromotionAuthorizationPayload): void {
  if (payload.decision !== "allow" && payload.decision !== "deny") {
    throw new Error("Routing promotion authorization decision is invalid");
  }
  for (const [value, label] of [
    [payload.actor, "actor"],
    [payload.proposalId, "proposalId"],
    [payload.proposalSha256, "proposalSha256"],
    [payload.projectId, "projectId"],
    [payload.routeId, "routeId"],
    [payload.referenceSubjectId, "referenceSubjectId"],
    [payload.candidateSubjectId, "candidateSubjectId"],
    [payload.preconditionSnapshotId, "preconditionSnapshotId"],
    [payload.preconditionSnapshotSha256, "preconditionSnapshotSha256"],
    [payload.routeRevision, "routeRevision"],
    [payload.workflowRunId, "workflowRunId"],
  ] as const) {
    prepareIdentity(value, `Routing promotion authorization ${label}`);
  }
  prepareCapability(payload.capability);
  prepareTimestamp(payload.decidedAt, "Routing promotion authorization decidedAt");
  const policies = normalizeSafeSet(
    payload.policyReferences,
    "Routing promotion authorization policy reference",
    true,
  );
  const approvals = normalizeSafeSet(
    payload.approvalIds,
    "Routing promotion authorization approvalId",
    payload.decision === "allow",
  );
  if (!sameArray(policies, payload.policyReferences) || !sameArray(approvals, payload.approvalIds)) {
    throw new Error("Routing promotion authorization references must be unique and canonically sorted");
  }
  if (payload.riskClass !== "R3" && payload.riskClass !== "R4") {
    throw new Error("Routing promotion authorization requires riskClass R3 or R4");
  }
  if (
    payload.routingMutationAuthorized !== (payload.decision === "allow") ||
    payload.automaticRoutingMutationAllowed !== false ||
    payload.automaticRollbackAllowed !== false ||
    payload.automaticRetryAllowed !== false ||
    payload.automaticRedispatchAllowed !== false
  ) {
    throw new Error("Routing promotion authorization authority flags are invalid");
  }
}

function assertFreshSnapshot(
  proposal: RoutingPromotionProposal,
  current: RoutingPreconditionSnapshot,
): void {
  if (
    current.snapshotId !== proposal.payload.preconditionSnapshotId ||
    current.snapshotSha256 !== proposal.payload.preconditionSnapshotSha256 ||
    current.payload.projectId !== proposal.payload.projectId ||
    current.payload.routeId !== proposal.payload.routeId ||
    current.payload.capability !== proposal.payload.capability ||
    current.payload.currentSubjectId !== proposal.payload.referenceSubjectId ||
    current.payload.routeRevision !== proposal.payload.routeRevision
  ) {
    throw new Error("Routing promotion precondition snapshot is stale or route state drifted");
  }
}

function assertPromotionWorkflow(
  workflow: WorkflowRun,
  proposal: RoutingPromotionProposal,
  experimentWorkflowRunId: string,
): void {
  if (workflow.id === experimentWorkflowRunId) {
    throw new Error("Routing promotion requires a separate workflow from experiment authorization");
  }
  if (workflow.projectId !== proposal.payload.projectId) {
    throw new Error("Routing promotion workflow projectId does not match proposal");
  }
  if (workflow.riskClass !== "R3" && workflow.riskClass !== "R4") {
    throw new Error("Routing promotion workflow requires riskClass R3 or R4");
  }
  if (workflow.phase !== "publish") {
    throw new Error("Routing promotion authorization requires workflow phase=publish after durable approval");
  }
  prepareTimestamp(workflow.updatedAt, "Routing promotion workflow updatedAt");
}

function prepareCapability(value: CapabilityId): CapabilityId {
  if (!(FROZEN_CAPABILITIES as readonly string[]).includes(value)) {
    throw new Error("Routing promotion capability is not in the frozen capability taxonomy");
  }
  return value;
}

function normalizeSafeSet(
  values: readonly string[],
  label: string,
  requireNonEmpty: boolean,
): readonly string[] {
  if (!Array.isArray(values)) throw new Error(`${label}s must be an array`);
  const normalized = [...new Set(values.map((item) => prepareSafeReference(item, label)))].sort();
  if (normalized.length !== values.length) throw new Error(`${label}s must not contain duplicates`);
  if (requireNonEmpty && normalized.length === 0) throw new Error(`${label}s must not be empty`);
  return deepFreeze(normalized);
}

function prepareIdentity(value: string, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must not be empty`);
  if (value !== value.trim() || /\r|\n/.test(value)) {
    throw new Error(`${label} must be canonical single-line text`);
  }
  if (utf8ByteLength(value) > 2048) throw new Error(`${label} exceeds 2048 bytes`);
  if (sanitizeText(value) !== value) throw new Error(`${label} contains secret-like material`);
  return value;
}

function prepareSafeReference(value: string, label: string): string {
  return prepareIdentity(value, label);
}

function prepareTimestamp(value: string, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be a valid timestamp`);
  }
  const normalized = new Date(value).toISOString();
  if (normalized !== value) throw new Error(`${label} must use canonical ISO-8601 UTC form`);
  return normalized;
}

function assertExactFields(
  value: Record<string, unknown>,
  fields: ReadonlySet<string>,
  label: string,
): void {
  const keys = Object.keys(value);
  for (const key of keys) if (!fields.has(key)) throw new Error(`${label}.${key} is not allowed`);
  for (const field of fields) if (!keys.includes(field)) throw new Error(`${label}.${field} is required`);
}

function sameArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function normalizeOptionalSha(value: string | undefined): string | undefined {
  return value?.toUpperCase();
}

function sanitizeText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [redacted]")
    .replace(
      /(authorization|api[_-]?key|access[_-]?token|password|secret|credential|cookie)\s*[:=]\s*(Bearer\s+)?[^\s,;]+/gi,
      "$1=[redacted]",
    )
    .replace(
      /\b(?:ghp_|github_pat_|sk-(?:proj-)?|sb_secret_)[A-Za-z0-9_-]{16,}\b/g,
      "[redacted]",
    );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function sha256Canonical(value: unknown): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("Web Crypto SHA-256 is unavailable in this runtime");
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(stableStringify(value)),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortJson(child)]),
  );
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
