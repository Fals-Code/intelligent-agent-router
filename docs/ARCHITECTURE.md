# Intelligent Agent Router Architecture

## Goal

Route each user request to the smallest reliable combination of model, skills, tools, and verification steps. The system optimizes quality, safety, latency, and cost instead of treating every prompt like an excuse to summon the most expensive model available.

## Decision pipeline

1. **Normalize** the prompt and detect language, modalities, files, URLs, and explicit constraints.
2. **Policy gate** detects sensitive domains, destructive actions, privacy requirements, and approval boundaries.
3. **Task analysis** extracts intent, domain, complexity, risk, freshness, output type, required capabilities, and ambiguity.
4. **Skill routing** selects only skills whose declared contracts fit the task.
5. **Model routing** filters models by hard constraints, then scores capability fit, reliability, reasoning, cost, latency, privacy, and tool support.
6. **Planning** creates a dependency graph for retrieval, execution, verification, and synthesis.
7. **Execution** invokes tools through typed adapters. Models never receive undeclared tools.
8. **Verification** checks claims, tool results, tests, citations, policy compliance, and requested format.
9. **Fallback** escalates only when confidence, execution, or verification fails.
10. **Tracing and evals** store decisions and outcomes without leaking secrets.

## Runtime execution layer

The runtime execution layer lives under `src/execution/` and turns a routing decision into an auditable run:

- `skill-executor.ts` defines the provider-agnostic executor contract.
- `execution-context.ts` carries the prompt, trace ID, routing decision, prior outputs, typed metadata, and abort signal.
- `execution-engine.ts` executes steps in dependency order, supports parallel groups, enforces per-step timeout, and records traces.
- `executor-registry.ts` resolves executors by skill ID.
- `retry-policy.ts` centralizes retryability and backoff.
- `in-memory-executor.ts` provides a deterministic test executor.
- `../providers/` contains provider contracts, registry, model resolution, in-memory provider, OpenAI adapter, and the provider-backed skill executor.

Trace IDs follow a single source-of-truth rule: if `RoutingDecision.traceId` is present and non-empty, the engine reuses it for the entire execution. If it is missing or blank, the engine calls the injected `createTraceId` generator once for the whole run, or falls back to `crypto.randomUUID()`. Step-level execution never creates a new trace ID.

The executor registry rejects duplicate `skillId` registration so a later executor cannot silently replace an earlier one. This keeps resolution deterministic and makes accidental shadowing visible during bootstrap.

The engine treats approval gates, missing executors, validation errors, and destructive-policy violations as explicit states instead of silent fallbacks. Timeout and retry behavior are configured in code and can be injected in tests for deterministic coverage.

## Why hybrid routing

Pure keyword routing is cheap but brittle. Pure LLM routing understands semantics but can hallucinate skills, ignore budgets, or route inconsistently. This project combines:

- deterministic hard constraints;
- an optional semantic classifier;
- a capability registry;
- weighted optimization;
- post-execution verification;
- eval-driven tuning.

## Core contracts

### TaskAnalysis

Represents what the task actually needs, not merely what words appear in the prompt.

### SkillProfile

Every skill declares its domain, input/output modalities, capabilities, authentication, cost, latency, side effects, and risk ceiling.

### ModelProfile

Every model declares capabilities, context window, modalities, tool support, reliability, cost, latency, privacy support, and configurable provider model ID.

### Provider contract

Providers are a separate contract from routing and execution. A provider declares its provider ID, whether it supports a given internal model or request, and how to generate a typed response for a typed request. Provider requests carry the internal model ID, resolved provider model ID, messages, optional system instruction, optional structured output schema, safe metadata, trace ID, step ID, skill ID, and abort signal.

Provider responses carry the provider ID, internal model ID, actual provider model ID, output text or structured output, finish reason, optional usage, latency, request ID when available, and safe metadata. Raw provider responses are not stored by default.

### Provider registry

`ProviderRegistry` registers providers by provider ID, rejects duplicate registration, and resolves a provider for a specific request. It fails explicitly when the provider is missing or does not support the requested model.

### Model resolution

`RegistryModelResolver` treats `modelRegistry` as the source of truth for internal model IDs. It resolves the provider ID and actual provider model ID from environment configuration via `apiModelEnv`. Missing environment values, unknown models, and disabled models fail explicitly.

### Error normalization

Provider errors are normalized into a typed category space: authentication, authorization, rate limit, timeout, network, invalid request, model unavailable, content policy, provider error, aborted, and unknown. The execution engine still decides retry behavior, but provider retryability is preserved in the normalized error so the runtime can honor it without guessing.

### OpenAI adapter boundary

The OpenAI adapter uses native `fetch`, accepts the base URL and API key through constructor parameters, and does not read secrets from a domain object. It sends OpenAI Responses API requests, supports structured output, captures usage and request IDs when available, and sanitizes error text before returning it. This boundary is provider-specific; routing and execution code above it remain provider-agnostic.

### Provider-backed skill executor

`ProviderBackedSkillExecutor` is a thin bridge between the execution engine and a `ModelProvider`. It reads `context.currentModelId`, resolves the internal model to provider identity, builds a provider request, and returns a normalized execution result. It does not implement its own retry loop, timeout policy, or fallback policy.

### Retry and fallback boundary

The execution engine owns retries and model fallback ordering. Provider adapters only indicate whether a failure is retryable. Fallback model selection still comes from the routing decision, while model resolution turns the selected internal model into a provider model ID at the last responsible moment.

### Observability

The runtime records internal model IDs in traces and can expose provider model IDs through safe output metadata when a provider-backed executor chooses to include them. Raw provider responses and secrets are not persisted by default.

### RoutingDecision

Contains the chosen model, fallbacks, selected skills, execution DAG, reasons, penalties, and trace ID.

## Production additions

- Persist traces to PostgreSQL or an observability platform.
- Add provider health, quota, and rate-limit signals to routing.
- Add tenant-level provider and data residency policies.
- Add prompt-injection scanning before tools consume retrieved content.
- Separate read tools from write tools and require approval tokens for writes.
- Add model-specific token pricing from a versioned registry.
- Add evaluation datasets for routing accuracy, task success, cost, latency, and unnecessary escalation.
- Add circuit breakers and fallback providers.
- Add streaming, tool calling, multimodal provider support, and production trace persistence when the execution contract needs them.
