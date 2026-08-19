import type { EvidenceRecord, WorkflowRun } from "../control-plane/contracts.js";
import type { EvalCohortSummary } from "./comparative-statistics.js";
import type { ExecutionReliabilitySummary } from "./execution-reliability-statistics.js";
import type { M5AdmissionDecision } from "./m5-admission-gate.js";
import type {
  ControlledExperimentAuthorization,
  ControlledExperimentDefinition,
} from "./controlled-experiment.js";
import {
  verifyControlledExperimentAuthorization,
  verifyControlledExperimentDefinition,
} from "./controlled-experiment.js";
import type {
  ControlledExperimentExecutionAdapter,
  ControlledExperimentExecutionReceipt,
  ControlledExperimentLiveAssignment,
  ControlledExperimentSampleExposure,
} from "./controlled-experiment-execution-adapter.js";
import type {
  ControlledExperimentExecutionJournalEvent,
  ControlledExperimentExecutionJournalState,
  JsonlControlledExperimentExecutionJournal,
} from "./controlled-experiment-execution-journal.js";
import { verifyControlledExperimentExecutionJournalEvent } from "./controlled-experiment-execution-journal.js";
import type { ControlledExperimentGuardrailDecision } from "./controlled-experiment-guardrails.js";
import { evaluateControlledExperimentGuardrails } from "./controlled-experiment-guardrails.js";

export interface ControlledExperimentDispatchSampleInput {
  readonly sampleId: string;
  readonly inputReference: string;
  readonly exposure: ControlledExperimentSampleExposure;
  readonly liveAssignment: ControlledExperimentLiveAssignment;
  readonly requestedAt: string;
}

export interface ControlledExperimentExecutorProgressEvidence {
  readonly observedAt: string;
  readonly referenceEvalSummary: EvalCohortSummary;
  readonly candidateEvalSummary: EvalCohortSummary;
  readonly referenceExecutionSummary: ExecutionReliabilitySummary;
  readonly candidateExecutionSummary: ExecutionReliabilitySummary;
}

export interface DispatchBoundedExperimentSampleInput {
  readonly experiment: ControlledExperimentDefinition;
  readonly authorization: ControlledExperimentAuthorization;
  readonly admissionDecision: M5AdmissionDecision;
  readonly workflow: WorkflowRun;
  readonly request: ControlledExperimentDispatchSampleInput;
  readonly progress?: ControlledExperimentExecutorProgressEvidence;
}

export interface BoundedExperimentDispatchOutcome {
  readonly reservationEvent: ControlledExperimentExecutionJournalEvent;
  readonly dispatchEvent: ControlledExperimentExecutionJournalEvent;
  readonly receipt: ControlledExperimentExecutionReceipt;
  readonly guardrailDecision?: ControlledExperimentGuardrailDecision;
  readonly evidence: EvidenceRecord;
  readonly automaticRedispatchAllowed: false;
  readonly productionRoutingMutationAllowed: false;
}

export interface RecordBoundedExperimentCompletionInput {
  readonly experiment: ControlledExperimentDefinition;
  readonly authorization: ControlledExperimentAuthorization;
  readonly admissionDecision: M5AdmissionDecision;
  readonly workflow: WorkflowRun;
  readonly sampleId: string;
  readonly completedAt: string;
  readonly referenceObservationId: string;
  readonly candidateObservationId: string;
}

export interface BoundedExperimentCompletionOutcome {
  readonly completionEvent: ControlledExperimentExecutionJournalEvent;
  readonly evidence: EvidenceRecord;
  readonly automaticRedispatchAllowed: false;
  readonly productionRoutingMutationAllowed: false;
}

export interface BoundedExperimentExecutorInspection extends ControlledExperimentExecutionJournalState {
  readonly adapterId: string;
  readonly automaticDispatchLoopAllowed: false;
  readonly productionRoutingMutationAllowed: false;
}

export interface BoundedExperimentExecutorOptions {
  readonly maxStringBytes: number;
  readonly now?: () => string;
}

/**
 * Sequential, bounded executor for one explicitly requested controlled-experiment
 * sample at a time.
 *
 * It never chooses a production route, never loops autonomously, and never retries
 * an uncertain dispatch. Reservation is fsync'd before the injected adapter call.
 * The adapter is product/runtime-specific and is expected to reuse canonical
 * runtime binding/reconciliation rather than introducing a provider side channel.
 */
export class BoundedExperimentExecutor {
  private readonly maxStringBytes: number;
  private readonly now: () => string;

  constructor(
    private readonly journal: JsonlControlledExperimentExecutionJournal,
    private readonly adapter: ControlledExperimentExecutionAdapter,
    options: BoundedExperimentExecutorOptions,
  ) {
    assertPositiveInteger(options.maxStringBytes, "Bounded experiment executor maxStringBytes");
    this.maxStringBytes = options.maxStringBytes;
    this.now = options.now ?? (() => new Date().toISOString());
    prepareIdentity(adapter.id, "Bounded experiment adapter id", this.maxStringBytes);
  }

  async dispatchSample(input: DispatchBoundedExperimentSampleInput): Promise<BoundedExperimentDispatchOutcome> {
    await this.verifyAuthority(input.experiment, input.authorization, input.admissionDecision, input.workflow);
    if (this.journal.experimentId !== input.experiment.experimentId) throw new Error("Bounded experiment journal does not belong to exact experiment definition");
    const state = this.journal.inspect();
    if (state.unresolvedSampleIds.length > 0) {
      throw new Error(`Bounded experiment has unresolved sample(s): ${state.unresolvedSampleIds.join(", ")}; manual reconciliation is required before any new dispatch`);
    }

    const guardrailDecision = await this.prepareGuardrailDecision(input, state);
    const request = this.prepareRequest(input.request);
    this.assertDispatchAllowed(input.experiment, state, request, guardrailDecision);

    const reservationEvent = await this.journal.reserveSample({
      sampleId: request.sampleId,
      exposure: request.exposure,
      liveAssignment: request.liveAssignment,
      inputReference: request.inputReference,
      reservedAt: request.requestedAt,
    });

    const candidateVisible = request.exposure === "bounded_live" && request.liveAssignment === "candidate";
    let receipt: ControlledExperimentExecutionReceipt;
    try {
      receipt = await this.adapter.dispatch({
        experimentId: input.experiment.experimentId,
        experimentSha256: input.experiment.experimentSha256,
        authorizationId: input.authorization.authorizationId,
        authorizationSha256: input.authorization.authorizationSha256,
        sampleId: request.sampleId,
        exposure: request.exposure,
        liveAssignment: request.liveAssignment,
        inputReference: request.inputReference,
        referenceSubjectId: input.experiment.payload.referenceSubjectId,
        candidateSubjectId: input.experiment.payload.candidateSubjectId,
        candidateOutputMayBeExternallyVisible: candidateVisible,
        idempotencyKey: `${input.experiment.experimentId}:${request.sampleId}:${reservationEvent.eventSha256}`,
      });
      this.assertReceipt(receipt, input.experiment, request, candidateVisible);
    } catch (error) {
      const message = safeErrorMessage(error);
      try {
        const errorEvent = await this.journal.recordDispatchError({
          sampleId: request.sampleId,
          adapterId: this.adapter.id,
          observedAt: this.now(),
          error: message,
        });
        throw new Error(`${message}; dispatch side effect is unknown and automatic redispatch is forbidden; journal=${errorEvent.eventId}`);
      } catch (journalError) {
        if (journalError instanceof Error && journalError.message.includes("dispatch side effect is unknown")) throw journalError;
        throw new Error(`${message}; failed to persist dispatch uncertainty: ${safeErrorMessage(journalError)}`);
      }
    }

    const dispatchEvent = await this.journal.recordDispatch({
      sampleId: request.sampleId,
      adapterId: receipt.adapterId,
      acceptedAt: receipt.acceptedAt,
      referenceExecutionReference: receipt.referenceExecutionReference,
      candidateExecutionReference: receipt.candidateExecutionReference,
      candidateOutputExternallyVisible: receipt.candidateOutputExternallyVisible,
    });
    const evidence = await controlledExperimentExecutionEventToEvidence(dispatchEvent, receipt.acceptedAt);
    return Object.freeze({
      reservationEvent,
      dispatchEvent,
      receipt: deepFreeze({ ...receipt }),
      guardrailDecision,
      evidence,
      automaticRedispatchAllowed: false as const,
      productionRoutingMutationAllowed: false as const,
    });
  }

  async recordCompletion(input: RecordBoundedExperimentCompletionInput): Promise<BoundedExperimentCompletionOutcome> {
    await this.verifyAuthority(input.experiment, input.authorization, input.admissionDecision, input.workflow);
    if (this.journal.experimentId !== input.experiment.experimentId) throw new Error("Bounded experiment journal does not belong to exact experiment definition");
    const completionEvent = await this.journal.recordCompletion({
      sampleId: prepareIdentity(input.sampleId, "Bounded experiment sampleId", this.maxStringBytes),
      completedAt: prepareTimestamp(input.completedAt, "Bounded experiment completion timestamp"),
      referenceObservationId: prepareSafeReference(input.referenceObservationId, "Bounded experiment reference observationId", this.maxStringBytes),
      candidateObservationId: prepareSafeReference(input.candidateObservationId, "Bounded experiment candidate observationId", this.maxStringBytes),
    });
    const evidence = await controlledExperimentExecutionEventToEvidence(completionEvent, input.completedAt);
    return Object.freeze({
      completionEvent,
      evidence,
      automaticRedispatchAllowed: false as const,
      productionRoutingMutationAllowed: false as const,
    });
  }

  inspect(): BoundedExperimentExecutorInspection {
    return deepFreeze({
      ...this.journal.inspect(),
      adapterId: this.adapter.id,
      automaticDispatchLoopAllowed: false as const,
      productionRoutingMutationAllowed: false as const,
    });
  }

  private async verifyAuthority(
    experiment: ControlledExperimentDefinition,
    authorization: ControlledExperimentAuthorization,
    admissionDecision: M5AdmissionDecision,
    workflow: WorkflowRun,
  ): Promise<void> {
    await verifyControlledExperimentDefinition(experiment, admissionDecision);
    await verifyControlledExperimentAuthorization(authorization, experiment, admissionDecision, workflow);
    if (authorization.payload.decision !== "allow" || authorization.payload.experimentContractAuthorized !== true) {
      throw new Error("Bounded experiment executor requires explicit allow authorization");
    }
    if (authorization.payload.automaticDispatchAllowed !== false || experiment.payload.automaticDispatchAllowed !== false) {
      throw new Error("Bounded experiment contract cannot grant automatic dispatch authority");
    }
  }

  private prepareRequest(input: ControlledExperimentDispatchSampleInput): ControlledExperimentDispatchSampleInput {
    const exposure = input.exposure;
    if (exposure !== "shadow" && exposure !== "bounded_live") throw new Error("Bounded experiment sample exposure is invalid");
    const liveAssignment = input.liveAssignment;
    if (liveAssignment !== "none" && liveAssignment !== "reference" && liveAssignment !== "candidate") throw new Error("Bounded experiment live assignment is invalid");
    if (exposure === "shadow" && liveAssignment !== "none") throw new Error("Shadow sample requires liveAssignment=none");
    if (exposure === "bounded_live" && liveAssignment === "none") throw new Error("Bounded-live sample requires reference or candidate live assignment");
    return deepFreeze({
      sampleId: prepareIdentity(input.sampleId, "Bounded experiment sampleId", this.maxStringBytes),
      inputReference: prepareSafeReference(input.inputReference, "Bounded experiment inputReference", this.maxStringBytes),
      exposure,
      liveAssignment,
      requestedAt: prepareTimestamp(input.requestedAt, "Bounded experiment requestedAt"),
    });
  }

  private async prepareGuardrailDecision(
    input: DispatchBoundedExperimentSampleInput,
    state: ControlledExperimentExecutionJournalState,
  ): Promise<ControlledExperimentGuardrailDecision | undefined> {
    if (state.completedSampleCount === 0) {
      if (input.progress !== undefined) throw new Error("Bounded experiment progress must be omitted before the first completed sample");
      return undefined;
    }
    if (!input.progress) throw new Error("Bounded experiment progress evidence is required after completed samples exist");
    this.assertProgressMatchesJournal(input.progress, state);
    return evaluateControlledExperimentGuardrails({
      experiment: input.experiment,
      authorization: input.authorization,
      admissionDecision: input.admissionDecision,
      workflow: input.workflow,
      progress: {
        observedAt: input.progress.observedAt,
        shadowSamples: state.completedShadowSamples,
        liveSamples: state.completedLiveSamples,
        candidateLiveSamples: state.completedCandidateLiveSamples,
        referenceEvalSummary: input.progress.referenceEvalSummary,
        candidateEvalSummary: input.progress.candidateEvalSummary,
        referenceExecutionSummary: input.progress.referenceExecutionSummary,
        candidateExecutionSummary: input.progress.candidateExecutionSummary,
      },
    });
  }

  private assertProgressMatchesJournal(
    progress: ControlledExperimentExecutorProgressEvidence,
    state: ControlledExperimentExecutionJournalState,
  ): void {
    prepareTimestamp(progress.observedAt, "Bounded experiment progress observedAt");
    const referenceIds = [...progress.referenceEvalSummary.payload.observationIds].sort();
    const candidateIds = [...progress.candidateEvalSummary.payload.observationIds].sort();
    if (!sameArray(referenceIds, state.completedReferenceObservationIds)) throw new Error("Bounded experiment reference Eval summary does not match durable completed-sample observation set");
    if (!sameArray(candidateIds, state.completedCandidateObservationIds)) throw new Error("Bounded experiment candidate Eval summary does not match durable completed-sample observation set");
    if (!sameArray([...progress.referenceExecutionSummary.payload.observationIds].sort(), referenceIds)) throw new Error("Bounded experiment reference execution summary does not match durable Eval observation set");
    if (!sameArray([...progress.candidateExecutionSummary.payload.observationIds].sort(), candidateIds)) throw new Error("Bounded experiment candidate execution summary does not match durable Eval observation set");
  }

  private assertDispatchAllowed(
    experiment: ControlledExperimentDefinition,
    state: ControlledExperimentExecutionJournalState,
    request: ControlledExperimentDispatchSampleInput,
    guardrailDecision?: ControlledExperimentGuardrailDecision,
  ): void {
    const budget = experiment.payload.budget;
    const nextTotal = state.reservedSampleCount + 1;
    if (nextTotal > budget.maxTotalSamples) throw new Error("Bounded experiment total reservation budget would be exceeded");
    if (guardrailDecision && ["STOP_REQUIRED", "ROLLBACK_REQUIRED", "COMPLETE"].includes(guardrailDecision.payload.classification)) {
      throw new Error(`Bounded experiment guardrail classification ${guardrailDecision.payload.classification} forbids new dispatch`);
    }

    if (state.reservedLiveSamples > 0 && request.exposure !== "bounded_live") {
      throw new Error("Bounded experiment exposure cannot return to shadow after live exposure has started");
    }
    if (request.exposure === "shadow") {
      if (state.reservedLiveSamples > 0) throw new Error("Bounded experiment cannot dispatch shadow after live reservation");
      return;
    }

    if (experiment.payload.exposureMode !== "shadow_then_bounded_live") throw new Error("Bounded-live dispatch is forbidden for shadow-only experiment");
    if (state.completedShadowSamples < budget.minimumShadowSamplesBeforeLive) throw new Error("Bounded-live dispatch requires minimum completed shadow samples");
    if (!guardrailDecision) throw new Error("Bounded-live dispatch requires a verified guardrail decision");
    const requiredClassification = state.reservedLiveSamples === 0 ? "ELIGIBLE_FOR_BOUNDED_LIVE" : "CONTINUE_BOUNDED_LIVE";
    if (guardrailDecision.payload.classification !== requiredClassification) {
      throw new Error(`Bounded-live dispatch requires ${requiredClassification}; received ${guardrailDecision.payload.classification}`);
    }
    const nextLive = state.reservedLiveSamples + 1;
    const nextCandidateLive = state.reservedCandidateLiveSamples + (request.liveAssignment === "candidate" ? 1 : 0);
    if (nextLive > budget.maxLiveSamples) throw new Error("Bounded experiment live reservation budget would be exceeded");
    if (nextCandidateLive > budget.maxCandidateLiveSamples) throw new Error("Bounded experiment candidate live reservation budget would be exceeded");
    const candidateBasisPoints = (nextCandidateLive / nextLive) * 10000;
    if (candidateBasisPoints > budget.maxCandidateTrafficBasisPoints) throw new Error("Bounded experiment candidate live traffic ceiling would be exceeded");
  }

  private assertReceipt(
    receipt: ControlledExperimentExecutionReceipt,
    experiment: ControlledExperimentDefinition,
    request: ControlledExperimentDispatchSampleInput,
    expectedCandidateVisible: boolean,
  ): void {
    if (!receipt || typeof receipt !== "object") throw new Error("Bounded experiment adapter receipt must be an object");
    if (receipt.adapterId !== this.adapter.id) throw new Error("Bounded experiment adapter receipt adapterId mismatch");
    if (receipt.experimentId !== experiment.experimentId) throw new Error("Bounded experiment adapter receipt experimentId mismatch");
    if (receipt.sampleId !== request.sampleId) throw new Error("Bounded experiment adapter receipt sampleId mismatch");
    prepareTimestamp(receipt.acceptedAt, "Bounded experiment adapter receipt acceptedAt");
    prepareSafeReference(receipt.referenceExecutionReference, "Bounded experiment reference execution receipt", this.maxStringBytes);
    prepareSafeReference(receipt.candidateExecutionReference, "Bounded experiment candidate execution receipt", this.maxStringBytes);
    if (receipt.candidateOutputExternallyVisible !== expectedCandidateVisible) throw new Error("Bounded experiment adapter receipt candidate visibility mismatch");
  }
}

export async function controlledExperimentExecutionEventToEvidence(
  event: ControlledExperimentExecutionJournalEvent,
  collectedAt: string,
): Promise<EvidenceRecord> {
  await verifyControlledExperimentExecutionJournalEvent(event);
  const at = prepareTimestamp(collectedAt, "Bounded experiment execution evidence collectedAt");
  const failed = event.payload.eventType === "dispatch_error";
  return deepFreeze({
    kind: "other" as const,
    status: failed ? "failed" as const : "passed" as const,
    reference: `controlled-experiment-execution:${event.eventId}`,
    producer: "bounded-experiment-executor",
    collectedAt: at,
    metadata: deepFreeze({
      experimentId: event.payload.experimentId,
      sampleId: event.payload.sampleId,
      eventType: event.payload.eventType,
      automaticRedispatchAllowed: false,
    }),
  });
}

function prepareIdentity(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must not be empty`);
  const normalized = value.trim();
  if (utf8ByteLength(normalized) > maxBytes) throw new Error(`${label} exceeds maxStringBytes`);
  if (/\r|\n/.test(normalized)) throw new Error(`${label} must be single-line`);
  if (sanitizeText(normalized) !== normalized) throw new Error(`${label} contains secret-like material`);
  return normalized;
}

function prepareSafeReference(value: unknown, label: string, maxBytes: number): string {
  return prepareIdentity(value, label, maxBytes);
}

function prepareTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`${label} must be a valid timestamp`);
  return new Date(value).toISOString();
}

function safeErrorMessage(error: unknown): string {
  return sanitizeText(error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, " ").slice(0, 2048);
}

function sanitizeText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [redacted]")
    .replace(/(authorization|api[_-]?key|access[_-]?token|password|secret|credential)\s*[:=]\s*(Bearer\s+)?[^\s,;]+/gi, "$1=[redacted]")
    .replace(/\b(?:ghp_|github_pat_|sk-(?:proj-)?|sb_secret_)[A-Za-z0-9_-]{16,}\b/g, "[redacted]");
}

function sameArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
