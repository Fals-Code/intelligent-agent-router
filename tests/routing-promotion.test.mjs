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

test("promotion proposal is evidence-bound and separate approval authorizes only the exact proposal", async (t) => {
  const fixture = await promotionFixture(t);

  assert.equal(fixture.proposal.payload.classification, "PROMOTION_ELIGIBLE");
  assert.equal(fixture.proposal.payload.beforeSubjectId, fixture.experiment.payload.referenceSubjectId);
  assert.equal(fixture.proposal.payload.afterSubjectId, fixture.experiment.payload.candidateSubjectId);
  assert.equal(fixture.proposal.payload.rollbackTargetSubjectId, fixture.experiment.payload.referenceSubjectId);
  assert.equal(fixture.proposal.payload.automaticRoutingMutationAllowed, false);
  assert.equal(fixture.proposal.payload.automaticRollbackAllowed, false);

  const promotionWorkflow = await approvedPromotionWorkflow(
    fixture.root,
    fixture.experiment.payload.projectId,
  );
  const authorization = await prepareRoutingPromotionAuthorization({
    proposal: fixture.proposal,
    proposalContext: fixture.context,
    currentPreconditionSnapshot: fixture.snapshot,
    workflow: promotionWorkflow,
    authorization: promotionAuthorizationInput(promotionWorkflow.approvalIds),
  });

  assert.equal(authorization.payload.routingMutationAuthorized, true);
  assert.equal(authorization.payload.automaticRoutingMutationAllowed, false);
  assert.equal(authorization.payload.automaticRollbackAllowed, false);
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
    "2026-08-21T03:10:00.000Z",
  );
  const authorizationEvidence = await verifiedRoutingPromotionAuthorizationToEvidence(
    authorization,
    fixture.proposal,
    fixture.context,
    fixture.snapshot,
    promotionWorkflow,
    "2026-08-21T03:11:00.000Z",
  );
  assert.equal(proposalEvidence.status, "passed");
  assert.equal(authorizationEvidence.status, "passed");
});

test("non-COMPLETE experiment evidence cannot become promotion-eligible", async (t) => {
  const fixture = await promotionFixture(t, { maxTotalSamples: 4, liveSamples: 0, shadowSamples: 3, candidateLiveSamples: 0 });
  assert.notEqual(fixture.guardrail.payload.classification, "COMPLETE");
  assert.equal(fixture.proposal.payload.classification, "PROMOTION_NOT_ELIGIBLE");

  const promotionWorkflow = await approvedPromotionWorkflow(
    fixture.root,
    fixture.experiment.payload.projectId,
  );
  await assert.rejects(
    prepareRoutingPromotionAuthorization({
      proposal: fixture.proposal,
      proposalContext: fixture.context,
      currentPreconditionSnapshot: fixture.snapshot,
      workflow: promotionWorkflow,
      authorization: promotionAuthorizationInput(promotionWorkflow.approvalIds),
    }),
    /eligible proposal/,
  );
});

test("unresolved bounded-live recovery evidence fails closed to manual reconciliation", async (t) => {
  const fixture = await promotionFixture(t, {
    recoveryReports: async (experiment) => [
      await recoveryReport({
        subjectId: experiment.payload.candidateSubjectId,
        classification: "manual_reconciliation_required",
        journalEventType: "operation_error",
        probeId: "probe:recovery",
        probeStatus: "unknown",
        externalReference: undefined,
        explicitOperatorActionRequired: true,
        reason: "Unknown side-effect state requires operator reconciliation.",
      }),
    ],
  });

  assert.equal(
    fixture.proposal.payload.classification,
    "MANUAL_RECONCILIATION_REQUIRED",
  );
  assert.equal(fixture.proposal.payload.automaticRoutingMutationAllowed, false);
});

test("reference restore evidence prevents permanent candidate promotion", async (t) => {
  const fixture = await promotionFixture(t, {
    recoveryReports: async (experiment) => [
      await recoveryReport({ subjectId: experiment.payload.candidateSubjectId }),
      await recoveryReport({
        kind: "reference_restore",
        operationId: "operation:restore-1",
        idempotencyKey: "idem:restore-1",
        authorityId: "m5liveauth:restore-1",
        subjectId: experiment.payload.referenceSubjectId,
        sampleId: undefined,
        outputSha256: undefined,
        externalReference: "isolated-restore:1",
      }),
    ],
  });
  assert.equal(fixture.proposal.payload.classification, "PROMOTION_NOT_ELIGIBLE");
  assert.match(fixture.proposal.payload.reasons.join(","), /reference_restore_observed/);
});

test("stale route snapshot invalidates promotion authorization", async (t) => {
  const fixture = await promotionFixture(t);
  const stale = await prepareRoutingPreconditionSnapshot({
    projectId: fixture.snapshot.payload.projectId,
    routeId: fixture.snapshot.payload.routeId,
    capability: fixture.snapshot.payload.capability,
    currentSubjectId: fixture.snapshot.payload.currentSubjectId,
    routeRevision: "route-revision:2",
    capturedAt: "2026-08-21T03:03:00.000Z",
    policyReferences: ["policy:route-precondition-v1"],
  });
  const workflow = await approvedPromotionWorkflow(
    fixture.root,
    fixture.experiment.payload.projectId,
  );
  await assert.rejects(
    prepareRoutingPromotionAuthorization({
      proposal: fixture.proposal,
      proposalContext: fixture.context,
      currentPreconditionSnapshot: stale,
      workflow,
      authorization: promotionAuthorizationInput(workflow.approvalIds),
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
      authorization: promotionAuthorizationInput(fixture.experimentWorkflow.approvalIds),
    }),
    /separate workflow/,
  );

  const workflow = await approvedPromotionWorkflow(
    fixture.root,
    fixture.experiment.payload.projectId,
  );
  await assert.rejects(
    prepareRoutingPromotionAuthorization({
      proposal: fixture.proposal,
      proposalContext: fixture.context,
      currentPreconditionSnapshot: fixture.snapshot,
      workflow,
      authorization: promotionAuthorizationInput(["approval:wrong"]),
    }),
    /do not match durable WorkflowRun approvals/,
  );

  await assert.rejects(
    prepareRoutingPromotionAuthorization({
      proposal: fixture.proposal,
      proposalContext: fixture.context,
      currentPreconditionSnapshot: fixture.snapshot,
      workflow: { ...workflow, phase: "review" },
      authorization: promotionAuthorizationInput(workflow.approvalIds),
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
    /source binding drift|before\/after\/rollback/,
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
      capturedAt: "2026-08-21T03:00:00.000Z",
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
  return {
    root,
    history,
    taxonomy,
    policy,
    reference,
    candidate,
    admissionDecision,
  };
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

  const shadowSamples = overrides.shadowSamples ?? 1;
  const liveSamples = overrides.liveSamples ?? 2;
  const candidateLiveSamples = overrides.candidateLiveSamples ?? 2;
  const guardrail = await evaluateControlledExperimentGuardrails({
    experiment,
    authorization: experimentAuthorization,
    admissionDecision: base.admissionDecision,
    workflow: experimentWorkflow,
    progress: {
      observedAt: "2026-08-21T03:00:00.000Z",
      shadowSamples,
      liveSamples,
      candidateLiveSamples,
      referenceEvalSummary: base.reference.evalSummary,
      candidateEvalSummary: base.candidate.evalSummary,
      referenceExecutionSummary: base.reference.executionSummary,
      candidateExecutionSummary: base.candidate.executionSummary,
    },
  });

  const recoveryReports =
    typeof overrides.recoveryReports === "function"
      ? await overrides.recoveryReports(experiment)
      : overrides.recoveryReports ??
        [await recoveryReport({ subjectId: experiment.payload.candidateSubjectId })];
  const snapshot = await prepareRoutingPreconditionSnapshot({
    projectId: experiment.payload.projectId,
    routeId: "route:code-interactive",
    capability: "code.interactive",
    currentSubjectId: experiment.payload.referenceSubjectId,
    routeRevision: "route-revision:1",
    capturedAt: "2026-08-21T03:01:00.000Z",
    policyReferences: ["policy:route-precondition-v1"],
  });
  const runLedgerEvidenceReferences = [
    `run-ledger:${base.reference.records[0].runId}`,
    `run-ledger:${base.candidate.records[0].runId}`,
  ];
  const evalEvidenceReferences = [
    `eval-summary:${base.reference.evalSummary.summaryId}`,
    `eval-summary:${base.candidate.evalSummary.summaryId}`,
  ];
  const proposal = await prepareRoutingPromotionProposal({
    admissionDecision: base.admissionDecision,
    experiment,
    experimentAuthorization,
    experimentWorkflow,
    proposal: {
      routeId: snapshot.payload.routeId,
      capability: snapshot.payload.capability,
      proposedAt: "2026-08-21T03:02:00.000Z",
      policyReferences: ["policy:routing-promotion-v1"],
      preconditionSnapshot: snapshot,
      finalGuardrailDecision: guardrail,
      recoveryReports,
      runLedgerEvidenceReferences,
      evalEvidenceReferences,
    },
  });
  const context = {
    admissionDecision: base.admissionDecision,
    experiment,
    experimentAuthorization,
    experimentWorkflow,
    finalGuardrailDecision: guardrail,
    recoveryReports,
    preconditionSnapshot: snapshot,
    runLedgerEvidenceReferences,
    evalEvidenceReferences,
  };
  await verifyRoutingPromotionProposal(proposal, context);
  return {
    ...base,
    experiment,
    experimentWorkflow,
    experimentAuthorization,
    guardrail,
    snapshot,
    recoveryReports,
    proposal,
    context,
  };
}

async function approvedPromotionWorkflow(root, projectId) {
  workflowSequence += 1;
  const store = new JsonlWorkflowCheckpointStore({
    filePath: join(root, `routing-promotion-workflow-${workflowSequence}.jsonl`),
    maxFileBytes: 512 * 1024,
    maxCheckpointBytes: 32 * 1024,
  });
  const durable = new DurableWorkflowStateMachine(store);
  let run = durable.create({
    id: `workflow-routing-promotion-${workflowSequence}`,
    projectId,
    riskClass: "R3",
    now: "2026-08-21T03:03:00.000Z",
  });
  run = durable.start(run, "2026-08-21T03:03:01.000Z");
  run = durable.advance(run, "2026-08-21T03:03:02.000Z");
  run = durable.advance(run, "2026-08-21T03:03:03.000Z");
  run = durable.advance(run, "2026-08-21T03:03:04.000Z");
  run = durable.advance(run, "2026-08-21T03:03:05.000Z");
  run = durable.requestApproval(run, "2026-08-21T03:03:06.000Z");
  run = durable.approve(
    run,
    `approval:routing-promotion-${workflowSequence}`,
    "2026-08-21T03:04:00.000Z",
  );
  return run;
}

function promotionAuthorizationInput(approvalIds) {
  return {
    decision: "allow",
    actor: "operator:routing-promotion",
    decidedAt: "2026-08-21T03:05:00.000Z",
    policyReferences: ["policy:routing-promotion-authorization-v1"],
    approvalIds,
  };
}

async function recoveryReport(overrides = {}) {
  const kind = overrides.kind ?? "publication";
  const payload = {
    operationId: overrides.operationId ?? "operation:publication-1",
    kind,
    journalEventId: overrides.journalEventId ?? "m5sideeffect:event-1",
    journalEventType: overrides.journalEventType ?? "operation_committed",
    idempotencyKey: overrides.idempotencyKey ?? "idem:publication-1",
    sinkId: "isolated-loopback",
    authorityId: overrides.authorityId ?? "m5liveauth:publication-1",
    subjectId: overrides.subjectId ?? "router-controlled-experiment",
    ...(kind === "publication"
      ? {
          sampleId: overrides.sampleId ?? "sample:publication-1",
          outputSha256:
            overrides.outputSha256 ??
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        }
      : {}),
    ...(overrides.probeId !== undefined ? { probeId: overrides.probeId } : {}),
    ...(overrides.probeStatus !== undefined
      ? { probeStatus: overrides.probeStatus }
      : {}),
    ...(overrides.externalReference === undefined &&
    (overrides.classification ?? "consistent_committed") === "consistent_committed"
      ? { externalReference: kind === "publication" ? "isolated-publication:1" : "isolated-restore:1" }
      : overrides.externalReference !== undefined
        ? { externalReference: overrides.externalReference }
        : {}),
    classification: overrides.classification ?? "consistent_committed",
    automaticRetryAllowed: false,
    automaticMutationAllowed: false,
    explicitOperatorActionRequired:
      overrides.explicitOperatorActionRequired ?? false,
    observedAt: "2026-08-21T03:00:30.000Z",
    reason: overrides.reason ?? "Durable side-effect journal contains committed terminal evidence.",
  };
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
