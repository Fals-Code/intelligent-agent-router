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

const journalOptions = (filePath) => ({
  filePath,
  maxFileBytes: 2 * 1024 * 1024,
  maxEventBytes: 128 * 1024,
  maxStringBytes: 4096,
});

export async function buildAuthorizedRoutingPromotionFixture(t) {
  const base = await routingAdmissionFixture(t);
  const assignments = ["candidate", "candidate"];
  const shadowSamples = 1;
  const maxTotalSamples = 3;
  const experiment = await prepareControlledExperimentDefinition(
    base.admissionDecision,
    experimentDefinitionInput({
      budget: {
        maxTotalSamples,
        minimumShadowSamplesBeforeLive: 1,
        maxLiveSamples: 2,
        maxCandidateLiveSamples: 2,
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
  const finalProgress = {
    observedAt: "2026-08-21T03:00:00.000Z",
    shadowSamples,
    liveSamples: 2,
    candidateLiveSamples: 2,
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
  const publicationEvidence = [];
  let candidateBefore = 0;
  for (let ordinal = 0; ordinal < assignments.length; ordinal += 1) {
    publicationEvidence.push(await livePublicationEvidence({
      root: base.root,
      admissionDecision: base.admissionDecision,
      experiment,
      experimentAuthorization,
      experimentWorkflow,
      reference: base.reference,
      candidate: base.candidate,
      sideEffectJournal,
      ordinal,
      assignment: assignments[ordinal],
      candidateBefore,
      shadowSamples,
    }));
    candidateBefore += 1;
  }
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
  const proposal = await prepareRoutingPromotionProposal({
    context,
    proposal: {
      routeId: "route:code-interactive",
      capability: "code.interactive",
      proposedAt: "2026-08-21T03:02:00.000Z",
      policyReferences: ["policy:routing-promotion-v3"],
    },
  });
  const workflow = await approvedPublishWorkflow(
    base.root,
    experiment.payload.projectId,
    "promotion-authority",
    "2026-08-21T03:03:00.000Z",
  );
  const authorization = await prepareRoutingPromotionAuthorization({
    proposal,
    proposalContext: context,
    currentPreconditionSnapshot: snapshot,
    workflow,
    authorization: {
      decision: "allow",
      actor: "operator:routing-promotion",
      decidedAt: "2026-08-21T03:06:00.000Z",
      policyReferences: ["policy:routing-promotion-authorization-v1"],
      approvalIds: workflow.approvalIds,
    },
  });
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
    workflow,
    authorization,
    authority: {
      authorization,
      proposal,
      proposalContext: context,
      preconditionSnapshot: snapshot,
      workflow,
    },
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

async function routingAdmissionFixture(t) {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const root = await mkdtemp(join(tmpdir(), "9router-isolated-routing-mutation-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const suite = await prepareGoldenTaskSuite(
    {
      schemaVersion: 1,
      suiteId: "isolated-routing-mutation-suite",
      description: "Isolated routing mutation authority fixture.",
      tasks: [{
        id: "route",
        kind: "routing",
        prompt: "Route this synthetic mutation task.",
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
  const baselineId = "isolated-routing-mutation-baseline";
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
    name: "isolated-routing-mutation-admission",
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
    prefix: "isolated-mutation-reference",
    count: 3,
    latencyBase: 150,
    costBase: 0.08,
    minuteBase: 0,
  });
  const candidate = await buildExperimentCohort({
    history,
    report: candidateReport,
    baseline: baselineFor(candidateSubjectId),
    prefix: "isolated-mutation-candidate",
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

async function livePublicationEvidence(input) {
  const completedBefore = input.shadowSamples + input.ordinal;
  const referenceObservations = input.reference.observations.slice(0, completedBefore);
  const candidateObservations = input.candidate.observations.slice(0, completedBefore);
  const referenceEvalSummary = await buildEvalCohortSummary(referenceObservations);
  const candidateEvalSummary = await buildEvalCohortSummary(candidateObservations);
  const referenceExecutionSummary = await buildExecutionReliabilitySummary(
    referenceObservations,
    input.reference.projections.slice(0, completedBefore),
    input.reference.records.slice(0, completedBefore),
  );
  const candidateExecutionSummary = await buildExecutionReliabilitySummary(
    candidateObservations,
    input.candidate.projections.slice(0, completedBefore),
    input.candidate.records.slice(0, completedBefore),
  );
  const observedMinute = 50 + input.ordinal * 2;
  const workflowMinute = 51 + input.ordinal * 2;
  const approvedMinute = 55 + input.ordinal * 2;
  const committedMinute = 56 + input.ordinal * 2;
  const preDispatchGuardrail = await evaluateControlledExperimentGuardrails({
    experiment: input.experiment,
    authorization: input.experimentAuthorization,
    admissionDecision: input.admissionDecision,
    workflow: input.experimentWorkflow,
    progress: {
      observedAt: minuteTime(observedMinute),
      shadowSamples: input.shadowSamples,
      liveSamples: input.ordinal,
      candidateLiveSamples: input.candidateBefore,
      referenceEvalSummary,
      candidateEvalSummary,
      referenceExecutionSummary,
      candidateExecutionSummary,
    },
  });
  const liveWorkflow = await approvedPublishWorkflow(
    input.root,
    input.experiment.payload.projectId,
    `live-${input.ordinal}`,
    minuteTime(workflowMinute),
  );
  const authorizationInputValue = {
    sampleId: `sample:isolated-mutation-${input.ordinal}`,
    inputReference: `input:isolated-mutation-${input.ordinal}`,
    liveAssignment: input.assignment,
    actor: "operator:bounded-live",
    approvedAt: minuteTime(approvedMinute),
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
  const runtimeResultId = `m5liveresult:isolated-mutation-${input.ordinal}`;
  const operationId = `publication:${authorization.authorizationId}:${runtimeResultId}`;
  const idempotencyKey = `${authorization.authorizationId}:${runtimeResultId}`;
  const outputSha256 = input.ordinal % 2 === 0 ? SHA_B : SHA_C;
  await input.sideEffectJournal.reserve({
    kind: "publication",
    operationId,
    idempotencyKey,
    sinkId: "isolated-loopback",
    authorityId: authorization.authorizationId,
    subjectId: authorization.payload.selectedSubjectId,
    sampleId: authorization.payload.sampleId,
    outputSha256,
    reservedAt: minuteTime(approvedMinute),
  });
  const commitEvent = await input.sideEffectJournal.recordCommit({
    operationId,
    externalReference: `isolated-publication:${input.ordinal}`,
    committedAt: minuteTime(committedMinute),
  });
  const receipt = await publicationReceipt(authorization, commitEvent, runtimeResultId);
  const recoveryReport = await recoveryReportFromEvent(commitEvent);
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
    selectedRole: authorization.payload.liveAssignment,
    sinkId: commitEvent.payload.sinkId,
    publicationReference: commitEvent.payload.externalReference,
    publicationIdempotencyKey: commitEvent.payload.idempotencyKey,
    sideEffectOperationId: commitEvent.payload.operationId,
    sideEffectCommitEventId: commitEvent.eventId,
    outputSha256: commitEvent.payload.outputSha256,
    outputBytes: 128,
    verifiedAt: commitEvent.payload.committedAt,
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

async function recoveryReportFromEvent(event) {
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
    probeId: undefined,
    probeStatus: undefined,
    externalReference: payload.externalReference,
    classification: "consistent_committed",
    automaticRetryAllowed: false,
    automaticMutationAllowed: false,
    explicitOperatorActionRequired: false,
    observedAt: payload.committedAt,
    reason: "Canonical durable side-effect journal contains committed terminal evidence.",
  };
  const reconciliationSha256 = await sha256Canonical(recoveryPayload);
  return {
    schemaVersion: 1,
    algorithm: "sha256",
    reconciliationId: `m5livereconcile:${reconciliationSha256.slice(0, 32).toLowerCase()}`,
    reconciliationSha256,
    payload: recoveryPayload,
  };
}

async function openSideEffectJournal(root, label) {
  journalSequence += 1;
  return JsonlBoundedLiveSideEffectJournal.open(
    journalOptions(join(root, `isolated-routing-mutation-side-effects-${label}-${journalSequence}.jsonl`)),
  );
}

async function approvedPublishWorkflow(root, projectId, prefix, now) {
  workflowSequence += 1;
  const store = new JsonlWorkflowCheckpointStore({
    filePath: join(root, `isolated-routing-mutation-workflow-${workflowSequence}.jsonl`),
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

function minuteTime(minute) {
  return new Date(Date.UTC(2026, 7, 21, 2, minute, 0)).toISOString();
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
