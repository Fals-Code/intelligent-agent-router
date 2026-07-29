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
