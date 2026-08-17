# Runtime Reconciliation Coordinator

This document defines the first restart-safe reconciliation boundary between durable 9Router workflow state and provider/runtime session state.

## Ownership

9Router remains canonical for workflow lifecycle, approvals, retry authority, and success/failure transitions. Runtime/provider state is evidence only.

A durable `RuntimeBinding` records the minimum control-plane identity required to locate an external runtime session after process restart:

- workflow run ID
- project ID
- workflow attempt
- runtime ID
- runtime session ID
- workspace
- binding timestamp

Provider credentials, prompts, raw messages, patches, and opaque provider-native state are not stored in the binding.

## Durable binding

`JsonlRuntimeBindingStore` is append-only and single-writer. It uses a versioned JSONL envelope, explicit file/record byte ceilings, synchronous append + file `fsync`, monotonic global sequence, stale-writer size-drift detection, and fail-closed parsing.

A workflow attempt may have only one binding. A later binding for the same workflow must have a strictly larger workflow attempt. This prevents a restart from silently replacing the runtime session associated with an already-observed attempt.

## Read-only reconciliation

`RuntimeReconciliationCoordinator` combines:

1. durable `WorkflowRun`
2. durable `RuntimeBinding`
3. a runtime-specific `RuntimeReconciliationProbe`

The coordinator is deliberately read-only. It never calls resume, retry, sendTask, approve, abort, destroy, publish, or workflow-success transitions.

The coordinator always returns `automaticRedispatchAllowed=false` for runtime-bound recovery.

### Runtime dispositions

- `running` -> wait for the existing runtime; do not re-dispatch
- `waiting_approval` -> preserve approval wait
- `completed` -> require deterministic verification; provider completion is not workflow success
- `interrupted` -> explicit resume/retry decision
- `failed` / `aborted` / `destroyed` -> explicit failure/retry decision
- `created` -> manual intervention because task execution cannot be proven
- missing binding/probe -> manual intervention
- observation failure -> fail closed

## OpenCode probe

`OpenCodeRuntimeReconciliationProbe` observes an existing OpenCode session directly through read-only GET endpoints. It validates session identity and workspace against the durable binding, then summarizes status, event types, and changed file names.

Raw diff patches are intentionally not exposed by the reconciliation observation. The probe reports only whether a patch was observed plus the changed-file list. This avoids turning unrestricted provider output into durable control-plane metadata.

Pending permission evidence uses the probe observation time because the OpenCode permission listing does not provide a trustworthy creation timestamp in the current adapter contract.

## Non-goals

This slice does not:

- auto-resume or auto-retry after restart
- infer workflow success from provider completion
- persist provider-native messages or patches
- reconnect `OpenCodeRuntimeAdapter`'s in-memory registry
- perform WorkflowRun + RuntimeBinding + RunLedger transactions
- provide distributed locking, shared database persistence, encryption, or cryptographic integrity

The next integration gate should connect execution-time session creation to durable runtime binding creation and then feed reconciliation output into deterministic verification and Run Ledger evidence without granting the runtime authority over workflow state.
