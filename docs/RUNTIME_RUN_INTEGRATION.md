# Runtime Session Binding and Run Ledger Integration

This document defines the first execution-time integration boundary between durable workflow state, runtime session identity, deterministic verification, and the immutable Run Ledger.

## Ownership

- `WorkflowStateMachine` remains the canonical workflow lifecycle owner.
- `AgentRuntimeAdapter` remains the owner of provider/runtime session side effects.
- `RuntimeBindingStore` remains the durable mapping from one workflow attempt to one runtime session.
- `RuntimeReconciliationCoordinator` remains read-only and treats provider state as evidence.
- `RunLedger` remains the immutable terminal audit record.

The integration layer does not move provider-native state into `WorkflowRun` and does not add runtime lifecycle semantics to `ExecutionEngine`.

## Session creation and binding

`RuntimeSessionBindingCoordinator.createBoundSession()` is allowed only when the workflow is at the `execute` phase and is `running` or `retrying` with `attempt >= 1`.

Before creating a provider session it rejects an equal-or-newer existing binding for the same workflow. The runtime request always carries canonical correlation metadata:

- `9router.workflowRunId`
- `9router.workflowAttempt`

Caller metadata cannot override those values.

After the provider returns a session, 9Router validates runtime ID, project ID, and workspace before writing the durable binding. If validation or binding persistence fails after the session was created, the coordinator performs best-effort compensating `abort()` and `destroy()` operations and then fails the operation. This cleanup is not a distributed transaction and is never represented as one.

## Runtime completion and deterministic verification

A provider status of `completed` is not workflow success.

`RuntimeVerificationCoordinator` only accepts a reconciliation report with disposition `verify_runtime_result` and `verificationRequired=true`. It requires matching durable binding and runtime observation evidence, then invokes a `DeterministicRuntimeVerifier`.

The result is converted into two evidence records:

1. an `other` evidence record summarizing the runtime observation without raw provider patch content;
2. a `deterministic_check` evidence record owned by the verifier.

Verifier metadata is scalar-only. Sensitive metadata keys and recognizable credential key-value strings are redacted before they can enter Run Ledger evidence. A verifier exception becomes failed deterministic evidence; it never becomes a PASS.

## Terminal Run Ledger write

`RuntimeRunLedgerFinalizer.appendTerminal()` accepts only terminal workflows: `failed`, `cancelled`, or `succeeded`.

The final record derives these fields from canonical state rather than caller input:

- `runId`, `projectId`, `riskClass`, `approvalIds`, `createdAt`, and terminal outcome from `WorkflowRun`;
- `runtimeId` and `workspace` from the durable runtime binding.

A successful runtime-backed workflow has an additional invariant beyond the generic risk-class Evidence Gate: it must carry a `RuntimeVerificationOutcome` with `passed=true` and a verifier-owned passed `deterministic_check` evidence record. This prevents an R2/R3 configuration from accidentally treating provider completion as success merely because its normal evidence profile does not list `deterministic_check`.

Failed or cancelled workflows may still be recorded without claiming successful deterministic verification.

## Failure semantics

The integration is fail-closed:

- invalid workflow phase/status prevents session creation before provider side effects;
- session identity drift triggers compensating cleanup;
- binding persistence failure triggers compensating cleanup;
- reconciliation states other than `verify_runtime_result` cannot invoke deterministic result verification;
- verifier exceptions produce failed evidence;
- a successful workflow cannot be written to Run Ledger without verifier-owned deterministic PASS;
- duplicate Run Ledger records remain rejected by the existing ledger implementation.

## Explicit non-goals

This PR does not provide atomic persistence across workflow checkpoint + runtime binding + Run Ledger. In particular, a workflow may already have reached a durable terminal checkpoint when the terminal Run Ledger append subsequently fails. That condition must be treated as reconciliation-required by the next transaction/integrity coordinator; this layer does not hide it.

This PR also does not:

- auto-dispatch or auto-retry runtime tasks;
- automatically advance workflow phases after verification;
- create a generic distributed transaction manager;
- change `ExecutionEngine` scheduling semantics;
- store raw provider patches in control-plane evidence;
- weaken existing risk-class Evidence Gate requirements.

## Next gate

The next integration gate is an execution transaction/integrity coordinator that can detect and reconcile partial durable state across workflow checkpoint, runtime binding, verification evidence, and terminal Run Ledger persistence without granting provider state canonical authority.
