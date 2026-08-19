# M5 End-to-End Shadow Executor Provenance

## Purpose

This gate closes the remaining gap between the controlled-experiment authority/executor path and the real runtime-backed shadow adapter.

PR #36 proved the real `RuntimeBackedShadowExperimentExecutionAdapter` boundary, durable runtime binding, process-restart reconciliation, deterministic verification, and Run Ledger finalization. It intentionally called the adapter directly. This gate proves one real shadow sample through the full control-plane chain:

```text
M5 admission evidence
  -> ControlledExperimentDefinition (#34)
  -> durable R3 WorkflowRun approval
  -> ControlledExperimentAuthorization (#34)
  -> BoundedExperimentExecutor (#35)
  -> JsonlControlledExperimentExecutionJournal
  -> RuntimeBackedShadowExperimentExecutionAdapter (#36)
  -> two real R0 runtime workflows + RuntimeBindings
  -> provider sessions

process restart
  -> runtime reconciliation + deterministic verification
  -> canonical Run Ledger records
  -> ExecutionMetricProjection
  -> durable Eval History observations
  -> BoundedExperimentExecutor.recordCompletion()
  -> sample_completed journal event
  -> content-addressed ShadowExperimentSampleProvenance
```

Passing this gate does **not** grant bounded-live authority, production traffic, candidate promotion, automatic dispatch, or automatic rollback.

## Authority separation

The experiment control workflow and runtime workflows remain separate authority domains:

- the controlled-experiment workflow is `R3`, reaches `publish`, carries a durable approval, and is the workflow bound to `ControlledExperimentAuthorization`;
- the reference and candidate runtime workflows are distinct `R0` read-only `execute` workflows;
- the runtime adapter continues to reject tools, live exposure, candidate external visibility, and redispatch;
- the runtime workflow project IDs must match the controlled experiment project ID for the provenance artifact to pass.

No risk-class downgrade is used to bypass experiment authorization.

## Provenance contract

`ShadowExperimentSampleProvenance` is content-addressed and can only be constructed when authoritative sources agree on one exact sample.

The contract requires:

- exact verified `ControlledExperimentDefinition` and `ControlledExperimentAuthorization`;
- an allow authorization bound to the durable approved control workflow;
- one journal sample with exactly `sample_reserved -> sample_dispatched -> sample_completed`;
- `exposure=shadow` and `liveAssignment=none`;
- candidate external visibility = false;
- automatic redispatch = false;
- distinct succeeded canonical reference/candidate Run Ledger records;
- dispatch execution references matching each Run Ledger runtime/run identity;
- verified execution-metric projections bound to the exact Run Ledger records;
- verified Eval History observations whose measurement equals the exact projection-derived measurement;
- completion observation IDs matching the durable journal event;
- completed observation IDs present after journal reopen.

Any drift causes provenance preparation/verification to fail closed.

## Live proof

The live harness uses two control-plane Node processes.

### Process A — authority + dispatch

1. require a clean exact router workspace;
2. create deterministic admission evidence for distinct reference/candidate model subjects;
3. assess an eligible M5 admission decision;
4. create a shadow-only R3 controlled experiment;
5. create and durably approve an R3 control workflow in `publish`;
6. create the exact allow `ControlledExperimentAuthorization`;
7. create two distinct R0 runtime workflows in `execute`;
8. open the durable #35 execution journal;
9. call `BoundedExperimentExecutor.dispatchSample()` for one shadow sample;
10. reserve before runtime side effects, then dispatch through the #36 runtime adapter;
11. persist both RuntimeBindings and integrity `runtime_bound` milestones;
12. require both real runtime sessions to complete with zero file/diff/commit mutation;
13. require the journal to remain exactly reserved + dispatched and unresolved before restart;
14. persist bounded authority/manifest artifacts and exit without destroying provider sessions.

The deterministic pre-admission cohort is fixture evidence used only to construct a verified #33/#34 authority chain. It is explicitly distinct from the real runtime sample evidence produced after restart.

### Process B — recovery + completion provenance

1. require a different Node PID while the provider server remains alive;
2. reopen the durable R3 control workflow and require `publish/running` with approval;
3. reopen R0 workflow/binding/integrity/Run Ledger state;
4. require `reconcile_runtime` for both runtime workflows;
5. observe both sessions through GET-only runtime reconciliation;
6. require `verify_runtime_result` and deterministic PASS for both;
7. persist verification and prove it survives reopen;
8. explicitly finalize both R0 runtime workflows and canonical Run Ledger records;
9. project the configured runtime completion-wait metric from each canonical Run Ledger record;
10. append two durable Eval History observations with projection-derived measurements;
11. call `BoundedExperimentExecutor.recordCompletion()` with those exact observation IDs;
12. reopen the journal and require one completed shadow sample and zero unresolved samples;
13. build and persist `ShadowExperimentSampleProvenance` from the authoritative sources;
14. reread and verify the provenance artifact;
15. destroy both temporary provider sessions;
16. require Git HEAD/worktree unchanged and emit durable SHA-256 hashes.

## Evidence files

A successful live proof emits SHA-256 hashes for:

- `authority.json`
- `control-workflow.jsonl`
- `runtime-workflow.jsonl`
- `binding.jsonl`
- `integrity.jsonl`
- `ledger.jsonl`
- `eval-history.jsonl`
- `experiment-execution.jsonl`
- `manifest.json`
- `provenance.json`

Raw provider output and raw provider patches are not persisted by the harness.

## Safety invariants

A PASS requires all of the following:

- experiment admission eligible = true;
- authorization decision = allow;
- durable R3 approval survives restart;
- journal reservation, dispatch, and completion all belong to one sample;
- both R0 runtime sessions are distinct and completed;
- recovery uses canonical reconciliation and deterministic verification;
- both Run Ledger outcomes are `succeeded`;
- each Eval observation measurement contains the exact canonical `run-ledger:<runId>` source;
- the content-addressed provenance artifact verifies after disk reopen;
- candidate output external visibility remains false;
- production routing mutation remains false;
- automatic redispatch remains false;
- Git HEAD and working tree remain unchanged.

## Non-goals

This gate does not implement or authorize:

- bounded-live traffic;
- candidate production visibility;
- production routing mutation;
- permanent candidate promotion;
- automatic experiment loops;
- concurrent experiment samples;
- automatic redispatch/retry after uncertain side effects;
- automatic rollback;
- traffic splitting;
- statistical significance or bandit/RL policy;
- raw provider-output persistence.

## Next gate

After CI and an independent real live proof/review pass, a separate bounded-live runtime gate may be designed. That future gate must preserve explicit R3/R4 approval, shadow-first evidence, candidate traffic ceilings, stop conditions, and reference-restore/rollback boundaries. This shadow provenance gate alone cannot authorize candidate live traffic.
