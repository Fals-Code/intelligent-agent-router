# Execution Transaction / Integrity Boundary

This document defines the first cross-store integrity boundary for runtime-backed 9Router execution.

It does **not** claim ACID or distributed transaction semantics. The purpose is to make partial durable state explicit, restart-safe, auditable, and recoverable without granting provider/runtime state canonical authority.

## Durable owners

9Router keeps separate owners for separate facts:

- `WorkflowCheckpointStore` owns canonical workflow lifecycle snapshots.
- `RuntimeBindingStore` owns workflow-attempt to runtime-session identity.
- `ExecutionIntegrityJournal` owns cross-store milestones and durable deterministic verification evidence.
- `RunLedger` owns the immutable terminal audit record.
- provider/runtime systems remain evidence sources, not workflow truth.

These stores are intentionally not collapsed into one product-specific database contract.

## Why an integrity journal is required

Before this boundary, deterministic verification from the runtime integration layer existed in memory until terminal Run Ledger append. A process failure after verifier PASS but before ledger finalization could therefore preserve the workflow and runtime binding while losing the verification result.

`JsonlExecutionIntegrityJournal` closes that gap by persisting bounded, versioned, append-only milestones:

1. `runtime_bound`
2. `verification_recorded`
3. `workflow_terminal`
4. `ledger_finalized`

The `verification_recorded` milestone stores the sanitized `RuntimeVerificationOutcome`, including runtime reconciliation evidence and deterministic verifier evidence. Raw provider patch content is not part of this contract.

## Persistence properties

The local journal follows the same durability posture as the other local control-plane stores:

- JSONL schema versioning;
- monotonic global sequence numbers;
- explicit `maxFileBytes` and `maxEntryBytes` ceilings;
- `fsync` before admission;
- fail-closed startup on malformed JSON, unsupported schema, sequence drift, partial final writes, invalid evidence, or impossible stage progression;
- file-size drift detection for the declared single-writer model.

The journal is not a multi-process lock and is not a cryptographic tamper log.

## Stage semantics

### `runtime_bound`

The binding must already exist in `RuntimeBindingStore` and must match the canonical workflow ID, project ID, and workflow attempt. The journal records the complete minimal runtime binding so later audits can detect binding-store loss or drift.

### `verification_recorded`

This stage requires `runtime_bound` for the same attempt. It persists the full sanitized `RuntimeVerificationOutcome` so deterministic verification can survive process restart before workflow completion or Run Ledger finalization.

A successful verification must carry verifier-owned passed `deterministic_check` evidence and matching runtime-reconciliation evidence for the durable runtime/session identity.

### `workflow_terminal`

The terminal workflow snapshot must already be durable in `WorkflowCheckpointStore`. Runtime-backed success additionally requires durable passed verification for the same attempt. Failed/cancelled terminal states do not fabricate successful verification.

### `ledger_finalized`

The immutable `RunLedgerRecord` must already exist and must agree with canonical workflow outcome and durable runtime identity. The journal marker is bookkeeping evidence that finalization was observed; it is not the Run Ledger itself.

## Integrity inspection

`ExecutionIntegrityCoordinator.inspect()` is read-only. Every report has `automaticMutationAllowed=false`.

It distinguishes conditions such as:

- pre-runtime workflow with no runtime state;
- durable binding whose journal milestone is missing;
- active runtime-bound work requiring reconciliation;
- durable passed verification available after restart;
- durable failed verification requiring explicit failure/retry handling;
- terminal workflow whose terminal milestone is missing;
- terminal workflow/evidence ready for Run Ledger finalization;
- Run Ledger already written but local finalization marker missing;
- fully consistent terminal state;
- orphaned or contradictory durable state requiring manual intervention.

The coordinator never contacts a provider, advances workflow state, retries execution, synthesizes missing verification, or writes a missing Run Ledger record automatically.

## Partial-state examples

### Verification PASS, process exits before terminal checkpoint

The journal preserves verification. On restart the coordinator reports `verification_available`. The caller may explicitly continue the normal workflow state machine using that evidence; no transition occurs automatically.

### Terminal workflow checkpoint exists, Run Ledger append failed

The coordinator reports `finalize_run_ledger` only when the required binding and, for success, durable passed verification are present. The caller can reuse `RuntimeRunLedgerFinalizer` with recovered verification.

### Run Ledger append succeeded, process exited before integrity marker

The coordinator reports `record_ledger_finalized_milestone`. No provider/runtime mutation is required because the immutable Run Ledger already exists.

### Runtime binding exists but journal milestone is missing

The coordinator reports `record_runtime_binding_milestone`. This makes migrations or crashes between the binding store and integrity journal visible instead of silently assuming the stores are synchronized.

### Journal references binding/ledger state that no longer exists

The coordinator reports `manual_intervention`. It does not recreate evidence from memory or provider claims.

## Explicit non-goals

This boundary does not provide:

- ACID transactions across files/stores;
- distributed consensus or multi-writer locking;
- automatic provider/session cleanup after arbitrary machine failure;
- automatic runtime re-dispatch or retry;
- automatic workflow success;
- cryptographic log integrity or encryption;
- raw provider patch persistence.

A crash can still occur between two fsync'd stores. The improvement is that the resulting partial state is durable, classifiable, and recoverable through explicit control-plane actions rather than hidden assumptions.

## Next gate

After this PR is proven, the next step is to wire these integrity milestones into the reference live runtime slice so one real OpenCode execution demonstrates restart/recovery evidence end-to-end. Only after that proof should the architecture broaden into observability/OTel, GitHub publication automation, or additional agent providers.
