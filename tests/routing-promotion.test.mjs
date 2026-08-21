import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import {
  DurableWorkflowStateMachine,
  JsonlBoundedLiveSideEffectJournal,
  JsonlEvalHistory,
  JsonlWorkflowCheckpointStore,
  RoutingEvalPlane,
  assessM5ControlledExperimentAdmission,
  buildCanonicalMetricTaxonomy,
  buildEvalCohortSummary,
  buildExecutionReliabilitySummary,
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
let journalSequence = 0;

const SHA_A = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const SHA_B = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const SHA_C = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";

test("promotion proposal derives canonical Eval/Run Ledger, final progress, and durable bounded-live evidence", async (t) => {
  const fixture = await promotionFixture(t);
  assert.equal(fixture.proposal.payload.classification, "PROMOTION_ELIGIBLE");
  assert.equal(fixture.proposal.payload.automaticRoutingMutationAllowed, false);
  assert.equal(fixture.proposal.payload.automaticRollbackAllowed, false);
  assert.match(fixture.proposal.payload.finalProgressSha256, /^[0-9A-F]{64}$/);
  assert.ok(fixture.proposal.payload.runLedgerEvidenceReferences.length >= 2);
  assert.equal(fixture.proposal.payload.evalEvidenceReferences.length, 4);
  assert.equal(fixture.proposal.payload.boundedLiveEvidenceReferences.length, 4);
  assert.ok(
    fixture.proposal.payload.boundedLiveEvidenceReferences.some((item) => item.startsWith("m5liveeffect-ref:")),
  );

  const workflow = await approvedPublishWorkflow(
    fixture.root,
    fixture.experiment.payload.projectId,
    "promotion",
    "2026-08-21T03:03:00.000Z",
  );
  const authorization = await prepareRoutingPromotionAuthorization({
    proposal: fixture.proposal,
    proposalContext: fixture.context,
    currentPreconditionSnapshot: fixture.snapshot,
    workflow,
    authorization: promotionAuthorizationInput(workflow.approvalIds, "2026-08-21T03:06:00.000Z"),
  });
  assert.equal(authorization.payload.routingMutationAuthorized, true);
  assert.equal(authorization.payload.automaticRoutingMutationAllowed, false);
  assert.notEqual(authorization.payload.workflowRunId, fixture.experimentWorkflow.id);
  await verifyRoutingPromotionAuthorization(
    authorization,
    fixture.proposal,
    fixture.context,
    fixture.snapshot,
    workflow,
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
    workflow,
    "2026-08-21T03:08:00.000Z",
  );
  assert.equal(proposalEvidence.status, "passed");
  assert.equal(authorizationEvidence.status, "passed");
});

test("re-hashed COMPLETE guardrail forgery is rejected when final progress does not derive it", async (t) => {
  const fixture = await promotionFixture(t, {
    maxTotalSamples: 4,
    finalProgress: { shadowSamples: 2, liveSamples: 1, candidateLiveSamples: 1 },
  });
  assert.notEqual(fixture.finalGuardrail.payload.classification, "COMPLETE");
  const forgedGuardrail = await rehashGuardrail({
    ...fixture.finalGuardrail.payload,
    classification: "COMPLETE",
    guardrailActionRequired: false,
    boundedLiveAdmissionEligible: false,
  });
  const context = { ...fixture.context, finalGuardrailDecision: forgedGuardrail };
  await assert.rejects(
    prepareRoutingPromotionProposal({ context, proposal: proposalInput() }),
    /re-derived authoritative final progress/,
  );
});

test("auth-matching receipt/recovery without durable journal provenance is rejected", async (t) => {
  const fixture = await promotionFixture(t);
  const emptyJournal = await openSideEffectJournal(fixture.root, "empty");
  const context = { ...fixture.context, sideEffectJournal: emptyJournal };
  await assert.rejects(
    verifyRoutingPromotionProposal(fixture.proposal, context),
    /no canonical durable side-effect journal event/,
  );
});

test("unrelated Eval evidence cannot satisfy promotion provenance", async (t) => {
  const fixture = await promotionFixture(t);
  const context = {
    ...fixture.context,
    candidateCohort: {
      ...fixture.context.candidateCohort,
      evalSummary: fixture.context.referenceCohort.evalSummary,
    },
  };
  await assert.rejects(
    verifyRoutingPromotionProposal(fixture.proposal, context),
    /candidate Eval summary|canonical Eval\/Run Ledger identity drift|final progress summaries drift/,
  );
});

test("unrelated canonical Run Ledger evidence cannot satisfy promotion provenance", async (t) => {
  const fixture = await promotionFixture(t);
  const records = [...fixture.context.candidateCohort.runLedgerRecords];
  records[0] = fixture.context.referenceCohort.runLedgerRecords[0];
  const context = {
    ...fixture.context,
    candidateCohort: { ...fixture.context.candidateCohort, runLedgerRecords: records },
  };
  await assert.rejects(
    verifyRoutingPromotionProposal(fixture.proposal, context),
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
  const context = {
    ...fixture.context,
    publicationEvidence: [{ ...original, recoveryReport: forgedRecovery }],
  };
  await assert.rejects(
    verifyRoutingPromotionProposal(fixture.proposal, context),
    /durable side-effect journal event|candidate publication authority/,
  );
});

test("unresolved exact bounded-live recovery blocks promotion and automatic retry", async (t) => {
  const fixture = await promotionFixture(t);
  const original = fixture.context.publicationEvidence[0];
  const journal = await openSideEffectJournal(fixture.root, "unresolved");
  const auth = original.authorization;
  const operationId = original.receipt.payload.sideEffectOperationId;
  await journal.reserve({
    kind: "publication",
    operationId,
    idempotencyKey: original.receipt.payload.publicationIdempotencyKey,
    sinkId: original.receipt.payload.sinkId,
    authorityId: auth.authorizationId,
    subjectId: auth.payload.selectedSubjectId,
    sampleId: auth.payload.sampleId,
    outputSha256: original.receipt.payload.outputSha256,
    reservedAt: "2026-08-21T02:56:00.000Z",
  });
  const errorEvent = await journal.recordError({
    operationId,
    observedAt: "2026-08-21T02:58:00.000Z",
    error: "synthetic unresolved side effect",
  });
  const recoveryReport = await recoveryReportFromEvent(errorEvent, {
    classification: "manual_reconciliation_required",
    explicitOperatorActionRequired: true,
    probeId: "probe:unresolved-candidate",
    probeStatus: "unknown",
    reason: "Exact candidate publication side effect remains unresolved.",
  });
  const context = {
    ...fixture.context,
    sideEffectJournal: journal,
    publicationEvidence: [{ ...original, receipt: undefined, recoveryReport }],
  };
  const proposal = await prepareRoutingPromotionProposal({ context, proposal: proposalInput() });
  assert.equal(proposal.payload.classification, "MANUAL_RECONCILIATION_REQUIRED");
  assert.equal(proposal.payload.automaticRoutingMutationAllowed, false);
  assert.equal(proposal.payload.automaticRetryAllowed, false);

  const workflow = await approvedPublishWorkflow(
    fixture.root,
    fixture.experiment.payload.projectId,
    "unresolved",
    "2026-08-21T03:03:00.000Z",
  );
  await assert.rejects(
    prepareRoutingPromotionAuthorization({
      proposal,
      proposalContext: context,
      currentPreconditionSnapshot: fixture.snapshot,
      workflow,
      authorization: promotionAuthorizationInput(workflow.approvalIds, "2026-08-21T03:06:00.000Z"),
    }),
    /eligible proposal/,
  );
});

test("non-COMPLETE experiment evidence cannot become promotion eligible", async (t) => {
  const fixture = await promotionFixture(t, {
    maxTotalSamples: 4,
    finalProgress: { shadowSamples: 2, liveSamples: 1, candidateLiveSamples: 1 },
  });
  assert.notEqual(fixture.finalGuardrail.payload.classification, "COMPLETE");
  assert.equal(fixture.proposal.payload.classification, "PROMOTION_NOT_ELIGIBLE");
});

test("reference restore durable evidence prevents permanent candidate promotion", async (t) => {
  const fixture = await promotionFixture(t);
  const restoreEvidence = await referenceRestoreEvidence(fixture);
  const context = { ...fixture.context, referenceRestoreEvidence: [restoreEvidence] };
  const proposal = await prepareRoutingPromotionProposal({ context, proposal: proposalInput() });
  assert.equal(proposal.payload.classification, "PROMOTION_NOT_ELIGIBLE");
  assert.match(proposal.payload.reasons.join(","), /reference_restore_observed/);
});

test("stale or different route snapshot cannot reuse promotion authorization", async (t) => {
  const fixture = await promotionFixture(t);
  const workflow = await approvedPublishWorkflow(
    fixture.root,
    fixture.experiment.payload.projectId,
    "route-reuse",
    "2026-08-21T03:03:00.000Z",
  );
  const authorization = await prepareRoutingPromotionAuthorization({
    proposal: fixture.proposal,
    proposalContext: fixture.context,
    currentPreconditionSnapshot: fixture.snapshot,
    workflow,
    authorization: promotionAuthorizationInput(workflow.approvalIds, "2026-08-21T03:06:00.000Z"),
  });
  const anotherRoute = await prepareRoutingPreconditionSnapshot({
    projectId: fixture.snapshot.payload.projectId,
    routeId: "route:another-code-interactive",
    capability: fixture.snapshot.payload.capability,
    currentSubjectId: fixture.snapshot.payload.currentSubjectId,
    routeRevision: fixture.snapshot.payload.routeRevision,
    capturedAt: fixture.snapshot.payload.capturedAt,
    policyReferences: fixture.snapshot.payload.policyReferences,
  });
  await assert.rejects(
    verifyRoutingPromotionAuthorization(
      authorization,
      fixture.proposal,
      fixture.context,
      anotherRoute,
      workflow,
    ),
    /stale|drifted/,
  );
});

test("promotion authorization requires distinct R3/R4 publish workflow and exact durable approvals", async (t) => {
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
      authorization: promotionAuthorizationInput(["approval:wrong"], "2026-08-21T03:06:00.000Z"),
    }),
    /do not match durable WorkflowRun approvals/,
  );
  await assert.rejects(
    prepareRoutingPromotionAuthorization({
      proposal: fixture.proposal,
      proposalContext: fixture.context,
      currentPreconditionSnapshot: fixture.snapshot,
      workflow: { ...workflow, phase: "review" },
      authorization: promotionAuthorizationInput(workflow.approvalIds, "2026-08-21T03:06:00.000Z"),
    }),
    /phase=publish/,
  );
  await assert.rejects(
    prepareRoutingPromotionAuthorization({
      proposal: fixture.proposal,
      proposalContext: fixture.context,
      currentPreconditionSnapshot: fixture.snapshot,
      workflow: { ...workflow, riskClass: "R2" },
      authorization: promotionAuthorizationInput(workflow.approvalIds, "2026-08-21T03:06:00.000Z"),
    }),
    /riskClass R3 or R4/,
  );
});

test("re-hashed semantic forgery cannot grant automatic routing mutation in proposal", async (t) => {
  const fixture = await promotionFixture(t);
  const payload = { ...fixture.proposal.payload, automaticRoutingMutationAllowed: true };
  const forged = await rehashProposal(payload);
  await assert.rejects(
    verifyRoutingPromotionProposal(forged, fixture.context),
    /cannot grant automatic authority/,
  );
});

test("re-hashed authorization cannot forge automatic authority flags", async (t) => {
  const fixture = await promotionFixture(t);
  const workflow = await approvedPublishWorkflow(
    fixture.root,
    fixture.experiment.payload.projectId,
    "auth-forgery",
    "2026-08-21T03:03:00.000Z",
  );
  const authorization = await prepareRoutingPromotionAuthorization({
    proposal: fixture.proposal,
    proposalContext: fixture.context,
    currentPreconditionSnapshot: fixture.snapshot,
    workflow,
    authorization: promotionAuthorizationInput(workflow.approvalIds, "2026-08-21T03:06:00.000Z"),
  });
  const forged = await rehashRoutingAuthorization({
    ...authorization.payload,
    automaticRoutingMutationAllowed: true,
  });
  await assert.rejects(
    verifyRoutingPromotionAuthorization(
      forged,
      fixture.proposal,
      fixture.context,
      fixture.snapshot,
      workflow,
    ),
    /authority flags are invalid/,
  );
});

test("reference/candidate identity swap is rejected despite recomputed digest", async (t) => {
  const fixture = await promotionFixture(t);
  const payload = {
    ...fixture.proposal.payload,
    referenceSubjectId: fixture.proposal.payload.candidateSubjectId,
    candidateSubjectId: fixture.proposal.payload.referenceSubjectId,
    beforeSubjectId: fixture.proposal.payload.candidateSubjectId,
    afterSubjectId: fixture.proposal.payload.referenceSubjectId,
    rollbackTargetSubjectId: fixture.proposal.payload.candidateSubjectId,
  };
  const forged = await rehashProposal(payload);
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
      tasks: [{
        id: "route",
        kind: "routing",
        prompt: "Route this synthetic promotion task.",
        critical: true,
        minimumScore: 1,
        assertions: [
          { id: "model", kind: "primary_model_equals", weight: 1, expected: "model-a" },
          { id: "verify", kind: "requires_verification_equals", weight: 1, expected: true },
        ],
      }],
    },
    {
      maxTasks: 8,
      maxAssertionsPerTask: 8,
      maxPromptBytes: 4096,
      maxStringBytes: 2048,
      maxSuiteBytes: 64 * 1024,
    },
  );
  const plane = new RoutingEvalPlane({ maxReportBytes: 64 * 1024, maxSubjectIdBytes: 2048 });
  const subject = (id) => ({
    id,
    async route() {
      return {
        primaryModel: { candidate: { id: "model-a" } },
        selectedSkills: [],
        analysis: { requiresVerification: true },
      };
    },
  });
  const referenceSubjectId = "opencode:9router/hemat";
  const candidateSubjectId = "opencode:9router/smart";
  const referenceReport = await plane.evaluate(suite, subject(referenceSubjectId));
  const candidateReport = await plane.evaluate(suite, subject(candidateSubjectId));
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
  const counters = overrides.finalProgress ?? {
    shadowSamples: 1,
    liveSamples: 2,
    candidateLiveSamples: 2,
  };
  const finalProgress = {
    observedAt: "2026-08-21T03:00:00.000Z",
    ...counters,
    referenceEvalSummary: base.reference.evalSummary,
    candidateEvalSummary: base.candidate.evalSummary,
    referenceExecutionSummary: base.reference.executionSummary,
    candidateExecutionSummary: base.candidate.executionSummary,
  };
  const finalGuardrail = await evaluateControlledExperimentGuardrails({
    experiment,
    authorization: experimentAuthorization,
    admissionDecision: base.admissionDecision,
    workflow: experimentWorkflow,
    progress: finalProgress,
  });
  const sideEffectJournal = await openSideEffectJournal(base.root, "canonical");
  const publicationEvidence = [await candidatePublicationEvidence({
    root: base.root,
    admissionDecision: base.admissionDecision,
    experiment,
    experimentAuthorization,
    experimentWorkflow,
    reference: base.reference,
    candidate: base.candidate,
    sideEffectJournal,
  })];
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
    finalProgress,
    finalGuardrailDecision: finalGuardrail,
    sideEffectJournal,
    preconditionSnapshot: snapshot,
    referenceCohort: cohortEvidence(base.reference),
    candidateCohort: cohortEvidence(base.candidate),
    publicationEvidence,
    referenceRestoreEvidence: [],
  };
  const proposal = await prepareRoutingPromotionProposal({ context, proposal: proposalInput() });
  await verifyRoutingPromotionProposal(proposal, context);
  return {
    ...base,
    experiment,
    experimentWorkflow,
    experimentAuthorization,
    finalProgress,
    finalGuardrail,
    sideEffectJournal,
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
  const referenceObservations = input.reference.observations.slice(0, 2);
  const candidateObservations = input.candidate.observations.slice(0, 2);
  const referenceEvalSummary = await buildEvalCohortSummary(referenceObservations);
  const candidateEvalSummary = await buildEvalCohortSummary(candidateObservations);
  const referenceExecutionSummary = await buildExecutionReliabilitySummary(
    referenceObservations,
    input.reference.projections.slice(0, 2),
    input.reference.records.slice(0, 2),
  );
  const candidateExecutionSummary = await buildExecutionReliabilitySummary(
    candidateObservations,
    input.candidate.projections.slice(0, 2),
    input.candidate.records.slice(0, 2),
  );
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
      referenceEvalSummary,
      candidateEvalSummary,
      referenceExecutionSummary,
      candidateExecutionSummary,
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
  const runtimeResultId = "m5liveresult:promotion-candidate-2";
  const operationId = `publication:${authorization.authorizationId}:${runtimeResultId}`;
  const idempotencyKey = `${authorization.authorizationId}:${runtimeResultId}`;
  await input.sideEffectJournal.reserve({
    kind: "publication",
    operationId,
    idempotencyKey,
    sinkId: "isolated-loopback",
    authorityId: authorization.authorizationId,
    subjectId: authorization.payload.selectedSubjectId,
    sampleId: authorization.payload.sampleId,
    outputSha256: SHA_B,
    reservedAt: "2026-08-21T02:56:00.000Z",
  });
  const commitEvent = await input.sideEffectJournal.recordCommit({
    operationId,
    externalReference: "isolated-publication:promotion-candidate-2",
    committedAt: "2026-08-21T02:57:00.000Z",
  });
  const receipt = await publicationReceipt(authorization, commitEvent, runtimeResultId);
  const recoveryReport = await recoveryReportFromEvent(commitEvent, {
    classification: "consistent_committed",
    explicitOperatorActionRequired: false,
    reason: "Canonical durable side-effect journal contains committed terminal evidence.",
  });
  return {
    guardrailDecision: preDispatchGuardrail,
    liveWorkflow,
    authorizationInput: authorizationInputValue,
    authorization,
    receipt,
    recoveryReport,
  };
}

async function publicationReceipt(authorization, commitEvent, runtimeResultId) {
  const payload = {
    sampleAuthorizationId: authorization.authorizationId,
    sampleAuthorizationSha256: authorization.authorizationSha256,
    runtimeResultId,
    runtimeResultSha256: SHA_A,
    sampleId: authorization.payload.sampleId,
    selectedSubjectId: authorization.payload.selectedSubjectId,
    selectedRole: "candidate",
    sinkId: commitEvent.payload.sinkId,
    publicationReference: commitEvent.payload.externalReference,
    publicationIdempotencyKey: commitEvent.payload.idempotencyKey,
    sideEffectOperationId: commitEvent.payload.operationId,
    sideEffectCommitEventId: commitEvent.eventId,
    outputSha256: commitEvent.payload.outputSha256,
    outputBytes: 128,
    verifiedAt: "2026-08-21T02:56:00.000Z",
    publishedAt: commitEvent.payload.committedAt,
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

async function referenceRestoreEvidence(fixture) {
  const authorizationPayload = {
    actor: "operator:rollback",
    approvedAt: "2026-08-21T03:10:00.000Z",
    policyReferences: ["policy:rollback-v1"],
    approvalIds: ["approval:rollback-1"],
    experimentId: fixture.experiment.experimentId,
    experimentSha256: fixture.experiment.experimentSha256,
    experimentAuthorizationId: fixture.experimentAuthorization.authorizationId,
    experimentAuthorizationSha256: fixture.experimentAuthorization.authorizationSha256,
    guardrailDecisionId: "guardrail:rollback-prior",
    guardrailDecisionSha256: SHA_C,
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
  const operationId = `restore:${authorization.authorizationId}`;
  const idempotencyKey = `${authorization.authorizationId}:${fixture.experiment.payload.referenceSubjectId}`;
  await fixture.sideEffectJournal.reserve({
    kind: "reference_restore",
    operationId,
    idempotencyKey,
    sinkId: "isolated-loopback",
    authorityId: authorization.authorizationId,
    subjectId: fixture.experiment.payload.referenceSubjectId,
    reservedAt: "2026-08-21T03:10:00.000Z",
  });
  const commitEvent = await fixture.sideEffectJournal.recordCommit({
    operationId,
    externalReference: "isolated-restore:prior",
    committedAt: "2026-08-21T03:11:00.000Z",
  });
  const receiptPayload = {
    rollbackAuthorizationId: authorization.authorizationId,
    rollbackAuthorizationSha256: authorization.authorizationSha256,
    experimentId: fixture.experiment.experimentId,
    targetSubjectId: fixture.experiment.payload.referenceSubjectId,
    sinkId: commitEvent.payload.sinkId,
    restoreReference: commitEvent.payload.externalReference,
    restoreIdempotencyKey: commitEvent.payload.idempotencyKey,
    sideEffectOperationId: operationId,
    sideEffectCommitEventId: commitEvent.eventId,
    restoredAt: commitEvent.payload.committedAt,
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
  const recoveryReport = await recoveryReportFromEvent(commitEvent, {
    classification: "consistent_committed",
    explicitOperatorActionRequired: false,
    reason: "Canonical durable side-effect journal contains committed terminal restore evidence.",
  });
  return { authorization, receipt, recoveryReport };
}

async function recoveryReportFromEvent(event, overrides) {
  const payload = event.payload;
  const recoveryPayload = {
    operationId: payload.operationId,
    kind: payload.kind,
    journalEventId: event.eventId,
    journalEventType: payload.eventType,
    idempotencyKey: payload.idempotencyKey,
    sinkId: payload.sinkId,
    authorityId: payload.authorityId,
    subjectId: payload.subjectId,
    sampleId: payload.sampleId,
    outputSha256: payload.outputSha256,
    probeId: overrides.probeId,
    probeStatus: overrides.probeStatus,
    externalReference: payload.eventType === "operation_committed" ? payload.externalReference : undefined,
    classification: overrides.classification,
    automaticRetryAllowed: false,
    automaticMutationAllowed: false,
    explicitOperatorActionRequired: overrides.explicitOperatorActionRequired,
    observedAt: payload.eventType === "operation_committed"
      ? payload.committedAt
      : payload.eventType === "operation_error"
        ? payload.observedAt
        : payload.reservedAt,
    reason: overrides.reason,
  };
  return rehashRecovery(recoveryPayload);
}

async function openSideEffectJournal(root, label) {
  journalSequence += 1;
  return JsonlBoundedLiveSideEffectJournal.open({
    filePath: join(root, `routing-promotion-side-effects-${label}-${journalSequence}.jsonl`),
    maxFileBytes: 2 * 1024 * 1024,
    maxEventBytes: 128 * 1024,
    maxStringBytes: 4096,
  });
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
  run = durable.approve(run, `approval:${prefix}-${workflowSequence}`, at(60));
  return run;
}

function proposalInput() {
  return {
    routeId: "route:code-interactive",
    capability: "code.interactive",
    proposedAt: "2026-08-21T03:02:00.000Z",
    policyReferences: ["policy:routing-promotion-v3"],
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

async function rehashGuardrail(payload) {
  const decisionSha256 = await sha256Canonical(payload);
  return {
    schemaVersion: 1,
    algorithm: "sha256",
    decisionId: `m5expguard:${decisionSha256.slice(0, 32).toLowerCase()}`,
    decisionSha256,
    payload,
  };
}

async function rehashRecovery(payload) {
  const reconciliationSha256 = await sha256Canonical(payload);
  return {
    schemaVersion: 1,
    algorithm: "sha256",
    reconciliationId: `m5livereconcile:${reconciliationSha256.slice(0, 32).toLowerCase()}`,
    reconciliationSha256,
    payload,
  };
}

async function rehashProposal(payload) {
  const proposalSha256 = await sha256Canonical(payload);
  return {
    schemaVersion: 1,
    algorithm: "sha256",
    proposalId: `m5routeproposal:${proposalSha256.slice(0, 32).toLowerCase()}`,
    proposalSha256,
    payload,
  };
}

async function rehashRoutingAuthorization(payload) {
  const authorizationSha256 = await sha256Canonical(payload);
  return {
    schemaVersion: 1,
    algorithm: "sha256",
    authorizationId: `m5routeauth:${authorizationSha256.slice(0, 32).toLowerCase()}`,
    authorizationSha256,
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
