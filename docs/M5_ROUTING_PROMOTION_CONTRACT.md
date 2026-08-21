# M5 Evidence-Bound Routing Promotion Contract

## Purpose

This slice implements Issue #40 as the next M5 authority boundary after bounded-live side-effect recovery. It allows 9Router to construct a verifiable promotion proposal and a separately approved promotion authorization from existing M5 evidence, while preserving the frozen rule that **proposal/authorization is not routing mutation**.

The contract is provider-neutral. It does not know provider credentials, provider-native routing schemas, production traffic splitters, or live mutation APIs.

## Authority chain

The accepted chain is:

`verified M5 admission -> exact controlled experiment -> exact experiment authorization -> final guardrail evidence -> bounded-live side-effect recovery evidence -> Run Ledger/Eval references -> route precondition snapshot -> routing promotion proposal -> separate R3/R4 promotion workflow approval -> routing promotion authorization`

No earlier artifact can be reinterpreted as mutation authority:

- `ELIGIBLE_FOR_CONTROLLED_EXPERIMENT` is not promotion authority.
- Controlled-experiment `allow` is not promotion authority.
- `ELIGIBLE_FOR_BOUNDED_LIVE` is not promotion authority.
- A bounded-live publication receipt is not promotion authority.
- `COMPLETE` is necessary but not sufficient.
- `PROMOTION_ELIGIBLE` is still only a proposal classification.
- A promotion authorization still hard-codes `automaticRoutingMutationAllowed=false`.

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
- final guardrail decision ID + SHA-256;
- bounded-live recovery report IDs + SHA-256 values;
- Run Ledger evidence references;
- Eval evidence references;
- route/capability/precondition snapshot;
- reference -> candidate intent;
- rollback target equal to the reference subject;
- policy references.

Classifications:

- `PROMOTION_ELIGIBLE`
- `PROMOTION_NOT_ELIGIBLE`
- `MANUAL_RECONCILIATION_REQUIRED`

Promotion eligibility requires:

1. final experiment guardrail classification `COMPLETE`;
2. bounded-live recovery evidence is present;
3. every relied-upon side effect is durably `consistent_committed` with no pending operator action;
4. at least one committed candidate publication is present;
5. no committed reference-restore evidence is present;
6. required Run Ledger/Eval evidence references are present;
7. exact route precondition still points to the known-good reference subject.

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

If the current precondition snapshot differs from the proposal snapshot, authorization fails closed as stale.

Even an allowed authorization records:

- `automaticRoutingMutationAllowed=false`;
- `automaticRollbackAllowed=false`;
- `automaticRetryAllowed=false`;
- `automaticRedispatchAllowed=false`.

The authorization does not call a router adapter.

## Verified evidence conversion

The proposal and authorization can be translated to the existing `EvidenceRecord` boundary only through verified conversion functions. They re-run the exact proposal/authorization verification before creating deterministic-check or approval evidence.

No second Run Ledger or evidence database is introduced.

## Fail-closed invariants

- No recovery evidence -> no proposal.
- Missing Run Ledger or Eval references -> no proposal.
- Non-`COMPLETE` guardrail -> not eligible.
- Any unresolved recovery state -> manual reconciliation.
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
