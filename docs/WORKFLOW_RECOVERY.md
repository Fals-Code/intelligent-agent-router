# Durable Workflow Checkpoints and Restart Recovery

This slice adds durable workflow control-plane state without making provider-native runtime state canonical.

## Existing ownership boundary

`WorkflowStateMachine` remains the source of transition semantics. `AgentRuntimeAdapter` remains the provider-neutral runtime boundary. The durable layer composes the existing state machine rather than changing routing, execution, provider, approval, or publish semantics.

## JSONL v1 checkpoints

`JsonlWorkflowCheckpointStore` appends a full `WorkflowRun` snapshot on every persisted transition using a small envelope:

```json
{"schemaVersion":1,"sequence":1,"run":{"id":"..."}}
```

The sequence is global and monotonic within the local file. Reload fails closed if the sequence is missing or reordered, but the sequence is not a cryptographic integrity mechanism.

The caller must provide an explicit file path, `maxFileBytes`, and `maxCheckpointBytes`. No persistence-size default is hidden in the implementation.

## Durable wrapper

`DurableWorkflowStateMachine` delegates every transition to the existing `WorkflowStateMachine` and checkpoints the returned state before returning it to the caller. If persistence fails, the transition is not returned as durable success.

The wrapper exposes the same lifecycle operations: create, start, advance, approval request/response, skip approval, pause, resume, retry, recover, fail, cancel, and succeed.

## Restart recovery policy

Recovery is deliberately conservative:

- `queued` -> `safe_to_start`: the run has never started, so no runtime side effect needs reconciliation.
- `waiting_approval` -> `await_approval`: durable approval state remains pending and is never bypassed by restart.
- `waiting_external` -> `await_external`: the external dependency must be re-evaluated explicitly.
- `running` -> `reconcile_runtime`: the provider/runtime may already have observed side effects; automatic resume or re-dispatch is forbidden.
- `retrying` -> `reconcile_retry`: retry activity may already have crossed the runtime boundary; automatic retry after restart is forbidden.
- `failed` -> `explicit_retry`: restart does not grant retry authority.
- `cancelled` / `succeeded` -> `terminal`: no restart action is required.

Only a never-started queued run is marked `automaticResumeAllowed=true`.

This matches the current OpenCode limitation that an interrupted generation cannot be assumed to resume mid-turn. A future runtime reconciliation component must query provider status/events/diff and decide whether to continue, re-dispatch, fail, or require human intervention.

## Persistence invariants

The local checkpoint store enforces:

- append-only checkpoint history
- explicit file and per-checkpoint byte ceilings
- file `fsync` before in-process admission
- restart/reopen reconstruction of latest state and per-run history
- monotonic checkpoint sequence
- immutable workflow `projectId`, `riskClass`, and `createdAt`
- non-decreasing attempt, phase, and `updatedAt`
- append-only approval IDs
- no checkpoint after `cancelled` or `succeeded`
- fail-closed malformed JSON, unknown schema, truncated final writes, invalid workflow shapes, oversized files/checkpoints, and stale-writer file-size drift

The stale-writer check is not a multi-process lock or tamper detector.

## Deliberate non-goals

This PR does not:

- automatically reconnect to OpenCode or another runtime after restart
- infer whether an external side effect completed
- re-dispatch an active/retrying task automatically
- persist provider-native sessions as canonical workflow truth
- add distributed locking or a shared workflow database
- add cryptographic integrity signing or encryption
- wire the execution engine, Run Ledger, OpenTelemetry, or Eval Plane into a single transaction

The next integration gate should add a runtime reconciliation coordinator that consumes durable workflow state plus `AgentRuntimeAdapter` status/events/diff, then emits evidence-backed recovery decisions before any re-dispatch.
