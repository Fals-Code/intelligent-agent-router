import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import {
  DurableWorkflowStateMachine,
  JsonlEvalHistory,
  JsonlWorkflowCheckpointStore,
  RoutingEvalPlane,
  assessM5ControlledExperimentAdmission,
  buildCanonicalMetricTaxonomy,
  evaluateControlledExperimentGuardrails,
  prepareBoundedLiveSampleAuthorization,
  prepareControlledExperimentAuthorization,
  prepareControlledExperimentDefinition,
  prepareGoldenTaskSuite,
  prepareM5AdmissionPolicy,
  prepareRoutingPreconditionSnapshot,
  prepareRoutingPromotionAuthorization,
  prepareRoutingPromotionProposal,
  verifiedRoutingPromotionAuthorizationToEvidence,
  verifiedRoutingPromotionProposalToEvidence,
  verifyRoutingPromotionAuthorization,
  verifyRoutingPromotionProposal,
} from "../dist/index.js";
import {
  authorizationInput,
  buildExperimentCohort,
  durableApprovedExperimentWorkflow,
  experimentDefinitionInput,
} from "./controlled-experiment-fixture.mjs";

let workflowSequence = 0;

test("promotion proposal derives canonical Run Ledger/Eval evidence and separate approval authorizes only the exact proposal", async (t) => {
  const fixture = await promotionFixture(t);

  assert.equal(fixture.proposal.payload.classification, "PROMOTION_ELIGIBLE");
  assert.equal(fixture.proposal.payload.automaticRoutingMutationAllowed, false);
  assert.equal(fixture.proposal.payload.automaticRollbackAllowed, false);
  assert.ok(fixture.proposal.payload.runLedgerEvidenceReferences.length >= 2);
  assert.equal(fixture.proposal.payload.evalEvidenceReferences.length, 4);
  assert.equal(fixture.proposal.payload.boundedLiveEvidenceReferences.length, 3);
  assert.ok(
    fixture.proposal.payload.runLedgerEvidenceReferences.every((item) =>
      /:(?:run-ledger):[^:]+:[0-9A-F]{64}$/.test(item),
    ),
  );

  const promotionWorkflow = await approvedPublishWorkflow(
    fixture.root,
    fixture.experiment.payload.projectId,
    "promotion",
    "2026-08-21T03:03:00.000Z",
  );
  const authorization = await prepareRoutingPromotionAuthorization({
    proposal: fixture.proposal,
    proposalContext: fixture.context,
    currentPreconditionSnapshot: fixture.snapshot,
    workflow: promotionWorkflow,
    authorization: promotionAuthorizationInput(
      promotionWorkflow.approvalIds,
      "2026-08-21T03:06:00.000Z",
    ),
  });

  assert.equal(authorization.payload.routingMutationAuthorized, true);
  assert.equal(authorization.payload.automaticRoutingMutationAllowed, false);
  assert.notEqual(authorization.payload.workflowRunId, fixture.experimentWorkflow.id);

  await verifyRoutingPromotionAuthorization(
    authorization,
    fixture.proposal,
    fixture.context,
    fixture.snapshot,
    promotionWorkflow,
  );

  const proposalEvidence = await verifiedRoutingPromotionProposalToEvidence(
    fixture.proposal,
    fixture.context,
    "2026-08-21T03:07:00.000Z",
  );
  const authorizationEvidence = await verifiedRoutingPromotionAuthorizationToEvidence(
    authorization,
    fixture.proposal,
    fixture.context,
    fixture.snapshot,
    promotionWorkflow,
    "2026-08-21T03:08:00.000Z",
  );
  assert.equal(proposalEvidence.status, "passed");
  assert.equal(authorizationEvidence.status, "passed");
});

test("unrelated Eval evidence cannot satisfy promotion provenance even when content-addressed", async (t) => {
  const fixture = await promotionFixture(t);
  const driftedContext = {
    ...fixture.context,
    candidateCohort: {
      ...fixture.context.candidateCohort,
      evalSummary: fixture.context.referenceCohort.evalSummary,
    },
  };
  await assert.rejects(
    verifyRoutingPromotionProposal(fixture.proposal, driftedContext),
    /candidate Eval summary does not match canonical observations|canonical Eval\/Run Ledger identity drift/,
  );
});

test("unrelated canonical Run Ledger evidence cannot satisfy promotion provenance", async (t) => {
  const fixture = await promotionFixture(t);
  const candidateRecords = [...fixture.context.candidateCohort.runLedgerRecords];
  candidateRecords[0] = fixture.context.referenceCohort.runLedgerRecords[0];
  const driftedContext = {
    ...fixture.context,
    candidateCohort: {
      ...fixture.context.candidateCohort,
      runLedgerRecords: candidateRecords,
    },
  };
  await assert.rejects(
    verifyRoutingPromotionProposal(fixture.proposal, driftedContext),
    /Run Ledger|execution summary/,
  );
});

test("same candidate subject with unrelated bounded-live authority is rejected", async (t) => {
  const fixture = await promotionFixture(t);
  const original = fixture.context.publicationEvidence[0];
  const forgedRecovery = await rehashRecovery({
    ...original.recoveryReport.payload,
    authorityId: "m5liveauth:unrelated-authority",
  });
  const driftedContext = {
    ...fixture.context,
    publicationEvidence: [
      {
        ...original,
        recoveryReport: forgedRecovery,
      },
    ],
  };
  await assert.rejects(
    verifyRoutingPromotionProposal(fixture.proposal, driftedContext),
    /exact publication authority\/operation/,
  );
});

test("non-COMPLETE experiment evidence cannot become promotion-eligible", async (t) => {
  const fixture = await promotionFixture(t, {
    maxTotalSamples: 4,
    finalProgress: {
      shadowSamples: 1,
      liveSamples: 1,
      candidateLiveSamples: 1,
    },
  });
  assert.notEqual(fixture.finalGuardrail.payload.classification, "COMPLETE");
  assert.equal(fixture.proposal.payload.classification, "PROMOTION_NOT_ELIGIBLE");

  const workflow = await approvedPublishWorkflow(
    fixture.root,
    fixture.experiment.payload.projectId,
    "ineligible",
    "2026-08-21T03:03:00.000Z",
  );
  await assert.rejects(
    prepareRoutingPromotionAuthorization({
      proposal: fixture.proposal,
      proposalContext: fixture.context,
      currentPreconditionSnapshot: fixture.snapshot,
      workflow,
      authorization: promotionAuthorizationInput(
        workflow.approvalIds,
        "2026-08-21T03:06:00.000Z",
      ),
    }),
    /eligible proposal/,
  );
});

test("reference restore evidence for the exact experiment prevents permanent candidate promotion", async (t) => {
  const fixture = await promotionFixture(t);
  const restoreEvidence = await referenceRestoreEvidence(fixture);
  const context = {
    ...fixture.context,
    referenceRestoreEvidence: [restoreEvidence],
  };
  const proposal = await prepareRoutingPromotionProposal({
    context,
    proposal: proposalInput(),
  });
  assert.equal(proposal.payload.classification, "PROMOTION_NOT_ELIGIBLE");
  assert.match(proposal.payload.reasons.join(","), /reference_restore_observed/);
});

test("stale route snapshot invalidates promotion authorization", async (t) => {
  const fixture = await promotionFixture(t);
  const stale = await prepareRoutingPreconditionSnapshot({
    projectId: fixture.snapshot.payload.projectId,
    routeId: fixture.snapshot.payload.routeId,
    capability: fixture.snapshot.payload.capability,
    currentSubjectId: fixture.snapshot.payload.currentSubjectId,
    routeRevision: "route-revision:2",
    capturedAt: "2026-08-21T03:01:00.000Z",
    policyReferences: ["policy:route-precondition-v1"],
  });
  const workflow = await approvedPublishWorkflow(
    fixture.root,
    fixture.experiment.payload.projectId,
    "stale",
    "2026-08-21T03:03:00.000Z",
  );
  await assert.rejects(
    prepareRoutingPromotionAuthorization({
      proposal: fixture.proposal,
      proposalContext: fixture.context,
      currentPreconditionSnapshot: stale,
      workflow,
      authorization: promotionAuthorizationInput(
        workflow.approvalIds,
        "2026-08-21T03:06:00.000Z",
      ),
    }),
    /stale|drifted/,
  );
});

test("promotion authorization requires a distinct R3/R4 publish workflow and exact durable approvals", async (t) => {
  const fixture = await promotionFixture(t);
  await assert.rejects(
    prepareRoutingPromotionAuthorization({
      proposal: fixture.proposal,
      proposalContext: fixture.context,
      currentPreconditionSnapshot: fixture.snapshot,
      workflow: fixture.experimentWorkflow,
      authorization: promotionAuthorizationInput(
        fixture.experimentWorkflow.approvalIds,
        "2026-08-21T03:06:00.000Z",
      ),
    }),
    /separate workflow/,
  );

  const workflow = await approvedPublishWorkflow(
    fixture.root,
    fixture.experiment.payload.projectId,
    "approval",
    "2026-08-21T03:03:00.000Z",
  );
  await assert.rejects(
    prepareRoutingPromotionAuthorization({
      proposal: fixture.proposal,
      proposalContext: fixture.context,
      currentPreconditionSnapshot: fixture.snapshot,
      workflow,
      authorization: promotionAuthorizationInput(
        ["approval:wrong"],
        "2026-08-21T03:06:00.000Z",
      ),
    }),
    /do not match durable WorkflowRun approvals/,
  );

  await assert.rejects(
    prepareRoutingPromotionAuthorization({
      proposal: fixture.proposal,
      proposalContext: fixture.context,
      currentPreconditionSnapshot: fixture.snapshot,
      workflow: { ...workflow, phase: "review" },
      authorization: promotionAuthorizationInput(
        workflow.approvalIds,
        "2026-08-21T03:06:00.000Z",
      ),
    }),
    /phase=publish/,
  );
});

test("re-hashed semantic forgery cannot grant automatic routing mutation", async (t) => {
  const fixture = await promotionFixture(t);
  const forgedPayload = {
    ...fixture.proposal.payload,
    automaticRoutingMutationAllowed: true,
  };
  const proposalSha256 = await sha256Canonical(forgedPayload);
  const forged = {
    ...fixture.proposal,
    proposalSha256,
    proposalId: `m5routeproposal:${proposalSha256.slice(0, 32).toLowerCase()}`,
    payload: forgedPayload,
  };
  await assert.rejects(
    verifyRoutingPromotionProposal(forged, fixture.context),
    /cannot grant automatic authority/,
  );
});

test("reference/candidate identity swap is rejected even with a valid recomputed digest", async (t) => {
  const fixture = await promotionFixture(t);
  const forgedPayload = {
    ...fixture.proposal.payload,
    referenceSubjectId: fixture.proposal.payload.candidateSubjectId,
    candidateSubjectId: fixture.proposal.payload.referenceSubjectId,
    beforeSubjectId: fixture.proposal.payload.candidateSubjectId,
    afterSubjectId: fixture.proposal.payload.referenceSubjectId,
    rollbackTargetSubjectId: fixture.proposal.payload.candidateSubjectId,
  };
  const proposalSha256 = await sha256Canonical(forgedPayload);
  const forged = {
    ...fixture.proposal,
    proposalSha256,
    proposalId: `m5routeproposal:${proposalSha256.slice(0, 32).toLowerCase()}`,
    payload: forgedPayload,
  };
  await assert.rejects(
    verifyRoutingPromotionProposal(forged, fixture.context),
    /canonical source binding drift|before\/after\/rollback/,
  );
});

test("secret-like route state is rejected before persistence", async () => {
  await assert.rejects(
    prepareRoutingPreconditionSnapshot({
      projectId: "project-controlled-experiment",
      routeId: "route:code-interactive",
      capability: "code.interactive",
      currentSubjectId: "router-controlled-experiment",
      routeRevision: "authorization=Bearer abcdefghijklmnopqrstuvwxyz",
      capturedAt: "2026-08-21T03:01:00.000Z",
      policyReferences: ["policy:route-precondition-v1"],
    }),
    /secret-like material/,
  );
});

async function routingAdmissionFixture(t) {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const root = await mkdtemp(join(tmpdir(), "9router-routing-promotion-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const suite = await prepareGoldenTaskSuite(
    {
      schemaVersion: 1,
      suiteId: "routing-promotion-suite",
      description: "Routing promotion evidence fixture.",
      tasks: [
        {
          id: "route",
          kind: "routing",
          prompt: "Route this synthetic promotion task.",
          critical: true,
          minimumScore: 1,
          assertions: [
            {
              id: "model",
              kind: "primary_model_equals",
              weight: 1,
              expected: "model-a",
            },
            {
              id: "verify",
              kind: "requires_verification_equals",
              weight: 1,
              expected: true,
            },
          ],
        },
      ],
    },
    {
      maxTasks: 8,
      maxAssertionsPerTask: 8,
      maxPromptBytes: 4096,
      maxStringBytes: 2048,
      maxSuiteBytes: 64 * 1024,
    },
  );
  const plane = new RoutingEvalPlane({
    maxReportBytes: 64 * 1024,
    maxSubjectIdBytes: 2048,
  });
  const subject = (id, model) => ({
    id,
    async route() {
      return {
        primaryModel: { candidate: { id: model } },
        selectedSkills: [],
        analysis: { requiresVerification: true },
      };
    },
  });
  const referenceSubjectId = "opencode:9router/hemat";
  const candidateSubjectId = "opencode:9router/smart";
  const referenceReport = await plane.evaluate(
    suite,
    subject(referenceSubjectId, "model-a"),
  );
  const candidateReport = await plane.evaluate(
    suite,
    subject(candidateSubjectId, "model-a"),
  );
  const baselineId = "routing-promotion-baseline";
  const baselineFor = (subjectId) => ({
    schemaVersion: 1,
    baselineId,
    suiteId: suite.suiteId,
    suiteSha256: suite.suiteSha256,
    subjectId,
    minimumWeightedScore: 1,
    minimumTaskPassRate: 1,
    minimumCriticalPassRate: 1,
    maximumFailedTasks: 0,
  });
  const history = await JsonlEvalHistory.open({
    filePath: join(root, "history.jsonl"),
    maxFileBytes: 2 * 1024 * 1024,
    maxObservationBytes: 128 * 1024,
    maxReportBytes: 64 * 1024,
    maxStringBytes: 2048,
    maxSourceReferences: 8,
  });
  const taxonomy = await buildCanonicalMetricTaxonomy();
  const policy = await prepareM5AdmissionPolicy(taxonomy, {
    name: "routing-promotion-admission",
    minimumObservationCount: 3,
    requireExecutionReliability: true,
    requireFullExecutionProvenance: true,
    minimumExecutionSampleCount: 3,
    minimumDecidedExecutionSampleCount: 2,
    minimumLatencyCoverageRatio: 1,
    minimumCostCoverageRatio: 1,
    maximumCoverageRegressionRatio: 0.1,
    maximumWeightedScoreMeanRegression: 0.05,
    maximumTaskPassRateMeanRegression: 0.05,
    maximumCriticalPassRateMeanRegression: 0.05,
    maximumBaselinePassRateRegression: 0.05,
    maximumExecutionSuccessRateRegression: 0.05,
    maximumCancellationRateIncrease: 0.1,
    maximumLatencyMeanIncreaseMs: 25,
    maximumCostMeanIncreaseUsd: 0.02,
  });
  const reference = await buildExperimentCohort({
    history,
    report: referenceReport,
    baseline: baselineFor(referenceSubjectId),
    prefix: "promotion-reference",
    count: 3,
    latencyBase: 150,
    costBase: 0.08,
    minuteBase: 0,
  });
  const candidate = await buildExperimentCohort({
    history,
    report: candidateReport,
    baseline: baselineFor(candidateSubjectId),
    prefix: "promotion-candidate",
    count: 3,
    latencyBase: 120,
    costBase: 0.06,
    minuteBase: 10,
  });
  const admissionDecision = await assessM5ControlledExperimentAdmission({
    taxonomy,
    policy,
    reference,
    candidate,
  });
  return { root, reference, candidate, admissionDecision };
}

async function promotionFixture(t, overrides = {}) {
  const base = await routingAdmissionFixture(t);
  const maxTotalSamples = overrides.maxTotalSamples ?? 3;
  const maxLiveSamples = maxTotalSamples - 1;
  const experiment = await prepareControlledExperimentDefinition(
    base.admissionDecision,
    experimentDefinitionInput({
      budget: {
        maxTotalSamples,
        minimumShadowSamplesBeforeLive: 1,
        maxLiveSamples,
        maxCandidateLiveSamples: maxLiveSamples,
        maxCandidateTrafficBasisPoints: 10000,
      },
    }),
  );
  const { run: experimentWorkflow } = await durableApprovedExperimentWorkflow(base.root);
  const experimentAuthorization = await prepareControlledExperimentAuthorization(
    experiment,
    base.admissionDecision,
    experimentWorkflow,
    authorizationInput(),
  );

  const finalProgress = overrides.finalProgress ?? {
    shadowSamples: 1,
    liveSamples: 2,
    candidateLiveSamples: 2,
  };
  const finalGuardrail = await evaluateControlledExperimentGuardrails({
    experiment,
    authorization: experimentAuthorization,
    admissionDecision: base.admissionDecision,
    workflow: experimentWorkflow,
    progress: {
      observedAt: "2026-08-21T03:00:00.000Z",
      ...finalProgress,
      referenceEvalSummary: base.reference.evalSummary,
      candidateEvalSummary: base.candidate.evalSummary,
      referenceExecutionSummary: base.reference.executionSummary,
      candidateExecutionSummary: base.candidate.executionSummary,
    },
  });

  const publicationEvidence = [
    await candidatePublicationEvidence({
      root: base.root,
      admissionDecision: base.admissionDecision,
      experiment,
      experimentAuthorization,
      experimentWorkflow,
      reference: base.reference,
      candidate: base.candidate,
    }),
  ];

  const snapshot = await prepareRoutingPreconditionSnapshot({
    projectId: experiment.payload.projectId,
    routeId: "route:code-interactive",
    capability: "code.interactive",
    currentSubjectId: experiment.payload.referenceSubjectId,
    routeRevision: "route-revision:1",
    capturedAt: "2026-08-21T03:01:00.000Z",
    policyReferences: ["policy:route-precondition-v1"],
  });
  const context = {
    admissionDecision: base.admissionDecision,
    experiment,
    experimentAuthorization,
    experimentWorkflow,
    finalGuardrailDecision: finalGuardrail,
    preconditionSnapshot: snapshot,
    referenceCohort: cohortEvidence(base.reference),
    candidateCohort: cohortEvidence(base.candidate),
    publicationEvidence,
    referenceRestoreEvidence: [],
  };
  const proposal = await prepareRoutingPromotionProposal({
    context,
    proposal: proposalInput(),
  });
  await verifyRoutingPromotionProposal(proposal, context);
  return {
    ...base,
    experiment,
    experimentWorkflow,
    experimentAuthorization,
    finalGuardrail,
    snapshot,
    context,
    proposal,
  };
}

function cohortEvidence(cohort) {
  return {
    evalSummary: cohort.evalSummary,
    executionSummary: cohort.executionSummary,
    observations: cohort.observations,
    projections: cohort.projections,
    runLedgerRecords: cohort.records,
  };
}

async function candidatePublicationEvidence(input) {
  const preDispatchGuardrail = await evaluateControlledExperimentGuardrails({
    experiment: input.experiment,
    authorization: input.experimentAuthorization,
    admissionDecision: input.admissionDecision,
    workflow: input.experimentWorkflow,
    progress: {
      observedAt: "2026-08-21T02:50:00.000Z",
      shadowSamples: 1,
      liveSamples: 1,
      candidateLiveSamples: 1,
      referenceEvalSummary: input.reference.evalSummary,
      candidateEvalSummary: input.candidate.evalSummary,
      referenceExecutionSummary: input.reference.executionSummary,
      candidateExecutionSummary: input.candidate.executionSummary,
    },
  });
  const liveWorkflow = await approvedPublishWorkflow(
    input.root,
    input.experiment.payload.projectId,
    "live",
    "2026-08-21T02:51:00.000Z",
  );
  const authorizationInputValue = {
    sampleId: "sample:promotion-candidate-2",
    inputReference: "input:promotion-candidate-2",
    liveAssignment: "candidate",
    actor: "operator:bounded-live",
    approvedAt: "2026-08-21T02:55:00.000Z",
    policyReferences: ["policy:bounded-live-v1"],
    approvalIds: liveWorkflow.approvalIds,
  };
  const authorization = await prepareBoundedLiveSampleAuthorization({
    experiment: input.experiment,
    experimentAuthorization: input.experimentAuthorization,
    admissionDecision: input.admissionDecision,
    experimentWorkflow: input.experimentWorkflow,
    guardrailDecision: preDispatchGuardrail,
    liveWorkflow,
    authorization: authorizationInputValue,
  });
  const receipt = await publicationReceipt(authorization);
  const recoveryReport = await recoveryReportForPublication(authorization, receipt);
  return {
    guardrailDecision: preDispatchGuardrail,
    liveWorkflow,
    authorizationInput: authorizationInputValue,
    authorization,
    receipt,
    recoveryReport,
  };
}

async function publicationReceipt(authorization) {
  const payload = {
    sampleAuthorizationId: authorization.authorizationId,
    sampleAuthorizationSha256: authorization.authorizationSha256,
    runtimeResultId: "m5liveresult:promotion-candidate-2",
    runtimeResultSha256:
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    sampleId: authorization.payload.sampleId,
    selectedSubjectId: authorization.payload.selectedSubjectId,
    selectedRole: "candidate",
    sinkId: "isolated-loopback",
    publicationReference: "isolated-publication:promotion-candidate-2",
    publicationIdempotencyKey: `${authorization.authorizationId}:m5liveresult:promotion-candidate-2`,
    sideEffectOperationId: `publication:${authorization.authorizationId}:m5liveresult:promotion-candidate-2`,
    sideEffectCommitEventId: "m5liveeffect:promotion-candidate-2",
    outputSha256:
      "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    outputBytes: 128,
    verifiedAt: "2026-08-21T02:56:00.000Z",
    publishedAt: "2026-08-21T02:57:00.000Z",
    externallyVisible: true,
    candidateOutputExternallyVisible: true,
    rawOutputPersisted: false,
    automaticRetryAllowed: false,
    automaticRollbackAllowed: false,
    productionRoutingMutationAllowed: false,
  };
  const receiptSha256 = await sha256Canonical(payload);
  return {
    schemaVersion: 1,
    algorithm: "sha256",
    receiptId: `m5livepub:${receiptSha256.slice(0, 32).toLowerCase()}`,
    receiptSha256,
    payload,
  };
}

async function recoveryReportForPublication(authorization, receipt) {
  return rehashRecovery({
    operationId: receipt.payload.sideEffectOperationId,
    kind: "publication",
    journalEventId: receipt.payload.sideEffectCommitEventId,
    journalEventType: "operation_committed",
    idempotencyKey: receipt.payload.publicationIdempotencyKey,
    sinkId: receipt.payload.sinkId,
    authorityId: authorization.authorizationId,
    subjectId: authorization.payload.selectedSubjectId,
    sampleId: authorization.payload.sampleId,
    outputSha256: receipt.payload.outputSha256,
    externalReference: receipt.payload.publicationReference,
    classification: "consistent_committed",
    automaticRetryAllowed: false,
    automaticMutationAllowed: false,
    explicitOperatorActionRequired: false,
    observedAt: receipt.payload.publishedAt,
    reason: "Durable side-effect journal contains committed terminal evidence.",
  });
}

async function referenceRestoreEvidence(fixture) {
  const authorizationPayload = {
    actor: "operator:rollback",
    approvedAt: "2026-08-21T02:40:00.000Z",
    policyReferences: ["policy:rollback-v1"],
    approvalIds: ["approval:rollback-1"],
    experimentId: fixture.experiment.experimentId,
    experimentSha256: fixture.experiment.experimentSha256,
    experimentAuthorizationId: fixture.experimentAuthorization.authorizationId,
    experimentAuthorizationSha256: fixture.experimentAuthorization.authorizationSha256,
    guardrailDecisionId: "guardrail:rollback-prior",
    guardrailDecisionSha256:
      "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
    experimentWorkflowRunId: fixture.experimentWorkflow.id,
    rollbackWorkflowRunId: "workflow:rollback-prior",
    projectId: fixture.experiment.payload.projectId,
    riskClass: "R3",
    strategy: "restore_reference_subject",
    targetSubjectId: fixture.experiment.payload.referenceSubjectId,
    guardrailClassification: "ROLLBACK_REQUIRED",
    explicitReferenceRestoreAuthorized: true,
    automaticRollbackAllowed: false,
    generalProductionRoutingMutationAllowed: false,
  };
  const authorizationSha256 = await sha256Canonical(authorizationPayload);
  const authorization = {
    schemaVersion: 1,
    algorithm: "sha256",
    authorizationId: `m5rollbackauth:${authorizationSha256.slice(0, 32).toLowerCase()}`,
    authorizationSha256,
    payload: authorizationPayload,
  };
  const receiptPayload = {
    rollbackAuthorizationId: authorization.authorizationId,
    rollbackAuthorizationSha256: authorization.authorizationSha256,
    experimentId: fixture.experiment.experimentId,
    targetSubjectId: fixture.experiment.payload.referenceSubjectId,
    sinkId: "isolated-loopback",
    restoreReference: "isolated-restore:prior",
    restoreIdempotencyKey: `${authorization.authorizationId}:${fixture.experiment.payload.referenceSubjectId}`,
    sideEffectOperationId: `restore:${authorization.authorizationId}`,
    sideEffectCommitEventId: "m5liveeffect:restore-prior",
    restoredAt: "2026-08-21T02:41:00.000Z",
    activeSubjectId: fixture.experiment.payload.referenceSubjectId,
    referenceSubjectRestored: true,
    automaticRollbackAllowed: false,
    automaticRetryAllowed: false,
    generalProductionRoutingMutationAllowed: false,
  };
  const receiptSha256 = await sha256Canonical(receiptPayload);
  const receipt = {
    schemaVersion: 1,
    algorithm: "sha256",
    receiptId: `m5restore:${receiptSha256.slice(0, 32).toLowerCase()}`,
    receiptSha256,
    payload: receiptPayload,
  };
  const recoveryReport = await rehashRecovery({
    operationId: receipt.payload.sideEffectOperationId,
    kind: "reference_restore",
    journalEventId: receipt.payload.sideEffectCommitEventId,
    journalEventType: "operation_committed",
    idempotencyKey: receipt.payload.restoreIdempotencyKey,
    sinkId: receipt.payload.sinkId,
    authorityId: authorization.authorizationId,
    subjectId: fixture.experiment.payload.referenceSubjectId,
    externalReference: receipt.payload.restoreReference,
    classification: "consistent_committed",
    automaticRetryAllowed: false,
    automaticMutationAllowed: false,
    explicitOperatorActionRequired: false,
    observedAt: receipt.payload.restoredAt,
    reason: "Durable side-effect journal contains committed terminal evidence.",
  });
  return { authorization, receipt, recoveryReport };
}

async function approvedPublishWorkflow(root, projectId, prefix, now) {
  workflowSequence += 1;
  const store = new JsonlWorkflowCheckpointStore({
    filePath: join(root, `routing-promotion-workflow-${workflowSequence}.jsonl`),
    maxFileBytes: 512 * 1024,
    maxCheckpointBytes: 32 * 1024,
  });
  const durable = new DurableWorkflowStateMachine(store);
  const base = Date.parse(now);
  const at = (seconds) => new Date(base + seconds * 1000).toISOString();
  let run = durable.create({
    id: `workflow-${prefix}-${workflowSequence}`,
    projectId,
    riskClass: "R3",
    now: at(0),
  });
  run = durable.start(run, at(1));
  run = durable.advance(run, at(2));
  run = durable.advance(run, at(3));
  run = durable.advance(run, at(4));
  run = durable.advance(run, at(5));
  run = durable.requestApproval(run, at(6));
  run = durable.approve(
    run,
    `approval:${prefix}-${workflowSequence}`,
    at(60),
  );
  return run;
}

function proposalInput() {
  return {
    routeId: "route:code-interactive",
    capability: "code.interactive",
    proposedAt: "2026-08-21T03:02:00.000Z",
    policyReferences: ["policy:routing-promotion-v2"],
  };
}

function promotionAuthorizationInput(approvalIds, decidedAt) {
  return {
    decision: "allow",
    actor: "operator:routing-promotion",
    decidedAt,
    policyReferences: ["policy:routing-promotion-authorization-v1"],
    approvalIds,
  };
}

async function rehashRecovery(payload) {
  const reconciliationSha256 = await sha256Canonical(payload);
  return {
    schemaVersion: 1,
    algorithm: "sha256",
    reconciliationId: `m5livereconcile:${reconciliationSha256
      .slice(0, 32)
      .toLowerCase()}`,
    reconciliationSha256,
    payload,
  };
}

async function sha256Canonical(value) {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(sortJson(value))),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortJson(child)]),
  );
}
