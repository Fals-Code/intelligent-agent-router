import type { WorkflowRun } from "../control-plane/contracts.js";
import type {
  LocalProductionRoutingReadinessSourceSnapshot,
  LocalProductionRoutingTargetSnapshot,
} from "./local-production-routing-readiness.js";
import {
  verifyLocalProductionRoutingReadinessSourceSnapshot,
  verifyLocalProductionRoutingTargetSnapshot,
} from "./local-production-routing-readiness.js";
import type {
  LocalProductionAdapterRehearsalAuthority,
  LocalProductionAdapterRehearsalReceipt,
  LocalProductionRouterFingerprint,
  JsonFileLocalProductionReadOnlyTarget,
  JsonFileLocalProductionRehearsalTarget,
  JsonlLocalProductionRehearsalJournal,
} from "./local-production-adapter-rehearsal.js";
import {
  verifyLocalProductionAdapterRehearsalReceipt,
  verifyLocalProductionRouterFingerprint,
} from "./local-production-adapter-rehearsal.js";

export const LOCAL_PRODUCTION_ROUTING_APPLY_BACKUP_EVIDENCE_SCHEMA_VERSION = 1 as const;
export const LOCAL_PRODUCTION_ROUTING_APPLY_PROPOSAL_SCHEMA_VERSION = 1 as const;
export const LOCAL_PRODUCTION_ROUTING_APPLY_AUTHORIZATION_SCHEMA_VERSION = 1 as const;
export const LOCAL_PRODUCTION_ROUTING_APPLY_EXECUTION_APPROVAL_SCHEMA_VERSION = 1 as const;
export const LOCAL_PRODUCTION_ROUTING_APPLY_PREWRITE_SEAL_SCHEMA_VERSION = 1 as const;

export interface LocalProductionRoutingApplyBackupEvidenceInput {
  readonly backupId: string;
  readonly backupSha256: string;
  readonly productionTargetId: string;
  readonly productionStateId: string;
  readonly productionStateSha256: string;
  readonly productionRawFileSha256: string;
  readonly retentionPolicyReference: string;
  readonly restoreProcedureReference: string;
  readonly evidenceReferences: readonly string[];
  readonly backupIntegrityVerified: boolean;
  readonly restoreProcedureRehearsed: boolean;
  readonly retainedForManualRecovery: boolean;
  readonly automaticRollbackAllowed: false;
  readonly capturedAt: string;
}

export interface LocalProductionRoutingApplyBackupEvidence {
  readonly schemaVersion: 1;
  readonly algorithm: "sha256";
  readonly evidenceId: string;
  readonly evidenceSha256: string;
  readonly payload: LocalProductionRoutingApplyBackupEvidenceInput;
}

export interface LocalProductionRoutingApplyContext {
  readonly rehearsalReceipt: LocalProductionAdapterRehearsalReceipt;
  readonly rehearsalAuthority: LocalProductionAdapterRehearsalAuthority;
  readonly rehearsalProductionPreFingerprint: LocalProductionRouterFingerprint;
  readonly rehearsalProductionTarget: JsonFileLocalProductionReadOnlyTarget;
  readonly rehearsalTarget: JsonFileLocalProductionRehearsalTarget;
  readonly rehearsalJournal: JsonlLocalProductionRehearsalJournal;
  readonly currentTargetSnapshot: LocalProductionRoutingTargetSnapshot;
  readonly currentSourceSnapshot: LocalProductionRoutingReadinessSourceSnapshot;
  readonly productionTarget: JsonFileLocalProductionReadOnlyTarget;
  readonly productionPreFingerprint: LocalProductionRouterFingerprint;
  readonly backupEvidence: LocalProductionRoutingApplyBackupEvidence;
}

export interface LocalProductionRoutingApplyProposalInput {
  readonly candidateSubjectId: string;
  readonly candidateRouteRevision: string;
  readonly proposedAt: string;
  readonly policyReferences: readonly string[];
  readonly runLedgerReferences: readonly string[];
  readonly traceReferences: readonly string[];
}

export interface LocalProductionRoutingApplyProposalPayload extends LocalProductionRoutingApplyProposalInput {
  readonly readinessAuthorizationId: string;
  readonly readinessAuthorizationSha256: string;
  readonly rehearsalReceiptId: string;
  readonly rehearsalReceiptSha256: string;
  readonly targetSnapshotId: string;
  readonly targetSnapshotSha256: string;
  readonly sourceSnapshotId: string;
  readonly sourceSnapshotSha256: string;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly adapterSourceSha256: string;
  readonly mainSourceSha256: string;
  readonly productionTargetId: string;
  readonly projectId: string;
  readonly routeId: string;
  readonly capability: string;
  readonly referenceSubjectId: string;
  readonly referenceRouteRevision: string;
  readonly productionPreFingerprintId: string;
  readonly productionPreFingerprintSha256: string;
  readonly productionPreStateId: string;
  readonly productionPreStateSha256: string;
  readonly productionPreRawFileSha256: string;
  readonly backupEvidenceId: string;
  readonly backupEvidenceSha256: string;
  readonly productionRoutingMutationAuthorized: false;
  readonly automaticRoutingMutationAllowed: false;
  readonly automaticRetryAllowed: false;
  readonly automaticRollbackAllowed: false;
  readonly automaticRedispatchAllowed: false;
  readonly automaticPromotionAllowed: false;
}

export interface LocalProductionRoutingApplyProposal {
  readonly schemaVersion: 1;
  readonly algorithm: "sha256";
  readonly proposalId: string;
  readonly proposalSha256: string;
  readonly payload: LocalProductionRoutingApplyProposalPayload;
}

export interface LocalProductionRoutingApplyAuthorizationInput {
  readonly decision: "allow" | "deny";
  readonly actor: string;
  readonly decidedAt: string;
  readonly approvalIds: readonly string[];
  readonly policyReferences: readonly string[];
}

export interface LocalProductionRoutingApplyAuthorizationPayload extends LocalProductionRoutingApplyAuthorizationInput {
  readonly proposalId: string;
  readonly proposalSha256: string;
  readonly workflowRunId: string;
  readonly riskClass: "R4";
  readonly projectId: string;
  readonly routeId: string;
  readonly capability: string;
  readonly productionTargetId: string;
  readonly referenceSubjectId: string;
  readonly referenceRouteRevision: string;
  readonly candidateSubjectId: string;
  readonly candidateRouteRevision: string;
  readonly rehearsalReceiptId: string;
  readonly rehearsalReceiptSha256: string;
  readonly sourceSnapshotId: string;
  readonly sourceSnapshotSha256: string;
  readonly backupEvidenceId: string;
  readonly backupEvidenceSha256: string;
  readonly productionPreFingerprintId: string;
  readonly productionPreFingerprintSha256: string;
  readonly productionRoutingMutationAuthorized: boolean;
  readonly oneShotAuthorization: true;
  readonly automaticRoutingMutationAllowed: false;
  readonly automaticRetryAllowed: false;
  readonly automaticRollbackAllowed: false;
  readonly automaticRedispatchAllowed: false;
  readonly automaticPromotionAllowed: false;
}

export interface LocalProductionRoutingApplyAuthorization {
  readonly schemaVersion: 1;
  readonly algorithm: "sha256";
  readonly authorizationId: string;
  readonly authorizationSha256: string;
  readonly payload: LocalProductionRoutingApplyAuthorizationPayload;
}

export interface LocalProductionRoutingApplyExecutionApprovalInput {
  readonly actor: string;
  readonly approvedAt: string;
  readonly explicitApplyNow: true;
  readonly policyReferences: readonly string[];
}

export interface LocalProductionRoutingApplyExecutionApprovalPayload extends LocalProductionRoutingApplyExecutionApprovalInput {
  readonly operationId: string;
  readonly proposalId: string;
  readonly proposalSha256: string;
  readonly authorizationId: string;
  readonly authorizationSha256: string;
  readonly productionTargetId: string;
  readonly productionPreFingerprintId: string;
  readonly productionPreFingerprintSha256: string;
  readonly candidateSubjectId: string;
  readonly candidateRouteRevision: string;
  readonly oneShotExecutionApproval: true;
  readonly automaticRoutingMutationAllowed: false;
  readonly automaticRetryAllowed: false;
  readonly automaticRollbackAllowed: false;
  readonly automaticRedispatchAllowed: false;
  readonly automaticPromotionAllowed: false;
}

export interface LocalProductionRoutingApplyExecutionApproval {
  readonly schemaVersion: 1;
  readonly algorithm: "sha256";
  readonly approvalId: string;
  readonly approvalSha256: string;
  readonly payload: LocalProductionRoutingApplyExecutionApprovalPayload;
}

export interface LocalProductionRoutingApplyPrewriteSealPayload {
  readonly operationId: string;
  readonly proposalId: string;
  readonly proposalSha256: string;
  readonly authorizationId: string;
  readonly authorizationSha256: string;
  readonly executionApprovalId: string;
  readonly executionApprovalSha256: string;
  readonly productionTargetId: string;
  readonly productionFingerprintId: string;
  readonly productionFingerprintSha256: string;
  readonly productionStateId: string;
  readonly productionStateSha256: string;
  readonly productionRawFileSha256: string;
  readonly sourceSnapshotId: string;
  readonly sourceSnapshotSha256: string;
  readonly backupEvidenceId: string;
  readonly backupEvidenceSha256: string;
  readonly observedAt: string;
  readonly productionWritePerformed: false;
  readonly productionRoutingMutationAuthorized: true;
  readonly automaticRoutingMutationAllowed: false;
  readonly automaticRetryAllowed: false;
  readonly automaticRollbackAllowed: false;
  readonly automaticRedispatchAllowed: false;
  readonly automaticPromotionAllowed: false;
}

export interface LocalProductionRoutingApplyPrewriteSeal {
  readonly schemaVersion: 1;
  readonly algorithm: "sha256";
  readonly sealId: string;
  readonly sealSha256: string;
  readonly payload: LocalProductionRoutingApplyPrewriteSealPayload;
}

const BACKUP_INPUT_FIELDS = new Set([
  "backupId", "backupSha256", "productionTargetId", "productionStateId", "productionStateSha256",
  "productionRawFileSha256", "retentionPolicyReference", "restoreProcedureReference", "evidenceReferences",
  "backupIntegrityVerified", "restoreProcedureRehearsed", "retainedForManualRecovery", "automaticRollbackAllowed", "capturedAt",
]);
const BACKUP_FIELDS = new Set(["schemaVersion", "algorithm", "evidenceId", "evidenceSha256", "payload"]);
const PROPOSAL_INPUT_FIELDS = new Set([
  "candidateSubjectId", "candidateRouteRevision", "proposedAt", "policyReferences", "runLedgerReferences", "traceReferences",
]);
const PROPOSAL_FIELDS = new Set(["schemaVersion", "algorithm", "proposalId", "proposalSha256", "payload"]);
const PROPOSAL_PAYLOAD_FIELDS = new Set([
  ...PROPOSAL_INPUT_FIELDS,
  "readinessAuthorizationId", "readinessAuthorizationSha256", "rehearsalReceiptId", "rehearsalReceiptSha256",
  "targetSnapshotId", "targetSnapshotSha256", "sourceSnapshotId", "sourceSnapshotSha256", "adapterId", "adapterVersion",
  "adapterSourceSha256", "mainSourceSha256", "productionTargetId", "projectId", "routeId", "capability",
  "referenceSubjectId", "referenceRouteRevision", "productionPreFingerprintId", "productionPreFingerprintSha256",
  "productionPreStateId", "productionPreStateSha256", "productionPreRawFileSha256", "backupEvidenceId", "backupEvidenceSha256",
  "productionRoutingMutationAuthorized", "automaticRoutingMutationAllowed", "automaticRetryAllowed", "automaticRollbackAllowed",
  "automaticRedispatchAllowed", "automaticPromotionAllowed",
]);
const AUTH_INPUT_FIELDS = new Set(["decision", "actor", "decidedAt", "approvalIds", "policyReferences"]);
const AUTH_FIELDS = new Set(["schemaVersion", "algorithm", "authorizationId", "authorizationSha256", "payload"]);
const AUTH_PAYLOAD_FIELDS = new Set([
  ...AUTH_INPUT_FIELDS, "proposalId", "proposalSha256", "workflowRunId", "riskClass", "projectId", "routeId", "capability",
  "productionTargetId", "referenceSubjectId", "referenceRouteRevision", "candidateSubjectId", "candidateRouteRevision",
  "rehearsalReceiptId", "rehearsalReceiptSha256", "sourceSnapshotId", "sourceSnapshotSha256", "backupEvidenceId",
  "backupEvidenceSha256", "productionPreFingerprintId", "productionPreFingerprintSha256", "productionRoutingMutationAuthorized",
  "oneShotAuthorization", "automaticRoutingMutationAllowed", "automaticRetryAllowed", "automaticRollbackAllowed",
  "automaticRedispatchAllowed", "automaticPromotionAllowed",
]);
const EXECUTION_INPUT_FIELDS = new Set(["actor", "approvedAt", "explicitApplyNow", "policyReferences"]);
const EXECUTION_FIELDS = new Set(["schemaVersion", "algorithm", "approvalId", "approvalSha256", "payload"]);
const EXECUTION_PAYLOAD_FIELDS = new Set([
  ...EXECUTION_INPUT_FIELDS, "operationId", "proposalId", "proposalSha256", "authorizationId", "authorizationSha256",
  "productionTargetId", "productionPreFingerprintId", "productionPreFingerprintSha256", "candidateSubjectId",
  "candidateRouteRevision", "oneShotExecutionApproval", "automaticRoutingMutationAllowed", "automaticRetryAllowed",
  "automaticRollbackAllowed", "automaticRedispatchAllowed", "automaticPromotionAllowed",
]);
const SEAL_FIELDS = new Set(["schemaVersion", "algorithm", "sealId", "sealSha256", "payload"]);
const SEAL_PAYLOAD_FIELDS = new Set([
  "operationId", "proposalId", "proposalSha256", "authorizationId", "authorizationSha256", "executionApprovalId",
  "executionApprovalSha256", "productionTargetId", "productionFingerprintId", "productionFingerprintSha256", "productionStateId",
  "productionStateSha256", "productionRawFileSha256", "sourceSnapshotId", "sourceSnapshotSha256", "backupEvidenceId",
  "backupEvidenceSha256", "observedAt", "productionWritePerformed", "productionRoutingMutationAuthorized",
  "automaticRoutingMutationAllowed", "automaticRetryAllowed", "automaticRollbackAllowed", "automaticRedispatchAllowed",
  "automaticPromotionAllowed",
]);

export async function prepareLocalProductionRoutingApplyBackupEvidence(
  input: LocalProductionRoutingApplyBackupEvidenceInput,
): Promise<LocalProductionRoutingApplyBackupEvidence> {
  assertExactFields(requireRecord(input, "Local production apply backup input"), BACKUP_INPUT_FIELDS, "Local production apply backup input");
  const payload: LocalProductionRoutingApplyBackupEvidenceInput = deepFreeze({
    backupId: identity(input.backupId, "backupId"),
    backupSha256: sha256(input.backupSha256, "backupSha256"),
    productionTargetId: identity(input.productionTargetId, "productionTargetId"),
    productionStateId: identity(input.productionStateId, "productionStateId"),
    productionStateSha256: sha256(input.productionStateSha256, "productionStateSha256"),
    productionRawFileSha256: sha256(input.productionRawFileSha256, "productionRawFileSha256"),
    retentionPolicyReference: identity(input.retentionPolicyReference, "retentionPolicyReference"),
    restoreProcedureReference: identity(input.restoreProcedureReference, "restoreProcedureReference"),
    evidenceReferences: normalizeSet(input.evidenceReferences, "backup evidence reference", true),
    backupIntegrityVerified: exactBoolean(input.backupIntegrityVerified, "backupIntegrityVerified"),
    restoreProcedureRehearsed: exactBoolean(input.restoreProcedureRehearsed, "restoreProcedureRehearsed"),
    retainedForManualRecovery: exactBoolean(input.retainedForManualRecovery, "retainedForManualRecovery"),
    automaticRollbackAllowed: input.automaticRollbackAllowed,
    capturedAt: timestamp(input.capturedAt, "capturedAt"),
  });
  if (payload.automaticRollbackAllowed !== false) throw new Error("Production apply backup evidence cannot authorize automatic rollback");
  if (!payload.backupIntegrityVerified || !payload.restoreProcedureRehearsed || !payload.retainedForManualRecovery) {
    throw new Error("Production apply backup evidence is incomplete");
  }
  const evidenceSha256 = await sha256Canonical(payload);
  return deepFreeze({
    schemaVersion: LOCAL_PRODUCTION_ROUTING_APPLY_BACKUP_EVIDENCE_SCHEMA_VERSION,
    algorithm: "sha256" as const,
    evidenceId: `m5localprodapplybackup:${evidenceSha256.slice(0, 32)}`,
    evidenceSha256,
    payload,
  });
}

export async function verifyLocalProductionRoutingApplyBackupEvidence(
  evidence: LocalProductionRoutingApplyBackupEvidence,
): Promise<void> {
  const outer = requireRecord(evidence, "Local production apply backup evidence");
  assertExactFields(outer, BACKUP_FIELDS, "Local production apply backup evidence");
  if (evidence.schemaVersion !== 1 || evidence.algorithm !== "sha256") throw new Error("Production apply backup evidence envelope is invalid");
  assertExactFields(requireRecord(evidence.payload, "Production apply backup payload"), BACKUP_INPUT_FIELDS, "Production apply backup payload");
  const expected = await prepareLocalProductionRoutingApplyBackupEvidence(evidence.payload);
  if (evidence.evidenceId !== expected.evidenceId || evidence.evidenceSha256 !== expected.evidenceSha256) {
    throw new Error("Production apply backup evidence content address is invalid");
  }
}

export async function prepareLocalProductionRoutingApplyProposal(input: {
  readonly context: LocalProductionRoutingApplyContext;
  readonly proposal: LocalProductionRoutingApplyProposalInput;
}): Promise<LocalProductionRoutingApplyProposal> {
  assertExactFields(requireRecord(input.proposal, "Local production apply proposal input"), PROPOSAL_INPUT_FIELDS, "Local production apply proposal input");
  await verifyApplyContext(input.context);
  const receipt = input.context.rehearsalReceipt.payload;
  const target = input.context.currentTargetSnapshot.payload;
  const source = input.context.currentSourceSnapshot.payload;
  const pre = input.context.productionPreFingerprint.payload;
  const payload: LocalProductionRoutingApplyProposalPayload = deepFreeze({
    candidateSubjectId: identity(input.proposal.candidateSubjectId, "candidateSubjectId"),
    candidateRouteRevision: identity(input.proposal.candidateRouteRevision, "candidateRouteRevision"),
    proposedAt: timestamp(input.proposal.proposedAt, "proposedAt"),
    policyReferences: normalizeSet(input.proposal.policyReferences, "production apply policy reference", true),
    runLedgerReferences: normalizeSet(input.proposal.runLedgerReferences, "production apply Run Ledger reference", true),
    traceReferences: normalizeSet(input.proposal.traceReferences, "production apply trace reference", true),
    readinessAuthorizationId: receipt.readinessAuthorizationId,
    readinessAuthorizationSha256: receipt.readinessAuthorizationSha256,
    rehearsalReceiptId: input.context.rehearsalReceipt.receiptId,
    rehearsalReceiptSha256: input.context.rehearsalReceipt.receiptSha256,
    targetSnapshotId: input.context.currentTargetSnapshot.snapshotId,
    targetSnapshotSha256: input.context.currentTargetSnapshot.snapshotSha256,
    sourceSnapshotId: input.context.currentSourceSnapshot.snapshotId,
    sourceSnapshotSha256: input.context.currentSourceSnapshot.snapshotSha256,
    adapterId: source.adapterId,
    adapterVersion: source.adapterVersion,
    adapterSourceSha256: source.adapterSourceSha256,
    mainSourceSha256: source.mainSourceSha256,
    productionTargetId: pre.targetId,
    projectId: pre.projectId,
    routeId: pre.routeId,
    capability: pre.capability,
    referenceSubjectId: pre.currentSubjectId,
    referenceRouteRevision: pre.routeRevision,
    productionPreFingerprintId: input.context.productionPreFingerprint.fingerprintId,
    productionPreFingerprintSha256: input.context.productionPreFingerprint.fingerprintSha256,
    productionPreStateId: pre.stateId,
    productionPreStateSha256: pre.stateSha256,
    productionPreRawFileSha256: pre.rawFileSha256,
    backupEvidenceId: input.context.backupEvidence.evidenceId,
    backupEvidenceSha256: input.context.backupEvidence.evidenceSha256,
    productionRoutingMutationAuthorized: false,
    automaticRoutingMutationAllowed: false,
    automaticRetryAllowed: false,
    automaticRollbackAllowed: false,
    automaticRedispatchAllowed: false,
    automaticPromotionAllowed: false,
  });
  if (payload.candidateSubjectId === payload.referenceSubjectId && payload.candidateRouteRevision === payload.referenceRouteRevision) {
    throw new Error("Production apply proposal candidate must differ from the reference state");
  }
  if (Date.parse(payload.proposedAt) < Date.parse(input.context.backupEvidence.payload.capturedAt)) {
    throw new Error("Production apply proposal predates the fresh backup evidence");
  }
  const proposalSha256 = await sha256Canonical(payload);
  return deepFreeze({
    schemaVersion: LOCAL_PRODUCTION_ROUTING_APPLY_PROPOSAL_SCHEMA_VERSION,
    algorithm: "sha256" as const,
    proposalId: `m5localprodapplyproposal:${proposalSha256.slice(0, 32)}`,
    proposalSha256,
    payload,
  });
}

export async function verifyLocalProductionRoutingApplyProposal(
  proposal: LocalProductionRoutingApplyProposal,
  context: LocalProductionRoutingApplyContext,
): Promise<void> {
  assertExactFields(requireRecord(proposal, "Local production apply proposal"), PROPOSAL_FIELDS, "Local production apply proposal");
  if (proposal.schemaVersion !== 1 || proposal.algorithm !== "sha256") throw new Error("Production apply proposal envelope is invalid");
  assertExactFields(requireRecord(proposal.payload, "Production apply proposal payload"), PROPOSAL_PAYLOAD_FIELDS, "Production apply proposal payload");
  const prepared = await prepareLocalProductionRoutingApplyProposal({
    context,
    proposal: {
      candidateSubjectId: proposal.payload.candidateSubjectId,
      candidateRouteRevision: proposal.payload.candidateRouteRevision,
      proposedAt: proposal.payload.proposedAt,
      policyReferences: proposal.payload.policyReferences,
      runLedgerReferences: proposal.payload.runLedgerReferences,
      traceReferences: proposal.payload.traceReferences,
    },
  });
  if (proposal.proposalId !== prepared.proposalId || proposal.proposalSha256 !== prepared.proposalSha256 || !sameJson(proposal.payload, prepared.payload)) {
    throw new Error("Production apply proposal canonical binding drift detected");
  }
}

export async function prepareLocalProductionRoutingApplyAuthorization(input: {
  readonly proposal: LocalProductionRoutingApplyProposal;
  readonly context: LocalProductionRoutingApplyContext;
  readonly workflow: WorkflowRun;
  readonly authorization: LocalProductionRoutingApplyAuthorizationInput;
}): Promise<LocalProductionRoutingApplyAuthorization> {
  assertExactFields(requireRecord(input.authorization, "Local production apply authorization input"), AUTH_INPUT_FIELDS, "Local production apply authorization input");
  await verifyLocalProductionRoutingApplyProposal(input.proposal, input.context);
  assertR4Workflow(input.workflow, input.proposal.payload.projectId, input.authorization.approvalIds, input.authorization.decision === "allow");
  const decidedAt = timestamp(input.authorization.decidedAt, "decidedAt");
  if (Date.parse(decidedAt) <= Date.parse(input.proposal.payload.proposedAt)) {
    throw new Error("Production apply authorization must be decided after the final proposal snapshot");
  }
  const payload: LocalProductionRoutingApplyAuthorizationPayload = deepFreeze({
    decision: input.authorization.decision,
    actor: identity(input.authorization.actor, "authorization actor"),
    decidedAt,
    approvalIds: normalizeSet(input.authorization.approvalIds, "production apply approvalId", input.authorization.decision === "allow"),
    policyReferences: normalizeSet(input.authorization.policyReferences, "production apply authorization policy reference", true),
    proposalId: input.proposal.proposalId,
    proposalSha256: input.proposal.proposalSha256,
    workflowRunId: input.workflow.id,
    riskClass: "R4",
    projectId: input.proposal.payload.projectId,
    routeId: input.proposal.payload.routeId,
    capability: input.proposal.payload.capability,
    productionTargetId: input.proposal.payload.productionTargetId,
    referenceSubjectId: input.proposal.payload.referenceSubjectId,
    referenceRouteRevision: input.proposal.payload.referenceRouteRevision,
    candidateSubjectId: input.proposal.payload.candidateSubjectId,
    candidateRouteRevision: input.proposal.payload.candidateRouteRevision,
    rehearsalReceiptId: input.proposal.payload.rehearsalReceiptId,
    rehearsalReceiptSha256: input.proposal.payload.rehearsalReceiptSha256,
    sourceSnapshotId: input.proposal.payload.sourceSnapshotId,
    sourceSnapshotSha256: input.proposal.payload.sourceSnapshotSha256,
    backupEvidenceId: input.proposal.payload.backupEvidenceId,
    backupEvidenceSha256: input.proposal.payload.backupEvidenceSha256,
    productionPreFingerprintId: input.proposal.payload.productionPreFingerprintId,
    productionPreFingerprintSha256: input.proposal.payload.productionPreFingerprintSha256,
    productionRoutingMutationAuthorized: input.authorization.decision === "allow",
    oneShotAuthorization: true,
    automaticRoutingMutationAllowed: false,
    automaticRetryAllowed: false,
    automaticRollbackAllowed: false,
    automaticRedispatchAllowed: false,
    automaticPromotionAllowed: false,
  });
  const authorizationSha256 = await sha256Canonical(payload);
  return deepFreeze({
    schemaVersion: LOCAL_PRODUCTION_ROUTING_APPLY_AUTHORIZATION_SCHEMA_VERSION,
    algorithm: "sha256" as const,
    authorizationId: `m5localprodapplyauth:${authorizationSha256.slice(0, 32)}`,
    authorizationSha256,
    payload,
  });
}

export async function verifyLocalProductionRoutingApplyAuthorization(
  authorization: LocalProductionRoutingApplyAuthorization,
  proposal: LocalProductionRoutingApplyProposal,
  context: LocalProductionRoutingApplyContext,
  workflow: WorkflowRun,
): Promise<void> {
  assertExactFields(requireRecord(authorization, "Local production apply authorization"), AUTH_FIELDS, "Local production apply authorization");
  if (authorization.schemaVersion !== 1 || authorization.algorithm !== "sha256") throw new Error("Production apply authorization envelope is invalid");
  assertExactFields(requireRecord(authorization.payload, "Production apply authorization payload"), AUTH_PAYLOAD_FIELDS, "Production apply authorization payload");
  const prepared = await prepareLocalProductionRoutingApplyAuthorization({
    proposal,
    context,
    workflow,
    authorization: {
      decision: authorization.payload.decision,
      actor: authorization.payload.actor,
      decidedAt: authorization.payload.decidedAt,
      approvalIds: authorization.payload.approvalIds,
      policyReferences: authorization.payload.policyReferences,
    },
  });
  if (authorization.authorizationId !== prepared.authorizationId || authorization.authorizationSha256 !== prepared.authorizationSha256 || !sameJson(authorization.payload, prepared.payload)) {
    throw new Error("Production apply authorization canonical binding drift detected");
  }
}

export async function prepareLocalProductionRoutingApplyExecutionApproval(input: {
  readonly proposal: LocalProductionRoutingApplyProposal;
  readonly authorization: LocalProductionRoutingApplyAuthorization;
  readonly context: LocalProductionRoutingApplyContext;
  readonly workflow: WorkflowRun;
  readonly approval: LocalProductionRoutingApplyExecutionApprovalInput;
}): Promise<LocalProductionRoutingApplyExecutionApproval> {
  assertExactFields(requireRecord(input.approval, "Local production execution approval input"), EXECUTION_INPUT_FIELDS, "Local production execution approval input");
  await verifyLocalProductionRoutingApplyAuthorization(input.authorization, input.proposal, input.context, input.workflow);
  if (input.authorization.payload.decision !== "allow" || !input.authorization.payload.productionRoutingMutationAuthorized) {
    throw new Error("Production execution approval requires an allowed exact production-apply authorization");
  }
  if (input.approval.explicitApplyNow !== true) throw new Error("Production execution approval must explicitly authorize apply now");
  const approvedAt = timestamp(input.approval.approvedAt, "approvedAt");
  if (Date.parse(approvedAt) <= Date.parse(input.authorization.payload.decidedAt)) {
    throw new Error("Production execution approval must be fresh and later than the R4 authorization");
  }
  const operationId = `local-production-apply:${input.authorization.authorizationId}`;
  const payload: LocalProductionRoutingApplyExecutionApprovalPayload = deepFreeze({
    actor: identity(input.approval.actor, "execution approval actor"),
    approvedAt,
    explicitApplyNow: true,
    policyReferences: normalizeSet(input.approval.policyReferences, "execution approval policy reference", true),
    operationId,
    proposalId: input.proposal.proposalId,
    proposalSha256: input.proposal.proposalSha256,
    authorizationId: input.authorization.authorizationId,
    authorizationSha256: input.authorization.authorizationSha256,
    productionTargetId: input.proposal.payload.productionTargetId,
    productionPreFingerprintId: input.proposal.payload.productionPreFingerprintId,
    productionPreFingerprintSha256: input.proposal.payload.productionPreFingerprintSha256,
    candidateSubjectId: input.proposal.payload.candidateSubjectId,
    candidateRouteRevision: input.proposal.payload.candidateRouteRevision,
    oneShotExecutionApproval: true,
    automaticRoutingMutationAllowed: false,
    automaticRetryAllowed: false,
    automaticRollbackAllowed: false,
    automaticRedispatchAllowed: false,
    automaticPromotionAllowed: false,
  });
  const approvalSha256 = await sha256Canonical(payload);
  return deepFreeze({
    schemaVersion: LOCAL_PRODUCTION_ROUTING_APPLY_EXECUTION_APPROVAL_SCHEMA_VERSION,
    algorithm: "sha256" as const,
    approvalId: `m5localprodapplyexec:${approvalSha256.slice(0, 32)}`,
    approvalSha256,
    payload,
  });
}

export async function verifyLocalProductionRoutingApplyExecutionApproval(
  approval: LocalProductionRoutingApplyExecutionApproval,
  proposal: LocalProductionRoutingApplyProposal,
  authorization: LocalProductionRoutingApplyAuthorization,
  context: LocalProductionRoutingApplyContext,
  workflow: WorkflowRun,
): Promise<void> {
  assertExactFields(requireRecord(approval, "Local production execution approval"), EXECUTION_FIELDS, "Local production execution approval");
  if (approval.schemaVersion !== 1 || approval.algorithm !== "sha256") throw new Error("Production execution approval envelope is invalid");
  assertExactFields(requireRecord(approval.payload, "Production execution approval payload"), EXECUTION_PAYLOAD_FIELDS, "Production execution approval payload");
  const prepared = await prepareLocalProductionRoutingApplyExecutionApproval({
    proposal,
    authorization,
    context,
    workflow,
    approval: {
      actor: approval.payload.actor,
      approvedAt: approval.payload.approvedAt,
      explicitApplyNow: approval.payload.explicitApplyNow,
      policyReferences: approval.payload.policyReferences,
    },
  });
  if (approval.approvalId !== prepared.approvalId || approval.approvalSha256 !== prepared.approvalSha256 || !sameJson(approval.payload, prepared.payload)) {
    throw new Error("Production execution approval canonical binding drift detected");
  }
}

export async function prepareLocalProductionRoutingApplyPrewriteSeal(input: {
  readonly proposal: LocalProductionRoutingApplyProposal;
  readonly authorization: LocalProductionRoutingApplyAuthorization;
  readonly executionApproval: LocalProductionRoutingApplyExecutionApproval;
  readonly context: LocalProductionRoutingApplyContext;
  readonly workflow: WorkflowRun;
  readonly observedAt: string;
}): Promise<LocalProductionRoutingApplyPrewriteSeal> {
  await verifyLocalProductionRoutingApplyExecutionApproval(input.executionApproval, input.proposal, input.authorization, input.context, input.workflow);
  const observedAt = timestamp(input.observedAt, "prewrite observedAt");
  if (Date.parse(observedAt) < Date.parse(input.executionApproval.payload.approvedAt)) {
    throw new Error("Production pre-write seal cannot predate the explicit execution approval");
  }
  await verifyApplyContext(input.context);
  const live = await input.context.productionTarget.fingerprint(observedAt);
  await verifyLocalProductionRouterFingerprint(live);
  assertSameFingerprint(input.context.productionPreFingerprint, live, "Production changed after apply proposal/authorization");
  const payload: LocalProductionRoutingApplyPrewriteSealPayload = deepFreeze({
    operationId: input.executionApproval.payload.operationId,
    proposalId: input.proposal.proposalId,
    proposalSha256: input.proposal.proposalSha256,
    authorizationId: input.authorization.authorizationId,
    authorizationSha256: input.authorization.authorizationSha256,
    executionApprovalId: input.executionApproval.approvalId,
    executionApprovalSha256: input.executionApproval.approvalSha256,
    productionTargetId: live.payload.targetId,
    productionFingerprintId: live.fingerprintId,
    productionFingerprintSha256: live.fingerprintSha256,
    productionStateId: live.payload.stateId,
    productionStateSha256: live.payload.stateSha256,
    productionRawFileSha256: live.payload.rawFileSha256,
    sourceSnapshotId: input.context.currentSourceSnapshot.snapshotId,
    sourceSnapshotSha256: input.context.currentSourceSnapshot.snapshotSha256,
    backupEvidenceId: input.context.backupEvidence.evidenceId,
    backupEvidenceSha256: input.context.backupEvidence.evidenceSha256,
    observedAt,
    productionWritePerformed: false,
    productionRoutingMutationAuthorized: true,
    automaticRoutingMutationAllowed: false,
    automaticRetryAllowed: false,
    automaticRollbackAllowed: false,
    automaticRedispatchAllowed: false,
    automaticPromotionAllowed: false,
  });
  const sealSha256 = await sha256Canonical(payload);
  return deepFreeze({
    schemaVersion: LOCAL_PRODUCTION_ROUTING_APPLY_PREWRITE_SEAL_SCHEMA_VERSION,
    algorithm: "sha256" as const,
    sealId: `m5localprodapplyseal:${sealSha256.slice(0, 32)}`,
    sealSha256,
    payload,
  });
}

export async function verifyLocalProductionRoutingApplyPrewriteSeal(
  seal: LocalProductionRoutingApplyPrewriteSeal,
  input: {
    readonly proposal: LocalProductionRoutingApplyProposal;
    readonly authorization: LocalProductionRoutingApplyAuthorization;
    readonly executionApproval: LocalProductionRoutingApplyExecutionApproval;
    readonly context: LocalProductionRoutingApplyContext;
    readonly workflow: WorkflowRun;
  },
): Promise<void> {
  assertExactFields(requireRecord(seal, "Local production prewrite seal"), SEAL_FIELDS, "Local production prewrite seal");
  if (seal.schemaVersion !== 1 || seal.algorithm !== "sha256") throw new Error("Production prewrite seal envelope is invalid");
  assertExactFields(requireRecord(seal.payload, "Production prewrite seal payload"), SEAL_PAYLOAD_FIELDS, "Production prewrite seal payload");
  const prepared = await prepareLocalProductionRoutingApplyPrewriteSeal({
    ...input,
    observedAt: seal.payload.observedAt,
  });
  if (seal.sealId !== prepared.sealId || seal.sealSha256 !== prepared.sealSha256 || !sameJson(seal.payload, prepared.payload)) {
    throw new Error("Production prewrite seal canonical binding drift detected");
  }
}

async function verifyApplyContext(context: LocalProductionRoutingApplyContext): Promise<void> {
  const c = requireRecord(context, "Local production apply context");
  for (const field of [
    "rehearsalReceipt", "rehearsalAuthority", "rehearsalProductionPreFingerprint", "rehearsalProductionTarget",
    "rehearsalTarget", "rehearsalJournal", "currentTargetSnapshot", "currentSourceSnapshot", "productionTarget",
    "productionPreFingerprint", "backupEvidence",
  ] as const) {
    if (!(field in c) || c[field] === undefined || c[field] === null) throw new Error(`Production apply context.${field} is required`);
  }
  await verifyLocalProductionAdapterRehearsalReceipt(
    context.rehearsalReceipt,
    context.rehearsalAuthority,
    context.rehearsalProductionPreFingerprint,
    context.rehearsalProductionTarget,
    context.rehearsalTarget,
    context.rehearsalJournal,
  );
  await verifyLocalProductionRoutingTargetSnapshot(context.currentTargetSnapshot);
  await verifyLocalProductionRoutingReadinessSourceSnapshot(context.currentSourceSnapshot);
  await verifyLocalProductionRouterFingerprint(context.productionPreFingerprint);
  await verifyLocalProductionRoutingApplyBackupEvidence(context.backupEvidence);
  const live = await context.productionTarget.fingerprint(context.productionPreFingerprint.payload.observedAt);
  await verifyLocalProductionRouterFingerprint(live);
  assertSameFingerprint(context.productionPreFingerprint, live, "Production pre-fingerprint is stale or drifted");
  const target = context.currentTargetSnapshot.payload;
  const source = context.currentSourceSnapshot.payload;
  const pre = context.productionPreFingerprint.payload;
  if (
    target.installationId !== pre.installationId ||
    target.projectId !== pre.projectId ||
    target.routeId !== pre.routeId ||
    target.capability !== pre.capability ||
    target.currentSubjectId !== pre.currentSubjectId ||
    target.routeRevision !== pre.routeRevision
  ) throw new Error("Current target snapshot does not match the exact live production reference state");
  if (!source.adapterSourceVerified || !source.mainSourceVerified) throw new Error("Current production-apply source snapshot is not independently verified");
  if (
    context.backupEvidence.payload.productionTargetId !== pre.targetId ||
    context.backupEvidence.payload.productionStateId !== pre.stateId ||
    context.backupEvidence.payload.productionStateSha256 !== pre.stateSha256 ||
    context.backupEvidence.payload.productionRawFileSha256 !== pre.rawFileSha256
  ) throw new Error("Fresh backup evidence does not bind the exact production pre-state");
}

function assertR4Workflow(workflow: WorkflowRun, projectId: string, approvalIds: readonly string[], requireApproval: boolean): void {
  requireRecord(workflow, "Production apply workflow");
  if (workflow.projectId !== projectId || workflow.riskClass !== "R4") throw new Error("Production apply requires exact R4 workflow scope");
  if (workflow.phase !== "approval" && workflow.phase !== "publish") throw new Error("Production apply workflow must be at approval/publish boundary");
  if (requireApproval && workflow.status !== "running") throw new Error("Allowed production apply requires an active workflow");
  const supplied = normalizeSet(approvalIds, "production apply approvalId", requireApproval);
  const durable = normalizeSet(workflow.approvalIds, "durable R4 workflow approvalId", requireApproval);
  if (!sameArray(supplied, durable)) throw new Error("Production apply approval IDs do not match durable workflow approvals");
}

function assertSameFingerprint(expected: LocalProductionRouterFingerprint, actual: LocalProductionRouterFingerprint, message: string): void {
  if (
    expected.payload.targetId !== actual.payload.targetId ||
    expected.payload.stateId !== actual.payload.stateId ||
    expected.payload.stateSha256 !== actual.payload.stateSha256 ||
    expected.payload.rawFileSha256 !== actual.payload.rawFileSha256 ||
    expected.payload.currentSubjectId !== actual.payload.currentSubjectId ||
    expected.payload.routeRevision !== actual.payload.routeRevision
  ) throw new Error(message);
}

function identity(value: string, label: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > 512) throw new Error(`${label} is invalid`);
  if (/token|secret|password|bearer|api[-_]?key/i.test(value)) throw new Error(`${label} contains secret-like material`);
  return value;
}

function sha256(value: string, label: string): string {
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error(`${label} must be a SHA-256 hex digest`);
  return value.toLowerCase();
}

function timestamp(value: string, label: string): string {
  if (typeof value !== "string" || value.length > 128 || !Number.isFinite(Date.parse(value))) throw new Error(`${label} is invalid`);
  return value;
}

function exactBoolean(value: boolean, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

function normalizeSet(values: readonly string[], label: string, required: boolean): readonly string[] {
  if (!Array.isArray(values)) throw new Error(`${label} list is invalid`);
  const normalized = [...new Set(values.map((value) => identity(value, label)))].sort();
  if (required && normalized.length === 0) throw new Error(`${label} is required`);
  return deepFreeze(normalized);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactFields(value: Record<string, unknown>, fields: Set<string>, label: string): void {
  const keys = Object.keys(value);
  if (keys.length !== fields.size || keys.some((key) => !fields.has(key))) {
    throw new Error(`${label} contains unknown, missing, or provider-specific fields`);
  }
}

function sameArray(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortJson(a)) === JSON.stringify(sortJson(b));
}

async function sha256Canonical(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(sortJson(value)));
  if (!globalThis.crypto?.subtle) throw new Error("Web Crypto SHA-256 is unavailable in this runtime");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isRecord(value)) return value;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) output[key] = sortJson(value[key]);
  return output;
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    return Object.freeze(value);
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) deepFreeze(item);
    return Object.freeze(value) as T;
  }
  return value;
}
