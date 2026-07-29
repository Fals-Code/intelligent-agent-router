import test from "node:test";
import assert from "node:assert/strict";
import { IntelligentAgentRouter } from "../dist/orchestrator/agent-router.js";
import { DefaultRetryPolicy, ExecutionEngine, ExecutorRegistry, InMemorySkillExecutor } from "../dist/execution/index.js";

const router = new IntelligentAgentRouter();

function decision(overrides = {}) {
  return {
    analysis: {
      rawPrompt: "prompt",
      normalizedPrompt: "prompt",
      intent: "answer",
      domain: "general",
      complexity: "simple",
      risk: "low",
      modalities: ["text"],
      requiredCapabilities: [],
      preferredCapabilities: [],
      requiredSkills: [],
      outputFormat: "text",
      requiresFreshData: false,
      requiresExternalAction: false,
      requiresVerification: false,
      canParallelize: false,
      estimatedContextTokens: 16,
      confidence: 1,
      ambiguities: [],
      constraints: {},
    },
    primaryModel: { candidate: { id: "primary" }, score: 1, reasons: [], penalties: [] },
    fallbackModels: [{ candidate: { id: "fallback" }, score: 0.5, reasons: [], penalties: [] }],
    selectedSkills: [],
    plan: [],
    explanation: [],
    traceId: "trace-1",
    ...overrides,
  };
}

function step(id, extras = {}) {
  return {
    id,
    purpose: "execute",
    skillIds: [id],
    modelId: "primary",
    dependsOn: [],
    humanApprovalRequired: false,
    instructions: id,
    ...extras,
  };
}

function engineWith(executors, options = {}) {
  const registry = new ExecutorRegistry().registerAll(executors);
  return new ExecutionEngine({ registry, retryPolicy: options.retryPolicy, maxAttempts: options.maxAttempts, now: options.now ?? (() => 1_000) });
}

test("routes fresh GitHub coding work to GitHub and a tool-capable model", async () => {
  const result = await router.route(
    "Gunakan GitHub untuk memeriksa bug terbaru pada repository, perbaiki kodenya, jalankan test, lalu buat pull request.",
  );

  assert.equal(result.analysis.domain, "software");
  assert.equal(result.analysis.requiresFreshData, true);
  assert.ok(result.selectedSkills.map((item) => item.candidate.id).includes("github"));
  assert.equal(result.primaryModel.candidate.toolUse, true);
  assert.ok(result.plan.some((step) => step.purpose === "verify"));
});

test("keeps a simple summary on the cheapest capable model", async () => {
  const result = await router.route("Ringkas paragraf ini menjadi tiga kalimat.");
  assert.equal(result.analysis.complexity, "simple");
  assert.equal(result.primaryModel.candidate.id, "openai-fast");
});

test("escalates security analysis", async () => {
  const result = await router.route(
    "Audit repository untuk kerentanan SQL injection, auth bypass, dan kebocoran secret. Buat remediation plan.",
  );

  assert.equal(result.analysis.domain, "security");
  assert.equal(result.analysis.complexity, "expert");
  assert.equal(result.primaryModel.candidate.id, "openai-frontier");
  assert.equal(result.analysis.requiresVerification, true);
});

test("adds image generation skill for visual tasks", async () => {
  const result = await router.route("Buat poster promosi dari foto produk ini.");
  assert.ok(result.selectedSkills.map((item) => item.candidate.id).includes("image-generation"));
});

test("one step succeeds", async () => {
  const engine = engineWith([
    new InMemorySkillExecutor("alpha", async () => ({ output: { ok: true } })),
  ]);
  const result = await engine.run({ prompt: "p", decision: decision({ plan: [step("alpha")] }) });
  assert.equal(result.status, "succeeded");
  assert.equal(result.trace[0].status, "succeeded");
  assert.deepEqual(result.outputs.alpha, { ok: true });
});

test("dependencies run in order", async () => {
  const calls = [];
  const engine = engineWith([
    new InMemorySkillExecutor("first", async () => {
      calls.push("first");
      return { output: "a" };
    }),
    new InMemorySkillExecutor("second", async (_step, context) => {
      calls.push(`second:${context.previousOutput}`);
      return { output: "b" };
    }),
  ]);
  await engine.run({ prompt: "p", decision: decision({ plan: [step("first"), step("second", { dependsOn: ["first"] })] }) });
  assert.deepEqual(calls, ["first", "second:a"]);
});

test("independent steps can run as a parallel group", async () => {
  const calls = [];
  const engine = engineWith([
    new InMemorySkillExecutor("one", async () => {
      calls.push("one-start");
      await new Promise((resolve) => setTimeout(resolve, 20));
      calls.push("one-end");
      return { output: 1 };
    }),
    new InMemorySkillExecutor("two", async () => {
      calls.push("two-start");
      await new Promise((resolve) => setTimeout(resolve, 10));
      calls.push("two-end");
      return { output: 2 };
    }),
  ]);
  const result = await engine.run({
    prompt: "p",
    decision: decision({ plan: [step("one", { parallelGroup: "grp" }), step("two", { parallelGroup: "grp" })] }),
  });
  assert.equal(result.status, "succeeded");
  assert.ok(calls.indexOf("one-start") < calls.indexOf("two-end"));
  assert.ok(calls.indexOf("two-start") < calls.indexOf("one-end"));
});

test("errors when executor is missing", async () => {
  const engine = engineWith([]);
  const result = await engine.run({ prompt: "p", decision: decision({ plan: [step("missing")] }) });
  assert.equal(result.status, "failed");
  assert.equal(result.trace[0].error.code, "EXECUTOR_NOT_FOUND");
});

test("rejects duplicate executor registration and keeps the first executor", async () => {
  const registry = new ExecutorRegistry();
  const first = new InMemorySkillExecutor("dup", async () => ({ output: "first" }));
  const second = new InMemorySkillExecutor("dup", async () => ({ output: "second" }));

  registry.register(first);

  assert.throws(
    () => registry.register(second),
    (error) => error instanceof Error && error.message === "Executor already registered for skill dup",
  );

  assert.strictEqual(registry.resolve("dup"), first);
});

test("keeps decision traceId when provided and uses injected traceId generator when missing", async () => {
  let createTraceCount = 0;
  const engine = new ExecutionEngine({
    registry: new ExecutorRegistry().register(
      new InMemorySkillExecutor("trace", async (_step, context) => ({ output: { traceId: context.traceId, currentModelId: context.currentModelId } })),
    ),
    createTraceId: () => {
      createTraceCount += 1;
      return `generated-${createTraceCount}`;
    },
  });

  const fixedDecision = decision({ traceId: "decision-trace", plan: [step("trace")] });
  const fixedResult = await engine.run({ prompt: "p", decision: fixedDecision });
  assert.equal(fixedResult.traceId, "decision-trace");
  assert.equal(fixedResult.outputs.trace.traceId, "decision-trace");
  assert.equal(fixedResult.trace[0].attempts[0].modelId, "primary");

  const generatedDecision = decision({ traceId: "", plan: [step("trace")] });
  const generatedResult = await engine.run({ prompt: "p", decision: generatedDecision });
  assert.equal(generatedResult.traceId, "generated-1");
  assert.equal(generatedResult.outputs.trace.traceId, "generated-1");
  assert.equal(createTraceCount, 1);
});

test("enforces timeout", async () => {
  const engine = engineWith([
    new InMemorySkillExecutor("slow", async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { error: { name: "TimeoutError", message: "Step timed out", retryable: false, code: "TIMEOUT" } };
    }),
  ]);
  const result = await engine.run({ prompt: "p", decision: decision({ plan: [step("slow", { timeoutMs: 5 })] }) });
  assert.equal(result.status, "timed_out");
  assert.equal(result.trace[0].status, "timed_out");
});

test("retries then succeeds", async () => {
  let count = 0;
  const engine = engineWith([
    new InMemorySkillExecutor("flaky", async () => {
      count += 1;
      if (count === 1) return { error: { name: "RetryableError", message: "again", retryable: true } };
      return { output: "ok" };
    }),
  ]);
  const result = await engine.run({ prompt: "p", decision: decision({ plan: [step("flaky")] }) });
  assert.equal(result.status, "succeeded");
  assert.equal(result.trace[0].attempts.length, 2);
});

test("retry budget can be exhausted", async () => {
  const engine = engineWith([
    new InMemorySkillExecutor("flaky", async () => ({ error: { name: "RetryableError", message: "again", retryable: true } })),
  ], { maxAttempts: 2, retryPolicy: new DefaultRetryPolicy({ baseDelayMs: 1 }) });
  const result = await engine.run({ prompt: "p", decision: decision({ plan: [step("flaky")] }) });
  assert.equal(result.status, "failed");
  assert.equal(result.trace[0].attempts.length, 2);
});

test("non-retryable errors are not repeated", async () => {
  let count = 0;
  const engine = engineWith([
    new InMemorySkillExecutor("bad", async () => {
      count += 1;
      return { error: { name: "ValidationError", message: "nope", retryable: false } };
    }),
  ]);
  const result = await engine.run({ prompt: "p", decision: decision({ plan: [step("bad")] }) });
  assert.equal(result.status, "failed");
  assert.equal(count, 1);
});

test("approval-gated step is blocked", async () => {
  const engine = engineWith([
    new InMemorySkillExecutor("approval", async () => ({ output: "ok" })),
  ]);
  const result = await engine.run({ prompt: "p", decision: decision({ plan: [step("approval", { humanApprovalRequired: true })] }) });
  assert.equal(result.status, "blocked");
  assert.equal(result.trace[0].status, "blocked");
});

test("approved step can run", async () => {
  const engine = engineWith([
    new InMemorySkillExecutor("approval", async () => ({ output: "ok" })),
  ]);
  const result = await engine.run({
    prompt: "p",
    decision: decision({ plan: [step("approval", { humanApprovalRequired: true })] }),
    approvedStepIds: ["approval"],
  });
  assert.equal(result.status, "succeeded");
});

test("fallback model is recorded after retryable failure", async () => {
  const seenModels = [];
  const engine = engineWith([
    new InMemorySkillExecutor("tool", async (step) => {
      seenModels.push(step.modelId);
      if (seenModels.length === 1) return { error: { name: "RetryableError", message: "try fallback", retryable: true } };
      return { output: "ok" };
    }),
  ]);
  const result = await engine.run({ prompt: "p", decision: decision({ plan: [step("tool")] }) });
  assert.equal(result.status, "succeeded");
  assert.deepEqual(seenModels, ["primary", "fallback"]);
  assert.deepEqual(result.trace[0].attempts.map((item) => item.modelId), ["primary", "fallback"]);
});

test("trace does not leak secret material", async () => {
  const engine = engineWith([
    new InMemorySkillExecutor("secret", async () => ({ output: { token: "abc", nested: { apiKey: "def" } } })),
  ]);
  const result = await engine.run({
    prompt: "p",
    decision: decision({ plan: [step("secret")] }),
    metadata: { secret: "raw-secret" },
  });
  const serialized = JSON.stringify(result.trace);
  assert.ok(!serialized.includes("raw-secret"));
  assert.ok(!serialized.includes("abc"));
  assert.ok(!serialized.includes("def"));
});

test("trace sanitization redacts common secret key variants recursively", async () => {
  const engine = engineWith([
    new InMemorySkillExecutor("secret", async () => ({
      output: {
        apiKey: "a",
        api_key: "b",
        API_KEY: "c",
        accessToken: "d",
        access_token: "e",
        authorization: "f",
        password: "g",
        secret: "h",
        credential: "i",
        nested: [{ apiKey: "j", safeValue: "ok" }],
      },
      error: {
        name: "Error",
        message: "bad",
        retryable: false,
        reason: "api_key=leak",
      },
    })),
  ]);
  const result = await engine.run({ prompt: "p", decision: decision({ plan: [step("secret")] }) });
  const serialized = JSON.stringify(result.trace);
  assert.ok(serialized.includes('"apiKey":"[redacted]"'));
  assert.ok(serialized.includes('"api_key":"[redacted]"'));
  assert.ok(serialized.includes('"API_KEY":"[redacted]"'));
  assert.ok(serialized.includes('"accessToken":"[redacted]"'));
  assert.ok(serialized.includes('"access_token":"[redacted]"'));
  assert.ok(serialized.includes('"authorization":"[redacted]"'));
  assert.ok(serialized.includes('"password":"[redacted]"'));
  assert.ok(serialized.includes('"secret":"[redacted]"'));
  assert.ok(serialized.includes('"credential":"[redacted]"'));
  assert.ok(serialized.includes('"nested":[{"apiKey":"[redacted]","safeValue":"ok"}]'));
  assert.ok(serialized.includes("safeValue"));
});

test("dependent step is skipped when dependency fails", async () => {
  const engine = engineWith([
    new InMemorySkillExecutor("bad", async () => ({ error: { name: "ValidationError", message: "nope", retryable: false } })),
    new InMemorySkillExecutor("child", async () => ({ output: "child" })),
  ]);
  const result = await engine.run({ prompt: "p", decision: decision({ plan: [step("bad"), step("child", { dependsOn: ["bad"] })] }) });
  assert.equal(result.trace[1].status, "skipped");
});
