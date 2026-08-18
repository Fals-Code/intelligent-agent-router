import test from "node:test";
import assert from "node:assert/strict";
import {
  prepareControlledExperimentAuthorization,
  prepareControlledExperimentDefinition,
  verifiedControlledExperimentAuthorizationToEvidence,
  verifyControlledExperimentAuthorization,
  verifyControlledExperimentDefinition,
} from "../dist/index.js";
import {
  authorizationInput,
  controlledExperimentFixture,
  durableApprovedExperimentWorkflow,
  experimentDefinitionInput,
} from "./controlled-experiment-fixture.mjs";

test("controlled experiment definition binds exact eligible admission evidence without granting automatic authority", async (t) => {
  const { admissionDecision } = await controlledExperimentFixture(t);
  const experiment = await prepareControlledExperimentDefinition(admissionDecision, experimentDefinitionInput());
  await verifyControlledExperimentDefinition(experiment, admissionDecision);
  assert.equal(experiment.payload.admissionDecisionId, admissionDecision.decisionId);
  assert.equal(experiment.payload.exposureMode, "shadow_then_bounded_live");
  assert.equal(experiment.payload.shadowFirstRequired, true);
  assert.equal(experiment.payload.rollback.targetSubjectId, admissionDecision.payload.referenceSubjectId);
  assert.equal(experiment.payload.rollback.automaticRollbackAllowed, false);
  assert.equal(experiment.payload.automaticDispatchAllowed, false);
  assert.equal(experiment.payload.productionRoutingMutationAllowed, false);
});

test("controlled experiment definition rejects non-eligible admission and unsafe live budgets", async (t) => {
  const { admissionDecision, nonEligibleDecision } = await controlledExperimentFixture(t);
  await assert.rejects(() => prepareControlledExperimentDefinition(nonEligibleDecision, experimentDefinitionInput()), /requires an eligible M5 admission decision/);
  await assert.rejects(
    () => prepareControlledExperimentDefinition(admissionDecision, experimentDefinitionInput({ riskClass: "R2" })),
    /Bounded-live experiment requires riskClass R3 or R4/,
  );
  await assert.rejects(
    () => prepareControlledExperimentDefinition(admissionDecision, experimentDefinitionInput({
      exposureMode: "shadow_only",
      riskClass: "R1",
      budget: {
        maxTotalSamples: 3,
        minimumShadowSamplesBeforeLive: 0,
        maxLiveSamples: 1,
        maxCandidateLiveSamples: 1,
        maxCandidateTrafficBasisPoints: 10000,
      },
    })),
    /Shadow-only experiment cannot allocate live traffic/,
  );
});

test("controlled experiment authorization binds exact experiment to durable approved workflow approvals", async (t) => {
  const { root, admissionDecision } = await controlledExperimentFixture(t);
  const experiment = await prepareControlledExperimentDefinition(admissionDecision, experimentDefinitionInput());
  const { run: workflow, store } = await durableApprovedExperimentWorkflow(root);
  assert.equal(store.get(workflow.id)?.phase, "publish");
  assert.deepEqual(store.get(workflow.id)?.approvalIds, ["approval:controlled-experiment-1"]);
  const authorization = await prepareControlledExperimentAuthorization(experiment, admissionDecision, workflow, authorizationInput());
  await verifyControlledExperimentAuthorization(authorization, experiment, admissionDecision, workflow);
  assert.equal(authorization.payload.experimentContractAuthorized, true);
  assert.deepEqual(authorization.payload.approvalIds, workflow.approvalIds);
  assert.equal(authorization.payload.automaticDispatchAllowed, false);
  assert.equal(authorization.payload.productionRoutingMutationAllowed, false);
  const evidence = await verifiedControlledExperimentAuthorizationToEvidence(
    authorization,
    experiment,
    admissionDecision,
    workflow,
    "2026-08-18T07:33:00.000Z",
  );
  assert.equal(evidence.kind, "approval");
  assert.equal(evidence.status, "passed");
  assert.match(evidence.reference, /^controlled-experiment-authorization:m5expauth:/);
});

test("controlled experiment allow authorization fails closed on approval, workflow, and experiment drift", async (t) => {
  const { root, admissionDecision } = await controlledExperimentFixture(t);
  const experiment = await prepareControlledExperimentDefinition(admissionDecision, experimentDefinitionInput());
  const { run: workflow } = await durableApprovedExperimentWorkflow(root);
  await assert.rejects(
    () => prepareControlledExperimentAuthorization(experiment, admissionDecision, workflow, authorizationInput({ approvalIds: ["approval:forged"] })),
    /approvalIds do not match durable WorkflowRun approvals/,
  );
  await assert.rejects(
    () => prepareControlledExperimentAuthorization(experiment, admissionDecision, { ...workflow, phase: "approval", status: "waiting_approval" }, authorizationInput()),
    /requires workflow phase=publish/,
  );
  await assert.rejects(
    () => prepareControlledExperimentAuthorization(experiment, admissionDecision, { ...workflow, projectId: "other-project" }, authorizationInput()),
    /workflow projectId does not match/,
  );
  const denied = await prepareControlledExperimentAuthorization(
    experiment,
    admissionDecision,
    { ...workflow, approvalIds: [] },
    authorizationInput({ decision: "deny", approvalIds: [] }),
  );
  assert.equal(denied.payload.experimentContractAuthorized, false);
});

test("controlled experiment definition, authorization, and evidence conversion are structurally fail closed", async (t) => {
  const { root, admissionDecision } = await controlledExperimentFixture(t);
  await assert.rejects(
    () => prepareControlledExperimentDefinition(admissionDecision, { ...experimentDefinitionInput(), unexpected: true }),
    /unexpected is not allowed/,
  );
  const experiment = await prepareControlledExperimentDefinition(admissionDecision, experimentDefinitionInput());
  const { run: workflow } = await durableApprovedExperimentWorkflow(root);
  const authorization = await prepareControlledExperimentAuthorization(experiment, admissionDecision, workflow, authorizationInput());
  const tamperedExperiment = { ...experiment, payload: { ...experiment.payload, automaticDispatchAllowed: true } };
  await assert.rejects(() => verifyControlledExperimentDefinition(tamperedExperiment, admissionDecision), /cannot grant automatic authority|digest does not match/);
  const tamperedAuthorization = { ...authorization, payload: { ...authorization.payload, productionRoutingMutationAllowed: true } };
  await assert.rejects(() => verifyControlledExperimentAuthorization(tamperedAuthorization, experiment, admissionDecision, workflow), /cannot grant automatic dispatch or production routing mutation authority|digest does not match/);
  await assert.rejects(
    () => verifiedControlledExperimentAuthorizationToEvidence(tamperedAuthorization, experiment, admissionDecision, workflow, "2026-08-18T07:34:00.000Z"),
    /cannot grant automatic dispatch or production routing mutation authority|digest does not match/,
  );
});
