import type { CapabilityId, RunLedgerRecord, WorkflowRun } from "../control-plane/contracts.js";
import { FROZEN_CAPABILITIES } from "../control-plane/contracts.js";
import type {
  RoutingPreconditionSnapshot,
  RoutingPromotionAuthorization,
  RoutingPromotionContext,
  RoutingPromotionProposal,
} from "./routing-promotion.js";
import type {
  IsolatedRoutingMutationReceipt,
  JsonFileIsolatedRoutingTarget,
  JsonlRoutingMutationJournal,
  RoutingMutationAuthoritySources,
} from "../integration/isolated-routing-mutation.js";
import { verifyIsolatedRoutingMutationReceipt } from "../integration/isolated-routing-mutation.js";

export const LOCAL_PRODUCTION_ROUTING_TARGET_SNAPSHOT_SCHEMA_VERSION = 1 as const;
export const LOCAL_PRODUCTION_ROUTING_READINESS_EVIDENCE_SCHEMA_VERSION = 1 as const;
export const LOCAL_PRODUCTION_ROUTING_READINESS_PROPOSAL_SCHEMA_VERSION = 1 as const;
export const LOCAL_PRODUCTION_ROUTING_READINESS_AUTHORIZATION_SCHEMA_VERSION = 1 as const;

export type LocalProductionRoutingReadinessClassification =
  | "NOT_READY"
  | "READY_FOR_LOCAL_PRODUCTION_ADAPTER_IMPLEMENTATION"
  | "MANUAL_RECONCILIATION_REQUIRED";

export interface LocalProductionRoutingTargetSnapshotInput {
  readonly installationId: string;
  readonly projectId: string;
  readonly routeId: string;
  readonly capability: CapabilityId;
  readonly currentSubjectId: string;
  readonly routeRevision: string;
  readonly canonicalStateOwner: string;
  readonly writeBoundary: string;
  readonly persistenceCategory: string;
  readonly runtimeId: string;
  readonly restartPolicyReference: string;
  readonly capturedAt: string;
  readonly policyReferences: readonly string[];
}

export interface LocalProductionRoutingTargetSnapshotPayload extends LocalProductionRoutingTargetSnapshotInput {
  readonly targetKind: "local_production_router";
  readonly singleWriterRequired: true;
  readonly providerSpecificStatePersisted: false;
  readonly rawProviderOutputPersisted: false;
  readonly secretMaterialPersisted: false;
}

export interface LocalProductionRoutingTargetSnapshot {
  readonly schemaVersion: typeof LOCAL_PRODUCTION_ROUTING_TARGET_SNAPSHOT_SCHEMA_VERSION;
  readonly algorithm: "sha256";
  readonly snapshotId: string;
  readonly snapshotSha256: string;
  readonly payload: LocalProductionRoutingTargetSnapshotPayload;
}

export interface CredentialIsolationReadinessEvidenceInput {
  readonly credentialBrokerId: string;
  readonly credentialScopeId: string;
  readonly filesystemScopeId: string;
  readonly networkEgressScopeId: string;
  readonly adapterWriteScopeId: string;
  readonly evidenceReferences: readonly string[];
  readonly credentialScopeVerified: boolean;
  readonly autonomousWorkerLongLivedSecretAccess: boolean;
  readonly exactTargetOnly: boolean;
  readonly providerFailureContained: boolean;
  readonly singleWriterVerified: boolean;
  readonly observedAt: string;
}

export interface BackupRestoreReadinessEvidenceInput {
  readonly backupId: string;
  readonly backupSha256: string;
  readonly referenceStateSha256: string;
  readonly restoredStateSha256: string;
  readonly retentionPolicyReference: string;
  readonly evidenceReferences: readonly string[];
  readonly backupIntegrityVerified: boolean;
  readonly restoreVerified: boolean;
  readonly destructiveCleanupPerformed: boolean;
  readonly observedAt: string;
}

export interface RollbackRehearsalReadinessEvidenceInput {
  readonly rehearsalId: string;
  readonly rehearsalResult: "PASSED" | "FAILED" | "MANUAL_RECONCILIATION_REQUIRED";
  readonly restoredSubjectId: string;
  readonly restoredRouteRevision: string;
  readonly evidenceReferences: readonly string[];
  readonly exactReferenceRestored: boolean;
  readonly duplicateSideEffectObserved: boolean;
  readonly automaticRollbackAllowed: boolean;
  readonly observedAt: string;
}

export interface ObservabilityReadinessEvidenceInput {
  readonly runLedgerReferences: readonly string[];
  readonly traceReferences: readonly string[];
  readonly approvalAttributionReady: boolean;
  readonly adapterAttributionReady: boolean;
  readonly beforeAfterStateAttributionReady: boolean;
  readonly sanitizedOperationalResultReady: boolean;
  readonly observedAt: string;
}

type ReadinessEvidenceKind = "credential_isolation" | "backup_restore" | "rollback_rehearsal" | "observability";

export interface LocalProductionRoutingReadinessEvidence<TPayload extends Record<string, unknown> = Record<string, unknown>> {
  readonly schemaVersion: typeof LOCAL_PRODUCTION_ROUTING_READINESS_EVIDENCE_SCHEMA_VERSION;
  readonly algorithm: "sha256";
  readonly kind: ReadinessEvidenceKind;
  readonly evidenceId: string;
  readonly evidenceSha256: string;
  readonly payload: TPayload;
}

export type CredentialIsolationReadinessEvidence = LocalProductionRoutingReadinessEvidence<CredentialIsolationReadinessEvidenceInput>;
export type BackupRestoreReadinessEvidence = LocalProductionRoutingReadinessEvidence<BackupRestoreReadinessEvidenceInput>;
export type RollbackRehearsalReadinessEvidence = LocalProductionRoutingReadinessEvidence<RollbackRehearsalReadinessEvidenceInput>;
export type ObservabilityReadinessEvidence = LocalProductionRoutingReadinessEvidence<ObservabilityReadinessEvidenceInput>;

export interface LocalProductionRoutingReadinessContext {
  readonly promotionAuthority: RoutingMutationAuthoritySources;
  readonly isolatedMutationReceipt: IsolatedRoutingMutationReceipt;
  readonly isolatedTarget: JsonFileIsolatedRoutingTarget;
  readonly isolatedJournal: JsonlRoutingMutationJournal;
  readonly targetSnapshot: LocalProductionRoutingTargetSnapshot;
  readonly credentialEvidence: CredentialIsolationReadinessEvidence;
  readonly backupEvidence: BackupRestoreReadinessEvidence;
  readonly rollbackEvidence: RollbackRehearsalReadinessEvidence;
  readonly observabilityEvidence: ObservabilityReadinessEvidence;
  readonly runLedgerRecords: readonly RunLedgerRecord[];
}

export interface LocalProductionRoutingReadinessProposalInput {
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly adapterSourceSha256: string;
  readonly mainSourceSha256: string;
  readonly proposedAt: string;
  readonly policyReferences: readonly string[];
}

export interface LocalProductionRoutingReadinessProposalPayload extends LocalProductionRoutingReadinessProposalInput {
  readonly promotionAuthorizationId: string;
  readonly promotionAuthorizationSha256: string;
  readonly promotionProposalId: string;
  readonly promotionProposalSha256: string;
  readonly promotionPreconditionSnapshotId: string;
  readonly promotionPreconditionSnapshotSha256: string;
  readonly isolatedMutationReceiptId: string;
  readonly isolatedMutationReceiptSha256: string;
  readonly targetSnapshotId: string;
  readonly targetSnapshotSha256: string;
  readonly projectId: string;
  readonly routeId: string;
  readonly capability: CapabilityId;
  readonly referenceSubjectId: string;
  readonly candidateSubjectId: string;
  readonly routeRevision: string;
  readonly credentialEvidenceId: string;
  readonly credentialEvidenceSha256: string;
  readonly backupEvidenceId: string;
  readonly backupEvidenceSha256: string;
  readonly rollbackEvidenceId: string;
  readonly rollbackEvidenceSha256: string;
  readonly observabilityEvidenceId: string;
  readonly observabilityEvidenceSha256: string;
  readonly runLedgerReferences: readonly string[];
  readonly classification: LocalProductionRoutingReadinessClassification;
  readonly reasons: readonly string[];
  readonly productionRoutingMutationAuthorized: false;
  readonly automaticRoutingMutationAllowed: false;
  readonly automaticRetryAllowed: false;
  readonly automaticRollbackAllowed: false;
  readonly automaticRedispatchAllowed: false;
}

export interface LocalProductionRoutingReadinessProposal {
  readonly schemaVersion: typeof LOCAL_PRODUCTION_ROUTING_READINESS_PROPOSAL_SCHEMA_VERSION;
  readonly algorithm: "sha256";
  readonly proposalId: string;
  readonly proposalSha256: string;
  readonly payload: LocalProductionRoutingReadinessProposalPayload;
}

export interface LocalProductionRoutingReadinessAuthorizationInput {
  readonly decision: "allow" | "deny";
  readonly actor: string;
  readonly decidedAt: string;
  readonly approvalIds: readonly string[];
  readonly policyReferences: readonly string[];
}

export interface LocalProductionRoutingReadinessAuthorizationPayload extends LocalProductionRoutingReadinessAuthorizationInput {
  readonly proposalId: string;
  readonly proposalSha256: string;
  readonly projectId: string;
  readonly routeId: string;
  readonly capability: CapabilityId;
  readonly targetSnapshotId: string;
  readonly targetSnapshotSha256: string;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly adapterSourceSha256: string;
  readonly mainSourceSha256: string;
  readonly workflowRunId: string;
  readonly riskClass: "R4";
  readonly implementationReadinessAuthorized: boolean;
  readonly productionRoutingMutationAuthorized: false;
  readonly automaticRoutingMutationAllowed: false;
  readonly automaticRetryAllowed: false;
  readonly automaticRollbackAllowed: false;
  readonly automaticRedispatchAllowed: false;
}

export interface LocalProductionRoutingReadinessAuthorization {
  readonly schemaVersion: typeof LOCAL_PRODUCTION_ROUTING_READINESS_AUTHORIZATION_SCHEMA_VERSION;
  readonly algorithm: "sha256";
  readonly authorizationId: string;
  readonly authorizationSha256: string;
  readonly payload: LocalProductionRoutingReadinessAuthorizationPayload;
}

const TARGET_INPUT_FIELDS = new Set([
  "installationId", "projectId", "routeId", "capability", "currentSubjectId", "routeRevision",
  "canonicalStateOwner", "writeBoundary", "persistenceCategory", "runtimeId", "restartPolicyReference",
  "capturedAt", "policyReferences",
]);
const TARGET_ENVELOPE_FIELDS = new Set(["schemaVersion", "algorithm", "snapshotId", "snapshotSha256", "payload"]);
const TARGET_PAYLOAD_FIELDS = new Set([
  ...TARGET_INPUT_FIELDS, "targetKind", "singleWriterRequired", "providerSpecificStatePersisted",
  "rawProviderOutputPersisted", "secretMaterialPersisted",
]);
const EVIDENCE_ENVELOPE_FIELDS = new Set(["schemaVersion", "algorithm", "kind", "evidenceId", "evidenceSha256", "payload"]);
const PROPOSAL_ENVELOPE_FIELDS = new Set(["schemaVersion", "algorithm", "proposalId", "proposalSha256", "payload"]);
const AUTH_ENVELOPE_FIELDS = new Set(["schemaVersion", "algorithm", "authorizationId", "authorizationSha256", "payload"]);

export async function prepareLocalProductionRoutingTargetSnapshot(
  input: LocalProductionRoutingTargetSnapshotInput,
): Promise<LocalProductionRoutingTargetSnapshot> {
  assertExactFields(input as unknown as Record<string, unknown>, TARGET_INPUT_FIELDS, "Local production routing target input");
  const payload: LocalProductionRoutingTargetSnapshotPayload = deepFreeze({
    installationId: prepareIdentity(input.installationId, "Local production installationId"),
    projectId: prepareIdentity(input.projectId, "Local production projectId"),
    routeId: prepareIdentity(input.routeId, "Local production routeId"),
    capability: prepareCapability(input.capability),
    currentSubjectId: prepareIdentity(input.currentSubjectId, "Local production currentSubjectId"),
    routeRevision: prepareIdentity(input.routeRevision, "Local production routeRevision"),
    canonicalStateOwner: prepareIdentity(input.canonicalStateOwner, "Local production canonicalStateOwner"),
    writeBoundary: prepareIdentity(input.writeBoundary, "Local production writeBoundary"),
    persistenceCategory: prepareIdentity(input.persistenceCategory, "Local production persistenceCategory"),
    runtimeId: prepareIdentity(input.runtimeId, "Local production runtimeId"),
    restartPolicyReference: prepareIdentity(input.restartPolicyReference, "Local production restartPolicyReference"),
    capturedAt: prepareTimestamp(input.capturedAt, "Local production target capturedAt"),
    policyReferences: normalizeSet(input.policyReferences, "Local production target policy reference", true),
    targetKind: "local_production_router",
    singleWriterRequired: true,
    providerSpecificStatePersisted: false,
    rawProviderOutputPersisted: false,
    secretMaterialPersisted: false,
  });
  const snapshotSha256 = await sha256Canonical(payload);
  return deepFreeze({
    schemaVersion: LOCAL_PRODUCTION_ROUTING_TARGET_SNAPSHOT_SCHEMA_VERSION,
    algorithm: "sha256" as const,
    snapshotId: `m5localprodtarget:${snapshotSha256.slice(0, 32).toLowerCase()}`,
    snapshotSha256,
    payload,
  });
}

export async function verifyLocalProductionRoutingTargetSnapshot(snapshot: LocalProductionRoutingTargetSnapshot): Promise<void> {
  if (!isRecord(snapshot)) throw new Error("Local production routing target snapshot must be an object");
  assertExactFields(snapshot, TARGET_ENVELOPE_FIELDS, "Local production routing target snapshot");
  if (snapshot.schemaVersion !== 1 || snapshot.algorithm !== "sha256" || !isRecord(snapshot.payload)) throw new Error("Local production routing target snapshot envelope is invalid");
  assertExactFields(snapshot.payload, TARGET_PAYLOAD_FIELDS, "Local production routing target snapshot payload");
  const p = snapshot.payload as unknown as LocalProductionRoutingTargetSnapshotPayload;
  for (const [value, label] of [
    [p.installationId, "installationId"], [p.projectId, "projectId"], [p.routeId, "routeId"],
    [p.currentSubjectId, "currentSubjectId"], [p.routeRevision, "routeRevision"], [p.canonicalStateOwner, "canonicalStateOwner"],
    [p.writeBoundary, "writeBoundary"], [p.persistenceCategory, "persistenceCategory"], [p.runtimeId, "runtimeId"],
    [p.restartPolicyReference, "restartPolicyReference"],
  ] as const) prepareIdentity(value, `Local production target ${label}`);
  prepareCapability(p.capability);
  prepareTimestamp(p.capturedAt, "Local production target capturedAt");
  if (!sameArray(p.policyReferences, normalizeSet(p.policyReferences, "Local production target policy reference", true))) throw new Error("Local production target policyReferences are not canonical");
  if (p.targetKind !== "local_production_router" || p.singleWriterRequired !== true || p.providerSpecificStatePersisted !== false || p.rawProviderOutputPersisted !== false || p.secretMaterialPersisted !== false) throw new Error("Local production target safety boundary is invalid");
  const expected = await sha256Canonical(p);
  if (snapshot.snapshotSha256 !== expected || snapshot.snapshotId !== `m5localprodtarget:${expected.slice(0, 32).toLowerCase()}`) throw new Error("Local production target content address is invalid");
}

export async function prepareCredentialIsolationReadinessEvidence(
  input: CredentialIsolationReadinessEvidenceInput,
): Promise<CredentialIsolationReadinessEvidence> {
  validateCredentialEvidencePayload(input);
  return prepareEvidence("credential_isolation", deepFreeze({ ...input, evidenceReferences: normalizeSet(input.evidenceReferences, "Credential evidence reference", true) }));
}

export async function prepareBackupRestoreReadinessEvidence(
  input: BackupRestoreReadinessEvidenceInput,
): Promise<BackupRestoreReadinessEvidence> {
  validateBackupEvidencePayload(input);
  return prepareEvidence("backup_restore", deepFreeze({ ...input, evidenceReferences: normalizeSet(input.evidenceReferences, "Backup evidence reference", true) }));
}

export async function prepareRollbackRehearsalReadinessEvidence(
  input: RollbackRehearsalReadinessEvidenceInput,
): Promise<RollbackRehearsalReadinessEvidence> {
  validateRollbackEvidencePayload(input);
  return prepareEvidence("rollback_rehearsal", deepFreeze({ ...input, evidenceReferences: normalizeSet(input.evidenceReferences, "Rollback evidence reference", true) }));
}

export async function prepareObservabilityReadinessEvidence(
  input: ObservabilityReadinessEvidenceInput,
): Promise<ObservabilityReadinessEvidence> {
  validateObservabilityEvidencePayload(input);
  return prepareEvidence("observability", deepFreeze({
    ...input,
    runLedgerReferences: normalizeSet(input.runLedgerReferences, "Observability Run Ledger reference", true),
    traceReferences: normalizeSet(input.traceReferences, "Observability trace reference", true),
  }));
}

export async function verifyLocalProductionRoutingReadinessEvidence(evidence: LocalProductionRoutingReadinessEvidence): Promise<void> {
  if (!isRecord(evidence)) throw new Error("Local production readiness evidence must be an object");
  assertExactFields(evidence, EVIDENCE_ENVELOPE_FIELDS, "Local production readiness evidence");
  if (evidence.schemaVersion !== 1 || evidence.algorithm !== "sha256" || !isRecord(evidence.payload)) throw new Error("Local production readiness evidence envelope is invalid");
  if (!["credential_isolation", "backup_restore", "rollback_rehearsal", "observability"].includes(evidence.kind)) throw new Error("Local production readiness evidence kind is invalid");
  if (evidence.kind === "credential_isolation") validateCredentialEvidencePayload(evidence.payload as unknown as CredentialIsolationReadinessEvidenceInput);
  else if (evidence.kind === "backup_restore") validateBackupEvidencePayload(evidence.payload as unknown as BackupRestoreReadinessEvidenceInput);
  else if (evidence.kind === "rollback_rehearsal") validateRollbackEvidencePayload(evidence.payload as unknown as RollbackRehearsalReadinessEvidenceInput);
  else validateObservabilityEvidencePayload(evidence.payload as unknown as ObservabilityReadinessEvidenceInput);
  const expected = await sha256Canonical({ kind: evidence.kind, payload: evidence.payload });
  if (evidence.evidenceSha256 !== expected || evidence.evidenceId !== `m5localprodproof:${evidence.kind}:${expected.slice(0, 32).toLowerCase()}`) throw new Error("Local production readiness evidence content address is invalid");
}

export async function prepareLocalProductionRoutingReadinessProposal(input: {
  readonly context: LocalProductionRoutingReadinessContext;
  readonly proposal: LocalProductionRoutingReadinessProposalInput;
}): Promise<LocalProductionRoutingReadinessProposal> {
  const derived = await verifyReadinessContext(input.context);
  const p = input.context.promotionAuthority;
  const proposedAt = prepareTimestamp(input.proposal.proposedAt, "Local production readiness proposedAt");
  assertAtOrAfter(proposedAt, [
    input.context.targetSnapshot.payload.capturedAt,
    input.context.credentialEvidence.payload.observedAt,
    input.context.backupEvidence.payload.observedAt,
    input.context.rollbackEvidence.payload.observedAt,
    input.context.observabilityEvidence.payload.observedAt,
  ], "Local production readiness proposal predates evidence");
  const payload: LocalProductionRoutingReadinessProposalPayload = deepFreeze({
    adapterId: prepareIdentity(input.proposal.adapterId, "Local production readiness adapterId"),
    adapterVersion: prepareIdentity(input.proposal.adapterVersion, "Local production readiness adapterVersion"),
    adapterSourceSha256: prepareSha256(input.proposal.adapterSourceSha256, "Local production readiness adapterSourceSha256"),
    mainSourceSha256: prepareSha256(input.proposal.mainSourceSha256, "Local production readiness mainSourceSha256"),
    proposedAt,
    policyReferences: normalizeSet(input.proposal.policyReferences, "Local production readiness policy reference", true),
    promotionAuthorizationId: p.authorization.authorizationId,
    promotionAuthorizationSha256: p.authorization.authorizationSha256,
    promotionProposalId: p.proposal.proposalId,
    promotionProposalSha256: p.proposal.proposalSha256,
    promotionPreconditionSnapshotId: p.preconditionSnapshot.snapshotId,
    promotionPreconditionSnapshotSha256: p.preconditionSnapshot.snapshotSha256,
    isolatedMutationReceiptId: input.context.isolatedMutationReceipt.receiptId,
    isolatedMutationReceiptSha256: input.context.isolatedMutationReceipt.receiptSha256,
    targetSnapshotId: input.context.targetSnapshot.snapshotId,
    targetSnapshotSha256: input.context.targetSnapshot.snapshotSha256,
    projectId: p.authorization.payload.projectId,
    routeId: p.authorization.payload.routeId,
    capability: p.authorization.payload.capability,
    referenceSubjectId: p.authorization.payload.referenceSubjectId,
    candidateSubjectId: p.authorization.payload.candidateSubjectId,
    routeRevision: input.context.targetSnapshot.payload.routeRevision,
    credentialEvidenceId: input.context.credentialEvidence.evidenceId,
    credentialEvidenceSha256: input.context.credentialEvidence.evidenceSha256,
    backupEvidenceId: input.context.backupEvidence.evidenceId,
    backupEvidenceSha256: input.context.backupEvidence.evidenceSha256,
    rollbackEvidenceId: input.context.rollbackEvidence.evidenceId,
    rollbackEvidenceSha256: input.context.rollbackEvidence.evidenceSha256,
    observabilityEvidenceId: input.context.observabilityEvidence.evidenceId,
    observabilityEvidenceSha256: input.context.observabilityEvidence.evidenceSha256,
    runLedgerReferences: derived.runLedgerReferences,
    classification: derived.classification,
    reasons: derived.reasons,
    productionRoutingMutationAuthorized: false,
    automaticRoutingMutationAllowed: false,
    automaticRetryAllowed: false,
    automaticRollbackAllowed: false,
    automaticRedispatchAllowed: false,
  });
  validateProposalPayload(payload);
  const proposalSha256 = await sha256Canonical(payload);
  return deepFreeze({
    schemaVersion: LOCAL_PRODUCTION_ROUTING_READINESS_PROPOSAL_SCHEMA_VERSION,
    algorithm: "sha256" as const,
    proposalId: `m5localprodready:${proposalSha256.slice(0, 32).toLowerCase()}`,
    proposalSha256,
    payload,
  });
}

export async function verifyLocalProductionRoutingReadinessProposal(
  proposal: LocalProductionRoutingReadinessProposal,
  context: LocalProductionRoutingReadinessContext,
): Promise<void> {
  const derived = await verifyReadinessContext(context);
  if (!isRecord(proposal)) throw new Error("Local production readiness proposal must be an object");
  assertExactFields(proposal, PROPOSAL_ENVELOPE_FIELDS, "Local production readiness proposal");
  if (proposal.schemaVersion !== 1 || proposal.algorithm !== "sha256" || !isRecord(proposal.payload)) throw new Error("Local production readiness proposal envelope is invalid");
  const p = proposal.payload as unknown as LocalProductionRoutingReadinessProposalPayload;
  validateProposalPayload(p);
  const a = context.promotionAuthority;
  if (
    p.promotionAuthorizationId !== a.authorization.authorizationId || p.promotionAuthorizationSha256 !== a.authorization.authorizationSha256 ||
    p.promotionProposalId !== a.proposal.proposalId || p.promotionProposalSha256 !== a.proposal.proposalSha256 ||
    p.promotionPreconditionSnapshotId !== a.preconditionSnapshot.snapshotId || p.promotionPreconditionSnapshotSha256 !== a.preconditionSnapshot.snapshotSha256 ||
    p.isolatedMutationReceiptId !== context.isolatedMutationReceipt.receiptId || p.isolatedMutationReceiptSha256 !== context.isolatedMutationReceipt.receiptSha256 ||
    p.targetSnapshotId !== context.targetSnapshot.snapshotId || p.targetSnapshotSha256 !== context.targetSnapshot.snapshotSha256 ||
    p.projectId !== a.authorization.payload.projectId || p.routeId !== a.authorization.payload.routeId || p.capability !== a.authorization.payload.capability ||
    p.referenceSubjectId !== a.authorization.payload.referenceSubjectId || p.candidateSubjectId !== a.authorization.payload.candidateSubjectId ||
    p.routeRevision !== context.targetSnapshot.payload.routeRevision ||
    p.credentialEvidenceId !== context.credentialEvidence.evidenceId || p.credentialEvidenceSha256 !== context.credentialEvidence.evidenceSha256 ||
    p.backupEvidenceId !== context.backupEvidence.evidenceId || p.backupEvidenceSha256 !== context.backupEvidence.evidenceSha256 ||
    p.rollbackEvidenceId !== context.rollbackEvidence.evidenceId || p.rollbackEvidenceSha256 !== context.rollbackEvidence.evidenceSha256 ||
    p.observabilityEvidenceId !== context.observabilityEvidence.evidenceId || p.observabilityEvidenceSha256 !== context.observabilityEvidence.evidenceSha256 ||
    p.classification !== derived.classification || !sameArray(p.reasons, derived.reasons) || !sameArray(p.runLedgerReferences, derived.runLedgerReferences)
  ) throw new Error("Local production readiness proposal canonical source binding drift detected");
  const expected = await sha256Canonical(p);
  if (proposal.proposalSha256 !== expected || proposal.proposalId !== `m5localprodready:${expected.slice(0, 32).toLowerCase()}`) throw new Error("Local production readiness proposal content address is invalid");
}

export async function prepareLocalProductionRoutingReadinessAuthorization(input: {
  readonly proposal: LocalProductionRoutingReadinessProposal;
  readonly context: LocalProductionRoutingReadinessContext;
  readonly currentTargetSnapshot: LocalProductionRoutingTargetSnapshot;
  readonly workflow: WorkflowRun;
  readonly authorization: LocalProductionRoutingReadinessAuthorizationInput;
}): Promise<LocalProductionRoutingReadinessAuthorization> {
  await verifyLocalProductionRoutingReadinessProposal(input.proposal, input.context);
  await verifyLocalProductionRoutingTargetSnapshot(input.currentTargetSnapshot);
  assertTargetFresh(input.proposal, input.currentTargetSnapshot);
  assertR4Workflow(input.workflow, input.proposal.payload.projectId, input.authorization.approvalIds, input.authorization.decision === "allow");
  if (input.authorization.decision === "allow" && input.proposal.payload.classification !== "READY_FOR_LOCAL_PRODUCTION_ADAPTER_IMPLEMENTATION") throw new Error("Local production readiness allow requires READY classification");
  const decidedAt = prepareTimestamp(input.authorization.decidedAt, "Local production readiness authorization decidedAt");
  assertAtOrAfter(decidedAt, [input.proposal.payload.proposedAt, input.workflow.updatedAt], "Local production readiness authorization predates proposal or workflow");
  const approvalIds = normalizeSet(input.authorization.approvalIds, "Local production readiness approvalId", input.authorization.decision === "allow");
  const payload: LocalProductionRoutingReadinessAuthorizationPayload = deepFreeze({
    decision: input.authorization.decision,
    actor: prepareIdentity(input.authorization.actor, "Local production readiness authorization actor"),
    decidedAt,
    approvalIds,
    policyReferences: normalizeSet(input.authorization.policyReferences, "Local production readiness authorization policy reference", true),
    proposalId: input.proposal.proposalId,
    proposalSha256: input.proposal.proposalSha256,
    projectId: input.proposal.payload.projectId,
    routeId: input.proposal.payload.routeId,
    capability: input.proposal.payload.capability,
    targetSnapshotId: input.currentTargetSnapshot.snapshotId,
    targetSnapshotSha256: input.currentTargetSnapshot.snapshotSha256,
    adapterId: input.proposal.payload.adapterId,
    adapterVersion: input.proposal.payload.adapterVersion,
    adapterSourceSha256: input.proposal.payload.adapterSourceSha256,
    mainSourceSha256: input.proposal.payload.mainSourceSha256,
    workflowRunId: input.workflow.id,
    riskClass: "R4",
    implementationReadinessAuthorized: input.authorization.decision === "allow",
    productionRoutingMutationAuthorized: false,
    automaticRoutingMutationAllowed: false,
    automaticRetryAllowed: false,
    automaticRollbackAllowed: false,
    automaticRedispatchAllowed: false,
  });
  validateAuthorizationPayload(payload);
  const authorizationSha256 = await sha256Canonical(payload);
  return deepFreeze({
    schemaVersion: LOCAL_PRODUCTION_ROUTING_READINESS_AUTHORIZATION_SCHEMA_VERSION,
    algorithm: "sha256" as const,
    authorizationId: `m5localprodreadyauth:${authorizationSha256.slice(0, 32).toLowerCase()}`,
    authorizationSha256,
    payload,
  });
}

export async function verifyLocalProductionRoutingReadinessAuthorization(
  authorization: LocalProductionRoutingReadinessAuthorization,
  proposal: LocalProductionRoutingReadinessProposal,
  context: LocalProductionRoutingReadinessContext,
  currentTargetSnapshot: LocalProductionRoutingTargetSnapshot,
  workflow: WorkflowRun,
): Promise<void> {
  await verifyLocalProductionRoutingReadinessProposal(proposal, context);
  await verifyLocalProductionRoutingTargetSnapshot(currentTargetSnapshot);
  assertTargetFresh(proposal, currentTargetSnapshot);
  if (!isRecord(authorization)) throw new Error("Local production readiness authorization must be an object");
  assertExactFields(authorization, AUTH_ENVELOPE_FIELDS, "Local production readiness authorization");
  if (authorization.schemaVersion !== 1 || authorization.algorithm !== "sha256" || !isRecord(authorization.payload)) throw new Error("Local production readiness authorization envelope is invalid");
  const p = authorization.payload as unknown as LocalProductionRoutingReadinessAuthorizationPayload;
  validateAuthorizationPayload(p);
  assertR4Workflow(workflow, proposal.payload.projectId, p.approvalIds, p.decision === "allow");
  if (
    p.proposalId !== proposal.proposalId || p.proposalSha256 !== proposal.proposalSha256 ||
    p.projectId !== proposal.payload.projectId || p.routeId !== proposal.payload.routeId || p.capability !== proposal.payload.capability ||
    p.targetSnapshotId !== currentTargetSnapshot.snapshotId || p.targetSnapshotSha256 !== currentTargetSnapshot.snapshotSha256 ||
    p.adapterId !== proposal.payload.adapterId || p.adapterVersion !== proposal.payload.adapterVersion ||
    p.adapterSourceSha256 !== proposal.payload.adapterSourceSha256 || p.mainSourceSha256 !== proposal.payload.mainSourceSha256 ||
    p.workflowRunId !== workflow.id
  ) throw new Error("Local production readiness authorization scope/source drift detected");
  if (p.decision === "allow" && proposal.payload.classification !== "READY_FOR_LOCAL_PRODUCTION_ADAPTER_IMPLEMENTATION") throw new Error("Local production readiness allow requires READY classification");
  assertAtOrAfter(p.decidedAt, [proposal.payload.proposedAt, workflow.updatedAt], "Local production readiness authorization predates proposal or workflow");
  const expected = await sha256Canonical(p);
  if (authorization.authorizationSha256 !== expected || authorization.authorizationId !== `m5localprodreadyauth:${expected.slice(0, 32).toLowerCase()}`) throw new Error("Local production readiness authorization content address is invalid");
}

async function verifyReadinessContext(context: LocalProductionRoutingReadinessContext): Promise<{
  readonly classification: LocalProductionRoutingReadinessClassification;
  readonly reasons: readonly string[];
  readonly runLedgerReferences: readonly string[];
}> {
  await verifyIsolatedRoutingMutationReceipt(context.isolatedMutationReceipt, context.promotionAuthority, context.isolatedTarget, context.isolatedJournal);
  await verifyLocalProductionRoutingTargetSnapshot(context.targetSnapshot);
  await verifyLocalProductionRoutingReadinessEvidence(context.credentialEvidence);
  await verifyLocalProductionRoutingReadinessEvidence(context.backupEvidence);
  await verifyLocalProductionRoutingReadinessEvidence(context.rollbackEvidence);
  await verifyLocalProductionRoutingReadinessEvidence(context.observabilityEvidence);
  const a = context.promotionAuthority.authorization.payload;
  const t = context.targetSnapshot.payload;
  if (a.decision !== "allow" || a.routingMutationAuthorized !== true) throw new Error("Local production readiness requires verified allowed promotion authorization");
  if (t.projectId !== a.projectId || t.routeId !== a.routeId || t.capability !== a.capability || t.currentSubjectId !== a.referenceSubjectId || t.routeRevision !== a.routeRevision) throw new Error("Local production target snapshot does not match exact promotion reference precondition");
  if (context.backupEvidence.payload.referenceStateSha256 !== context.targetSnapshot.snapshotSha256) throw new Error("Backup evidence reference state does not match exact local production target snapshot");
  if (context.backupEvidence.payload.restoredStateSha256 !== context.targetSnapshot.snapshotSha256 && context.backupEvidence.payload.restoreVerified) throw new Error("Restore evidence claims success for a state that does not match exact reference target snapshot");
  if (context.rollbackEvidence.payload.restoredSubjectId !== a.referenceSubjectId || context.rollbackEvidence.payload.restoredRouteRevision !== a.routeRevision) throw new Error("Rollback rehearsal target does not match exact promotion reference state");
  const runLedgerReferences = canonicalRunLedgerReferences(context.runLedgerRecords, a.projectId);
  if (!sameArray(runLedgerReferences, context.observabilityEvidence.payload.runLedgerReferences)) throw new Error("Observability evidence does not match canonical Run Ledger records");
  const reasons: string[] = [];
  const credential = context.credentialEvidence.payload;
  const backup = context.backupEvidence.payload;
  const rollback = context.rollbackEvidence.payload;
  const observability = context.observabilityEvidence.payload;
  if (rollback.rehearsalResult === "MANUAL_RECONCILIATION_REQUIRED") {
    reasons.push("Rollback rehearsal requires manual reconciliation.");
    return deepFreeze({ classification: "MANUAL_RECONCILIATION_REQUIRED", reasons, runLedgerReferences });
  }
  if (!credential.credentialScopeVerified) reasons.push("Credential scope is not independently verified.");
  if (credential.autonomousWorkerLongLivedSecretAccess) reasons.push("Autonomous worker can access long-lived secret material.");
  if (!credential.exactTargetOnly) reasons.push("Credential/write scope is not bounded to the exact target.");
  if (!credential.providerFailureContained) reasons.push("Provider failure containment is not proven.");
  if (!credential.singleWriterVerified) reasons.push("Single-writer ownership is not proven.");
  if (!backup.backupIntegrityVerified) reasons.push("Backup integrity is not verified.");
  if (!backup.restoreVerified) reasons.push("Exact restore capability is not verified.");
  if (backup.destructiveCleanupPerformed) reasons.push("Readiness evidence performed destructive cleanup.");
  if (rollback.rehearsalResult !== "PASSED" || !rollback.exactReferenceRestored || rollback.duplicateSideEffectObserved || rollback.automaticRollbackAllowed) reasons.push("Rollback rehearsal is not a clean, exact, non-automatic restore proof.");
  if (!observability.approvalAttributionReady || !observability.adapterAttributionReady || !observability.beforeAfterStateAttributionReady || !observability.sanitizedOperationalResultReady) reasons.push("Operational attribution/observability evidence is incomplete.");
  if (runLedgerReferences.length === 0 || observability.traceReferences.length === 0) reasons.push("Run Ledger or trace evidence is missing.");
  return deepFreeze({
    classification: reasons.length === 0 ? "READY_FOR_LOCAL_PRODUCTION_ADAPTER_IMPLEMENTATION" : "NOT_READY",
    reasons,
    runLedgerReferences,
  });
}

async function prepareEvidence<T extends Record<string, unknown>>(
  kind: ReadinessEvidenceKind,
  payload: T,
): Promise<LocalProductionRoutingReadinessEvidence<T>> {
  const evidenceSha256 = await sha256Canonical({ kind, payload });
  return deepFreeze({
    schemaVersion: LOCAL_PRODUCTION_ROUTING_READINESS_EVIDENCE_SCHEMA_VERSION,
    algorithm: "sha256" as const,
    kind,
    evidenceId: `m5localprodproof:${kind}:${evidenceSha256.slice(0, 32).toLowerCase()}`,
    evidenceSha256,
    payload,
  });
}

function validateCredentialEvidencePayload(p: CredentialIsolationReadinessEvidenceInput): void {
  for (const [value, label] of [[p.credentialBrokerId, "credentialBrokerId"], [p.credentialScopeId, "credentialScopeId"], [p.filesystemScopeId, "filesystemScopeId"], [p.networkEgressScopeId, "networkEgressScopeId"], [p.adapterWriteScopeId, "adapterWriteScopeId"]] as const) prepareIdentity(value, `Credential readiness ${label}`);
  normalizeSet(p.evidenceReferences, "Credential evidence reference", true);
  for (const value of [p.credentialScopeVerified, p.autonomousWorkerLongLivedSecretAccess, p.exactTargetOnly, p.providerFailureContained, p.singleWriterVerified]) if (typeof value !== "boolean") throw new Error("Credential readiness booleans are invalid");
  prepareTimestamp(p.observedAt, "Credential readiness observedAt");
}

function validateBackupEvidencePayload(p: BackupRestoreReadinessEvidenceInput): void {
  prepareIdentity(p.backupId, "Backup readiness backupId");
  prepareSha256(p.backupSha256, "Backup readiness backupSha256");
  prepareSha256(p.referenceStateSha256, "Backup readiness referenceStateSha256");
  prepareSha256(p.restoredStateSha256, "Backup readiness restoredStateSha256");
  prepareIdentity(p.retentionPolicyReference, "Backup readiness retentionPolicyReference");
  normalizeSet(p.evidenceReferences, "Backup evidence reference", true);
  for (const value of [p.backupIntegrityVerified, p.restoreVerified, p.destructiveCleanupPerformed]) if (typeof value !== "boolean") throw new Error("Backup readiness booleans are invalid");
  prepareTimestamp(p.observedAt, "Backup readiness observedAt");
}

function validateRollbackEvidencePayload(p: RollbackRehearsalReadinessEvidenceInput): void {
  prepareIdentity(p.rehearsalId, "Rollback readiness rehearsalId");
  if (!["PASSED", "FAILED", "MANUAL_RECONCILIATION_REQUIRED"].includes(p.rehearsalResult)) throw new Error("Rollback readiness result is invalid");
  prepareIdentity(p.restoredSubjectId, "Rollback readiness restoredSubjectId");
  prepareIdentity(p.restoredRouteRevision, "Rollback readiness restoredRouteRevision");
  normalizeSet(p.evidenceReferences, "Rollback evidence reference", true);
  for (const value of [p.exactReferenceRestored, p.duplicateSideEffectObserved, p.automaticRollbackAllowed]) if (typeof value !== "boolean") throw new Error("Rollback readiness booleans are invalid");
  prepareTimestamp(p.observedAt, "Rollback readiness observedAt");
}

function validateObservabilityEvidencePayload(p: ObservabilityReadinessEvidenceInput): void {
  normalizeSet(p.runLedgerReferences, "Observability Run Ledger reference", true);
  normalizeSet(p.traceReferences, "Observability trace reference", true);
  for (const value of [p.approvalAttributionReady, p.adapterAttributionReady, p.beforeAfterStateAttributionReady, p.sanitizedOperationalResultReady]) if (typeof value !== "boolean") throw new Error("Observability readiness booleans are invalid");
  prepareTimestamp(p.observedAt, "Observability readiness observedAt");
}

function validateProposalPayload(p: LocalProductionRoutingReadinessProposalPayload): void {
  for (const [value, label] of [
    [p.adapterId, "adapterId"], [p.adapterVersion, "adapterVersion"], [p.promotionAuthorizationId, "promotionAuthorizationId"],
    [p.promotionProposalId, "promotionProposalId"], [p.promotionPreconditionSnapshotId, "promotionPreconditionSnapshotId"],
    [p.isolatedMutationReceiptId, "isolatedMutationReceiptId"], [p.targetSnapshotId, "targetSnapshotId"], [p.projectId, "projectId"],
    [p.routeId, "routeId"], [p.referenceSubjectId, "referenceSubjectId"], [p.candidateSubjectId, "candidateSubjectId"], [p.routeRevision, "routeRevision"],
    [p.credentialEvidenceId, "credentialEvidenceId"], [p.backupEvidenceId, "backupEvidenceId"], [p.rollbackEvidenceId, "rollbackEvidenceId"], [p.observabilityEvidenceId, "observabilityEvidenceId"],
  ] as const) prepareIdentity(value, `Local production readiness proposal ${label}`);
  prepareCapability(p.capability);
  for (const [value, label] of [
    [p.adapterSourceSha256, "adapterSourceSha256"], [p.mainSourceSha256, "mainSourceSha256"], [p.promotionAuthorizationSha256, "promotionAuthorizationSha256"],
    [p.promotionProposalSha256, "promotionProposalSha256"], [p.promotionPreconditionSnapshotSha256, "promotionPreconditionSnapshotSha256"],
    [p.isolatedMutationReceiptSha256, "isolatedMutationReceiptSha256"], [p.targetSnapshotSha256, "targetSnapshotSha256"],
    [p.credentialEvidenceSha256, "credentialEvidenceSha256"], [p.backupEvidenceSha256, "backupEvidenceSha256"], [p.rollbackEvidenceSha256, "rollbackEvidenceSha256"], [p.observabilityEvidenceSha256, "observabilityEvidenceSha256"],
  ] as const) prepareSha256(value, `Local production readiness proposal ${label}`);
  prepareTimestamp(p.proposedAt, "Local production readiness proposedAt");
  normalizeSet(p.policyReferences, "Local production readiness policy reference", true);
  normalizeSet(p.runLedgerReferences, "Local production readiness Run Ledger reference", true);
  if (!["NOT_READY", "READY_FOR_LOCAL_PRODUCTION_ADAPTER_IMPLEMENTATION", "MANUAL_RECONCILIATION_REQUIRED"].includes(p.classification)) throw new Error("Local production readiness classification is invalid");
  if (!Array.isArray(p.reasons) || p.reasons.some((reason) => typeof reason !== "string" || !reason.trim())) throw new Error("Local production readiness reasons are invalid");
  if (p.productionRoutingMutationAuthorized !== false || p.automaticRoutingMutationAllowed !== false || p.automaticRetryAllowed !== false || p.automaticRollbackAllowed !== false || p.automaticRedispatchAllowed !== false) throw new Error("Local production readiness proposal cannot grant production or automatic mutation authority");
}

function validateAuthorizationPayload(p: LocalProductionRoutingReadinessAuthorizationPayload): void {
  if (p.decision !== "allow" && p.decision !== "deny") throw new Error("Local production readiness authorization decision is invalid");
  for (const [value, label] of [[p.actor, "actor"], [p.proposalId, "proposalId"], [p.projectId, "projectId"], [p.routeId, "routeId"], [p.targetSnapshotId, "targetSnapshotId"], [p.adapterId, "adapterId"], [p.adapterVersion, "adapterVersion"], [p.workflowRunId, "workflowRunId"]] as const) prepareIdentity(value, `Local production readiness authorization ${label}`);
  prepareCapability(p.capability);
  for (const [value, label] of [[p.proposalSha256, "proposalSha256"], [p.targetSnapshotSha256, "targetSnapshotSha256"], [p.adapterSourceSha256, "adapterSourceSha256"], [p.mainSourceSha256, "mainSourceSha256"]] as const) prepareSha256(value, `Local production readiness authorization ${label}`);
  prepareTimestamp(p.decidedAt, "Local production readiness authorization decidedAt");
  normalizeSet(p.approvalIds, "Local production readiness authorization approvalId", p.decision === "allow");
  normalizeSet(p.policyReferences, "Local production readiness authorization policy reference", true);
  if (p.riskClass !== "R4") throw new Error("Local production readiness authorization must be R4");
  if (p.implementationReadinessAuthorized !== (p.decision === "allow")) throw new Error("Local production readiness implementation authority flag is invalid");
  if (p.productionRoutingMutationAuthorized !== false || p.automaticRoutingMutationAllowed !== false || p.automaticRetryAllowed !== false || p.automaticRollbackAllowed !== false || p.automaticRedispatchAllowed !== false) throw new Error("Local production readiness authorization cannot grant production or automatic mutation authority");
}

function assertTargetFresh(proposal: LocalProductionRoutingReadinessProposal, current: LocalProductionRoutingTargetSnapshot): void {
  if (proposal.payload.targetSnapshotId !== current.snapshotId || proposal.payload.targetSnapshotSha256 !== current.snapshotSha256 || proposal.payload.projectId !== current.payload.projectId || proposal.payload.routeId !== current.payload.routeId || proposal.payload.capability !== current.payload.capability || proposal.payload.referenceSubjectId !== current.payload.currentSubjectId || proposal.payload.routeRevision !== current.payload.routeRevision) throw new Error("Local production readiness target snapshot is stale or drifted");
}

function assertR4Workflow(workflow: WorkflowRun, projectId: string, approvalIdsInput: readonly string[], requireApproval: boolean): void {
  if (workflow.projectId !== projectId || workflow.riskClass !== "R4") throw new Error("Local production readiness requires exact R4 workflow scope");
  if (workflow.phase !== "approval" && workflow.phase !== "publish") throw new Error("Local production readiness workflow must be at approval/publish boundary");
  if (requireApproval && workflow.status !== "running") throw new Error("Local production readiness allow requires active workflow");
  const approvals = normalizeSet(approvalIdsInput, "Local production readiness approvalId", requireApproval);
  const durable = normalizeSet(workflow.approvalIds, "Local production readiness durable workflow approvalId", requireApproval);
  if (!sameArray(approvals, durable)) throw new Error("Local production readiness approvalIds do not match durable R4 workflow approvals");
}

function canonicalRunLedgerReferences(records: readonly RunLedgerRecord[], projectId: string): readonly string[] {
  if (!Array.isArray(records) || records.length === 0) return [];
  const refs = records.map((record) => {
    if (!isRecord(record) || record.projectId !== projectId) throw new Error("Local production readiness Run Ledger project scope drift detected");
    if (record.riskClass !== "R3" && record.riskClass !== "R4") throw new Error("Local production readiness Run Ledger evidence must be high-impact/critical");
    if (record.outcome !== "succeeded") throw new Error("Local production readiness Run Ledger evidence must be successful");
    prepareIdentity(record.runId, "Local production readiness Run Ledger runId");
    prepareIdentity(record.traceId, "Local production readiness Run Ledger traceId");
    return `run-ledger:${record.runId}:${record.traceId}`;
  });
  return normalizeSet(refs, "Local production readiness Run Ledger reference", true);
}

function prepareCapability(value: unknown): CapabilityId {
  if (typeof value !== "string" || !(FROZEN_CAPABILITIES as readonly string[]).includes(value)) throw new Error("Local production readiness capability is invalid");
  return value as CapabilityId;
}

function prepareIdentity(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || /\r|\n/.test(value)) throw new Error(`${label} must be canonical non-empty single-line text`);
  if (containsSecretLikeMaterial(value)) throw new Error(`${label} contains secret-like material`);
  return value;
}

function prepareSha256(value: unknown, label: string): string {
  const prepared = prepareIdentity(value, label).toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(prepared)) throw new Error(`${label} must be a SHA-256 digest`);
  return prepared;
}

function prepareTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`${label} must be a valid timestamp`);
  const normalized = new Date(value).toISOString();
  if (normalized !== value) throw new Error(`${label} must use canonical ISO-8601 UTC form`);
  return normalized;
}

function normalizeSet(values: readonly string[], label: string, requireNonEmpty: boolean): readonly string[] {
  if (!Array.isArray(values)) throw new Error(`${label} list is invalid`);
  const normalized = [...new Set(values.map((value) => prepareIdentity(value, label)))].sort();
  if (normalized.length !== values.length) throw new Error(`${label} list contains duplicates`);
  if (requireNonEmpty && normalized.length === 0) throw new Error(`${label} list must not be empty`);
  return deepFreeze(normalized);
}

function assertAtOrAfter(value: string, references: readonly string[], message: string): void {
  const time = Date.parse(value);
  if (references.some((reference) => time < Date.parse(reference))) throw new Error(message);
}

function assertExactFields(value: Record<string, unknown>, expected: ReadonlySet<string>, label: string): void {
  const keys = Object.keys(value);
  for (const key of keys) if (!expected.has(key)) throw new Error(`${label}.${key} is not allowed`);
  for (const key of expected) if (!keys.includes(key)) throw new Error(`${label}.${key} is required`);
}

function sameArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function containsSecretLikeMaterial(value: string): boolean {
  return /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/i.test(value)
    || /(authorization|api[_-]?key|access[_-]?token|password|secret|credential)\s*[:=]/i.test(value)
    || /\bghp_[A-Za-z0-9]{20,}\b/.test(value)
    || /\bgithub_pat_[A-Za-z0-9_]{20,}\b/.test(value)
    || /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function sha256Canonical(value: unknown): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("Web Crypto SHA-256 is unavailable in this runtime");
  const bytes = new TextEncoder().encode(stableStringify(value));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
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
