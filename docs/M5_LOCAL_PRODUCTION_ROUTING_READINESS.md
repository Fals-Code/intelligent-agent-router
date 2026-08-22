# M5 Local-Production Routing Readiness Gate

## Purpose

This slice implements Issue #44 after the isolated routing mutation/restart-recovery proof merged in PR #43.

It does **not** add or execute a local-production routing mutation adapter. It defines a provider-neutral, content-addressed readiness contract that decides whether one exact local-production target and one exact adapter design are safe enough to proceed to a later implementation/rehearsal gate.

The frozen Architecture Contract remains authoritative: no evidence means no success; M5 routing may adapt only inside fixed safety policy; R4 production-impacting activity requires explicit human approval plus backup/rollback evidence; single-writer ownership remains the default; M6 autonomous self-optimization remains deferred.

## Authority chain

`verified isolated mutation/recovery capability -> exact local-production target snapshot -> credential/isolation proof -> backup/restore proof -> rollback rehearsal proof -> canonical Run Ledger + trace evidence -> readiness proposal -> independently verified current adapter/main source snapshot -> separate durable R4 approval -> readiness authorization`

A readiness authorization permits only a later **adapter implementation/rehearsal gate**.

It never grants production route mutation authority.

## Classification

The readiness proposal is classified as exactly one of:

- `NOT_READY`;
- `READY_FOR_LOCAL_PRODUCTION_ADAPTER_IMPLEMENTATION`;
- `MANUAL_RECONCILIATION_REQUIRED`.

`MANUAL_RECONCILIATION_REQUIRED` dominates when rollback rehearsal evidence is ambiguous and requires operator resolution.

## Local-production target snapshot

`LocalProductionRoutingTargetSnapshot` content-addresses one exact user-local production route boundary:

- installation identity;
- project/route/capability;
- current reference subject;
- route revision;
- canonical state owner;
- write boundary;
- persistence category;
- responsible runtime;
- restart-policy reference;
- policy references.

The snapshot hard-codes:

- `targetKind=local_production_router`;
- `singleWriterRequired=true`;
- `providerSpecificStatePersisted=false`;
- `rawProviderOutputPersisted=false`;
- `secretMaterialPersisted=false`.

The readiness layer stores no credential/token values and no provider-specific production schema.

## Current adapter/main source snapshot

`LocalProductionRoutingReadinessSourceSnapshot` is a separate content-addressed source authority presented at readiness authorization time. It binds:

- exact adapter identity and version;
- current adapter source SHA-256;
- current `main` source SHA-256;
- independent source-evidence references;
- explicit adapter-source verification state;
- explicit main-source verification state;
- observation timestamp.

Authorization preparation and verification both require this current source snapshot. They fail closed if the adapter identity/version, adapter source SHA, or `main` source SHA differs from the approved proposal, if either source is not verified, or if the source evidence predates the proposal. Reusing an old readiness authorization against changed source therefore fails and requires new readiness evidence plus R4 approval.

The source snapshot itself is provider-neutral and hard-codes `providerSpecificStatePersisted=false` and `secretMaterialPersisted=false`.

## Structural fail-closed boundary

Target snapshots, source snapshots, every evidence kind, readiness proposals, and readiness authorizations use explicit field allowlists. Unknown fields are rejected before a content-addressed artifact can be treated as valid.

This means adding an arbitrary/provider-specific/secret-bearing field and recomputing the artifact hash/id does not turn that modified object into valid readiness evidence. The core contract accepts only the frozen provider-neutral schema.

## Credential + isolation proof

Credential/isolation evidence binds only normalized scope identities and verifiable booleans. It must prove:

- the credential scope is independently verified;
- autonomous workers do not receive raw long-lived secrets;
- filesystem/network/write scope is bounded to the exact target;
- provider failure is contained at the adapter boundary;
- the canonical routing state retains one verified writer.

Any missing proof classifies the candidate `NOT_READY`. Broadened target/write scope or ambiguous multiple-writer ownership also classifies `NOT_READY`.

## Backup + restore proof

Backup readiness binds:

- backup identity + SHA-256;
- exact reference target snapshot SHA-256;
- exact restored state SHA-256;
- retention-policy reference;
- independent evidence references;
- backup-integrity and restore verification results.

A successful restore claim whose restored content address differs from the exact target reference snapshot is rejected, not downgraded to a warning. Missing or invalid backup integrity evidence prevents READY classification.

This slice performs no destructive cleanup.

## Rollback rehearsal proof

Rollback remains a separate safety boundary.

A readiness candidate can become READY only when a non-production rehearsal proves:

- the exact reference subject was restored;
- the exact reference route revision was restored;
- no duplicate side effect occurred;
- automatic rollback remains disabled.

A rehearsal that cannot be reconciled exactly classifies `MANUAL_RECONCILIATION_REQUIRED`. A `FAILED` rehearsal cannot become READY.

## Observability + Run Ledger proof

Readiness evidence must bind canonical successful R3/R4 Run Ledger records for the exact project and exact trace references.

The evidence explicitly records readiness for future attribution of:

- operator/human approval;
- adapter identity/version;
- before/after route state;
- sanitized operational result;
- trace identity.

Agent self-report is never accepted as proof.

## Proposal binding

`LocalProductionRoutingReadinessProposal` binds:

- exact promotion authorization/proposal/precondition;
- exact verified isolated mutation receipt;
- exact local-production target snapshot;
- credential/isolation evidence;
- backup/restore evidence;
- rollback rehearsal evidence;
- observability/Run Ledger evidence;
- exact adapter identity/version/source SHA-256;
- exact `main` source SHA-256 supplied to the contract;
- classification + reasons.

Proposal verification re-derives these bindings from the verified context. Project, route, capability, reference, candidate, route-revision, evidence, or provenance drift fails closed even when a caller recomputes the proposal hash.

All mutation authority flags are hard-coded false:

- `productionRoutingMutationAuthorized=false`;
- `automaticRoutingMutationAllowed=false`;
- `automaticRetryAllowed=false`;
- `automaticRollbackAllowed=false`;
- `automaticRedispatchAllowed=false`.

## R4 readiness authorization

`LocalProductionRoutingReadinessAuthorization` requires a separate exact R4 workflow at the approval/publish boundary and exact durable approval IDs.

An `allow` decision is valid only for a proposal classified `READY_FOR_LOCAL_PRODUCTION_ADAPTER_IMPLEMENTATION`.

The authorization binds the exact proposal, target snapshot, adapter identity/version/source SHA and main source SHA. Verification also compares those approved identities to the independently supplied current source snapshot.

Missing workflow state, missing/different durable approvals, stale approval timing, target drift, or source drift fails closed.

Even when `implementationReadinessAuthorized=true`, production mutation remains explicitly unauthorized.

## Freshness + drift

Authorization fails closed if the current local-production target no longer exactly matches the approved snapshot, including project/route/capability/reference subject/route revision.

Authorization also fails closed if the separately verified current adapter/main source snapshot no longer exactly matches the approved adapter identity/version/source SHA and `main` source SHA.

Proposal verification re-verifies the isolated mutation receipt and its durable journal. A stale in-memory journal reader therefore fails closed if a second writer changes durable classification after the reader opened.

Changing adapter source identity, `main` source identity, target snapshot, evidence content address, Run Ledger source, or durable R4 approval requires a new readiness artifact and authorization.

## Negative-first proof

The regression suite covers at minimum:

- clean READY path with R4 approval while production mutation remains unauthorized;
- credential/isolation weakness -> `NOT_READY`;
- manual rollback state -> `MANUAL_RECONCILIATION_REQUIRED`;
- `FAILED` rollback rehearsal -> `NOT_READY`;
- target revision drift before authorization;
- project/route/capability/reference/candidate/revision proposal drift with recomputed hashes;
- missing isolated mutation receipt and missing credential/backup/rollback evidence;
- missing/invalid backup integrity and exact backup/reference mismatch;
- secret-like material rejection;
- broadened credential/write scope and multiple-writer ambiguity -> `NOT_READY`;
- missing R4 workflow, missing/wrong/stale durable human approval;
- re-hashed production/automatic-authority forgery rejection;
- re-hashed provider-specific/unknown-field forgery rejection for evidence, proposal, authorization, and source snapshot;
- stale isolated journal reader after second-writer durable classification drift;
- adapter source identity drift against an existing authorization;
- current adapter source SHA drift, current `main` source SHA drift, and unverified current source against an old authorization.

## Non-goals

This slice does not:

- mutate the real local-production route;
- implement a real local-production writer/adapter;
- grant production mutation authority;
- grant automatic promotion, rollback, retry or redispatch;
- introduce multiple PRIMARY writers;
- add traffic splitting/global rankings;
- introduce provider credentials/schema into core contracts;
- add autonomous scheduling;
- implement bandits, RL, self-modifying policy or other M6 behavior.

## Validation gate

Before readiness of this PR:

- exact changed-file scope is frozen;
- `npm run check` passes;
- `npm run eval` passes;
- Ubuntu and Windows CI pass on the exact head;
- negative-first readiness tests actually execute;
- independent exact-head review approves;
- unresolved review threads = 0;
- no production/live route mutation occurs.

## Next gate

Only after this readiness contract is merged may a separate issue define a bounded **local-production adapter implementation + non-destructive rehearsal**. That later gate must still not infer permission for a real route apply from this readiness authorization alone.
