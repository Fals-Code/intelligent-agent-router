import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DurableWorkflowStateMachine,
  InMemoryAgentRuntimeAdapter,
  JsonlRuntimeBindingStore,
  JsonlWorkflowCheckpointStore,
  RuntimeBackedShadowExperimentExecutionAdapter,
  RuntimeReconciliationCoordinator,
  RuntimeVerificationCoordinator,
} from "../dist/index.js";

class RecordingRuntimeAdapter {
  constructor(runtimeId, sessionId) {
    this.inner = new InMemoryAgentRuntimeAdapter({
      runtimeId,
      createSessionId: () => sessionId,
      createEventId: (() => {
        let sequence = 0;
        return () => `${runtimeId}-event-${++sequence}`;
      })(),
      now: () => "2026-08-19T01:00:00.000Z",
    });
    this.runtimeId = runtimeId;
    this.createRequests = [];
    this.tasks = [];
  }

  async createSession(request) {
    this.createRequests.push(request);
    return this.inner.createSession(request);
  }
  async sendTask(sessionId, task) {
    this.tasks.push({ sessionId, task });
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
  completeTask(...args) { return this.inner.completeTask(...args); }
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "9router-shadow-runtime-adapter-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workflowStore = new JsonlWorkflowCheckpointStore({
    filePath: join(root, "workflow.jsonl"),
    maxFileBytes: 512 * 1024,
    maxCheckpointBytes: 32 * 1024,
  });
  const machine = new DurableWorkflowStateMachine(workflowStore);
  const referenceRun = makeExecuteRun(machine, "shadow-reference-run", "project-shadow-runtime");
  const candidateRun = makeExecuteRun(machine, "shadow-candidate-run", "project-shadow-runtime");
  const bindingPath = join(root, "binding.jsonl");
  const bindingStore = new JsonlRuntimeBindingStore({
    filePath: bindingPath,
    maxFileBytes: 512 * 1024,
    maxBindingBytes: 32 * 1024,
  });
  const referenceRuntime = new RecordingRuntimeAdapter("reference-runtime", "reference-session");
  const candidateRuntime = new RecordingRuntimeAdapter("candidate-runtime", "candidate-session");
  const sharedTask = {
    prompt: "Return a concise shadow comparison result without external side effects.",
    context: ["R0 shadow-only experiment.", "No tools or publication are available."],
    toolIds: [],
  };
  const resolver = {
    async resolve({ role, subjectId }) {
      return role === "reference"
        ? {
            subjectId,
            run: referenceRun,
            workspace: root,
            adapter: referenceRuntime,
            bindingStore,
            task: { taskId: "reference-shadow-task", ...sharedTask },
          }
        : {
            subjectId,
            run: candidateRun,
            workspace: root,
            adapter: candidateRuntime,
            bindingStore,
            task: { taskId: "candidate-shadow-task", ...sharedTask },
          };
    },
  };
  const adapter = new RuntimeBackedShadowExperimentExecutionAdapter(resolver, {
    id: "runtime-backed-shadow:test",
    now: () => "2026-08-19T01:01:00.000Z",
  });
  return { root, referenceRun, candidateRun, bindingStore, bindingPath, referenceRuntime, candidateRuntime, resolver, adapter };
}

function makeExecuteRun(machine, id, projectId) {
  let run = machine.create({ id, projectId, riskClass: "R0", now: "2026-08-19T00:58:00.000Z" });
  run = machine.start(run, "2026-08-19T00:58:01.000Z");
  run = machine.advance(run, "2026-08-19T00:58:02.000Z");
  run = machine.advance(run, "2026-08-19T00:58:03.000Z");
  assert.equal(run.phase, "execute");
  assert.equal(run.status, "running");
  return run;
}

function dispatchRequest(overrides = {}) {
  return {
    experimentId: "m5experiment:shadow-runtime-proof",
    experimentSha256: "a".repeat(64),
    authorizationId: "m5expauth:shadow-runtime-proof",
    authorizationSha256: "b".repeat(64),
    sampleId: "shadow-sample-1",
    exposure: "shadow",
    liveAssignment: "none",
    inputReference: "fixture:shadow-input-1",
    referenceSubjectId: "subject:reference",
    candidateSubjectId: "subject:candidate",
    candidateOutputMayBeExternallyVisible: false,
    idempotencyKey: "m5experiment:shadow-runtime-proof:shadow-sample-1:reservation-hash",
    ...overrides,
  };
}

function probeFor(runtime) {
  return {
    runtimeId: runtime.runtimeId,
    async inspect(binding) {
      const status = await runtime.getStatus(binding.sessionId);
      const events = await runtime.getEvents(binding.sessionId);
      const diff = await runtime.getDiff(binding.sessionId);
      return {
        runtimeId: binding.runtimeId,
        sessionId: binding.sessionId,
        status,
        observedAt: "2026-08-19T01:02:00.000Z",
        events: {
          count: events.length,
          types: [...new Set(events.map((event) => event.type))].sort(),
          lastEventId: events.at(-1)?.id,
          lastEventAt: events.at(-1)?.timestamp,
        },
        diff: {
          filesChanged: [...diff.filesChanged].sort(),
          commitSha: diff.commitSha,
          patchObserved: Boolean(diff.patch),
        },
      };
    },
  };
}

test("runtime-backed shadow adapter binds two R0 execute workflows before sending identical no-tool tasks", async (t) => {
  const ctx = await fixture(t);
  const receipt = await ctx.adapter.dispatch(dispatchRequest());

  assert.equal(receipt.candidateOutputExternallyVisible, false);
  assert.match(receipt.referenceExecutionReference, /^shadow-runtime:reference:reference-runtime:shadow-reference-run:1:reference-session$/);
  assert.match(receipt.candidateExecutionReference, /^shadow-runtime:candidate:candidate-runtime:shadow-candidate-run:1:candidate-session$/);
  assert.equal(ctx.referenceRuntime.createRequests.length, 1);
  assert.equal(ctx.candidateRuntime.createRequests.length, 1);
  assert.equal(ctx.referenceRuntime.tasks.length, 1);
  assert.equal(ctx.candidateRuntime.tasks.length, 1);
  assert.deepEqual(ctx.referenceRuntime.tasks[0].task.context, ctx.candidateRuntime.tasks[0].task.context);
  assert.equal(ctx.referenceRuntime.tasks[0].task.prompt, ctx.candidateRuntime.tasks[0].task.prompt);
  assert.deepEqual(ctx.referenceRuntime.tasks[0].task.toolIds, []);
  assert.deepEqual(ctx.candidateRuntime.tasks[0].task.toolIds, []);

  for (const request of [ctx.referenceRuntime.createRequests[0], ctx.candidateRuntime.createRequests[0]]) {
    assert.equal(request.riskClass, "R0");
    assert.equal(request.metadata["9router.experimentExposure"], "shadow");
    assert.equal(request.metadata["9router.experimentCandidateOutputExternallyVisible"], false);
  }

  const referenceBinding = ctx.bindingStore.get(ctx.referenceRun.id);
  const candidateBinding = ctx.bindingStore.get(ctx.candidateRun.id);
  assert.equal(referenceBinding.sessionId, "reference-session");
  assert.equal(candidateBinding.sessionId, "candidate-session");

  const reopened = new JsonlRuntimeBindingStore({
    filePath: ctx.bindingPath,
    maxFileBytes: 512 * 1024,
    maxBindingBytes: 32 * 1024,
  });
  assert.equal(reopened.get(ctx.referenceRun.id).sessionId, "reference-session");
  assert.equal(reopened.get(ctx.candidateRun.id).sessionId, "candidate-session");
});

test("completed shadow sessions reconcile and verify through the canonical runtime coordinators", async (t) => {
  const ctx = await fixture(t);
  await ctx.adapter.dispatch(dispatchRequest());
  const referenceBinding = ctx.bindingStore.get(ctx.referenceRun.id);
  const candidateBinding = ctx.bindingStore.get(ctx.candidateRun.id);
  ctx.referenceRuntime.completeTask(referenceBinding.sessionId, { filesChanged: [] });
  ctx.candidateRuntime.completeTask(candidateBinding.sessionId, { filesChanged: [] });

  const reconciliationCoordinator = new RuntimeReconciliationCoordinator();
  const verificationCoordinator = new RuntimeVerificationCoordinator();
  for (const [run, binding, runtime, role] of [
    [ctx.referenceRun, referenceBinding, ctx.referenceRuntime, "reference"],
    [ctx.candidateRun, candidateBinding, ctx.candidateRuntime, "candidate"],
  ]) {
    const reconciliation = await reconciliationCoordinator.reconcile(run, binding, probeFor(runtime));
    assert.equal(reconciliation.disposition, "verify_runtime_result");
    assert.equal(reconciliation.automaticRedispatchAllowed, false);
    const verification = await verificationCoordinator.verify(run, reconciliation, {
      id: `shadow-${role}-verifier`,
      async verify({ observation }) {
        return {
          passed: observation.status === "completed" && observation.diff.filesChanged.length === 0 && observation.diff.patchObserved === false,
          reference: `shadow-runtime:${role}:deterministic-proof`,
          collectedAt: "2026-08-19T01:03:00.000Z",
          metadata: { candidateOutputExternallyVisible: false },
        };
      },
    });
    assert.equal(verification.passed, true);
  }
});

test("shadow adapter rejects live exposure, tools, or incomparable targets before provider side effects", async (t) => {
  const ctx = await fixture(t);
  await assert.rejects(
    () => ctx.adapter.dispatch(dispatchRequest({ exposure: "bounded_live", liveAssignment: "candidate", candidateOutputMayBeExternallyVisible: true })),
    /accepts shadow exposure only/,
  );
  assert.equal(ctx.referenceRuntime.createRequests.length, 0);
  assert.equal(ctx.candidateRuntime.createRequests.length, 0);

  const toolResolver = {
    async resolve(input) {
      const base = await ctx.resolver.resolve(input);
      return input.role === "candidate" ? { ...base, task: { ...base.task, toolIds: ["read"] } } : base;
    },
  };
  const toolAdapter = new RuntimeBackedShadowExperimentExecutionAdapter(toolResolver);
  await assert.rejects(() => toolAdapter.dispatch(dispatchRequest()), /candidate task must not expose tools/);
  assert.equal(ctx.referenceRuntime.createRequests.length, 0);
  assert.equal(ctx.candidateRuntime.createRequests.length, 0);

  const driftResolver = {
    async resolve(input) {
      const base = await ctx.resolver.resolve(input);
      return input.role === "candidate" ? { ...base, task: { ...base.task, prompt: `${base.task.prompt} drift` } } : base;
    },
  };
  const driftAdapter = new RuntimeBackedShadowExperimentExecutionAdapter(driftResolver);
  await assert.rejects(() => driftAdapter.dispatch(dispatchRequest()), /prompts must be identical/);
  assert.equal(ctx.referenceRuntime.createRequests.length, 0);
  assert.equal(ctx.candidateRuntime.createRequests.length, 0);
});

test("existing durable binding blocks redispatch before a second runtime session is created", async (t) => {
  const ctx = await fixture(t);
  await ctx.adapter.dispatch(dispatchRequest());
  const second = new RuntimeBackedShadowExperimentExecutionAdapter(ctx.resolver);
  await assert.rejects(() => second.dispatch(dispatchRequest()), /already has a durable runtime binding; automatic redispatch is forbidden/);
  assert.equal(ctx.referenceRuntime.createRequests.length, 1);
  assert.equal(ctx.candidateRuntime.createRequests.length, 1);
});
