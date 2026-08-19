import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DurableWorkflowStateMachine,
  InMemoryAgentRuntimeAdapter,
  JsonlRuntimeBindingStore,
  JsonlWorkflowCheckpointStore,
  RuntimeBackedDeferredBoundedLiveExecutionCoordinator,
  verifyDeferredBoundedLiveRuntimeDispatchEnvelope,
} from "../dist/index.js";

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, stable(child)]));
}

function sha256Canonical(value) {
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex").toUpperCase();
}

function sampleAuthorization({ assignment = "candidate", sampleId = "live-runtime-sample-1" } = {}) {
  const payload = {
    sampleId,
    inputReference: "live-input:runtime-backed-deferred-v1",
    liveAssignment: assignment,
    actor: "operator:runtime-backed-deferred-test",
    approvedAt: "2026-08-19T07:20:00.000Z",
    policyReferences: ["policy:bounded-live-runtime-v1"],
    approvalIds: ["approval:bounded-live-runtime-1"],
    experimentId: "m5experiment:runtime-backed-deferred",
    experimentSha256: "A".repeat(64),
    experimentAuthorizationId: "m5expauth:runtime-backed-deferred",
    experimentAuthorizationSha256: "B".repeat(64),
    guardrailDecisionId: "m5expguard:runtime-backed-deferred",
    guardrailDecisionSha256: "C".repeat(64),
    experimentWorkflowRunId: "experiment-workflow-runtime-backed",
    liveWorkflowRunId: "live-workflow-runtime-backed",
    projectId: "project-bounded-live-runtime",
    riskClass: "R3",
    selectedSubjectId: assignment === "candidate" ? "opencode:9router/smart" : "opencode:9router/hemat",
    shadowSamplesBeforeLive: 3,
    liveSamplesBeforeDispatch: 0,
    candidateLiveSamplesBeforeDispatch: 0,
    candidateTrafficAfterDispatchBasisPoints: assignment === "candidate" ? 10000 : 0,
    candidateOutputMayBeExternallyVisible: assignment === "candidate",
    singleSampleAuthority: true,
    automaticDispatchAllowed: false,
    automaticRedispatchAllowed: false,
    productionRoutingMutationAllowed: false,
    automaticRollbackAllowed: false,
  };
  const authorizationSha256 = sha256Canonical(payload);
  return {
    schemaVersion: 1,
    algorithm: "sha256",
    authorizationId: `m5liveauth:${authorizationSha256.slice(0, 32).toLowerCase()}`,
    authorizationSha256,
    payload,
  };
}

function experiment() {
  return {
    schemaVersion: 1,
    algorithm: "sha256",
    experimentId: "m5experiment:runtime-backed-deferred",
    experimentSha256: "A".repeat(64),
    payload: {
      projectId: "project-bounded-live-runtime",
      referenceSubjectId: "opencode:9router/hemat",
      candidateSubjectId: "opencode:9router/smart",
    },
  };
}

class RecordingRuntimeAdapter {
  constructor(runtimeId, sessionId, { failSend = false } = {}) {
    this.inner = new InMemoryAgentRuntimeAdapter({
      runtimeId,
      createSessionId: () => sessionId,
      createEventId: (() => {
        let sequence = 0;
        return () => `${runtimeId}-event-${++sequence}`;
      })(),
      now: () => "2026-08-19T07:21:00.000Z",
    });
    this.runtimeId = runtimeId;
    this.failSend = failSend;
    this.createRequests = [];
    this.tasks = [];
  }
  async createSession(request) { this.createRequests.push(request); return this.inner.createSession(request); }
  async sendTask(sessionId, task) {
    this.tasks.push({ sessionId, task });
    if (this.failSend) throw new Error("synthetic bounded-live send failure");
    return this.inner.sendTask(sessionId, task);
  }
  interrupt(...args) { return this.inner.interrupt(...args); }
  resume(...args) { return this.inner.resume(...args); }
  getStatus(...args) { return this.inner.getStatus(...args); }
  getEvents(...args) { return this.inner.getEvents(...args); }
  getDiff(...args) { return this.inner.getDiff(...args); }
  respondToApproval(...args) { return this.inner.respondToApproval(...args); }
  abort(...args) { return this.inner.abort(...args); }
  destroy(...args) { return this.inner.destroy(...args); }
}

function makeExecuteRun(machine, id, projectId) {
  let run = machine.create({ id, projectId, riskClass: "R0", now: "2026-08-19T07:19:00.000Z" });
  run = machine.start(run, "2026-08-19T07:19:01.000Z");
  run = machine.advance(run, "2026-08-19T07:19:02.000Z");
  run = machine.advance(run, "2026-08-19T07:19:03.000Z");
  assert.equal(run.phase, "execute");
  assert.equal(run.status, "running");
  return run;
}

async function fixture(t, { candidateFailSend = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "9router-deferred-live-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workflowStore = new JsonlWorkflowCheckpointStore({
    filePath: join(root, "workflow.jsonl"),
    maxFileBytes: 512 * 1024,
    maxCheckpointBytes: 32 * 1024,
  });
  const machine = new DurableWorkflowStateMachine(workflowStore);
  const referenceRun = makeExecuteRun(machine, "deferred-live-reference-run", "project-bounded-live-runtime");
  const candidateRun = makeExecuteRun(machine, "deferred-live-candidate-run", "project-bounded-live-runtime");
  const bindingPath = join(root, "binding.jsonl");
  const bindingStore = new JsonlRuntimeBindingStore({ filePath: bindingPath, maxFileBytes: 512 * 1024, maxBindingBytes: 32 * 1024 });
  const referenceRuntime = new RecordingRuntimeAdapter("opencode", "ses_deferred_live_reference");
  const candidateRuntime = new RecordingRuntimeAdapter("opencode", "ses_deferred_live_candidate", { failSend: candidateFailSend });
  const shared = {
    prompt: "Return a concise bounded-live comparison result without tools or source changes.",
    context: ["R0 paired bounded-live execution.", "Output is not externally visible during dispatch."],
    toolIds: [],
  };
  const resolver = {
    async resolve({ role, subjectId }) {
      return role === "reference"
        ? { subjectId, run: referenceRun, workspace: root, adapter: referenceRuntime, bindingStore, task: { taskId: "deferred-live-reference-task", ...shared } }
        : { subjectId, run: candidateRun, workspace: root, adapter: candidateRuntime, bindingStore, task: { taskId: "deferred-live-candidate-task", ...shared } };
    },
  };
  const coordinator = new RuntimeBackedDeferredBoundedLiveExecutionCoordinator(resolver, { now: () => "2026-08-19T07:21:00.000Z" });
  return { root, referenceRun, candidateRun, bindingPath, bindingStore, referenceRuntime, candidateRuntime, resolver, coordinator };
}

test("runtime-backed deferred live dispatch durably binds two R0 zero-tool sessions before sending tasks and exposes no output", async (t) => {
  const ctx = await fixture(t);
  const authorization = sampleAuthorization();
  const dispatch = await ctx.coordinator.dispatch({ experiment: experiment(), authorization });
  await assert.doesNotReject(() => verifyDeferredBoundedLiveRuntimeDispatchEnvelope(dispatch));

  assert.equal(dispatch.payload.selectedRole, "candidate");
  assert.equal(dispatch.payload.zeroRuntimeTools, true);
  assert.equal(dispatch.payload.candidateOutputExternallyVisible, false);
  assert.equal(dispatch.payload.automaticRedispatchAllowed, false);
  assert.equal(dispatch.payload.productionRoutingMutationAllowed, false);
  assert.match(dispatch.payload.referenceExecutionReference, /^bounded-live-runtime:reference:opencode:deferred-live-reference-run:1:ses_deferred_live_reference$/);
  assert.match(dispatch.payload.candidateExecutionReference, /^bounded-live-runtime:candidate:opencode:deferred-live-candidate-run:1:ses_deferred_live_candidate$/);

  assert.equal(ctx.referenceRuntime.createRequests.length, 1);
  assert.equal(ctx.candidateRuntime.createRequests.length, 1);
  assert.equal(ctx.referenceRuntime.tasks.length, 1);
  assert.equal(ctx.candidateRuntime.tasks.length, 1);
  assert.equal(ctx.referenceRuntime.tasks[0].task.prompt, ctx.candidateRuntime.tasks[0].task.prompt);
  assert.deepEqual(ctx.referenceRuntime.tasks[0].task.context, ctx.candidateRuntime.tasks[0].task.context);
  assert.deepEqual(ctx.referenceRuntime.tasks[0].task.toolIds, []);
  assert.deepEqual(ctx.candidateRuntime.tasks[0].task.toolIds, []);

  for (const request of [ctx.referenceRuntime.createRequests[0], ctx.candidateRuntime.createRequests[0]]) {
    assert.equal(request.riskClass, "R0");
    assert.equal(request.metadata["9router.experimentExposure"], "bounded_live");
    assert.equal(request.metadata["9router.experimentSelectedRole"], "candidate");
    assert.equal(request.metadata["9router.candidateOutputExternallyVisibleBeforePublication"], false);
    assert.equal(request.metadata["9router.liveSampleAuthorizationId"], authorization.authorizationId);
  }

  const reopened = new JsonlRuntimeBindingStore({ filePath: ctx.bindingPath, maxFileBytes: 512 * 1024, maxBindingBytes: 32 * 1024 });
  assert.equal(reopened.get(ctx.referenceRun.id).sessionId, "ses_deferred_live_reference");
  assert.equal(reopened.get(ctx.candidateRun.id).sessionId, "ses_deferred_live_candidate");
});

test("runtime-backed deferred live dispatch rejects tool/prompt drift before provider side effects", async (t) => {
  const ctx = await fixture(t);
  const authorization = sampleAuthorization();
  const toolResolver = {
    async resolve(input) {
      const base = await ctx.resolver.resolve(input);
      return input.role === "candidate" ? { ...base, task: { ...base.task, toolIds: ["read"] } } : base;
    },
  };
  const toolCoordinator = new RuntimeBackedDeferredBoundedLiveExecutionCoordinator(toolResolver);
  await assert.rejects(() => toolCoordinator.dispatch({ experiment: experiment(), authorization }), /candidate runtime task must expose zero tools/);
  assert.equal(ctx.referenceRuntime.createRequests.length, 0);
  assert.equal(ctx.candidateRuntime.createRequests.length, 0);

  const driftResolver = {
    async resolve(input) {
      const base = await ctx.resolver.resolve(input);
      return input.role === "candidate" ? { ...base, task: { ...base.task, prompt: `${base.task.prompt} drift` } } : base;
    },
  };
  const driftCoordinator = new RuntimeBackedDeferredBoundedLiveExecutionCoordinator(driftResolver);
  await assert.rejects(() => driftCoordinator.dispatch({ experiment: experiment(), authorization }), /identical prompt\/context\/tool policy/);
  assert.equal(ctx.referenceRuntime.createRequests.length, 0);
  assert.equal(ctx.candidateRuntime.createRequests.length, 0);
});

test("existing durable binding blocks deferred live redispatch before a second provider session", async (t) => {
  const ctx = await fixture(t);
  const authorization = sampleAuthorization();
  await ctx.coordinator.dispatch({ experiment: experiment(), authorization });
  const second = new RuntimeBackedDeferredBoundedLiveExecutionCoordinator(ctx.resolver);
  await assert.rejects(() => second.dispatch({ experiment: experiment(), authorization }), /already has durable binding; automatic redispatch is forbidden/);
  assert.equal(ctx.referenceRuntime.createRequests.length, 1);
  assert.equal(ctx.candidateRuntime.createRequests.length, 1);
});

test("candidate send failure after both durable bindings remains manual-reconciliation only", async (t) => {
  const ctx = await fixture(t, { candidateFailSend: true });
  const authorization = sampleAuthorization();
  await assert.rejects(
    () => ctx.coordinator.dispatch({ experiment: experiment(), authorization }),
    /send side effect is uncertain after durable binding; manual reconciliation is required and automatic redispatch is forbidden/,
  );
  assert.equal(ctx.referenceRuntime.createRequests.length, 1);
  assert.equal(ctx.candidateRuntime.createRequests.length, 1);
  assert.equal(ctx.referenceRuntime.tasks.length, 1);
  assert.equal(ctx.candidateRuntime.tasks.length, 1);
  assert.ok(ctx.bindingStore.get(ctx.referenceRun.id));
  assert.ok(ctx.bindingStore.get(ctx.candidateRun.id));
  const second = new RuntimeBackedDeferredBoundedLiveExecutionCoordinator(ctx.resolver);
  await assert.rejects(() => second.dispatch({ experiment: experiment(), authorization }), /already has durable binding; automatic redispatch is forbidden/);
});
