# M5 Bounded-Live Runtime Gate

## Purpose

This gate is the first step after the merged end-to-end shadow provenance proof (#37). It defines the authority and safety boundaries required before a real candidate output may become externally visible.

This change does **not** itself execute candidate live exposure.

## Design rule: verify before visibility

A bounded-live sample must not publish provider output during initial runtime dispatch. Runtime execution, reconciliation, deterministic verification, and canonical Run Ledger finalization happen first. Only a verified selected runtime result may cross the publication boundary.

The intended chain is:

```text
eligible M5 admission
  -> R3/R4 controlled experiment authorization
  -> completed shadow evidence
  -> guardrail ELIGIBLE_FOR_BOUNDED_LIVE / CONTINUE_BOUNDED_LIVE
  -> separate durable R3/R4 live-sample workflow approval
  -> content-addressed BoundedLiveSampleAuthorization
  -> bounded runtime execution
  -> reconciliation + deterministic verification
  -> canonical Run Ledger succeeded
  -> exact RuntimeBinding
  -> ephemeral provider output hash/size verification
  -> explicit BoundedLivePublicationCoordinator.publish()
  -> content-addressed publication receipt
```

No autonomous dispatch loop is introduced.

## Sample-specific live authorization

`BoundedLiveSampleAuthorization` is separate from the experiment-level authorization. It binds one exact live sample to:

- exact experiment + experiment authorization;
- exact guardrail decision;
- exact experiment workflow;
- a separate approved R3/R4 live workflow;
- sample ID and input reference;
- reference or candidate live assignment;
- durable live approval IDs;
- shadow/live counters before dispatch;
- candidate traffic basis points after the proposed dispatch;
- exact selected subject;
- a single-sample authority flag.

The authorization fails closed when:

- experiment mode is not `shadow_then_bounded_live`;
- risk is below R3;
- the guardrail is not `ELIGIBLE_FOR_BOUNDED_LIVE` for first live exposure or `CONTINUE_BOUNDED_LIVE` later;
- minimum completed shadow evidence is missing;
- max total/live/candidate-live budget would be exceeded;
- candidate traffic basis-point ceiling would be exceeded;
- the live workflow is not approved, running, and in `publish`;
- approval IDs do not match durable workflow state.

It never grants automatic dispatch, redispatch, rollback, or general production routing mutation.

## Verified publication boundary

`VerifiedBoundedLiveRuntimeResult` binds the selected live assignment to:

- exact sample authorization;
- succeeded canonical Run Ledger record;
- exact RuntimeBinding run/project/runtime identity;
- positive workflow attempt and exact session ID;
- an exact passed deterministic verification evidence reference;
- SHA-256 and byte length of the selected provider output;
- no raw-output persistence.

`BoundedLivePublicationCoordinator` then reads the selected output ephemerally, recomputes its SHA-256 and byte length, and calls an injected publication sink only on exact match.

The persisted publication receipt contains hashes and references, not raw provider output.

If the sink call fails, side-effect state is treated as unknown and automatic retry is forbidden.

Candidate external visibility is true only when the authorized selected role is `candidate`. Publishing a sample does not grant general production routing mutation.

## Explicit reference restore

A guardrail breach after live exposure may classify the experiment as `ROLLBACK_REQUIRED`.

Reference restoration is deliberately separate from publication and requires:

- exact ROLLBACK_REQUIRED guardrail decision;
- the experiment rollback strategy `restore_reference_subject`;
- a separate approved R3/R4 rollback workflow;
- durable rollback approval IDs;
- explicit `BoundedLiveRollbackAuthorization`;
- an injected reference-restore sink returning the exact reference subject as active.

`automaticRollbackAllowed` remains false. A failed restore has unknown side-effect state and is never automatically retried.

The rollback boundary authorizes only explicit restoration of the experiment's canonical reference subject. It does not grant arbitrary production routing mutation.

## Initial regression gate

Before any real live exposure, CI must prove:

1. first candidate live sample is rejected when it would exceed the configured traffic basis-point ceiling;
2. sample-specific R3/R4 authorization is content-addressed and bound to durable approvals;
3. publication fails before sink side effects when ephemeral output hash/size drifts;
4. publication requires succeeded Run Ledger + exact RuntimeBinding + deterministic verification evidence;
5. candidate publication receipt records candidate external visibility without raw output persistence or general routing authority;
6. rollback authorization is impossible without ROLLBACK_REQUIRED;
7. explicit reference restore proves the reference subject becomes active and remains non-automatic.

## Live gate plan after CI/review

A later commit in this PR may add the real local bounded-live proof harness. That proof must use tiny budgets and an isolated publication sink before any production-facing adapter is considered.

Planned progression:

1. shadow sample(s) complete first;
2. first bounded-live sample assigned to reference when required by candidate traffic ceiling;
3. candidate bounded-live sample only after CONTINUE_BOUNDED_LIVE and sample-specific approval;
4. candidate output is verified before visibility;
5. guardrail is reevaluated after completion;
6. a deterministic breach scenario proves explicit reference restore;
7. all durable authority/publication/restore artifacts are hashed and independently reviewed.

Real candidate external visibility remains **PENDING explicit execution approval**.

## Non-goals

This gate does not authorize:

- automatic experiment loops;
- automatic redispatch;
- permanent candidate promotion;
- global model-route mutation;
- arbitrary production traffic splitting;
- automatic rollback;
- self-modifying routing policy;
- bandit/RL adaptation;
- raw provider-output persistence.
