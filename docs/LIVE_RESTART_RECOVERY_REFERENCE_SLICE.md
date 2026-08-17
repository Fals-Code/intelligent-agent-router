# Live Restart/Recovery Reference Slice

This reference slice proves the durable restart/recovery path with a real OpenCode session while keeping provider-native state non-canonical.

## What is restarted

The proof uses two separate Node processes:

1. **Process A — prepare** creates and durably checkpoints an R0 workflow at `running/execute`, creates a real OpenCode session, persists its runtime binding, records `runtime_bound`, runs a read-only OpenCode task, waits for the provider task to complete, and exits without advancing the workflow.
2. **Process B — recover** starts with a different process ID, reopens workflow/binding/integrity/ledger JSONL files from disk, classifies the active workflow as `reconcile_runtime`, inspects the still-existing OpenCode session with `OpenCodeRuntimeReconciliationProbe`, deterministically verifies the recovered observation, persists verification evidence, reopens the stores again, explicitly advances the workflow to terminal success, writes the immutable Run Ledger record, records finalization, and performs one final reopen requiring `consistent_terminal`.

The OpenCode server itself is intentionally **not restarted**. This slice proves a 9Router/control-plane process restart while an external provider session survives. That is the recovery boundary defined by the current architecture.

## Provider permissions

The live OpenCode task is read-only. Its session tool policy allows only:

- `read`
- `glob`
- `grep`
- `list`

Every other tool is denied by the runtime adapter. An approval request is denied and fails the slice. The task must leave the router Git HEAD and working tree unchanged.

## Durable state

The harness requires `ROUTER_RESTART_RECOVERY_STATE_ROOT` to identify one dedicated proof directory. Process A refuses to start unless that directory is empty. There is intentionally no shared/static fallback directory, so stale evidence from an earlier proof cannot be mixed into a new run. The Windows wrapper creates a unique `%TEMP%` directory automatically and passes the same directory to both processes.

The reference state directory contains four authoritative JSONL stores:

- `workflow.jsonl`
- `binding.jsonl`
- `integrity.jsonl`
- `ledger.jsonl`

The prepare/recover manifest is harness metadata only; it is not a canonical control-plane store.

The integrity sequence expected for a successful run is:

`runtime_bound -> verification_recorded -> workflow_terminal -> ledger_finalized`

Verification is reopened from disk before the workflow is allowed to continue. After terminal finalization, all stores are reopened again and `ExecutionIntegrityCoordinator.inspect()` must return `consistent_terminal`.

## Deterministic verification

The recovery verifier requires all of the following:

- provider observation status is `completed`;
- observed events contain both `task_started` and `task_completed`;
- provider diff reports zero changed files and no patch;
- router Git HEAD matches the prepare-phase HEAD;
- router working tree matches the prepare-phase snapshot;
- prepare and recover process IDs are different.

A provider `completed` status alone is never treated as workflow success.

## Safety boundaries

- no automatic runtime redispatch;
- no automatic retry/resume/publish;
- recovery observation uses the GET-only OpenCode reconciliation probe;
- raw provider patches are not persisted in the integrity journal or Run Ledger;
- final workflow success is explicit and happens only after deterministic verification has been persisted and reopened;
- the live OpenCode session is deleted after the terminal proof succeeds;
- the temporary JSONL state directory is retained for independent evidence review.

## Windows entry point

`scripts/windows-reference-restart-recovery-slice.ps1` is the authoritative guarded local entry point. It requires a clean router checkout whose HEAD exactly matches `origin/main`, validates the source and eval suite, creates a unique empty state root under `%TEMP%`, starts a temporary loopback OpenCode server only when needed, runs the existing live OpenCode preflight, then launches the prepare and recover Node processes separately with the same explicit state root.

The wrapper retains the state directory and transcript path in its final output so the proof can be reviewed independently.

## CI boundary

GitHub Actions does not run the live OpenCode proof because hosted runners are not assumed to have the user's OpenCode/9Router runtime configuration. CI instead validates:

- JavaScript syntax for the live harness and proof policy;
- PowerShell syntax for the Windows wrapper;
- policy regression tests;
- the full existing `npm run check` and `npm run eval` suites on Ubuntu and Windows.

The live proof remains an explicit post-merge local gate.
