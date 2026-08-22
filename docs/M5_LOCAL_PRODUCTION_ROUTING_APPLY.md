# M5 First Bounded Local-Production Routing Apply Gate

## Status

This document describes the Issue #48 implementation in Draft PR #49 after merged PR #47 / closed Issue #46.

The implementation now contains the complete **isolated implementation mechanism** for one bounded local-production routing transition: exact authority, fresh backup capture, one canonical writer, fsync-backed reservation/commit evidence, interruption/restart reconciliation, and a context-bound final receipt.

**This PR does not perform a real production apply.** All writer and recovery execution in this branch is exercised only against isolated temporary fixtures. Merging this implementation still does not authorize a later production write.

## Frozen architecture constraints

The implementation keeps the frozen contract invariants unchanged:

- no evidence, no success;
- R4 activity requires explicit human approval plus backup/rollback evidence;
- approvals are durable workflow state;
- every production write must be attributable to exact run/tool/approval evidence;
- exactly one canonical writer owns the production routing state domain;
- provider-specific failure remains at the adapter boundary;
- unrestricted long-lived credentials never enter autonomous worker/core state;
- machine/restart recovery reconciles durable state instead of blindly replaying side effects;
- M5 adaptation occurs only inside fixed safety policy;
- M6 autonomous self-optimization remains deferred.

The following values remain hard-coded false across proposal, authorization, execution approval, pre-write seal, journal, and final receipt:

- `automaticRoutingMutationAllowed=false`;
- `automaticRetryAllowed=false`;
- `automaticRollbackAllowed=false`;
- `automaticRedispatchAllowed=false`;
- `automaticPromotionAllowed=false`.

## Source-first reuse

Issue #48 extends rather than replaces the merged evidence chain:

1. `LocalProductionRoutingReadinessAuthorization` remains historical Issue #44 implementation-readiness authority only. It still cannot authorize production mutation.
2. `LocalProductionAdapterRehearsalReceipt` remains Issue #46 rehearsal proof only.
3. Fresh Issue #48 target/source snapshots, production pre-fingerprint, backup evidence, R4 authorization, and explicit execution approval are separate authorities.
4. `LocalProductionRouterState` and `LocalProductionRouterFingerprint` remain the normalized provider-neutral canonical state/fingerprint formats.
5. Recovery verifies historical rehearsal provenance without requiring the current production bytes to still equal the pre-apply bytes after a legitimate one-shot apply.

## Implemented authority chain

The implementation binds this exact chain:

`verified Issue #46 rehearsal receipt -> fresh current target/source -> immutable production pre-fingerprint -> fresh content-addressed backup -> exact proposal -> durable R4 authorization -> separate apply-now approval -> fresh target/source observations -> fresh pre-write seal -> durable reservation -> exactly one canonical write -> read-back/fingerprint verification -> durable commit -> context-bound final receipt`

Any pre-write drift stops before a writer is reached. Any ambiguous state after reservation/write stops automatic activity and enters manual reconciliation.

## Fresh content-addressed backup

`JsonFileLocalProductionRoutingApplyBackupStore` is an exact-target backup boundary used by the implementation and isolated tests.

Before a reservation it:

- reads the exact production pre-state;
- computes/verifies the exact semantic state and raw-file SHA-256;
- stores the raw bytes under a content-addressed object key derived from the raw SHA-256;
- fsyncs the backup file;
- verifies the persisted backup bytes and normalized semantic state;
- binds backup store ID, object key, byte length, semantic state ID/SHA, raw SHA, retention policy, restore procedure, and restore-rehearsal evidence;
- retains the backup for explicit manual recovery;
- grants no automatic rollback authority.

The backup store is physically distinct from the production target. Existing backup paths that physically alias the production file are rejected.

## Narrow canonical writer and single-writer boundary

`CanonicalLocalProductionRoutingWriter` is intentionally not a generic filesystem writer.

Its descriptor binds exactly:

- one production target ID;
- one project;
- one route;
- one capability;
- one write-boundary ID;
- one exact state file path;
- `singleWriter=true`.

The writer captures physical target identity and checks it again at the final write boundary. Candidate state must pass the existing normalized `LocalProductionRouterState` schema and cannot contain provider-specific state, raw provider output, or secret material.

The write sequence is:

1. verify exact pre-fingerprint;
2. build/verify exact normalized candidate;
3. stage candidate bytes to a bounded sibling temporary file;
4. fsync staged bytes;
5. verify staged bytes + semantic state;
6. re-check physical target identity and exact live pre-fingerprint;
7. perform one atomic replacement of the exact target path;
8. read back and verify exact candidate semantic state + raw bytes.

The writer instance is one-shot. `LocalProductionRoutingSingleWriterBoundary` rejects any second/co-primary writer registration.

## Durable fsync-backed apply journal

`JsonlLocalProductionRoutingApplyJournal` stores append-only JSONL evidence.

Each persisted entry has:

- monotonic sequence;
- previous-entry SHA-256;
- content-addressed event;
- entry SHA-256;
- file fsync before append returns.

A stale reader detects external/second-writer journal changes before any append/read operation. Reopen fails closed on partial/truncated JSON, sequence drift, broken hash chain, or event hash tamper.

The canonical progression is bounded to:

- `apply_reserved` first;
- then exactly one of:
  - `apply_committed`,
  - `not_applied_safe`,
  - `manual_reconciliation_required`;
- a later manual event may follow an already committed apply only when later verification proves the production state is no longer exact/verifiable.

No commit or terminal event may exist without a reservation. No committed operation can be replayed as a second automatic write.

## Reservation-before-side-effect

`LocalProductionRoutingApplyCoordinator.execute()` re-verifies the exact pre-write seal and checks that the operation has no existing durable journal state.

It then:

1. derives the exact candidate state and deterministic operation/idempotency ID;
2. appends + fsyncs `apply_reserved` with `productionWriteObserved=NO`;
3. only after durable reservation calls the canonical writer;
4. reads back exact production candidate state/fingerprint;
5. appends + fsyncs `apply_committed`;
6. creates and verifies the final receipt.

There is no retry loop and no automatic rollback path.

## Interruption and restart reconciliation

Two explicit interruption points are covered:

- after durable reservation but before write;
- after one production write but before durable commit.

Recovery never invokes the writer.

For the exact bound operation:

- reservation + exact original production pre-state => append durable `NOT_APPLIED_SAFE`;
- reservation + exact authorized candidate => append recovered commit and return `APPLIED_VERIFIED` without another write;
- durable commit + exact candidate => remain `APPLIED_VERIFIED`;
- unexpected, malformed, deleted, unreadable, or otherwise unverifiable production state => append/retain `MANUAL_RECONCILIATION_REQUIRED` where journal integrity permits;
- later drift after a durable commit => `MANUAL_RECONCILIATION_REQUIRED`, with no automatic rollback.

A corrupt apply journal itself fails closed and cannot be silently repaired/replayed.

## Final receipt

`LocalProductionRoutingApplyReceipt` has exactly one classification:

- `NOT_APPLIED_SAFE`;
- `APPLIED_VERIFIED`;
- `MANUAL_RECONCILIATION_REQUIRED`.

The receipt binds:

- deterministic operation/idempotency identity;
- production target/project/route/capability;
- exact reference and candidate state IDs/SHA/revisions;
- production pre/post semantic + raw-byte fingerprints;
- reservation/commit/terminal event IDs + SHA-256;
- journal progression SHA-256;
- Issue #44 readiness authorization;
- Issue #46 rehearsal receipt;
- Issue #48 proposal, R4 authorization, explicit execution approval, and pre-write seal;
- current adapter/main source identity;
- fresh backup identity/integrity evidence;
- workflow + human approval identities/timestamps;
- Run Ledger + trace references;
- recovery status.

`productionRouteMutated=true` is valid only for `APPLIED_VERIFIED`.

Every receipt sets:

- `oneShotConsumed=true`;
- `productionRoutingMutationAuthorizedForThisOperation=true`;
- `futureProductionMutationAuthorized=false`;
- all automatic authority flags false.

Receipt verification is not a self-hash check. It rebinds the receipt to the current durable journal and, for safe/applied classifications, the current exact production state.

## Negative-first matrix

The Issue #48 tests exercise isolated fixtures for:

- missing/deny/stale apply authorization;
- R4 approval created before/equal to final proposal snapshot;
- rehashed wrong project/route/capability/reference/target/backup/writer bindings;
- stale/forged historical Issue #44 readiness authority;
- invalid/wrong Issue #46 rehearsal receipt;
- unverified or changed adapter/main source;
- semantic production drift before pre-write;
- raw-byte-only production drift;
- drift between pre-write seal and reservation/write;
- stale/mismatched/missing/tampered backup proof;
- second/co-primary writer ambiguity;
- broadened writer path/scope;
- physical backup aliasing;
- provider-specific extra fields;
- secret-like material;
- forged automatic authority flags;
- forged operation transfer;
- stale journal reader/second writer;
- partial/truncated/tampered journal;
- crash after reservation before write;
- crash after write before commit;
- stable restart from exact committed candidate;
- unexpected/malformed/deleted production during recovery;
- post-commit drift requiring manual reconciliation;
- receipt context/provenance forgery;
- attempted second/future application;
- automatic retry/rollback/redispatch/promotion/routing mutation invariants.

The tests also assert that production, backup, and apply-journal paths are rooted under temporary isolated fixture directories.

## Development vs execution authority

The fixture’s explicit `apply now` approval exists only to exercise the implementation mechanism against isolated temporary files.

It is **not** an instruction to apply the user’s real production route.

A real execution remains a separate post-merge gate and requires, at execution time:

1. implementation merged to current `main`;
2. exact approved implementation/source still current;
3. exact target still equals the approved reference precondition;
4. a newly captured fresh backup + integrity proof;
5. verified Issue #46 rehearsal provenance;
6. a newly prepared exact production-apply proposal;
7. fresh durable R4 human approval created after final evidence;
8. exact one-shot authorization;
9. no conflicting writer;
10. explicit operator instruction for **that exact apply now**;
11. a final fresh pre-write seal immediately before reservation/write.

If any one of those conditions fails, the production writer must not run.

## PR #49 readiness gate

PR #49 must remain Draft until all of the following are true on the same exact HEAD:

- frozen changed-file scope remains exactly the five Issue #48 files;
- `npm run check` passes;
- `npm run eval` passes;
- required Ubuntu and Windows CI pass;
- the negative-first/interruption/recovery matrix actually executes;
- no test touches the real production route;
- independent exact-head review is `APPROVE`;
- unresolved review threads = 0;
- branch is behind current `main` by 0;
- no provider credential persistence;
- no second PRIMARY writer;
- no automatic mutation/retry/rollback/redispatch/promotion;
- no M6 behavior.

Only after those implementation gates pass may the PR be considered for Ready status. Ready/merge still does not constitute a production execution instruction.
