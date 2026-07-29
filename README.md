# Intelligent Agent Router

A TypeScript starter for an AI orchestrator that analyzes prompts, selects skills, chooses an appropriate model tier, builds an execution plan, and adds verification when the task is risky or complex.

## What it solves

Most agent systems make one of two charming mistakes:

1. send everything to one giant model; or
2. build a pile of `if prompt.includes(...)` rules until nobody dares touch it.

This router uses a hybrid design:

- deterministic constraints for safety, modality, privacy, context, and budget;
- optional semantic task analysis through the OpenAI Responses API;
- typed model and skill registries;
- weighted routing with reasons and penalties;
- execution planning and verifier selection;
- fallback models instead of blind retries.

## Requirements

- Node.js 20+
- npm
- Optional OpenAI API key for semantic classification

## Setup

```bash
cp .env.example .env
npm install
npm run check
```

Run a routing decision:

```bash
npm run dev -- "Gunakan GitHub untuk audit repository, perbaiki bug, jalankan test, dan buat PR"
```

The CLI returns JSON containing:

- task analysis;
- primary and fallback models;
- selected skills;
- execution plan;
- routing reasons and penalties;
- trace ID.

## Model IDs

The registry uses stable internal IDs such as `openai-fast`, `openai-balanced`, and `openai-frontier`. Actual provider model IDs are environment variables. This prevents routing logic from being welded to a provider naming scheme.

Configure:

```env
OPENAI_ROUTER_MODEL_ID=<cheap structured-output model>
OPENAI_FAST_MODEL_ID=<fast execution model>
OPENAI_BALANCED_MODEL_ID=<balanced reasoning model>
OPENAI_FRONTIER_MODEL_ID=<highest reliability model>
```

## Recommended production topology

```text
API / Chat UI
    |
Prompt Normalizer
    |
Policy and Risk Gate
    |
Hybrid Task Analyzer
    |
Skill Router ------ Skill Registry / MCP Catalog
    |
Model Router ------ Model Registry / Cost / Health
    |
Execution Planner
    |
Tool Sandbox + Provider Adapters
    |
Verifier / Evaluator
    |
Final Response + Trace
```

## Routing principles

1. Hard-filter impossible or disallowed routes first.
2. Prefer the cheapest model that clears a reliability threshold.
3. Use a stronger verifier for high-risk outputs.
4. Never expose write-capable tools without explicit side-effect metadata.
5. Escalate based on evidence, not because the prompt sounds dramatic.
6. Record routing outcomes and tune weights using evals.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full design.

## Runtime execution

The router now ships with a runtime execution engine that can run registered skill executors with dependency ordering, retries, timeout control, and approval gates.

Example with an in-memory executor:

```ts
import {
  ExecutionEngine,
  ExecutorRegistry,
  InMemorySkillExecutor,
} from "./dist/index.js";

const registry = new ExecutorRegistry().register(
  new InMemorySkillExecutor("document-builder", async (step, context) => {
    return {
      output: {
        stepId: step.id,
        previousOutput: context.previousOutput ?? null,
      },
    };
  }),
);

const engine = new ExecutionEngine({ registry });
const result = await engine.run({
  prompt: "Build the report",
  decision: routingDecision,
  approvedStepIds: ["write-report"],
});

console.log(result.status);
console.log(result.trace[0].status);
console.log(result.traceId);
```

If the routing decision has no usable `traceId`, the engine generates one once per execution. Fallback models are used on later attempts when a retryable failure occurs, and the trace records every attempt with the model ID that was actually used.

The execution trace records step status, attempts, model IDs, duration, and normalized errors without storing raw secrets or credentials.
