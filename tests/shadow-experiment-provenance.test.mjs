import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  BoundedExperimentExecutor,
  ExecutionMetricProjector,
  JsonlControlledExperimentExecutionJournal,
  executionProjectionToEvalMeasurement,
  prepareControlledExperimentAuthorization,
  prepareControlledExperimentDefinition,
  prepareShadowExperimentSampleProvenance,
  verifyShadowExperimentSampleProvenance,
} from "../dist/index.js";
import {
  authorizationInput,
  controlledExperimentFixture,
  durableApprovedExperimentWorkflow,
  experimentDefinitionInput,
} from "./controlled-experiment-fixture.mjs";

class ProvenanceAdapter {
  id = "runtime-backed-shadow:provenance-test";
  async dispatch(request) {
    return {
      adapterId: this.id,
      experimentId: request.experimentId,
      sampleId: request.sampleId,
      acceptedAt: "2026-08-19T05:00:00.000Z",
      referenceExecutionReference: "shadow-runtime:reference:opencode:provenance-reference-run:1:ses_reference",
      candidateExecutionReference: "shadow-runtime:candidate:opencode:provenance-candidate-run:1:ses_candidate",
      candidateOutputExternallyVisible: false,
    };
  }
}

async function context(t) {
  const fixture = await controlledExperimentFixture(t);
  const experiment = await prepareControlledExperimentDefinition(
    fixture.admissionDecision,
    experimentDefinitionInput({
      exposureMode: "shadow_only",
      budget: {
        maxTotalSamples: 1,
        minimumShadowSamplesBeforeLive: 1,
        maxLiveSamples: 0,
        maxCandidateLiveSamples: 0,
        maxCandidateTrafficBasisPoints: 0,
      },
    }),
  );
  const { run: workflow } = await durableApprovedExperimentWorkflow(fixture.root, { riskClass: experiment.payload.riskClass });
  const authorization = await prepareControlledExperimentAuthorization(
    experiment,
    fixture.admissionDecision,
    workflow,
    authorizationInput(),
  );
  const journal = await JsonlControlledExperimentExecutionJournal.open({
    filePath: join(fixture.root, "provenance-execution.jsonl"),
    experimentId: experiment.experimentId,
    maxFileBytes: 512 * 1024,
    maxEventBytes: 32 * 1024,
    maxStringBytes: 2048,
  });
  const executor = new BoundedExperimentExecutor(journal, new ProvenanceAdapter(), {
    maxStringBytes: 2048,
    now: () => "2026-08-19T05:00:01.000Z",
  });
  const sampleId = "shadow-provenance-sample-1";
  await executor.dispatchSample({
    experiment,
    authorization,
    admissionDecision: fixture.admissionDecision,
    workflow,
    request: {
      sampleId,
      inputReference: "fixture:shadow-provenance-input",
      exposure: "shadow",
      liveAssignment: "none",
      requestedAt: "2026-08-19T04:59:59.000Z",
    },
  });

  const referenceRun = runRecord("provenance-reference-run", 112);
  const candidateRun = runRecord("provenance-candidate-run", 93);
  const projector = new ExecutionMetricProjector({
    latencyMetricKey: "runtime.shadow_completion_wait_ms",
    requireLatency: true,
    maxMetricKeyBytes: 256,
  });
  const referenceProjection = await projector.project(referenceRun);
  const candidateProjection = await projector.project(candidateRun);
  const referenceObservation = await fixture.history.append({
    observedAt: "2026-08-19T05:01:00.000Z",
    report: fixture.passReport,
    baseline: fixture.baseline,
    measurement: await executionProjectionToEvalMeasurement(referenceProjection),
  });
  const candidateObservation = await fixture.history.append({
    observedAt: "2026-08-19T05:01:01.000Z",
    report: fixture.passReport,
    baseline: fixture.baseline,
    measurement: await executionProjectionToEvalMeasurement(candidateProjection),
  });
  await executor.recordCompletion({
    experiment,
    authorization,
    admissionDecision: fixture.admissionDecision,
    workflow,
    sampleId,
    completedAt: "2026-08-19T05:02:00.000Z",
    referenceObservationId: referenceObservation.observationId,
    candidateObservationId: candidateObservation.observationId,
  });

  return {
    ...fixture,
    experiment,
    workflow,
    authorization,
    journal,
    sampleId,
    referenceRun,
    candidateRun,
    referenceProjection,
    candidateProjection,
    referenceObservation,
    candidateObservation,
  };
}

function sources(ctx, overrides = {}) {
  return {
    experiment: ctx.experiment,
    authorization: ctx.authorization,
    admissionDecision: ctx.admissionDecision,
    workflow: ctx.workflow,
    journal: ctx.journal,
    sampleId: ctx.sampleId,
    referenceRun: ctx.referenceRun,
    candidateRun: ctx.candidateRun,
    referenceProjection: ctx.referenceProjection,
    candidateProjection: ctx.candidateProjection,
    referenceObservation: ctx.referenceObservation,
    candidateObservation: ctx.candidateObservation,
    ...overrides,
  };
}

test("shadow provenance binds exact #34/#35 journal sample to canonical Run Ledger projections and Eval observations", async (t) => {
  const ctx = await context(t);
  const provenance = await prepareShadowExperimentSampleProvenance(sources(ctx));
  assert.match(provenance.provenanceId, /^m5shadowprov:[a-f0-9]{32}$/);
  assert.equal(provenance.payload.experimentId, ctx.experiment.experimentId);
  assert.equal(provenance.payload.controlWorkflowRunId, ctx.workflow.id);
  assert.equal(provenance.payload.referenceRunId, ctx.referenceRun.runId);
  assert.equal(provenance.payload.candidateRunId, ctx.candidateRun.runId);
  assert.equal(provenance.payload.referenceObservationId, ctx.referenceObservation.observationId);
  assert.equal(provenance.payload.candidateObservationId, ctx.candidateObservation.observationId);
  assert.equal(provenance.payload.exposure, "shadow");
  assert.equal(provenance.payload.liveAssignment, "none");
  assert.equal(provenance.payload.candidateOutputExternallyVisible, false);
  assert.equal(provenance.payload.automaticRedispatchAllowed, false);
  assert.equal(provenance.payload.productionRoutingMutationAllowed, false);
  await assert.doesNotReject(() => verifyShadowExperimentSampleProvenance(provenance, sources(ctx)));
  assert.equal(ctx.journal.inspect().completedSampleCount, 1);
  assert.deepEqual(ctx.journal.inspect().unresolvedSampleIds, []);
});

test("shadow provenance fails closed on wrong Run Ledger, projection, observation, or incomplete sample", async (t) => {
  const ctx = await context(t);
  const provenance = await prepareShadowExperimentSampleProvenance(sources(ctx));

  await assert.rejects(
    () => verifyShadowExperimentSampleProvenance(provenance, sources(ctx, { candidateRun: { ...ctx.candidateRun, runId: "wrong-run" } })),
  );
  await assert.rejects(
    () => verifyShadowExperimentSampleProvenance(provenance, sources(ctx, { candidateProjection: ctx.referenceProjection })),
    /candidate execution projection does not match canonical Run Ledger/,
  );
  await assert.rejects(
    () => verifyShadowExperimentSampleProvenance(provenance, sources(ctx, { candidateObservation: ctx.referenceObservation })),
    /distinct reference\/candidate Eval observations|candidateObservationId mismatch/,
  );

  const pendingJournal = await JsonlControlledExperimentExecutionJournal.open({
    filePath: join(ctx.root, "pending-provenance.jsonl"),
    experimentId: ctx.experiment.experimentId,
    maxFileBytes: 512 * 1024,
    maxEventBytes: 32 * 1024,
    maxStringBytes: 2048,
  });
  await pendingJournal.reserveSample({
    sampleId: "pending-sample",
    exposure: "shadow",
    liveAssignment: "none",
    inputReference: "fixture:pending",
    reservedAt: "2026-08-19T05:03:00.000Z",
  });
  await assert.rejects(
    () => prepareShadowExperimentSampleProvenance(sources(ctx, { journal: pendingJournal, sampleId: "pending-sample" })),
    /exactly three sample events/,
  );
});

function runRecord(runId, latencyMs) {
  return {
    runId,
    projectId: "project-controlled-experiment",
    task: "End-to-end shadow provenance fixture",
    riskClass: "R0",
    runtimeId: "opencode",
    modelRoute: [runId.includes("reference") ? "opencode:9router/hemat" : "opencode:9router/smart"],
    contextCompilerVersion: "shadow-provenance/v1",
    skills: ["runtime.binding", "runtime.reconciliation", "deterministic.verification"],
    toolsets: [],
    workspace: "C:/isolated/shadow-provenance",
    policyDecisions: ["R0 shadow-only", "zero runtime tools"],
    approvalIds: [],
    changeReferences: [],
    evidence: [{
      kind: "policy",
      status: "passed",
      reference: `policy:${runId}`,
      producer: "shadow-provenance-test",
      collectedAt: "2026-08-19T05:00:00.000Z",
    }],
    resourceMetrics: { "runtime.shadow_completion_wait_ms": latencyMs },
    traceId: `shadow-provenance:${runId}`,
    outcome: "succeeded",
    createdAt: "2026-08-19T04:59:00.000Z",
  };
}
