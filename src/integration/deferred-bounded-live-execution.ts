import type { RunLedgerRecord } from "../control-plane/contracts.js";
import type { ControlledExperimentDefinition } from "../evaluation/controlled-experiment.js";
import type { JsonlControlledExperimentExecutionJournal, ControlledExperimentExecutionJournalEvent } from "../evaluation/controlled-experiment-execution-journal.js";
import type { BoundedLiveSampleAuthorization } from "../evaluation/bounded-live-sample-authorization.js";
import { verifyBoundedLiveSampleAuthorizationEnvelope } from "../evaluation/bounded-live-sample-authorization.js";
import type { RuntimeBinding } from "../reconciliation/runtime-reconciliation.js";
import type {
  BoundedLivePublicationReceipt,
  VerifiedBoundedLiveRuntimeResult,
} from "./bounded-live-publication.js";
import {
  verifyBoundedLivePublicationReceipt,
  verifyVerifiedBoundedLiveRuntimeResultEnvelope,
} from "./bounded-live-publication.js";

export const VERIFIED_BOUNDED_LIVE_PAIRED_EXECUTION_SCHEMA_VERSION = 1 as const;

export interface VerifiedBoundedLivePairedExecutionPayload {
  readonly experimentId: string;
  readonly experimentSha256: string;
  readonly sampleAuthorizationId: string;
  readonly sampleAuthorizationSha256: string;
  readonly sampleId: string;
  readonly selectedRole: "reference" | "candidate";
  readonly referenceSubjectId: string;
  readonly candidateSubjectId: string;
  readonly referenceRunId: string;
  readonly candidateRunId: string;
  readonly referenceExecutionReference: string;
  readonly candidateExecutionReference: string;
  readonly referenceVerificationReference: string;
  readonly candidateVerificationReference: string;
  readonly referenceSessionId: string;
  readonly candidateSessionId: string;
  readonly referenceWorkflowAttempt: number;
  readonly candidateWorkflowAttempt: number;
  readonly verifiedAt: string;
  readonly bothRunLedgerOutcomesSucceeded: true;
  readonly rawProviderOutputPersisted: false;
  readonly candidateOutputExternallyVisibleBeforePublication: false;
  readonly automaticRedispatchAllowed: false;
  readonly productionRoutingMutationAllowed: false;
}

export interface VerifiedBoundedLivePairedExecution {
  readonly schemaVersion: typeof VERIFIED_BOUNDED_LIVE_PAIRED_EXECUTION_SCHEMA_VERSION;
  readonly algorithm: "sha256";
  readonly executionId: string;
  readonly executionSha256: string;
  readonly payload: VerifiedBoundedLivePairedExecutionPayload;
}

export async function prepareVerifiedBoundedLivePairedExecution(input: {
  readonly experiment: ControlledExperimentDefinition;
  readonly authorization: BoundedLiveSampleAuthorization;
  readonly referenceRun: RunLedgerRecord;
  readonly candidateRun: RunLedgerRecord;
  readonly referenceBinding: RuntimeBinding;
  readonly candidateBinding: RuntimeBinding;
  readonly referenceVerificationReference: string;
  readonly candidateVerificationReference: string;
  readonly verifiedAt: string;
}): Promise<VerifiedBoundedLivePairedExecution> {
  await verifyBoundedLiveSampleAuthorizationEnvelope(input.authorization);
  const experiment = input.experiment;
  const authorization = input.authorization;
  if (authorization.payload.experimentId !== experiment.experimentId || authorization.payload.experimentSha256 !== experiment.experimentSha256) {
    throw new Error("Deferred bounded-live execution authorization does not match exact experiment");
  }
  if (experiment.payload.referenceSubjectId === experiment.payload.candidateSubjectId) {
    throw new Error("Deferred bounded-live execution requires distinct reference/candidate subjects");
  }
  const expectedSelected = authorization.payload.liveAssignment === "candidate" ? experiment.payload.candidateSubjectId : experiment.payload.referenceSubjectId;
  if (authorization.payload.selectedSubjectId !== expectedSelected) throw new Error("Deferred bounded-live selected subject does not match experiment assignment");

  const reference = verifyRunBinding(
    "reference",
    input.referenceRun,
    input.referenceBinding,
    experiment.payload.referenceSubjectId,
    input.referenceVerificationReference,
    experiment.payload.projectId,
  );
  const candidate = verifyRunBinding(
    "candidate",
    input.candidateRun,
    input.candidateBinding,
    experiment.payload.candidateSubjectId,
    input.candidateVerificationReference,
    experiment.payload.projectId,
  );
  if (reference.runId === candidate.runId || reference.sessionId === candidate.sessionId) {
    throw new Error("Deferred bounded-live execution requires distinct reference/candidate runs and sessions");
  }
  if (normalizePath(input.referenceBinding.workspace) !== normalizePath(input.candidateBinding.workspace)) {
    throw new Error("Deferred bounded-live reference/candidate runtimes must use the same workspace");
  }
  const verifiedAt = prepareTimestamp(input.verifiedAt, "Deferred bounded-live paired verifiedAt");
  if (Date.parse(verifiedAt) < Date.parse(authorization.payload.approvedAt)) {
    throw new Error("Deferred bounded-live paired verification cannot predate sample authorization");
  }

  const payload: VerifiedBoundedLivePairedExecutionPayload = deepFreeze({
    experimentId: experiment.experimentId,
    experimentSha256: experiment.experimentSha256,
    sampleAuthorizationId: authorization.authorizationId,
    sampleAuthorizationSha256: authorization.authorizationSha256,
    sampleId: authorization.payload.sampleId,
    selectedRole: authorization.payload.liveAssignment,
    referenceSubjectId: experiment.payload.referenceSubjectId,
    candidateSubjectId: experiment.payload.candidateSubjectId,
    referenceRunId: reference.runId,
    candidateRunId: candidate.runId,
    referenceExecutionReference: runtimeReference("reference", input.referenceBinding),
    candidateExecutionReference: runtimeReference("candidate", input.candidateBinding),
    referenceVerificationReference: reference.verificationReference,
    candidateVerificationReference: candidate.verificationReference,
    referenceSessionId: input.referenceBinding.sessionId,
    candidateSessionId: input.candidateBinding.sessionId,
    referenceWorkflowAttempt: input.referenceBinding.workflowAttempt,
    candidateWorkflowAttempt: input.candidateBinding.workflowAttempt,
    verifiedAt,
    bothRunLedgerOutcomesSucceeded: true as const,
    rawProviderOutputPersisted: false as const,
    candidateOutputExternallyVisibleBeforePublication: false as const,
    automaticRedispatchAllowed: false as const,
    productionRoutingMutationAllowed: false as const,
  });
  const executionSha256 = await sha256Canonical(payload);
  return deepFreeze({
    schemaVersion: VERIFIED_BOUNDED_LIVE_PAIRED_EXECUTION_SCHEMA_VERSION,
    algorithm: "sha256" as const,
    executionId: `m5livepair:${executionSha256.slice(0, 32).toLowerCase()}`,
    executionSha256,
    payload,
  });
}

export async function verifyVerifiedBoundedLivePairedExecutionEnvelope(execution: VerifiedBoundedLivePairedExecution): Promise<void> {
  if (!execution || typeof execution !== "object" || execution.schemaVersion !== VERIFIED_BOUNDED_LIVE_PAIRED_EXECUTION_SCHEMA_VERSION || execution.algorithm !== "sha256") {
    throw new Error("Deferred bounded-live paired execution envelope is invalid");
  }
  const payload = execution.payload;
  if (!payload || typeof payload !== "object") throw new Error("Deferred bounded-live paired execution payload is invalid");
  if (payload.selectedRole !== "reference" && payload.selectedRole !== "candidate") throw new Error("Deferred bounded-live paired selectedRole is invalid");
  if (payload.referenceRunId === payload.candidateRunId || payload.referenceSessionId === payload.candidateSessionId) throw new Error("Deferred bounded-live paired execution identities must be distinct");
  if (payload.bothRunLedgerOutcomesSucceeded !== true || payload.rawProviderOutputPersisted !== false
    || payload.candidateOutputExternallyVisibleBeforePublication !== false || payload.automaticRedispatchAllowed !== false
    || payload.productionRoutingMutationAllowed !== false) {
    throw new Error("Deferred bounded-live paired execution safety flags are invalid");
  }
  const expected = await sha256Canonical(payload);
  if (execution.executionSha256 !== expected || execution.executionId !== `m5livepair:${expected.slice(0, 32).toLowerCase()}`) {
    throw new Error("Deferred bounded-live paired execution digest is invalid");
  }
}

export class DeferredBoundedLiveExecutor {
  constructor(private readonly journal: JsonlControlledExperimentExecutionJournal) {}

  async reserve(input: {
    readonly experiment: ControlledExperimentDefinition;
    readonly authorization: BoundedLiveSampleAuthorization;
    readonly requestedAt: string;
  }): Promise<ControlledExperimentExecutionJournalEvent> {
    await verifyBoundedLiveSampleAuthorizationEnvelope(input.authorization);
    const { experiment, authorization } = input;
    if (this.journal.experimentId !== experiment.experimentId || authorization.payload.experimentId !== experiment.experimentId
      || authorization.payload.experimentSha256 !== experiment.experimentSha256) {
      throw new Error("Deferred bounded-live journal/authorization does not match exact experiment");
    }
    const state = this.journal.inspect();
    if (state.unresolvedSampleIds.length > 0) throw new Error("Deferred bounded-live execution requires zero unresolved samples before reservation");
    if (state.completedShadowSamples !== authorization.payload.shadowSamplesBeforeLive
      || state.completedLiveSamples !== authorization.payload.liveSamplesBeforeDispatch
      || state.completedCandidateLiveSamples !== authorization.payload.candidateLiveSamplesBeforeDispatch) {
      throw new Error("Deferred bounded-live authorization counters do not match durable completed journal state");
    }
    if (state.reservedLiveSamples !== state.completedLiveSamples || state.reservedCandidateLiveSamples !== state.completedCandidateLiveSamples) {
      throw new Error("Deferred bounded-live journal contains unresolved historical live reservations");
    }
    return this.journal.reserveSample({
      sampleId: authorization.payload.sampleId,
      exposure: "bounded_live",
      liveAssignment: authorization.payload.liveAssignment,
      inputReference: authorization.payload.inputReference,
      reservedAt: prepareTimestamp(input.requestedAt, "Deferred bounded-live requestedAt"),
    });
  }

  async recordPublishedDispatch(input: {
    readonly authorization: BoundedLiveSampleAuthorization;
    readonly pairedExecution: VerifiedBoundedLivePairedExecution;
    readonly selectedRuntimeResult: VerifiedBoundedLiveRuntimeResult;
    readonly publicationReceipt: BoundedLivePublicationReceipt;
  }): Promise<ControlledExperimentExecutionJournalEvent> {
    await verifyBoundedLiveSampleAuthorizationEnvelope(input.authorization);
    await verifyVerifiedBoundedLivePairedExecutionEnvelope(input.pairedExecution);
    await verifyVerifiedBoundedLiveRuntimeResultEnvelope(input.selectedRuntimeResult);
    await verifyBoundedLivePublicationReceipt(input.publicationReceipt);
    const authorization = input.authorization;
    const pair = input.pairedExecution.payload;
    const selected = input.selectedRuntimeResult.payload;
    const publication = input.publicationReceipt.payload;
    if (pair.sampleAuthorizationId !== authorization.authorizationId || pair.sampleAuthorizationSha256 !== authorization.authorizationSha256
      || pair.sampleId !== authorization.payload.sampleId || pair.selectedRole !== authorization.payload.liveAssignment) {
      throw new Error("Deferred bounded-live paired execution does not match exact sample authorization");
    }
    if (selected.sampleAuthorizationId !== authorization.authorizationId || selected.sampleAuthorizationSha256 !== authorization.authorizationSha256
      || selected.sampleId !== authorization.payload.sampleId || selected.role !== pair.selectedRole) {
      throw new Error("Deferred bounded-live selected runtime result does not match pair/authorization");
    }
    const expectedSelectedRunId = pair.selectedRole === "candidate" ? pair.candidateRunId : pair.referenceRunId;
    const expectedSelectedSessionId = pair.selectedRole === "candidate" ? pair.candidateSessionId : pair.referenceSessionId;
    if (selected.runId !== expectedSelectedRunId || selected.sessionId !== expectedSelectedSessionId) {
      throw new Error("Deferred bounded-live selected runtime result is not the selected member of paired execution");
    }
    if (publication.sampleAuthorizationId !== authorization.authorizationId || publication.runtimeResultId !== input.selectedRuntimeResult.resultId
      || publication.sampleId !== authorization.payload.sampleId || publication.selectedRole !== pair.selectedRole) {
      throw new Error("Deferred bounded-live publication receipt does not match selected verified execution");
    }
    if (Date.parse(publication.publishedAt) < Date.parse(pair.verifiedAt)) {
      throw new Error("Deferred bounded-live publication cannot predate paired deterministic verification");
    }
    const latest = this.journal.latest(authorization.payload.sampleId);
    if (!latest || latest.payload.eventType !== "sample_reserved") {
      throw new Error("Deferred bounded-live publication requires unresolved durable sample_reserved state");
    }
    return this.journal.recordDispatch({
      sampleId: authorization.payload.sampleId,
      adapterId: publication.sinkId,
      acceptedAt: publication.publishedAt,
      referenceExecutionReference: pair.referenceExecutionReference,
      candidateExecutionReference: pair.candidateExecutionReference,
      candidateOutputExternallyVisible: publication.candidateOutputExternallyVisible,
    });
  }

  async recordCompletion(input: {
    readonly authorization: BoundedLiveSampleAuthorization;
    readonly completedAt: string;
    readonly referenceObservationId: string;
    readonly candidateObservationId: string;
  }): Promise<ControlledExperimentExecutionJournalEvent> {
    await verifyBoundedLiveSampleAuthorizationEnvelope(input.authorization);
    return this.journal.recordCompletion({
      sampleId: input.authorization.payload.sampleId,
      completedAt: prepareTimestamp(input.completedAt, "Deferred bounded-live completedAt"),
      referenceObservationId: prepareIdentity(input.referenceObservationId, "Deferred bounded-live referenceObservationId"),
      candidateObservationId: prepareIdentity(input.candidateObservationId, "Deferred bounded-live candidateObservationId"),
    });
  }
}

function verifyRunBinding(role: "reference" | "candidate", run: RunLedgerRecord, binding: RuntimeBinding, subjectId: string, verificationReferenceInput: string, projectId: string) {
  if (run.outcome !== "succeeded") throw new Error(`Deferred bounded-live ${role} Run Ledger outcome must be succeeded`);
  if (run.projectId !== projectId || binding.projectId !== projectId) throw new Error(`Deferred bounded-live ${role} projectId mismatch`);
  if (run.runId !== binding.workflowRunId || run.runtimeId !== binding.runtimeId) throw new Error(`Deferred bounded-live ${role} Run Ledger identity does not match RuntimeBinding`);
  if (normalizePath(run.workspace) !== normalizePath(binding.workspace)) throw new Error(`Deferred bounded-live ${role} workspace mismatch`);
  if (!run.modelRoute.includes(subjectId)) throw new Error(`Deferred bounded-live ${role} modelRoute does not contain exact experiment subject`);
  if (!Number.isInteger(binding.workflowAttempt) || binding.workflowAttempt <= 0) throw new Error(`Deferred bounded-live ${role} workflowAttempt is invalid`);
  prepareIdentity(binding.sessionId, `Deferred bounded-live ${role} sessionId`);
  const verificationReference = prepareIdentity(verificationReferenceInput, `Deferred bounded-live ${role} verification reference`);
  if (!run.evidence.some((item) => item.kind === "deterministic_check" && item.status === "passed" && item.reference === verificationReference)) {
    throw new Error(`Deferred bounded-live ${role} lacks exact passed deterministic verification evidence`);
  }
  return { runId: run.runId, sessionId: binding.sessionId, verificationReference };
}

function runtimeReference(role: "reference" | "candidate", binding: RuntimeBinding): string {
  return `bounded-live-runtime:${role}:${binding.runtimeId}:${binding.workflowRunId}:${binding.workflowAttempt}:${binding.sessionId}`;
}
function normalizePath(value: string): string { return value.replace(/\\/g, "/").replace(/\/+$/, ""); }
function prepareIdentity(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must not be empty`);
  const prepared = value.trim();
  if (/\r|\n/.test(prepared)) throw new Error(`${label} must be single-line`);
  return prepared;
}
function prepareTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`${label} must be a valid timestamp`);
  return new Date(value).toISOString();
}
async function sha256Canonical(value: unknown): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("Web Crypto SHA-256 is unavailable in this runtime");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(stableStringify(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
}
function stableStringify(value: unknown): string { return JSON.stringify(sortJson(value)); }
function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, child]) => child !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, sortJson(child)]));
}
function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}
