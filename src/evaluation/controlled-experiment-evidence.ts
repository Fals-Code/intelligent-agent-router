import type { EvidenceRecord, WorkflowRun } from "../control-plane/contracts.js";
import type { M5AdmissionDecision } from "./m5-admission-gate.js";
import type { ControlledExperimentAuthorization, ControlledExperimentDefinition } from "./controlled-experiment.js";
import {
  controlledExperimentAuthorizationToEvidence,
  verifyControlledExperimentAuthorization,
} from "./controlled-experiment.js";
import type { ControlledExperimentGuardrailDecision } from "./controlled-experiment-guardrails.js";
import {
  controlledExperimentGuardrailDecisionToEvidence,
  verifyControlledExperimentGuardrailDecision,
} from "./controlled-experiment-guardrails.js";

/**
 * Re-verifies the exact authorization/experiment/admission/workflow binding before
 * translating it into the existing Run Ledger EvidenceRecord contract.
 */
export async function verifiedControlledExperimentAuthorizationToEvidence(
  authorization: ControlledExperimentAuthorization,
  experiment: ControlledExperimentDefinition,
  admissionDecision: M5AdmissionDecision,
  workflow: WorkflowRun,
  collectedAt: string,
): Promise<EvidenceRecord> {
  await verifyControlledExperimentAuthorization(authorization, experiment, admissionDecision, workflow);
  return controlledExperimentAuthorizationToEvidence(authorization, collectedAt);
}

/**
 * Re-verifies a content-addressed guardrail decision before translating it into
 * the existing Run Ledger EvidenceRecord contract.
 */
export async function verifiedControlledExperimentGuardrailDecisionToEvidence(
  decision: ControlledExperimentGuardrailDecision,
  collectedAt: string,
): Promise<EvidenceRecord> {
  await verifyControlledExperimentGuardrailDecision(decision);
  return controlledExperimentGuardrailDecisionToEvidence(decision, collectedAt);
}
