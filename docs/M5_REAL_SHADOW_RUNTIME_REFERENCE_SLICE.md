# M5 Real Shadow Runtime Reference Slice

## Purpose

This slice proves that an explicitly requested controlled-experiment shadow sample can cross the real 9Router runtime boundary without creating a second provider dispatch path and without making candidate output eligible for production use.

It is intentionally narrower than bounded-live experimentation. Passing this slice does **not** promote a candidate, mutate production routing, allocate production traffic, or authorize automatic experiment loops.

## Canonical path

```text
BoundedExperimentExecutor (#35)
  -> ControlledExperimentExecutionAdapter
  -> RuntimeBackedShadowExperimentExecutionAdapter (#36)
  -> RuntimeSessionBindingCoordinator
  -> AgentRuntimeAdapter
  -> provider session

process restart
  -> durable WorkflowRun + RuntimeBinding + Integrity journal
  -> RuntimeReconciliationCoordinator
  -> OpenCodeRuntimeReconciliationProbe (GET-only)
  -> RuntimeVerificationCoordinator
  -> deterministic no-mutation verification
  -> durable verification reopen
  -> terminal WorkflowRun + Run Ledger
```

## Runtime authority boundary

`RuntimeBackedShadowExperimentExecutionAdapter` accepts only:

- `exposure = shadow`
- `liveAssignment = none`
- `candidateOutputMayBeExternallyVisible = false`
- distinct reference/candidate subjects
- distinct dedicated runtime workflows
- both workflows active in `execute`
- both workflows `R0`
- identical workspace, prompt, context, and tool policy
- zero runtime tools

Both targets are resolved and validated before the first provider side effect.

The adapter has no provider-output sink. It submits two no-tool tasks and returns only durable runtime-binding references. It does not read provider response text for publication, does not route candidate output to a caller-facing channel, and cannot execute bounded-live traffic.

## Durable binding and redispatch safety

Each reference/candidate runtime session is created through `RuntimeSessionBindingCoordinator` and immediately bound to a dedicated `WorkflowRun`.

An existing binding blocks another dispatch for that workflow. After a durable binding exists, the adapter does not attempt automatic cross-runtime compensation or retry. If a later external call fails, the outer #35 execution journal retains the unresolved sample and requires explicit reconciliation.

## Real OpenCode proof

The live harness requires two explicit OpenCode model targets:

- reference provider + model ID
- candidate provider + model ID

The targets must be distinct. No model IDs are hard-coded into the core adapter.

### Process A — prepare

1. require a clean `intelligent-agent-router` working tree;
2. create two durable R0 workflows and advance both to `execute`;
3. create reference/candidate `OpenCodeRuntimeAdapter` instances with explicit model targets;
4. call `RuntimeBackedShadowExperimentExecutionAdapter` once;
5. persist both runtime bindings and integrity `runtime_bound` milestones;
6. wait for both no-tool tasks to complete;
7. require zero runtime diff / patch / commit evidence;
8. require Git HEAD and working tree unchanged;
9. persist a bounded manifest;
10. exit without destroying the provider sessions.

### Process B — recover

1. run in a distinct Node process while the OpenCode server remains alive;
2. reopen Workflow, Binding, Integrity, and Run Ledger stores;
3. require both runs to classify as `reconcile_runtime`;
4. use `OpenCodeRuntimeReconciliationProbe` for GET-only observation;
5. require `verify_runtime_result` for both sessions;
6. deterministically verify completion, task events, zero diff/patch, unchanged Git state, process restart, and candidate containment;
7. persist verification for both runs;
8. reopen stores and prove verification survives disk;
9. explicitly advance both R0 workflows to terminal success;
10. finalize one canonical Run Ledger record per runtime workflow;
11. reopen again and require `consistent_terminal` for both;
12. destroy the two temporary provider sessions;
13. emit hashes for workflow, binding, integrity, ledger, and manifest evidence.

No runtime task is re-dispatched during recovery.

## Evidence guarantees

A passing proof requires:

- distinct control-plane PIDs;
- provider not restarted;
- both runtime bindings durable;
- both provider sessions completed;
- both reconciliations `verify_runtime_result`;
- both deterministic verifications PASS;
- both verifications survive durable reopen;
- both final integrity states `consistent_terminal`;
- both Run Ledger outcomes `succeeded`;
- candidate output external visibility remains false;
- production routing mutation remains false;
- automatic redispatch remains false;
- Git HEAD and working tree remain unchanged.

Raw provider output and raw provider patch are not persisted by this proof harness.

## Windows runner

Use `scripts/windows-reference-shadow-runtime-slice.ps1` with explicit reference/candidate provider and model IDs. The wrapper can start a temporary loopback OpenCode server when one is not already running, performs the standard live OpenCode preflight, builds the repository, then launches `prepare` and `recover` as two distinct Node processes.

The wrapper supports optional `-ExpectedHead`, `-SkipInstall`, and `-SkipSourceValidation` guards.

## Non-goals

This slice does not provide:

- bounded-live or production traffic allocation;
- candidate promotion;
- model or skill ranking mutation;
- an autonomous experiment scheduler;
- concurrent experiment samples;
- automatic rollback execution;
- automatic reconciliation or redispatch;
- a second runtime binding store;
- a new approval store;
- raw provider-output persistence;
- statistical significance, bandits, reinforcement learning, or self-modifying policy.

## Next gate

After CI and an independent real live proof pass, the next safe step is a bounded-live runtime adapter gate that consumes #34/#35 guardrail eligibility while still requiring explicit traffic assignment and preserving rollback/manual intervention boundaries. A shadow proof alone must never be reinterpreted as bounded-live authority.
