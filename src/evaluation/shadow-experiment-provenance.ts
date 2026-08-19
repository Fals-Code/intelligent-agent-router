import type { RunLedgerRecord, WorkflowRun } from "../control-plane/contracts.js";
import { InMemoryRunLedger } from "../control-plane/run-ledger.js";
import type { ControlledExperimentAuthorization, ControlledExperimentDefinition } from "./controlled-experiment.js";
import { verifyControlledExperimentAuthorization, verifyControlledExperimentDefinition } from "./controlled-experiment.js";
import type {
  ControlledExperimentExecutionJournalEvent,
  JsonlControlledExperimentExecutionJournal,
} from "./controlled-experiment-execution-journal.js";
import { verifyControlledExperimentExecutionJournalEvent } from "./controlled-experiment-execution-journal.js";
import type { EvalHistoryObservation } from "./eval-history.js";
import { verifyEvalHistoryObservation } from "./eval-history.js";
import type { ExecutionMetricProjection } from "./execution-metrics-projection.js";
import {
  executionProjectionToEvalMeasurement,
  verifyExecutionMetricProjection,
} from "./execution-metrics-projection.js";
import type { M5AdmissionDecision } from "./m5-admission-gate.js";

export const SHADOW_EXPERIMENT_SAMPLE_PROVENANCE_SCHEMA_VERSION = 1 as const;

export interface ShadowExperimentSampleProvenancePayload {
  readonly experimentId: string;
  readonly experimentSha256: string;
  readonly authorizationId: string;
  readonly authorizationSha256: string;
  readonly controlWorkflowRunId: string;
  readonly sampleId: string;
  readonly reservationEventId: string;
  readonly dispatchEventId: string;
  readonly completionEventId: string;
  readonly adapterId: string;
  readonly referenceExecutionReference: string;
  readonly candidateExecutionReference: string;
  readonly referenceRunId: string;
  readonly candidateRunId: string;
  readonly referenceProjectionId: string;
  readonly candidateProjectionId: string;
  readonly referenceObservationId: string;
  readonly candidateObservationId: string;
  readonly referenceObservationSha256: string;
  readonly candidateObservationSha256: string;
  readonly exposure: "shadow";
  readonly liveAssignment: "none";
  readonly candidateOutputExternallyVisible: false;
  readonly automaticRedispatchAllowed: false;
  readonly productionRoutingMutationAllowed: false;
}

export interface ShadowExperimentSampleProvenance {
  readonly schemaVersion: typeof SHADOW_EXPERIMENT_SAMPLE_PROVENANCE_SCHEMA_VERSION;
  readonly algorithm: "sha256";
  readonly provenanceId: string;
  readonly provenanceSha256: string;
  readonly payload: ShadowExperimentSampleProvenancePayload;
}

export interface ShadowExperimentSampleProvenanceSources {
  readonly experiment: ControlledExperimentDefinition;
  readonly authorization: ControlledExperimentAuthorization;
  readonly admissionDecision: M5AdmissionDecision;
  readonly workflow: WorkflowRun;
  readonly journal: JsonlControlledExperimentExecutionJournal;
  readonly sampleId: string;
  readonly referenceRun: RunLedgerRecord;
  readonly candidateRun: RunLedgerRecord;
  readonly referenceProjection: ExecutionMetricProjection;
  readonly candidateProjection: ExecutionMetricProjection;
  readonly referenceObservation: EvalHistoryObservation;
  readonly candidateObservation: EvalHistoryObservation;
}

export async function prepareShadowExperimentSampleProvenance(
  sources: ShadowExperimentSampleProvenanceSources,
): Promise<ShadowExperimentSampleProvenance> {
  await verifyControlledExperimentDefinition(sources.experiment, sources.admissionDecision);
  await verifyControlledExperimentAuthorization(
    sources.authorization,
    sources.experiment,
    sources.admissionDecision,
    sources.workflow,
  );
  if (sources.authorization.payload.decision !== "allow" || sources.authorization.payload.experimentContractAuthorized !== true) {
    throw new Error("Shadow experiment provenance requires an explicit allow authorization");
  }
  if (sources.experiment.payload.productionRoutingMutationAllowed !== false || sources.authorization.payload.productionRoutingMutationAllowed !== false) {
    throw new Error("Shadow experiment provenance cannot originate from production routing authority");
  }
  if (sources.journal.experimentId !== sources.experiment.experimentId) {
    throw new Error("Shadow experiment provenance journal does not belong to the exact experiment");
  }

  const sampleId = prepareIdentity(sources.sampleId, "Shadow experiment provenance sampleId");
  const events = sources.journal.list().filter((event) => event.payload.sampleId === sampleId);
  if (events.length !== 3) throw new Error(`Shadow experiment provenance requires exactly three sample events; received ${events.length}`);
  for (const event of events) await verifyControlledExperimentExecutionJournalEvent(event);
  const [reservation, dispatch, completion] = events;
  requireEventType(reservation, "sample_reserved");
  requireEventType(dispatch, "sample_dispatched");
  requireEventType(completion, "sample_completed");
  if (reservation.payload.exposure !== "shadow" || reservation.payload.liveAssignment !== "none") {
    throw new Error("Shadow experiment provenance requires shadow exposure with liveAssignment=none");
  }
  if (dispatch.payload.candidateOutputExternallyVisible !== false) {
    throw new Error("Shadow experiment provenance forbids externally visible candidate output");
  }
  if (reservation.payload.automaticRedispatchAllowed !== false || dispatch.payload.automaticRedispatchAllowed !== false || completion.payload.automaticRedispatchAllowed !== false) {
    throw new Error("Shadow experiment provenance cannot grant automatic redispatch");
  }

  const ledger = new InMemoryRunLedger();
  ledger.append(sources.referenceRun);
  ledger.append(sources.candidateRun);
  const referenceRun = ledger.get(sources.referenceRun.runId);
  const candidateRun = ledger.get(sources.candidateRun.runId);
  if (!referenceRun || !candidateRun) throw new Error("Shadow experiment provenance could not validate canonical Run Ledger records");
  if (referenceRun.runId === candidateRun.runId) throw new Error("Shadow experiment provenance requires distinct reference/candidate Run Ledger records");
  if (referenceRun.outcome !== "succeeded" || candidateRun.outcome !== "succeeded") {
    throw new Error("Shadow experiment provenance requires succeeded reference/candidate Run Ledger outcomes");
  }
  if (referenceRun.projectId !== sources.experiment.payload.projectId || candidateRun.projectId !== sources.experiment.payload.projectId) {
    throw new Error("Shadow experiment provenance runtime Run Ledger projectId does not match experiment projectId");
  }
  assertExecutionReference(dispatch.payload.referenceExecutionReference, "reference", referenceRun);
  assertExecutionReference(dispatch.payload.candidateExecutionReference, "candidate", candidateRun);

  await verifyExecutionMetricProjection(sources.referenceProjection);
  await verifyExecutionMetricProjection(sources.candidateProjection);
  assertProjectionMatchesRun(sources.referenceProjection, referenceRun, "reference");
  assertProjectionMatchesRun(sources.candidateProjection, candidateRun, "candidate");

  await verifyEvalHistoryObservation(sources.referenceObservation);
  await verifyEvalHistoryObservation(sources.candidateObservation);
  if (sources.referenceObservation.observationId === sources.candidateObservation.observationId) {
    throw new Error("Shadow experiment provenance requires distinct reference/candidate Eval observations");
  }
  if (completion.payload.referenceObservationId !== sources.referenceObservation.observationId) {
    throw new Error("Shadow experiment provenance completion referenceObservationId mismatch");
  }
  if (completion.payload.candidateObservationId !== sources.candidateObservation.observationId) {
    throw new Error("Shadow experiment provenance completion candidateObservationId mismatch");
  }
  await assertObservationMatchesProjection(sources.referenceObservation, sources.referenceProjection, "reference");
  await assertObservationMatchesProjection(sources.candidateObservation, sources.candidateProjection, "candidate");

  const state = sources.journal.inspect();
  if (!state.completedReferenceObservationIds.includes(sources.referenceObservation.observationId)
    || !state.completedCandidateObservationIds.includes(sources.candidateObservation.observationId)) {
    throw new Error("Shadow experiment provenance completed observation IDs are not durable in the execution journal");
  }

  const payload: ShadowExperimentSampleProvenancePayload = deepFreeze({
    experimentId: sources.experiment.experimentId,
    experimentSha256: sources.experiment.experimentSha256,
    authorizationId: sources.authorization.authorizationId,
    authorizationSha256: sources.authorization.authorizationSha256,
    controlWorkflowRunId: sources.workflow.id,
    sampleId,
    reservationEventId: reservation.eventId,
    dispatchEventId: dispatch.eventId,
    completionEventId: completion.eventId,
    adapterId: dispatch.payload.adapterId,
    referenceExecutionReference: dispatch.payload.referenceExecutionReference,
    candidateExecutionReference: dispatch.payload.candidateExecutionReference,
    referenceRunId: referenceRun.runId,
    candidateRunId: candidateRun.runId,
    referenceProjectionId: sources.referenceProjection.projectionId,
    candidateProjectionId: sources.candidateProjection.projectionId,
    referenceObservationId: sources.referenceObservation.observationId,
    candidateObservationId: sources.candidateObservation.observationId,
    referenceObservationSha256: sources.referenceObservation.observationSha256,
    candidateObservationSha256: sources.candidateObservation.observationSha256,
    exposure: "shadow" as const,
    liveAssignment: "none" as const,
    candidateOutputExternallyVisible: false as const,
    automaticRedispatchAllowed: false as const,
    productionRoutingMutationAllowed: false as const,
  });
  const provenanceSha256 = await sha256Canonical(payload);
  return deepFreeze({
    schemaVersion: SHADOW_EXPERIMENT_SAMPLE_PROVENANCE_SCHEMA_VERSION,
    algorithm: "sha256" as const,
    provenanceId: `m5shadowprov:${provenanceSha256.slice(0, 32).toLowerCase()}`,
    provenanceSha256,
    payload,
  });
}

export async function verifyShadowExperimentSampleProvenance(
  provenance: ShadowExperimentSampleProvenance,
  sources: ShadowExperimentSampleProvenanceSources,
): Promise<void> {
  if (!isRecord(provenance)) throw new Error("Shadow experiment sample provenance must be an object");
  if (provenance.schemaVersion !== SHADOW_EXPERIMENT_SAMPLE_PROVENANCE_SCHEMA_VERSION || provenance.algorithm !== "sha256") {
    throw new Error("Shadow experiment sample provenance envelope is invalid");
  }
  const expected = await prepareShadowExperimentSampleProvenance(sources);
  if (provenance.provenanceId !== expected.provenanceId || provenance.provenanceSha256 !== expected.provenanceSha256) {
    throw new Error("Shadow experiment sample provenance digest does not match authoritative sources");
  }
  if (stableStringify(provenance.payload) !== stableStringify(expected.payload)) {
    throw new Error("Shadow experiment sample provenance payload does not match authoritative sources");
  }
}

function requireEventType<T extends ControlledExperimentExecutionJournalEvent["payload"]["eventType"]>(
  event: ControlledExperimentExecutionJournalEvent,
  type: T,
): asserts event is ControlledExperimentExecutionJournalEvent & { payload: Extract<ControlledExperimentExecutionJournalEvent["payload"], { eventType: T }> } {
  if (event.payload.eventType !== type) throw new Error(`Shadow experiment provenance expected ${type}; received ${event.payload.eventType}`);
}

function assertExecutionReference(reference: string, role: "reference" | "candidate", run: RunLedgerRecord): void {
  const prepared = prepareIdentity(reference, `Shadow experiment ${role} execution reference`);
  const expectedPrefix = `shadow-runtime:${role}:${run.runtimeId}:${run.runId}:`;
  if (!prepared.startsWith(expectedPrefix)) {
    throw new Error(`Shadow experiment ${role} execution reference does not match canonical Run Ledger runtime/run identity`);
  }
}

function assertProjectionMatchesRun(projection: ExecutionMetricProjection, run: RunLedgerRecord, role: string): void {
  if (projection.payload.runId !== run.runId || projection.payload.projectId !== run.projectId || projection.payload.runtimeId !== run.runtimeId || projection.payload.outcome !== run.outcome) {
    throw new Error(`Shadow experiment ${role} execution projection does not match canonical Run Ledger identity/outcome`);
  }
  if (!projection.payload.sourceReferences.includes(`run-ledger:${run.runId}`)) {
    throw new Error(`Shadow experiment ${role} execution projection lacks canonical Run Ledger source reference`);
  }
}

async function assertObservationMatchesProjection(
  observation: EvalHistoryObservation,
  projection: ExecutionMetricProjection,
  role: string,
): Promise<void> {
  if (!observation.payload.measurement) throw new Error(`Shadow experiment ${role} Eval observation requires an execution measurement`);
  const expectedMeasurement = await executionProjectionToEvalMeasurement(projection);
  if (stableStringify(observation.payload.measurement) !== stableStringify(expectedMeasurement)) {
    throw new Error(`Shadow experiment ${role} Eval observation measurement does not match exact execution projection`);
  }
}

function prepareIdentity(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must not be empty`);
  const prepared = value.trim();
  if (/\r|\n/.test(prepared)) throw new Error(`${label} must be single-line`);
  if (containsSecretLikeMaterial(prepared)) throw new Error(`${label} contains secret-like material`);
  return prepared;
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
