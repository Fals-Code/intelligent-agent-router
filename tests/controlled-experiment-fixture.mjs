import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DurableWorkflowStateMachine,
  ExecutionMetricProjector,
  JsonlEvalHistory,
  JsonlWorkflowCheckpointStore,
  RoutingEvalPlane,
  assessM5ControlledExperimentAdmission,
  buildCanonicalMetricTaxonomy,
  buildEvalCohortSummary,
  buildExecutionReliabilitySummary,
  executionProjectionToEvalMeasurement,
  prepareGoldenTaskSuite,
  prepareM5AdmissionPolicy,
} from "../dist/index.js";

const suiteLimits = {
  maxTasks: 8,
  maxAssertionsPerTask: 8,
  maxPromptBytes: 4096,
  maxStringBytes: 2048,
  maxSuiteBytes: 64 * 1024,
};

const historyOptions = (filePath) => ({
  filePath,
  maxFileBytes: 2 * 1024 * 1024,
  maxObservationBytes: 128 * 1024,
  maxReportBytes: 64 * 1024,
  maxStringBytes: 2048,
  maxSourceReferences: 8,
});

let workflowFixtureSequence = 0;

export async function controlledExperimentFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "9router-controlled-experiment-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const suite = await prepareGoldenTaskSuite({
    schemaVersion: 1,
    suiteId: "controlled-experiment-suite",
    description: "Controlled experiment contract fixture.",
    tasks: [{
      id: "route",
      kind: "routing",
      prompt: "Route this synthetic controlled experiment task.",
      critical: true,
      minimumScore: 1,
      assertions: [
        { id: "model", kind: "primary_model_equals", weight: 1, expected: "model-a" },
        { id: "verify", kind: "requires_verification_equals", weight: 1, expected: true },
      ],
    }],
  }, suiteLimits);
  const plane = new RoutingEvalPlane({ maxReportBytes: 64 * 1024, maxSubjectIdBytes: 2048 });
  const subject = (model) => ({
    id: "router-controlled-experiment",
    async route() {
      return {
        primaryModel: { candidate: { id: model } },
        selectedSkills: [],
        analysis: { requiresVerification: true },
      };
    },
  });
  const passReport = await plane.evaluate(suite, subject("model-a"));
  const failReport = await plane.evaluate(suite, subject("model-b"));
  const baseline = {
    schemaVersion: 1,
    baselineId: "controlled-experiment-baseline",
    suiteId: suite.suiteId,
    suiteSha256: suite.suiteSha256,
    subjectId: "router-controlled-experiment",
    minimumWeightedScore: 1,
    minimumTaskPassRate: 1,
    minimumCriticalPassRate: 1,
    maximumFailedTasks: 0,
  };
  const history = await JsonlEvalHistory.open(historyOptions(join(root, "history.jsonl")));
  const taxonomy = await buildCanonicalMetricTaxonomy();
  const policy = await prepareM5AdmissionPolicy(taxonomy, {
    name: "controlled-experiment-admission",
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
  const reference = await buildExperimentCohort({ history, report: passReport, baseline, prefix: "admission-reference", count: 3, latencyBase: 150, costBase: 0.08, minuteBase: 0 });
  const candidate = await buildExperimentCohort({ history, report: passReport, baseline, prefix: "admission-candidate", count: 3, latencyBase: 120, costBase: 0.06, minuteBase: 10 });
  const nonEligibleCandidate = await buildExperimentCohort({ history, report: failReport, baseline, prefix: "admission-bad", count: 3, latencyBase: 120, costBase: 0.06, minuteBase: 20 });
  const admissionDecision = await assessM5ControlledExperimentAdmission({ taxonomy, policy, reference, candidate });
  const nonEligibleDecision = await assessM5ControlledExperimentAdmission({ taxonomy, policy, reference, candidate: nonEligibleCandidate });
  return { root, history, taxonomy, policy, passReport, failReport, baseline, reference, candidate, admissionDecision, nonEligibleDecision };
}

export function experimentDefinitionInput(overrides = {}) {
  return {
    name: "router-model-controlled-experiment",
    projectId: "project-controlled-experiment",
    riskClass: "R3",
    exposureMode: "shadow_then_bounded_live",
    budget: {
      maxTotalSamples: 6,
      minimumShadowSamplesBeforeLive: 3,
      maxLiveSamples: 3,
      maxCandidateLiveSamples: 3,
      maxCandidateTrafficBasisPoints: 10000,
    },
    stopConditions: {
      maxFailedExecutions: 0,
      maximumCancellationRate: 0.1,
      maximumWeightedScoreMeanRegression: 0.05,
      maximumTaskPassRateMeanRegression: 0.05,
      maximumCriticalPassRateMeanRegression: 0.05,
      maximumBaselinePassRateRegression: 0.05,
      maximumExecutionSuccessRateRegression: 0.05,
      maximumLatencyMeanIncreaseMs: 25,
      maximumCostMeanIncreaseUsd: 0.02,
    },
    rollbackPolicyReference: "policy:restore-reference-route-v1",
    ...overrides,
  };
}

export async function durableApprovedExperimentWorkflow(root, overrides = {}) {
  workflowFixtureSequence += 1;
  const store = new JsonlWorkflowCheckpointStore({
    filePath: join(root, `workflow-${workflowFixtureSequence}.jsonl`),
    maxFileBytes: 512 * 1024,
    maxCheckpointBytes: 32 * 1024,
  });
  const durable = new DurableWorkflowStateMachine(store);
  const input = {
    id: `workflow-controlled-experiment-${workflowFixtureSequence}`,
    projectId: "project-controlled-experiment",
    riskClass: "R3",
    now: "2026-08-18T07:30:00.000Z",
    ...overrides,
  };
  let run = durable.create(input);
  run = durable.start(run, "2026-08-18T07:30:01.000Z");
  run = durable.advance(run, "2026-08-18T07:30:02.000Z");
  run = durable.advance(run, "2026-08-18T07:30:03.000Z");
  run = durable.advance(run, "2026-08-18T07:30:04.000Z");
  run = durable.advance(run, "2026-08-18T07:30:05.000Z");
  run = durable.requestApproval(run, "2026-08-18T07:30:06.000Z");
  run = durable.approve(run, "approval:controlled-experiment-1", "2026-08-18T07:31:00.000Z");
  return { run, store };
}

export function authorizationInput(overrides = {}) {
  return {
    decision: "allow",
    actor: "operator:test",
    decidedAt: "2026-08-18T07:32:00.000Z",
    policyReferences: ["policy:controlled-experiment-authorization-v1"],
    approvalIds: ["approval:controlled-experiment-1"],
    ...overrides,
  };
}

export async function buildExperimentCohort({
  history,
  report,
  baseline,
  prefix,
  count,
  outcomes,
  latencyBase = 100,
  costBase = 0.05,
  minuteBase = 0,
}) {
  const observations = [];
  const projections = [];
  const records = [];
  for (let index = 0; index < count; index += 1) {
    const record = runRecord(`${prefix}-${index}`, outcomes?.[index] ?? "succeeded", latencyBase + index, costBase + (index * 0.001));
    records.push(record);
    const projector = new ExecutionMetricProjector({
      latencyMetricKey: "runtime.total_ms",
      costMetricKey: "billing.usd",
      requireLatency: true,
      requireCost: true,
      maxMetricKeyBytes: 256,
    });
    const projection = await projector.project(record);
    const measurement = await executionProjectionToEvalMeasurement(projection);
    const observedAt = new Date(Date.UTC(2026, 7, 18, 9, minuteBase + index, 0)).toISOString();
    const observation = await history.append({ observedAt, report, baseline, measurement });
    observations.push(observation);
    projections.push(projection);
  }
  return {
    evalSummary: await buildEvalCohortSummary(observations),
    executionSummary: await buildExecutionReliabilitySummary(observations, projections, records),
  };
}

function runRecord(runId, outcome, latencyMs, costUsd) {
  return {
    runId,
    projectId: "project-controlled-experiment",
    task: "Synthetic controlled experiment execution",
    riskClass: "R0",
    runtimeId: "opencode",
    modelRoute: ["openai-balanced"],
    contextCompilerVersion: "v1",
    skills: [],
    toolsets: [],
    workspace: "C:/isolated/controlled-experiment",
    policyDecisions: ["policy:allow"],
    approvalIds: [],
    changeReferences: [],
    evidence: [{
      kind: "policy",
      status: "passed",
      reference: `policy:${runId}`,
      producer: "policy-engine",
      collectedAt: "2026-08-18T07:00:00.000Z",
    }],
    resourceMetrics: { "runtime.total_ms": latencyMs, "billing.usd": costUsd },
    traceId: `trace:${runId}`,
    outcome,
    failureReason: outcome === "failed" ? "synthetic failure" : undefined,
    createdAt: "2026-08-18T06:59:00.000Z",
  };
}
