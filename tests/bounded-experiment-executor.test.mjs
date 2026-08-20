import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  BoundedExperimentExecutor,
  JsonlControlledExperimentExecutionJournal,
  buildEvalCohortSummary,
  buildExecutionReliabilitySummary,
  prepareControlledExperimentAuthorization,
  prepareControlledExperimentDefinition,
} from "../dist/index.js";
import {
  authorizationInput,
  buildExperimentCohort,
  controlledExperimentFixture,
  durableApprovedExperimentWorkflow,
  experimentDefinitionInput,
} from "./controlled-experiment-fixture.mjs";

class FakeExperimentAdapter {
  id = "experiment-runtime:test";
  requests = [];
  failNext = false;
  mutateReceipt = undefined;

  async dispatch(request) {
    this.requests.push(request);
    if (this.failNext) {
      this.failNext = false;
      throw new Error("synthetic adapter failure api_key=super-secret-value");
    }
    const receipt = {
      adapterId: this.id,
      experimentId: request.experimentId,
      sampleId: request.sampleId,
      acceptedAt: "2026-08-19T00:10:00.000Z",
      referenceExecutionReference: `runtime:reference:${request.sampleId}`,
      candidateExecutionReference: `runtime:candidate:${request.sampleId}`,
      candidateOutputExternallyVisible: false,
    };
    return this.mutateReceipt ? this.mutateReceipt(receipt) : receipt;
  }
}

async function executorContext(t, definitionOverrides = {}) {
  const fixture = await controlledExperimentFixture(t);
  const experiment = await prepareControlledExperimentDefinition(fixture.admissionDecision, experimentDefinitionInput(definitionOverrides));
  const { run: workflow } = await durableApprovedExperimentWorkflow(fixture.root, { riskClass: experiment.payload.riskClass });
  const authorization = await prepareControlledExperimentAuthorization(experiment, fixture.admissionDecision, workflow, authorizationInput());
  const journalPath = join(fixture.root, "bounded-executor.jsonl");
  const journalOptions = {
    filePath: journalPath,
    experimentId: experiment.experimentId,
    maxFileBytes: 2 * 1024 * 1024,
    maxEventBytes: 64 * 1024,
    maxStringBytes: 2048,
  };
  const journal = await JsonlControlledExperimentExecutionJournal.open(journalOptions);
  const adapter = new FakeExperimentAdapter();
  const executor = new BoundedExperimentExecutor(journal, adapter, { maxStringBytes: 2048, now: () => "2026-08-19T00:11:00.000Z" });
  const reference = await buildExperimentCohort({ history: fixture.history, report: fixture.passReport, baseline: fixture.baseline, prefix: "executor-reference", count: 6, latencyBase: 150, costBase: 0.08, minuteBase: 120 });
  const candidate = await buildExperimentCohort({ history: fixture.history, report: fixture.passReport, baseline: fixture.baseline, prefix: "executor-candidate", count: 6, latencyBase: 120, costBase: 0.06, minuteBase: 140 });
  return { ...fixture, experiment, workflow, authorization, journal, journalOptions, adapter, executor, progressReference: reference, progressCandidate: candidate };
}

async function progress(ctx, count, observedAt = "2026-08-19T00:20:00.000Z") {
  const referenceObservations = ctx.progressReference.observations.slice(0, count);
  const candidateObservations = ctx.progressCandidate.observations.slice(0, count);
  return {
    observedAt,
    referenceEvalSummary: await buildEvalCohortSummary(referenceObservations),
    candidateEvalSummary: await buildEvalCohortSummary(candidateObservations),
    referenceExecutionSummary: await buildExecutionReliabilitySummary(referenceObservations, ctx.progressReference.projections.slice(0, count), ctx.progressReference.records.slice(0, count)),
    candidateExecutionSummary: await buildExecutionReliabilitySummary(candidateObservations, ctx.progressCandidate.projections.slice(0, count), ctx.progressCandidate.records.slice(0, count)),
  };
}

function dispatchInput(ctx, sampleId, exposure = "shadow", liveAssignment = "none", progressEvidence) {
  return {
    experiment: ctx.experiment,
    authorization: ctx.authorization,
    admissionDecision: ctx.admissionDecision,
    workflow: ctx.workflow,
    request: { sampleId, inputReference: `fixture-input:${sampleId}`, exposure, liveAssignment, requestedAt: "2026-08-19T00:09:00.000Z" },
    progress: progressEvidence,
  };
}

async function complete(ctx, sampleId, index) {
  return ctx.executor.recordCompletion({
    experiment: ctx.experiment,
    authorization: ctx.authorization,
    admissionDecision: ctx.admissionDecision,
    workflow: ctx.workflow,
    sampleId,
    completedAt: "2026-08-19T00:12:00.000Z",
    referenceObservationId: ctx.progressReference.observations[index].observationId,
    candidateObservationId: ctx.progressCandidate.observations[index].observationId,
  });
}

test("bounded executor remains sequential durable shadow executor and never exposes candidate output", async (t) => {
  const ctx = await executorContext(t);
  const first = await ctx.executor.dispatchSample(dispatchInput(ctx, "sample-1"));
  assert.equal(first.guardrailDecision, undefined);
  assert.equal(first.receipt.candidateOutputExternallyVisible, false);
  assert.equal(ctx.adapter.requests[0].candidateOutputMayBeExternallyVisible, false);
  await complete(ctx, "sample-1", 0);

  const second = await ctx.executor.dispatchSample(dispatchInput(ctx, "sample-2", "shadow", "none", await progress(ctx, 1)));
  assert.equal(second.guardrailDecision.payload.classification, "CONTINUE_SHADOW");
  await complete(ctx, "sample-2", 1);
  assert.equal(ctx.executor.inspect().completedShadowSamples, 2);
  assert.equal(ctx.executor.inspect().automaticDispatchLoopAllowed, false);
});

test("legacy immediate bounded-live dispatch fails closed before reservation or adapter side effect", async (t) => {
  const ctx = await executorContext(t);
  for (let index = 0; index < 3; index += 1) {
    const sampleId = `shadow-${index + 1}`;
    await ctx.executor.dispatchSample(dispatchInput(ctx, sampleId, "shadow", "none", index === 0 ? undefined : await progress(ctx, index)));
    await complete(ctx, sampleId, index);
  }
  const beforeRequests = ctx.adapter.requests.length;
  const beforeReservations = ctx.executor.inspect().reservedSampleCount;
  const liveProgress = await progress(ctx, 3);
  await assert.rejects(
    () => ctx.executor.dispatchSample(dispatchInput(ctx, "legacy-live", "bounded_live", "candidate", liveProgress)),
    /Immediate bounded-live dispatch is disabled; use DeferredBoundedLiveExecutor verify-before-visibility path/,
  );
  assert.equal(ctx.adapter.requests.length, beforeRequests);
  assert.equal(ctx.executor.inspect().reservedSampleCount, beforeReservations);
  assert.equal(ctx.journal.latest("legacy-live"), undefined);
});

test("adapter failure records unknown side effect and blocks automatic redispatch across reopen", async (t) => {
  const ctx = await executorContext(t);
  ctx.adapter.failNext = true;
  await assert.rejects(() => ctx.executor.dispatchSample(dispatchInput(ctx, "uncertain-1")), /dispatch side effect is unknown and automatic redispatch is forbidden/);
  assert.deepEqual(ctx.executor.inspect().unresolvedSampleIds, ["uncertain-1"]);
  assert.deepEqual(ctx.executor.inspect().dispatchErrorSampleIds, ["uncertain-1"]);
  assert.doesNotMatch(JSON.stringify(ctx.journal.list()), /super-secret-value/);

  const reopened = await JsonlControlledExperimentExecutionJournal.open(ctx.journalOptions);
  const executor = new BoundedExperimentExecutor(reopened, ctx.adapter, { maxStringBytes: 2048 });
  await assert.rejects(() => executor.dispatchSample(dispatchInput(ctx, "uncertain-2")), /manual reconciliation is required before any new dispatch/);
});

test("accepted adapter dispatch with failed durable dispatch persistence remains manual-reconciliation only", async (t) => {
  const ctx = await executorContext(t);
  ctx.journal.recordDispatch = async () => { throw new Error("synthetic durable dispatch persistence failure"); };
  await assert.rejects(
    () => ctx.executor.dispatchSample(dispatchInput(ctx, "accepted-but-unpersisted")),
    /external side effect may have occurred.*manual reconciliation is required.*automatic redispatch is forbidden/,
  );
  assert.equal(ctx.adapter.requests.length, 1);
  const reopened = await JsonlControlledExperimentExecutionJournal.open(ctx.journalOptions);
  assert.deepEqual(reopened.inspect().unresolvedSampleIds, ["accepted-but-unpersisted"]);
  assert.equal(reopened.latest("accepted-but-unpersisted").payload.eventType, "sample_reserved");
});

test("bounded executor rejects progress summaries that do not equal durable completed observation set", async (t) => {
  const ctx = await executorContext(t);
  await ctx.executor.dispatchSample(dispatchInput(ctx, "sample-provenance-1"));
  await complete(ctx, "sample-provenance-1", 0);
  await assert.rejects(
    () => ctx.executor.dispatchSample(dispatchInput(ctx, "sample-provenance-2", "shadow", "none", {
      observedAt: "2026-08-19T00:20:00.000Z",
      referenceEvalSummary: ctx.reference.evalSummary,
      candidateEvalSummary: ctx.candidate.evalSummary,
      referenceExecutionSummary: ctx.reference.executionSummary,
      candidateExecutionSummary: ctx.candidate.executionSummary,
    })),
    /does not match durable completed-sample observation set/,
  );
});

test("invalid adapter receipt remains uncertain external side effect rather than safe retry", async (t) => {
  const ctx = await executorContext(t);
  ctx.adapter.mutateReceipt = (receipt) => ({ ...receipt, sampleId: "wrong-sample" });
  await assert.rejects(() => ctx.executor.dispatchSample(dispatchInput(ctx, "receipt-drift")), /dispatch side effect is unknown and automatic redispatch is forbidden/);
  assert.deepEqual(ctx.executor.inspect().dispatchErrorSampleIds, ["receipt-drift"]);
});
