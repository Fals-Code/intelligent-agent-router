# M5 Isolated Routing Mutation + Restart Recovery Gate

## Purpose

This slice implements Issue #42, the first routing-mutation adapter allowed after the evidence-bound promotion contract from PR #41.

It is deliberately **isolated/local only**. The adapter mutates a JSON-backed test-router state file and has no network or provider-specific production routing integration.

The frozen Architecture Contract requires runtime crash recovery to fail safely, machine restart to resume without duplicate side effects, idempotency-aware mutation handling, and M5 evidence-based routing changes within fixed safety policy. M6 remains deferred.

## Authority chain

`verified RoutingPromotionAuthorization -> fresh exact route precondition -> durable mutation reservation -> isolated route apply -> durable commit -> restart reconciliation -> verified mutation receipt/evidence`

The promotion authorization remains explicit human-approved R3/R4 authority. The mutation adapter does not reinterpret `PROMOTION_ELIGIBLE` as automatic action.

## Isolated target boundary

`JsonFileIsolatedRoutingTarget` accepts only:

- `targetKind=isolated_local_test_router`;
- a deterministic target identity for the exact project + route;
- a local state-file path;
- normalized project/route/capability/current-subject/revision facts.

State records hard-code:

- `productionRouter=false`;
- `providerSpecificStatePersisted=false`;
- `rawProviderOutputPersisted=false`.

A production/live target kind is rejected before state creation or mutation.

## Mutation authority and stale-state check

Before any side effect, `IsolatedRoutingMutationCoordinator.apply()`:

1. re-verifies the exact `RoutingPromotionAuthorization` against its proposal, proposal context, precondition snapshot, and durable promotion workflow;
2. requires `decision=allow` and `routingMutationAuthorized=true`;
3. requires every automatic-action flag to remain false;
4. freshly reads the isolated router state from disk;
5. exact-compares project, route, capability, reference subject, and route revision to the authorized precondition;
6. rejects stale/drifted state before durable reservation.

The deterministic after-state changes only the authorized subject, route revision, mutation count, and timestamp. Target/project/route/capability identity cannot change.

## Durable routing-mutation journal

`JsonlRoutingMutationJournal` is append-only JSONL with content-addressed events and fsync-backed writes.

Event types:

- `mutation_reserved`;
- `mutation_committed`;
- `mutation_not_applied`;
- `mutation_manual_reconciliation_required`.

The durable reservation is written before the router-state side effect. Each operation binds:

- exact authorization/proposal/precondition IDs + SHA-256;
- exact isolated target identity;
- exact project/route/capability;
- exact before and deterministic after state IDs + SHA-256;
- exact reference/candidate subject identities;
- before/after route revisions;
- deterministic operation + idempotency identity.

Journal safety flags are always:

- `automaticRetryAllowed=false`;
- `automaticRollbackAllowed=false`;
- `productionRoutingMutationAllowed=false`.

An authorization/operation cannot be used twice. A manual-reconciliation operation blocks new mutation reservations in the same journal.

## Restart reconciliation

Restart recovery never blindly redispatches the route mutation.

For an interrupted durable reservation:

- exact before-state still present -> `NOT_APPLIED_SAFE`; record terminal not-applied evidence and require a new explicit authorization for any future attempt;
- exact deterministic after-state already present -> record `mutation_committed` with `recoveredAfterRestart=true`; no second mutation is executed;
- any other or unverifiable state -> `MANUAL_RECONCILIATION_REQUIRED`.

For an already committed operation:

- exact after-state -> stable `COMMITTED`, no second mutation;
- drifted after-state -> manual reconciliation.

Partial/corrupt target or journal storage fails closed.

## Receipt and evidence

`IsolatedRoutingMutationReceipt` binds:

- exact promotion authorization and proposal;
- exact precondition snapshot;
- exact isolated target/project/route/capability;
- exact before/after state content addresses;
- exact durable mutation commit event;
- whether commit was recovered after restart.

Receipt verification re-verifies the promotion authority, the durable commit event, and the current authoritative isolated after-state before it can be converted to `EvidenceRecord`.

## Fault injection proof

The isolated coordinator accepts a test-only/local fault injector at two explicit boundaries:

- `after_reservation`;
- `after_apply_before_commit`.

Regression tests exercise process-interruption semantics by reopening both the route state and the journal after these injected failures.

Required proof includes:

- normal isolated authorized mutation;
- stale precondition rejection before reservation;
- production target rejection;
- duplicate authorization rejection;
- reservation-before-apply crash -> not-applied safe, no retry;
- apply-before-commit crash -> recovered commit without duplicate mutation;
- unexpected route state -> manual reconciliation;
- partial journal write detection;
- forged receipt automatic-authority rejection;
- forged/invalid promotion authorization rejection.

## Non-goals

This slice does not:

- mutate a live or production 9Router route;
- introduce provider-specific production routing schemas;
- perform automatic promotion, rollback, retry, or redispatch;
- add a traffic splitter or global model/skill ranking mutation;
- add autonomous scheduling;
- implement bandits, reinforcement learning, self-modifying policy, or M6 behavior.

## Validation gate

Before readiness:

- changed-file scope is frozen;
- `npm run check` passes;
- `npm run eval` passes;
- Ubuntu and Windows CI pass on the exact head;
- the restart/recovery tests actually execute on both CI jobs;
- independent review approves the exact head;
- unresolved review threads = 0;
- no direct/force push to `main`;
- no production/live routing mutation occurs.

## Next gate

Only after this isolated/local mutation + restart/recovery gate passes should a separate issue evaluate whether a real local-production routing adapter can be designed safely. That future decision remains distinct from M6 autonomous self-optimization.
