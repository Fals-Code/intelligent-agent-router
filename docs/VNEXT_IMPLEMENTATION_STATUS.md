# 9Router vNext Implementation Status

This file tracks implementation against the frozen **9Router vNext Architecture Contract v1.0**. It is an implementation status document, not a replacement for the frozen contract.

## Current target

The first strategic target is **M4 (Measured)**. Broad provider rollout remains blocked until the reference engineering vertical slice proves the required functional, recovery, reproducibility, observability, security, rollback, and measurement gates.

## Implemented foundation

### Provider boundary

- Provider-agnostic model provider contract.
- Provider registry and internal-model resolution.
- OpenAI provider adapter and in-memory provider for deterministic tests.
- Provider-normalized retryable errors.
- Provider-backed skill execution integrated with the runtime engine.

### Frozen control-plane contracts

- Frozen capability taxonomy represented as typed capability IDs.
- `CapabilityProvider` contract with modes, transports, health, version, permissions, isolation, cost, context, and side-effect metadata.
- PRIMARY / FALLBACK / SHADOW capability bindings.
- Single-writer guard for canonical write domains.
- R0-R4 minimum risk-control model.
- Resource-bound guard for autonomous runs without freezing numeric defaults.
- Engineering workflow states and phase transitions with durable approval state semantics.
- Evidence gate that prevents a successful outcome without required proof.
- Append-only in-memory Run Ledger contract implementation for development and tests.

### Project and context foundation

- In-memory Project Graph contract that stores canonical references and relationships rather than copying provider-owned state.
- Bounded Context Compiler that requires an explicit token budget.
- Applicable project rules are mandatory and cannot be silently dropped to fit the budget.
- Full skill disclosure is limited to selected skills; unselected tool definitions are excluded.
- Design context is included only when design is in scope.
- Compiled context records total token estimate, dropped items, source counts, and tool catalog size.

### Runtime boundary

- Provider-agnostic `AgentRuntimeAdapter` contract covering session creation, task delivery, interrupt/resume, status/events, diff retrieval, approval responses, abort, and destroy.
- In-memory runtime adapter for deterministic lifecycle, approval, interruption, and recovery-oriented contract tests.
- Provider wire schemas remain outside the core runtime contract.

## Not yet implemented

The following remain explicit work items and must not be represented as production-complete:

- Persistent Project Graph schema/backend and migration rules.
- Real retrieval adapters feeding source-code, history, documentation, design, skill, and tool candidates into the Context Compiler.
- MCP Tool Broker and tool catalog filtering from live MCP capability discovery.
- Credential Broker, sandbox policy enforcement, and network egress policy.
- Durable Workflow Engine persistence and machine-restart recovery.
- Persistent Run Ledger backend.
- OpenTelemetry export and versioned internal telemetry schema.
- Eval Plane golden-task storage, baselines, and statistical routing feedback.
- OpenCode, OpenHands, and ACP wire adapters implementing `AgentRuntimeAdapter`.
- Playwright evidence adapter.
- GitHub publish adapter tied to evidence/approval gates.
- Penpot/Excalidraw design adapters.
- Hermes/OpenClaw/n8n/AppFlowy/Baserow/Teable/Appsmith/Cal.diy provider adapters.
- Provider health/quota-aware route selection and circuit breaking.
- Compatibility matrix, adapter quarantine, and capability downgrade behavior.
- Fault injection and machine-restart recovery tests.
- Reference Stok Reconciliation vertical slice against real providers.

## Next implementation gate

The next coherent milestone is the first reference vertical slice:

```text
Task + Project Graph
  -> Task Classifier / Risk Engine
  -> Context Compiler
  -> OpenCode Runtime Adapter
  -> isolated Git worktree
  -> implementation
  -> deterministic tests
  -> Playwright verification
  -> independent review
  -> approval when required
  -> GitHub PR
  -> Run Ledger + telemetry + eval result
```

The immediate next adapter should be **OpenCode** because the frozen contract defines it as the initial PRIMARY provider for `code.interactive`. Its current server/API compatibility must be verified before implementing the wire adapter.

No additional ecosystem provider should become part of the default production path before this slice demonstrates safe failure, recovery, evidence, and measurable value.
