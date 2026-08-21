# M5 Evidence-Bound Routing Promotion Contract

## Purpose

This slice implements Issue #40 as the next M5 authority boundary after bounded-live side-effect recovery. It allows 9Router to construct a verifiable promotion proposal and a separately approved promotion authorization from existing M5 evidence, while preserving the frozen rule that **proposal/authorization is not routing mutation**.

The contract is provider-neutral. It does not know provider credentials, provider-native routing schemas, production traffic splitters, or live mutation APIs.

## Authority chain

The accepted chain is:

`verified M5 admission -> exact controlled experiment -> exact experiment authorization -> authoritative final progress -> re-derived final guardrail -> canonical Eval/Run Ledger cohorts -> exact bounded-live authorization -> canonical durable side-effect journal event -> recovery/publication evidence -> route precondition snapshot -> routing promotion proposal -> separate R3/R4 promotion workflow approval -> routing promotion authorization`

No earlier artifact can be reinterpreted as mutation authority:

- `ELIGIBLE_FOR_CONTROLLED_EXPERIMENT` is not promotion authority.
- Controlled-experiment `allow` is not promotion authority.
- `ELIGIBLE_FOR_BOUNDED_LIVE` is not promotion authority.
- A bounded-live publication receipt is not promotion authority.
- `COMPLETE` is necessary but not sufficient.
- `PROMOTION_ELIGIBLE` is still only a proposal classification.
- A promotion authorization still hard-codes `automaticRoutingMutationAllowed=false`.

## Canonical final progress proof

`RoutingPromotionContext` carries the exact `ControlledExperimentProgressInput` that produced the final guardrail decision.

Before promotion evidence is accepted, the contract:

1. requires the final progress Eval and execution summaries to be exactly the canonical promotion cohorts;
2. re-runs `evaluateControlledExperimentGuardrails()` using the exact experiment, experiment authorization, admission decision, durable experiment workflow, and final progress;
3. exact-compares the re-derived decision with the supplied final guardrail decision;
4. content-addresses the final progress as `finalProgressSha256` inside the promotion proposal.

Therefore a caller cannot turn a non-complete experiment into `COMPLETE` merely by changing the guardrail payload and re-hashing it. Counters, summary identities, deltas, classification, reasons, and safety flags must all be reproduced by the authoritative guardrail evaluator.

## Canonical Eval and Run Ledger proof

Promotion does not accept arbitrary `run-ledger:*` or `eval-summary:*` strings as evidence.

For both reference and candidate cohorts, the contract consumes canonical:

- Eval observations;
- Eval cohort summary;
- execution projections;
- Run Ledger records;
- execution reliability summary.

It rebuilds the Eval and execution summaries and exact-compares them to the supplied canonical summaries. Their subject, suite, suite SHA-256, baseline, observation IDs, and admission summary identities must agree with the verified M5 admission decision.

Only after those checks pass are content-addressed Run Ledger and Eval references derived for the proposal.

## Durable bounded-live side-effect proof

A content-addressed receipt or recovery report is not enough to prove a committed side effect.

`RoutingPromotionContext` therefore requires the canonical `JsonlBoundedLiveSideEffectJournal`. Promotion verification requires every bounded-live recovery report to resolve to the exact current durable journal event for its operation.

The journal event must match the recovery report on:

- event ID and event type;
- operation ID;
- idempotency key;
- sink ID;
- authority ID;
- subject ID;
- sample ID when applicable;
- output SHA-256 when applicable.

For `consistent_committed` publication evidence, the latest durable event must be `operation_committed`, and the exact publication receipt must additionally match the durable event and recovery report, including `sideEffectCommitEventId`, external publication reference, operation, idempotency key, sink, sample, subject, and output digest.

The proposal records a content-addressed reference to the exact durable journal event. An auth-matching receipt/recovery object with no journal event is rejected.

If the canonical journal contains any unresolved operation, promotion classification becomes `MANUAL_RECONCILIATION_REQUIRED`. Automatic retry remains forbidden.

## Route precondition snapshot

`RoutingPreconditionSnapshot` is content-addressed and captures only normalized routing facts:

- project ID;
- route ID;
- frozen capability ID;
- current subject ID;
- route revision/reference;
- capture time;
- policy references.

The snapshot explicitly records:

- `providerSpecificStatePersisted=false`;
- `rawProviderOutputPersisted=false`.

The known-good current subject must be the experiment reference subject before a candidate promotion can be proposed. A future mutation adapter must re-check this exact snapshot immediately before mutation.

## Promotion proposal

`RoutingPromotionProposal` binds the exact:

- admission decision ID + SHA-256;
- controlled experiment ID + SHA-256;
- controlled-experiment authorization ID + SHA-256;
- experiment workflow;
- authoritative final progress SHA-256;
- re-derived final guardrail decision ID + SHA-256;
- canonical Run Ledger evidence references;
- canonical Eval evidence references;
- bounded-live sample authorization evidence;
- exact durable side-effect journal event evidence;
- publication/recovery evidence;
- route/capability/precondition snapshot;
- reference -> candidate intent;
- rollback target equal to the reference subject;
- policy references.

Classifications:

- `PROMOTION_ELIGIBLE`
- `PROMOTION_NOT_ELIGIBLE`
- `MANUAL_RECONCILIATION_REQUIRED`

Promotion eligibility requires:

1. authoritative final progress re-derives the exact final guardrail;
2. final experiment guardrail classification is `COMPLETE`;
3. canonical Eval/Run Ledger evidence is exact and complete;
4. canonical durable side-effect journal evidence is present;
5. every relied-upon side effect is durably `consistent_committed` with no pending operator action;
6. at least one exact committed candidate publication is present;
7. no committed reference-restore evidence is present;
8. the durable journal has no unresolved side-effect operation;
9. exact route precondition still points to the known-good reference subject.

Any unresolved side effect becomes `MANUAL_RECONCILIATION_REQUIRED`. A completed reference restore makes the candidate `PROMOTION_NOT_ELIGIBLE`.

## Separate promotion authorization

`RoutingPromotionAuthorization` requires a **different workflow** from the experiment authorization workflow.

An `allow` decision requires:

- proposal classification `PROMOTION_ELIGIBLE`;
- active `R3` or `R4` workflow;
- workflow phase `publish`;
- exact durable approval IDs;
- exact proposal ID + SHA-256;
- exact project/route/capability/reference/candidate scope;
- exact precondition snapshot ID + SHA-256;
- unchanged route revision.

If the current precondition snapshot differs from the proposal snapshot, authorization fails closed as stale. The same authorization cannot be reused for another route/capability.

Even an allowed authorization records:

- `automaticRoutingMutationAllowed=false`;
- `automaticRollbackAllowed=false`;
- `automaticRetryAllowed=false`;
- `automaticRedispatchAllowed=false`.

Re-hashing an authorization with any automatic-action flag changed to `true` is rejected by semantic verification.

The authorization does not call a router adapter.

## Verified evidence conversion

The proposal and authorization can be translated to the existing `EvidenceRecord` boundary only through verified conversion functions. They re-run exact proposal/authorization verification before creating deterministic-check or approval evidence.

No second Run Ledger or evidence database is introduced.

## Fail-closed invariants

- No evidence, no promotion eligibility.
- Missing authoritative final progress -> reject.
- Re-hashed final `COMPLETE` decision that does not re-derive from final progress -> reject.
- Missing canonical Eval/Run Ledger provenance -> reject.
- Missing canonical durable side-effect journal event -> reject.
- Any unresolved durable journal operation -> manual reconciliation.
- Non-`COMPLETE` guardrail -> not eligible.
- Reference/candidate/project/route/capability drift -> reject.
- Stale route snapshot -> reject authorization.
- Re-using the experiment authorization workflow -> reject.
- Wrong risk class or workflow phase -> reject.
- Durable approval mismatch -> reject.
- Re-hashed semantic forgery -> reject.
- Automatic mutation/retry/rollback/redispatch flags cannot be true.
- Secret-like references are rejected before content addressing.
- Provider-specific state and raw provider output are structurally excluded.

## Non-goals

This slice does not:

- mutate `main` or any live route;
- call a production routing adapter;
- change global model or skill ranking;
- allocate or split production traffic;
- auto-promote a candidate;
- auto-rollback;
- auto-retry or redispatch;
- persist provider credentials or raw provider output;
- implement bandits, RL, self-modifying policy, or M6 behavior.

## Next gate

After this contract passes required CI and independent review, the next separate gate is an **isolated/local bounded routing-mutation adapter with restart/recovery proof**. That future adapter must consume the exact promotion authorization and re-check the precondition snapshot immediately before any side effect.