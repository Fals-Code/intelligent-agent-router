# M5 Bounded Experiment Executor

PR #35 adds a deliberately narrow execution boundary for the controlled-experiment contract from PR #34.

## Purpose

The executor may dispatch one explicitly requested experiment sample only after:

1. the exact M5 admission decision is still eligible,
2. the exact controlled-experiment definition verifies,
3. the exact controlled-experiment authorization verifies against the durable WorkflowRun approval state,
4. the durable experiment execution journal has no unresolved sample,
5. the requested sample fits the immutable budget, exposure, and traffic ceilings, and
6. after the first completed sample, the supplied Eval/Execution summaries exactly match the observation IDs recorded by the durable journal and the deterministic guardrail classifier allows the requested exposure.

This is not an adaptive routing loop.

## Execution boundary

`BoundedExperimentExecutor` talks only to an injected `ControlledExperimentExecutionAdapter`.

The adapter is product/runtime-specific. Real implementations are expected to use the existing canonical runtime path (`AgentRuntimeAdapter`, durable runtime binding, reconciliation, verification, Run Ledger/Eval History projection) rather than introduce a new provider-specific side channel.

The executor itself has no provider credentials, no OpenCode-specific conditionals, no traffic splitter, and no API for changing production model/skill rankings.

## Sequential sample lifecycle

v1 intentionally permits one in-flight sample at a time:

```text
explicit sample request
        |
        v
verify admission / experiment / durable authorization
        |
        v
verify prior completed-sample evidence + guardrails
        |
        v
persist + fsync sample_reserved
        |
        v
single adapter.dispatch(...)
        |
        +-- exception / invalid receipt --> persist dispatch_error
        |                                sideEffectState=unknown
        |                                manual reconciliation required
        |                                NO automatic redispatch
        |
        v
persist + fsync sample_dispatched
        |
        v
external canonical runtime/eval pipeline
        |
        v
record exact reference/candidate Eval observation IDs
        |
        v
persist + fsync sample_completed
```

A crash after reservation but before a durable dispatch record is intentionally ambiguous. Reopening the journal preserves the unresolved reservation and blocks new dispatch. The executor never guesses whether an external side effect happened.

## Durable budget accounting

The execution journal is local, single-writer, append-only JSONL with:

- schema version,
- monotonic sequence,
- SHA-256 content-addressed events,
- bounded file/event/string sizes,
- owner-created file mode through the existing local filesystem pattern,
- fsync before in-memory admission,
- stale-writer detection,
- fail-closed replay for malformed/truncated data, sequence drift, digest mismatch, duplicate samples, invalid transitions, secret-bearing references, and unsupported schemas.

Budgets are checked against durable reservations, not caller counters. This prevents restart from resetting:

- total sample consumption,
- live sample consumption,
- candidate-live sample consumption, or
- candidate traffic-share ceilings.

Completed shadow/live counters are derived from completed journal samples and are supplied to the PR #34 guardrail evaluator.

## Provenance boundary

Every completed sample records exactly one reference Eval observation ID and one candidate Eval observation ID. Before another sample may dispatch, the supplied Eval summaries must contain exactly those durable IDs. Their Execution Reliability summaries must contain the same observation sets.

This prevents a caller from using unrelated or selectively chosen measurement cohorts to unlock live exposure.

## Shadow-first and bounded live

- `shadow_only` definitions can never dispatch bounded-live samples.
- `shadow_then_bounded_live` remains shadow until the minimum completed shadow sample count is satisfied and the deterministic guardrail result is `ELIGIBLE_FOR_BOUNDED_LIVE`.
- after live starts, exposure is monotonic: the executor does not return to shadow.
- continuing live requires `CONTINUE_BOUNDED_LIVE`.
- `STOP_REQUIRED`, `ROLLBACK_REQUIRED`, and `COMPLETE` forbid new dispatch.
- candidate-live reservation is checked before adapter invocation against `maxCandidateLiveSamples` and `maxCandidateTrafficBasisPoints`.

The executor never automatically executes rollback. `ROLLBACK_REQUIRED` remains evidence requiring a separate authorized action.

## Side-effect uncertainty

Adapter exceptions and structurally invalid adapter receipts are treated as potentially side-effecting failures. The journal records:

- `sideEffectState: unknown`,
- `manualReconciliationRequired: true`, and
- `automaticRedispatchAllowed: false`.

The journal remains blocked until a future explicit reconciliation slice is introduced. v1 deliberately does not provide a force-clear or retry shortcut.

## Evidence

Durable execution journal events can be translated into the existing `EvidenceRecord` contract through verified content-addressed event conversion. Raw prompts, provider responses, patches, credentials, and tokens are not stored by this slice. Requests carry bounded external input references only.

## Explicit non-goals

PR #35 does **not** add:

- autonomous experiment loops,
- concurrent experiment dispatch,
- uncontrolled production traffic allocation,
- permanent candidate promotion,
- model/skill ranking mutation,
- automatic rollback execution,
- provider credentials,
- direct OpenCode/provider API calls,
- a second runtime binding mechanism,
- automatic redispatch after uncertain failure,
- distributed/ACID transactions,
- statistical significance or causal claims,
- bandits, RL, or self-modifying policy.

## Next gate

The next narrow gate should be a real **shadow runtime reference slice** that implements `ControlledExperimentExecutionAdapter` through the existing canonical runtime session/binding/reconciliation/verification path, proves candidate output cannot escape during shadow mode, persists execution/eval evidence, and exercises restart/reconciliation without enabling production traffic mutation.
