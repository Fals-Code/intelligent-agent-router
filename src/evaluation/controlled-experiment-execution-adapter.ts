export type ControlledExperimentSampleExposure = "shadow" | "bounded_live";
export type ControlledExperimentLiveAssignment = "none" | "reference" | "candidate";

export interface ControlledExperimentExecutionDispatchRequest {
  readonly experimentId: string;
  readonly experimentSha256: string;
  readonly authorizationId: string;
  readonly authorizationSha256: string;
  readonly sampleId: string;
  readonly exposure: ControlledExperimentSampleExposure;
  readonly liveAssignment: ControlledExperimentLiveAssignment;
  readonly inputReference: string;
  readonly referenceSubjectId: string;
  readonly candidateSubjectId: string;
  readonly candidateOutputMayBeExternallyVisible: boolean;
  readonly idempotencyKey: string;
}

export interface ControlledExperimentExecutionReceipt {
  readonly adapterId: string;
  readonly experimentId: string;
  readonly sampleId: string;
  readonly acceptedAt: string;
  readonly referenceExecutionReference: string;
  readonly candidateExecutionReference: string;
  readonly candidateOutputExternallyVisible: boolean;
}

/**
 * Product/runtime-specific experiment execution boundary.
 *
 * Implementations are expected to reuse the existing 9Router runtime integration
 * (AgentRuntimeAdapter + durable runtime binding/reconciliation) rather than call
 * providers through a new hidden path. The bounded executor invokes this adapter
 * once per explicitly requested sample; it never owns an autonomous dispatch loop.
 */
export interface ControlledExperimentExecutionAdapter {
  readonly id: string;
  dispatch(request: ControlledExperimentExecutionDispatchRequest): Promise<ControlledExperimentExecutionReceipt>;
}
