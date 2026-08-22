# M5 First Bounded Local-Production Routing Apply Gate

## Status

This document starts the source-first implementation of Issue #48 after merged PR #47 / closed Issue #46.

The current branch implements only the **authority + final pre-write seal boundary**. It does **not** execute a production write, does not register a production writer, and does not claim the full Issue #48 execution/recovery gate is complete yet.

That sequencing is intentional: the first implementation step proves that an exact one-shot production mutation cannot even become write-eligible without a fresh evidence chain and a separate explicit execution approval.

## Frozen architecture constraints

The frozen Architecture Contract remains authoritative:

- no evidence, no success;
- R4 activity requires explicit human approval plus backup/rollback evidence;
- approvals are durable workflow state;
- writes must be attributable to run/tool/approval evidence;
- one canonical writer per state domain by default;
- provider-specific failures remain at adapter boundaries;
- long-lived unrestricted credentials do not reach autonomous workers;
- M5 may adapt only inside fixed safety policy;
- M6 remains deferred.

## Source-first findings

The implementation reuses the already-merged contracts instead of duplicating them:

1. `LocalProductionRoutingReadinessAuthorization` remains historical readiness evidence only. Its production mutation flag is still false.
2. `LocalProductionAdapterRehearsalReceipt` remains rehearsal proof only. It is re-verified against its historical authority, journal, clone, and read-only production fingerprint.
3. A fresh current target snapshot and fresh current adapter/main source snapshot are separate Issue #48 authorities.
4. The production target remains represented by `JsonFileLocalProductionReadOnlyTarget` in this initial slice.
5. The new Issue #48 boundary creates a separate one-shot R4 production-apply authorization and a later explicit `apply now` execution approval.
6. The final artifact in this first slice is a content-addressed pre-write seal with `productionWritePerformed=false`.

## Authority chain implemented in this first slice

`verified historical rehearsal receipt -> fresh current target/source snapshot -> fresh immutable production pre-fingerprint -> fresh backup evidence -> exact production-apply proposal -> durable R4 authorization -> separate explicit apply-now approval -> fresh live production re-fingerprint -> pre-write seal`

The pre-write seal is the stopping point in this branch stage.

No file write to the production route is performed after the seal.

## Backup evidence contract

`LocalProductionRoutingApplyBackupEvidence` binds:

- backup identity + SHA-256;
- exact production target identity;
- exact semantic state ID/SHA-256;
- exact raw production file SHA-256;
- retention policy reference;
- restore procedure reference;
- independent evidence references;
- `backupIntegrityVerified=true`;
- `restoreProcedureRehearsed=true`;
- `retainedForManualRecovery=true`;
- `automaticRollbackAllowed=false`.

Unknown/provider-specific fields fail closed.

This initial slice verifies backup evidence supplied by the trusted boundary. It does not yet add the later narrow backup writer/capture mechanism that the final Issue #48 implementation will require before execution.

## Production-apply proposal

`LocalProductionRoutingApplyProposal` binds one exact transition:

- historical readiness authorization identity/SHA through the rehearsal receipt;
- exact verified rehearsal receipt identity/SHA;
- fresh current target snapshot;
- fresh current adapter/main source snapshot;
- exact current production pre-fingerprint;
- exact reference subject + revision;
- exact candidate subject + candidate revision;
- exact fresh backup evidence;
- Run Ledger references;
- trace references;
- policy references.

The proposal hard-codes:

- `productionRoutingMutationAuthorized=false`;
- `automaticRoutingMutationAllowed=false`;
- `automaticRetryAllowed=false`;
- `automaticRollbackAllowed=false`;
- `automaticRedispatchAllowed=false`;
- `automaticPromotionAllowed=false`.

The candidate must differ from the exact current reference state.

## Fresh R4 production-apply authorization

`LocalProductionRoutingApplyAuthorization` is separate from both Issue #44 readiness authority and Issue #46 rehearsal evidence.

For an `allow` decision it requires:

- exact proposal verification;
- exact project-scoped R4 workflow;
- workflow phase `approval` or `publish`;
- active workflow status;
- approval IDs equal to durable workflow approval IDs;
- decision timestamp strictly after the final proposal snapshot.

Only this exact one-shot authorization may set `productionRoutingMutationAuthorized=true`.

It still hard-codes every automatic mutation/retry/rollback/redispatch/promotion flag false.

## Separate explicit execution approval

Implementation approval is not execution approval.

`LocalProductionRoutingApplyExecutionApproval` is an additional one-shot content-addressed artifact. It requires:

- an already-valid exact `allow` production-apply authorization;
- `explicitApplyNow=true`;
- a timestamp strictly later than the R4 production-apply authorization;
- the exact operation/proposal/authorization/target/pre-fingerprint/candidate binding.

This is the contract hook for the final operator confirmation required immediately before a future real apply.

No such live execution approval is created or used by this development task.

## Fresh pre-write seal

`prepareLocalProductionRoutingApplyPrewriteSeal()` verifies the complete chain again and then re-fingerprints the read-only production target.

The fresh live fingerprint must still match the exact proposal/authorization production pre-fingerprint, including raw bytes.

The resulting seal binds:

- exact deterministic operation ID;
- proposal + authorization;
- explicit execution approval;
- exact production target;
- exact semantic and raw-file fingerprint;
- exact current source snapshot;
- exact backup evidence;
- observation timestamp;
- `productionWritePerformed=false`;
- all automatic mutation flags false.

A stale or changed production file therefore fails before any future production writer could be reached.

## Initial negative-first coverage

The new tests currently prove:

- exact R4 authorization + explicit apply-now approval can produce a pre-write seal while production bytes remain unchanged;
- deny authorization cannot produce execution approval;
- R4 authorization predating the final proposal is rejected;
- `explicitApplyNow=false` is rejected;
- raw-byte production drift after authorization is rejected at the pre-write seal;
- provider-specific/unknown backup fields are rejected;
- automatic rollback authority in backup evidence is rejected;
- unverified fresh source evidence is rejected;
- a re-hashed attempt to forge automatic retry authority is rejected.

## Intended full Issue #48 scope

After source-first inspection, the intended branch scope is kept narrow around these files:

- `docs/M5_LOCAL_PRODUCTION_ROUTING_APPLY.md`;
- `src/evaluation/index.ts`;
- `src/evaluation/local-production-routing-apply.ts`;
- `tests/local-production-routing-apply-fixture.mjs`;
- `tests/local-production-routing-apply.test.mjs`.

The same source/test files may grow to add the remaining journal/writer/recovery/receipt phases. Scope expansion requires explicit re-inspection and re-freeze.

## Remaining implementation before Issue #48 can become Ready

This branch is **not Ready** yet. The following still must be implemented and reviewed before the PR may leave Draft:

1. a single narrow canonical production writer with physical target identity sealing;
2. fresh backup capture/integrity mechanics against isolated fixtures;
3. fsync-backed production apply reservation/commit journal;
4. one-write interruption and restart reconciliation;
5. fail-closed manual reconciliation on ambiguous/unreadable production after reservation/write;
6. final context-bound `APPLIED_VERIFIED` receipt;
7. the full Issue #48 mandatory negative-first matrix;
8. exact-head Ubuntu + Windows CI;
9. `npm run check` + `npm run eval`;
10. independent exact-head review;
11. zero unresolved threads and branch behind main = 0.

Even after that implementation PR eventually merges, **no real production apply occurs automatically**. A later execution step still requires fresh exact evidence and explicit operator instruction for that exact apply.
