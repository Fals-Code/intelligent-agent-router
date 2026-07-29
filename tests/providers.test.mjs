import test from "node:test";
import assert from "node:assert/strict";
import {
  ProviderRegistry,
  InMemoryModelProvider,
  createRetryableProviderError,
  createNonRetryableProviderError,
  RegistryModelResolver,
  OpenAIModelProvider,
  ProviderBackedSkillExecutor,
  ExecutionEngine,
  ExecutorRegistry,
  DefaultRetryPolicy,
} from "../dist/index.js";

function modelRegistry() {
  return [
    { id: "openai-fast", provider: "openai", apiModelEnv: "OPENAI_FAST_MODEL_ID", enabled: true },
    { id: "openai-balanced", provider: "openai", apiModelEnv: "OPENAI_BALANCED_MODEL_ID", enabled: true },
    { id: "openai-frontier", provider: "openai", apiModelEnv: "OPENAI_FRONTIER_MODEL_ID", enabled: false },
  ];
}

function envReader(values) {
  return { get: (name) => values[name] };
}

function decision(overrides = {}) {
  return {
    analysis: { rawPrompt: "p", normalizedPrompt: "p", intent: "answer", domain: "general", complexity: "simple", risk: "low", modalities: ["text"], requiredCapabilities: [], preferredCapabilities: [], requiredSkills: [], outputFormat: "text", requiresFreshData: false, requiresExternalAction: false, requiresVerification: false, canParallelize: false, estimatedContextTokens: 16, confidence: 1, ambiguities: [], constraints: {} },
    primaryModel: { candidate: { id: "openai-fast" }, score: 1, reasons: [], penalties: [] },
    fallbackModels: [{ candidate: { id: "openai-balanced" }, score: 0.5, reasons: [], penalties: [] }],
    selectedSkills: [],
    plan: [],
    explanation: [],
    traceId: "trace-1",
    ...overrides,
  };
}

function step(id, extras = {}) {
  return { id, purpose: "execute", skillIds: [id], modelId: "openai-fast", dependsOn: [], humanApprovalRequired: false, instructions: id, ...extras };
}

function fakeResponse({ ok = true, status = 200, headers = {}, json, text }) {
  return {
    ok,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    json: async () => json,
    text: async () => text ?? JSON.stringify(json),
  };
}

test("ProviderRegistry rejects duplicate provider registration", () => {
  const registry = new ProviderRegistry();
  const provider = new InMemoryModelProvider("openai", async () => ({ outputText: "ok", providerId: "openai", internalModelId: "openai-fast", providerModelId: "gpt-fast", latencyMs: 1 }));
  registry.register(provider);
  assert.throws(() => registry.register(provider), /Provider already registered for provider openai/);
});

test("ProviderRegistry resolves the first supporting provider and errors when none match", () => {
  const primary = new InMemoryModelProvider("openai", async () => ({ providerId: "openai", internalModelId: "openai-fast", providerModelId: "gpt-fast", outputText: "ok", latencyMs: 1 }), new Set(["openai-fast"]));
  const secondary = new InMemoryModelProvider("alt", async () => ({ providerId: "alt", internalModelId: "openai-fast", providerModelId: "alt-fast", outputText: "ok", latencyMs: 1 }), new Set(["openai-balanced"]));
  const registry = new ProviderRegistry().register(primary).register(secondary);
  assert.equal(registry.resolveSupporting({ providerId: "openai", internalModelId: "openai-fast", providerModelId: "gpt-fast", messages: [] }), primary);
  assert.throws(() => registry.resolveSupporting({ providerId: "missing", internalModelId: "openai-fast", providerModelId: "gpt-fast", messages: [] }), /No provider available/);
});

test("RegistryModelResolver resolves internal model IDs and rejects missing env, unknown, disabled, and provider mismatch", () => {
  const resolver = new RegistryModelResolver(modelRegistry(), envReader({ OPENAI_FAST_MODEL_ID: "gpt-fast" }));
  assert.deepEqual(resolver.resolve("openai-fast"), { internalModelId: "openai-fast", providerId: "openai", providerModelId: "gpt-fast" });
  assert.throws(() => resolver.resolve("missing"), /Unknown model missing/);
  assert.throws(() => resolver.resolve("openai-balanced"), /Missing environment variable OPENAI_BALANCED_MODEL_ID/);
  assert.throws(() => resolver.resolve("openai-frontier"), /Model openai-frontier is disabled/);
  assert.equal(resolver.resolve("openai-fast").providerId, "openai");
});

test("InMemoryModelProvider can simulate success, structured output, retryable and non-retryable errors", async () => {
  const success = new InMemoryModelProvider("openai", async () => ({ providerId: "openai", internalModelId: "openai-fast", providerModelId: "gpt-fast", outputText: "hello", latencyMs: 2 }));
  const structured = new InMemoryModelProvider("openai", async () => ({ providerId: "openai", internalModelId: "openai-fast", providerModelId: "gpt-fast", structuredOutput: { ok: true }, latencyMs: 2 }));
  const retryable = new InMemoryModelProvider("openai", async () => ({ error: createRetryableProviderError("rate limited", "openai", "openai-fast", "gpt-fast", "rate_limit") }));
  const nonRetryable = new InMemoryModelProvider("openai", async () => ({ error: createNonRetryableProviderError("bad input", "openai", "openai-fast", "gpt-fast") }));

  assert.equal((await success.generate({ providerId: "openai", internalModelId: "openai-fast", providerModelId: "gpt-fast", messages: [] })).outputText, "hello");
  assert.deepEqual((await structured.generate({ providerId: "openai", internalModelId: "openai-fast", providerModelId: "gpt-fast", messages: [] })).structuredOutput, { ok: true });
  assert.equal((await retryable.generate({ providerId: "openai", internalModelId: "openai-fast", providerModelId: "gpt-fast", messages: [] })).error.retryable, true);
  assert.equal((await nonRetryable.generate({ providerId: "openai", internalModelId: "openai-fast", providerModelId: "gpt-fast", messages: [] })).error.retryable, false);
});

test("OpenAIModelProvider parses structured output when schema is supplied", async () => {
  const provider = new OpenAIModelProvider({
    apiKey: "sk-secret",
    baseUrl: "https://example.invalid/v1/responses",
    fetchImpl: async () => fakeResponse({ json: { output_text: "{\"ok\":true}" } }),
  });
  const result = await provider.generate({ providerId: "openai", internalModelId: "openai-fast", providerModelId: "gpt-fast", messages: [], structuredOutputSchema: { name: "Result", schema: { type: "object" } } });
  assert.deepEqual(result.structuredOutput, { ok: true });
});

test("OpenAIModelProvider records usage and request identifiers when available", async () => {
  const provider = new OpenAIModelProvider({
    apiKey: "sk-secret",
    baseUrl: "https://example.invalid/v1/responses",
    fetchImpl: async () => fakeResponse({ headers: { "x-request-id": "req-usage" }, json: { id: "resp-usage", output_text: "hello", usage: { input_tokens: 3, output_tokens: 5, total_tokens: 8 } } }),
  });
  const result = await provider.generate({ providerId: "openai", internalModelId: "openai-fast", providerModelId: "gpt-fast", messages: [] });
  assert.equal(result.requestId, "req-usage");
  assert.deepEqual(result.usage, { inputTokens: 3, outputTokens: 5, totalTokens: 8 });
  assert.equal(result.outputText, "hello");
});

test("OpenAIModelProvider handles empty, malformed, and partial usage defensively", async () => {
  const empty = new OpenAIModelProvider({ apiKey: "sk-secret", baseUrl: "https://example.invalid/v1/responses", fetchImpl: async () => fakeResponse({ json: { output: [] } }) });
  const emptyResult = await empty.generate({ providerId: "openai", internalModelId: "openai-fast", providerModelId: "gpt-fast", messages: [] });
  assert.equal(emptyResult.error.category, "unknown");
  assert.match(emptyResult.error.message, /no output text/);

  const malformed = new OpenAIModelProvider({ apiKey: "sk-secret", baseUrl: "https://example.invalid/v1/responses", fetchImpl: async () => fakeResponse({ json: "not-an-object" }) });
  const malformedResult = await malformed.generate({ providerId: "openai", internalModelId: "openai-fast", providerModelId: "gpt-fast", messages: [] });
  assert.equal(malformedResult.error.category, "unknown");
  assert.match(malformedResult.error.message, /invalid payload/);

  const partialUsage = new OpenAIModelProvider({ apiKey: "sk-secret", baseUrl: "https://example.invalid/v1/responses", fetchImpl: async () => fakeResponse({ json: { output_text: "hello", usage: { input_tokens: 2, output_tokens: -1 } } }) });
  const partial = await partialUsage.generate({ providerId: "openai", internalModelId: "openai-fast", providerModelId: "gpt-fast", messages: [] });
  assert.equal(partial.outputText, "hello");
  assert.deepEqual(partial.usage, { inputTokens: 2, outputTokens: undefined, totalTokens: 2 });
});

test("OpenAIModelProvider maps HTTP and network failures", async () => {
  const provider = new OpenAIModelProvider({
    apiKey: "sk-secret",
    baseUrl: "https://example.invalid/v1/responses",
    fetchImpl: async () => new Response("unauthorized", { status: 401 }),
  });
  const auth = await provider.generate({ providerId: "openai", internalModelId: "openai-fast", providerModelId: "gpt-fast", messages: [] });
  assert.equal(auth.error.category, "authentication");
  assert.equal(auth.error.retryable, false);

  const rateLimited = new OpenAIModelProvider({
    apiKey: "sk-secret",
    baseUrl: "https://example.invalid/v1/responses",
    fetchImpl: async () => new Response("too many", { status: 429 }),
  });
  assert.equal((await rateLimited.generate({ providerId: "openai", internalModelId: "openai-fast", providerModelId: "gpt-fast", messages: [] })).error.retryable, true);

  const network = new OpenAIModelProvider({
    apiKey: "sk-secret",
    baseUrl: "https://example.invalid/v1/responses",
    fetchImpl: async () => { throw new TypeError("fetch failed"); },
  });
  assert.equal((await network.generate({ providerId: "openai", internalModelId: "openai-fast", providerModelId: "gpt-fast", messages: [] })).error.category, "unknown");

  const aborted = new OpenAIModelProvider({
    apiKey: "sk-secret",
    baseUrl: "https://example.invalid/v1/responses",
    fetchImpl: async (_url, init) => { init.signal.throwIfAborted(); throw new DOMException("Aborted", "AbortError"); },
  });
  const controller = new AbortController();
  controller.abort();
  assert.equal((await aborted.generate({ providerId: "openai", internalModelId: "openai-fast", providerModelId: "gpt-fast", messages: [], signal: controller.signal })).error.category, "aborted");
});

test("OpenAIModelProvider maps HTTP errors by status and sanitizes sensitive body text", async () => {
  const cases = [
    [400, "invalid_request", false],
    [401, "authentication", false],
    [403, "authorization", false],
    [408, "timeout", true],
    [429, "rate_limit", true],
    [500, "provider_error", true],
    [502, "provider_error", true],
    [503, "model_unavailable", true],
  ];
  for (const [status, category, retryable] of cases) {
    const provider = new OpenAIModelProvider({
      apiKey: "sk-secret",
      baseUrl: "https://example.invalid/v1/responses",
      fetchImpl: async () => fakeResponse({ ok: false, status, text: `api_key=secret Bearer token password=bad credential=bad` }),
    });
    const result = await provider.generate({ providerId: "openai", internalModelId: "openai-fast", providerModelId: "gpt-fast", messages: [] });
    assert.equal(result.error.category, category);
    assert.equal(result.error.retryable, retryable);
    assert.ok(!JSON.stringify(result).includes("secret"));
  }
});

test("OpenAIModelProvider rejects malformed structured output and sanitized error bodies", async () => {
  const provider = new OpenAIModelProvider({
    apiKey: "sk-secret",
    baseUrl: "https://example.invalid/v1/responses",
    fetchImpl: async () => new Response(JSON.stringify({ output_text: "not-json" }), { status: 200 }),
  });
  const malformed = await provider.generate({ providerId: "openai", internalModelId: "openai-fast", providerModelId: "gpt-fast", messages: [], structuredOutputSchema: { name: "Result", schema: { type: "object" } } });
  assert.equal(malformed.error.message, "OpenAI provider returned malformed structured output");
});

test("ProviderBackedSkillExecutor resolves models and execution engine retries on provider failures", async () => {
  const calls = [];
  const provider = new InMemoryModelProvider("openai", async (request) => {
    calls.push({ internalModelId: request.internalModelId, providerModelId: request.providerModelId });
    if (calls.length === 1) return { error: createRetryableProviderError("retry", "openai", request.internalModelId, request.providerModelId) };
    return { providerId: "openai", internalModelId: request.internalModelId, providerModelId: request.providerModelId, outputText: "done", latencyMs: 1 };
  }, new Set(["openai-fast", "openai-balanced"]));
  const registry = new ProviderRegistry().register(provider);
  const resolver = new RegistryModelResolver(modelRegistry(), envReader({ OPENAI_FAST_MODEL_ID: "gpt-fast", OPENAI_BALANCED_MODEL_ID: "gpt-balanced" }));
  const engine = new ExecutionEngine({
    registry: new ExecutorRegistry().register(new ProviderBackedSkillExecutor("model-exec", registry, resolver)),
    retryPolicy: new DefaultRetryPolicy({ baseDelayMs: 1 }),
    maxAttempts: 2,
    now: () => 1_000,
  });
  const result = await engine.run({ prompt: "p", decision: decision({ plan: [step("model-exec")] }) });
  assert.equal(result.status, "succeeded");
  assert.deepEqual(calls.map((item) => item.providerModelId), ["gpt-fast", "gpt-balanced"]);
  assert.equal(result.outputs["model-exec"].providerModelId, "gpt-balanced");
  assert.equal(result.trace[0].attempts[0].modelId, "openai-fast");
  assert.equal(result.trace[0].attempts[1].modelId, "openai-balanced");
});

test("ProviderBackedSkillExecutor respects approval gates before provider invocation", async () => {
  let called = false;
  const provider = new InMemoryModelProvider("openai", async () => {
    called = true;
    return { providerId: "openai", internalModelId: "openai-fast", providerModelId: "gpt-fast", outputText: "ok", latencyMs: 1 };
  }, new Set(["openai-fast"]));
  const registry = new ProviderRegistry().register(provider);
  const resolver = new RegistryModelResolver(modelRegistry(), envReader({ OPENAI_FAST_MODEL_ID: "gpt-fast" }));
  const engine = new ExecutionEngine({
    registry: new ExecutorRegistry().register(new ProviderBackedSkillExecutor("model-exec", registry, resolver)),
    now: () => 1_000,
  });
  const result = await engine.run({ prompt: "p", decision: decision({ plan: [step("model-exec", { humanApprovalRequired: true })] }) });
  assert.equal(result.status, "blocked");
  assert.equal(called, false);
});

test("ProviderBackedSkillExecutor fails clearly when current model is missing and respects provider mismatch", async () => {
  const provider = new InMemoryModelProvider("openai", async () => ({ providerId: "openai", internalModelId: "openai-fast", providerModelId: "gpt-fast", outputText: "ok", latencyMs: 1 }), new Set(["openai-fast"]));
  const registry = new ProviderRegistry().register(provider);
  const resolver = new RegistryModelResolver(modelRegistry(), envReader({ OPENAI_FAST_MODEL_ID: "gpt-fast" }));
  const executor = new ProviderBackedSkillExecutor("model-exec", registry, resolver);
  const missing = await executor.execute(step("model-exec"), { prompt: "p", traceId: "t", decision: decision(), executionPlan: [], metadata: {}, signal: new AbortController().signal, approvedStepIds: new Set() });
  assert.equal(missing.error.code, "MISSING_CURRENT_MODEL_ID");

  const mismatch = new InMemoryModelProvider("alt", async () => ({ providerId: "alt", internalModelId: "openai-fast", providerModelId: "alt-fast", outputText: "ok", latencyMs: 1 }), new Set(["openai-fast"]));
  const badRegistry = new ProviderRegistry().register(mismatch);
  const result = await new ProviderBackedSkillExecutor("model-exec", badRegistry, resolver).execute(step("model-exec"), {
    prompt: "p",
    traceId: "t",
    decision: decision(),
    executionPlan: [],
    currentModelId: "openai-fast",
    metadata: {},
    signal: new AbortController().signal,
    approvedStepIds: new Set(),
  });
  assert.equal(result.error.code, "PROVIDER_EXECUTION_ERROR");
});
