# M5 Bounded Local-Production Adapter Rehearsal Gate

## Purpose

This slice implements Issue #46 after the local-production readiness contract merged in PR #45.

It introduces a **rehearsal-only adapter implementation** that exercises the exact local-production routing-state contract against an isolated clone. The real local-production target is exposed only through a read-only target and must remain byte-for-byte unchanged throughout the rehearsal.

This slice does **not** authorize or execute a real production route apply.

The frozen Architecture Contract remains authoritative: no evidence means no success; M5 adaptation stays inside fixed safety policy; R4 authority remains explicit and durable; one canonical production writer remains the default; provider-specific schemas and secrets stay behind adapter boundaries; M6 remains deferred.

## Authority chain

`verified M5 readiness authorization -> fresh exact target snapshot -> fresh exact adapter/main source snapshot -> read-only production fingerprint -> isolated rehearsal clone -> durable candidate reservation -> clone-only candidate apply -> durable candidate commit -> restart/reopen verification -> explicit restore reservation -> clone-only reference restore -> durable restore commit -> read-only production post-fingerprint -> verified rehearsal receipt`

A successful rehearsal proves only implementation/recovery behavior of the bounded adapter.

It never grants production routing mutation authority.

## Components

### Read-only production target

`JsonFileLocalProductionReadOnlyTarget` can only read and fingerprint a normalized local-production routing-state representation.

The normalized state is content-addressed and hard-codes:

- `targetKind=local_production_router`;
- `productionRouter=true`;
- `providerSpecificStatePersisted=false`;
- `rawProviderOutputPersisted=false`;
- `secretMaterialPersisted=false`.

The class intentionally exposes no production write method.

A production fingerprint binds both:

- the verified content-addressed parsed state; and
- SHA-256 of the raw file bytes.

The raw-byte hash is required so whitespace or serialization-only drift is still observable even when parsed routing semantics appear unchanged.

### Rehearsal clone

`JsonFileLocalProductionRehearsalTarget` is a separate state file with explicit:

- `targetKind=local_production_rehearsal_clone`;
- `rehearsalOnly=true`;
- `productionRouter=false`.

Initialization requires a verified read-only production state, but the clone must have a different target identity and a different resolved filesystem path from production.

The clone is the **only** writable state in this slice.

### Readiness authority

Every candidate apply, recovery, restore, finalization, and receipt verification reuses the merged Issue #44 verifier through `verifyLocalProductionRoutingReadinessAuthorization()`.

The supplied authority must still bind:

- exact readiness authorization and proposal;
- exact readiness context;
- exact current local-production target snapshot;
- exact current adapter/main source snapshot;
- exact R4 workflow/approval state.

The authorization must be `allow`, `implementationReadinessAuthorized=true`, and the readiness proposal must still classify `READY_FOR_LOCAL_PRODUCTION_ADAPTER_IMPLEMENTATION`.

The following remain hard-coded false:

- `productionRoutingMutationAuthorized`;
- automatic routing mutation;
- automatic retry;
- automatic rollback;
- automatic redispatch.

A stale adapter SHA, stale main SHA, target drift, approval drift, proposal drift, or invalid readiness artifact therefore fails before rehearsal writes.

## Deterministic operation identity

Each rehearsal uses exactly two deterministic operations derived from the exact readiness authorization:

- `local-production-rehearsal:<authorizationId>:candidate`;
- `local-production-rehearsal:<authorizationId>:restore`.

The idempotency key is exactly the operation ID.

A candidate or restore operation cannot be blindly dispatched twice.

## Durable rehearsal journal

`JsonlLocalProductionRehearsalJournal` is an append-only fsync-backed JSONL journal.

Every event is SHA-256 content-addressed and binds:

- candidate vs restore phase;
- deterministic operation/idempotency identity;
- exact production and rehearsal identities;
- project/route/capability;
- readiness authorization/proposal IDs and SHA-256;
- target/source snapshot IDs and SHA-256;
- adapter ID/version/source SHA-256 and main SHA-256;
- exact before/after rehearsal state IDs and SHA-256;
- exact before/after subject and route revision;
- complete pre-rehearsal production fingerprint, including raw file SHA-256;
- fixed false production/automatic-authority flags.

The journal records a reservation before each clone write.

Supported durable terminal records are:

- committed;
- not-applied-safe;
- manual-reconciliation-required.

A stale journal reader detects a second writer through durable file size + SHA-256 drift and fails closed.

Partial/truncated records, sequence drift, hash tampering, unknown fields, operation identity drift, or non-canonical progression fail closed on reopen.

## Candidate rehearsal

`applyCandidate()` performs:

1. exact readiness authorization verification;
2. production pre-fingerprint;
3. exact production/reference binding check;
4. exact rehearsal-reference-state check;
5. deterministic candidate-state derivation on the clone;
6. durable candidate reservation;
7. clone-only candidate write;
8. exact after-state readback;
9. production fingerprint re-check;
10. durable candidate commit.

The candidate revision is rehearsal-specific and never written to the real production target.

## Candidate interruption recovery

After restart/reopen:

- reservation + exact before-state => `NOT_APPLIED_SAFE`;
- reservation + exact expected candidate after-state => recovered durable commit without another write;
- durable commit + exact candidate state => stable committed classification;
- any unexpected clone state => `MANUAL_RECONCILIATION_REQUIRED`;
- any production fingerprint drift => `MANUAL_RECONCILIATION_REQUIRED`.

Recovery never automatically retries candidate apply.

## Explicit restore

Reference restore is a separate explicit operation.

`restoreReference()` requires an exact durable candidate commit. It then:

1. rechecks production immutability;
2. requires the exact committed candidate clone state;
3. derives the exact original reference subject + route revision;
4. durably reserves restore;
5. writes only the rehearsal clone;
6. verifies exact restored state;
7. rechecks production immutability;
8. durably commits restore.

No automatic rollback is performed.

## Restore interruption recovery

After restart/reopen:

- restore reservation + exact candidate before-state => `NOT_APPLIED_SAFE`;
- restore reservation + exact reference after-state => recovered durable restore commit without another write;
- durable restore commit + exact reference state => stable restore commit;
- unexpected state or production drift => manual reconciliation.

## Final rehearsal receipt

`finalize()` requires both exact durable candidate and restore commits.

The final clone must equal the exact restored durable state and the original reference subject/revision.

The current production target is fingerprinted again. Its semantic state and raw bytes must equal the original production pre-fingerprint.

`LocalProductionRehearsalReceipt` binds:

- `REHEARSAL_PASSED` classification;
- canonical candidate/restore operation IDs;
- exact candidate and restore durable commit event IDs/SHA-256;
- readiness authorization/proposal;
- target/source snapshots;
- adapter identity/version/source SHA and main SHA;
- production and rehearsal target identities;
- reference, candidate, and restored rehearsal states;
- production pre/post fingerprints;
- restart-recovery flags;
- completion timestamp;
- fixed false production and automatic authority flags.

Receipt verification is context-bound. It re-verifies the readiness authorization, fresh journal, exact durable commit events, current restored rehearsal state, and current read-only production fingerprint.

A receipt hash by itself is not proof.

## Fault-injection boundaries

The coordinator exposes four deterministic test-only fault points:

- after candidate reservation;
- after candidate apply before candidate commit;
- after restore reservation;
- after restore apply before restore commit.

These prove restart behavior without granting an automatic retry or rollback path.

## Negative-first proof

The regression suite covers at minimum:

- clean candidate + explicit restore + final receipt while production bytes remain identical;
- production path alias rejection;
- production identity alias rejection;
- stale adapter/main source rejection;
- deny readiness authorization rejection;
- candidate crash after reservation -> `NOT_APPLIED_SAFE`;
- candidate crash after apply -> recovered commit without duplicate mutation;
- restore crash after reservation -> candidate remains active and no automatic restore;
- restore crash after apply -> recovered restore without duplicate mutation;
- production raw-byte drift -> manual reconciliation;
- stale journal reader after second-writer append;
- partial/truncated journal rejection;
- duplicate candidate dispatch rejection;
- re-hashed production/automatic authority forgery rejection;
- re-hashed operation/event provenance forgery rejection;
- provider-specific extra field rejection in receipt and production state.

## Frozen scope

This issue intentionally keeps the implementation slice narrow:

- `docs/M5_LOCAL_PRODUCTION_ADAPTER_REHEARSAL.md`;
- `src/evaluation/index.ts`;
- `src/evaluation/local-production-adapter-rehearsal.ts`;
- `tests/local-production-adapter-rehearsal-fixture.mjs`;
- `tests/local-production-adapter-rehearsal.test.mjs`.

No production routing configuration, provider credential file, runtime provider adapter, or production writer is changed.

## Validation gate

Before this issue may close:

- exact changed-file scope remains frozen;
- `npm run check` passes;
- `npm run eval` passes;
- required Ubuntu + Windows CI pass on the exact head;
- interruption/restart tests actually execute;
- negative-first tests actually execute;
- independent exact-head review approves;
- unresolved review threads are zero;
- branch is not behind current `main` at readiness/merge gate;
- production bytes remain unchanged in every successful rehearsal;
- no real production route apply occurs;
- no automatic promotion/rollback/retry/redispatch is introduced;
- no provider credentials are persisted;
- no M6 behavior is introduced.

## Next gate

Only after this rehearsal gate is merged may a separate issue define the **first bounded production-apply authorization + execution gate**.

That later gate must require a new explicit production-apply authority. Neither the Issue #44 readiness authorization nor this rehearsal receipt is sufficient by itself to mutate production routing.
