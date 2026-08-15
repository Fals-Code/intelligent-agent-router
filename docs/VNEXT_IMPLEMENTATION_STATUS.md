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

### OpenCode adapter foundation

- Native HTTP adapter for the PRIMARY `code.interactive` provider.
- Project/worktree scoping follows current OpenCode SDK behavior: GET/HEAD use the `directory` query; mutating requests use an encoded `x-opencode-directory` header.
- Optional OpenCode server Basic Auth support.
- Session creation carries 9Router project/risk metadata but keeps canonical project truth in 9Router.
- Task dispatch uses the current asynchronous prompt endpoint.
- Tool permissions are patched before each task using deny-by-default rules followed by explicit allows for selected tool IDs.
- Status normalization supports OpenCode `idle`, `busy`, and `retry` states and requires completed assistant-message evidence before reporting a completed turn.
- Runtime event polling normalizes OpenCode messages and pending permission requests.
- Approval response prefers the current permission endpoint and has an adapter-local fallback for the legacy session permission endpoint.
- Structured OpenCode file diffs are normalized into the runtime diff contract.
- Interrupt maps to OpenCode abort; `resume()` makes the existing session reusable for task re-dispatch and does not falsely claim continuation of an aborted generation.
- OpenCode capability health/version discovery uses `/global/health`.
- Safe live-preflight harness validates health/version and project scoping from the target machine; temporary R0 session smoke is explicit opt-in and sends no coding prompt.

### Tool Broker foundation

- Protocol-neutral `ToolSourceAdapter` contract keeps MCP/native wire schemas outside the core broker.
- Normalized tool descriptors declare capabilities, read/write/execute mode, side-effect class, risk ceiling, policy permissions, provider permission names, idempotency, timeout, and source identity.
- Discovery is health/version gated; unhealthy or incompatible sources fail closed and do not expose tools.
- Selection is capability/request driven and uses a bounded `maxTools` catalog instead of loading every discovered tool.
- R0 never receives mutation tools; R3/R4 mutations require explicit approval; destructive tools always require approval.
- Required policy permissions are hard filters and are translated into provider-specific permission grants.
- Duplicate logical tool IDs across sources are quarantined rather than selected arbitrarily.
- Invocation re-checks source health/version, enforces timeout and attempt ceilings, normalizes errors, records attempts, and sanitizes sensitive error text.
- Automatic retries are limited to explicitly retryable, idempotency-safe, non-destructive tools. Timeout retry requires explicit opt-in.
- Rate-limit signals can carry normalized HTTP/retry-after metadata without leaking provider wire errors into core logic.
- Parent workflow abort wins even when a source adapter ignores `AbortSignal`.
- In-memory Tool Source adapter provides deterministic discovery and execution tests.

### Isolated workspace foundation

- Provider-neutral `WorkspaceManager` and Git worktree lease contracts represent workspace lifecycle explicitly.
- `GitWorktreeManager` resolves the canonical Git root before creating an isolated worktree and validates the requested base ref as a commit.
- R0 cannot request a mutation workspace.
- Managed worktrees are constrained to a configured root and bounded by `maxActiveWorktrees`.
- Generated paths are slugged and checked to remain below the managed root; unsafe base refs and branch names are rejected before Git execution.
- Git commands are executed as argv with `shell: false`; no shell command concatenation is used.
- Dirty worktrees are retained by default. Forced dirty removal requires both policy permission and an explicit `forceDirty` request.
- A policy configured to retain dirty worktrees cannot be overridden by `forceDirty`.
- Optional branch cleanup uses safe `git branch -d`, not unconditional `-D`.
- Command output is bounded and sensitive key/value material is redacted before entering errors/evidence.

## OpenCode compatibility notes

The adapter intentionally avoids importing OpenCode SDK types into 9Router core. Current compatibility was checked against the upstream server/source contract at implementation time, but real-machine validation and a versioned compatibility matrix are still required before claiming M2 integration.

Known deliberate limitations of this first adapter:

- `getEvents()` currently polls normalized messages and permission requests instead of maintaining a long-lived SSE subscription.
- An interrupted OpenCode generation cannot be resumed mid-turn by the current server API; recovery must re-dispatch from durable workflow state.
- Provider health currently validates the health/version endpoint but does not yet apply a release compatibility matrix or quarantine policy.
- OpenCode receives only the provider permission names granted by the Tool Broker; live MCP discovery still requires a dedicated adapter.

## Not yet implemented

The following remain explicit work items and must not be represented as production-complete:

- Persistent Project Graph schema/backend and migration rules.
- Real retrieval adapters feeding source-code, history, documentation, design, skill, and tool candidates into the Context Compiler.
- Live MCP transport adapter implementing Tool Source discovery/execution against current MCP semantics.
- Credential Broker, sandbox policy enforcement, and network egress policy.
- Durable Workflow Engine persistence and machine-restart recovery.
- Persistent Run Ledger backend.
- OpenTelemetry export and versioned internal telemetry schema.
- Eval Plane golden-task storage, baselines, and statistical routing feedback.
- Live OpenCode adapter validation against the target 9Router/OpenCode installation.
- Live isolated-worktree validation on the target Windows/Git environment.
- OpenHands and ACP wire adapters implementing `AgentRuntimeAdapter`.
- Playwright evidence adapter.
- GitHub publish adapter tied to evidence/approval gates.
- Penpot/Excalidraw design adapters.
- Hermes/OpenClaw/n8n/AppFlowy/Baserow/Teable/Appsmith/Cal.diy provider adapters.
- Provider health/quota-aware route selection and circuit breaking beyond the current tool/provider contracts.
- Compatibility matrix, adapter quarantine, and capability downgrade behavior.
- Fault injection and machine-restart recovery tests.
- Reference Stok Reconciliation vertical slice against real providers.

## Next implementation gate

The next coherent milestone is the first reference vertical slice:

```text
Task + Project Graph
  -> Task Classifier / Risk Engine
  -> Context Compiler
  -> Tool Broker
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

The immediate environment gate is to validate both the OpenCode adapter and isolated-worktree behavior on the target Windows machine. In parallel, the next source-side P0 items are the live MCP transport adapter and durable workflow/evidence persistence needed before a real prompt-driven vertical-slice run.

No additional ecosystem provider should become part of the default production path before this slice demonstrates safe failure, recovery, evidence, and measurable value.
