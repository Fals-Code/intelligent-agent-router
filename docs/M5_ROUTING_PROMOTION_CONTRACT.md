# M5 Evidence-Bound Routing Promotion Contract

## Purpose

This slice implements Issue #40 as the next M5 authority boundary after bounded-live side-effect recovery. It allows 9Router to construct a verifiable routing-promotion proposal and a separately approved routing-promotion authorization from measured M5 evidence while preserving the frozen rule that **proposal/authorization is not routing mutation**.

The contract is provider-neutral. It does not know provider credentials, provider-native routing schemas, production traffic splitters, or live mutation APIs.

## Authority chain

The accepted chain is:

`verified M5 admission -> exact controlled experiment -> exact experiment authorization -> authoritative final progress -> re-derived final guardrail -> canonical Eval/Run Ledger cohorts -> complete bounded-live sample coverage -> fresh durable side-effect journal proof -> recovery/publication evidence -> route precondition snapshot -> routing promotion proposal -> separate R3/R4 promotion workflow approval -> routing promotion authorization`

No earlier artifact can be reinterpreted as mutation authority:

- `ELIGIBLE_FOR_CONTROLLED_EXPERIMENT` is not promotion authority.
- Controlled-experiment `allow` is not promotion authority.
- `ELIGIBLE_FOR_BOUNDED_LIVE` is not promotion authority.
- A bounded-live sample authorization or publication receipt is not promotion authority.
- Controlled-experiment `COMPLETE` is necessary but not sufficient.
- `PROMOTION_ELIGIBLE` is still only a proposal classification.
- A promotion authorization still hard-codes `automaticRoutingMutationAllowed=false`.

## Canonical final progress proof

`RoutingPromotionContext` carries the exact `ControlledExperimentProgressInput` that produced the final guardrail decision.

Before promotion evidence is accepted, the contract:

1. requires the final progress Eval and execution summaries to be exactly the canonical promotion cohorts;
2. re-runs `evaluateControlledExperimentGuardrails()` using the exact experiment, experiment authorization, admission decision, durable experiment workflow, and final progress;
3. exact-compares the re-derived decision with the supplied final guardrail decision;
4. content-addresses the final progress as `finalProgressSha256` inside the promotion proposal.

A caller therefore cannot turn a non-complete experiment into `COMPLETE` merely by changing and re-hashing the guardrail payload. Counters, summary identities, deltas, classification, reasons, and safety flags must all be reproduced by the authoritative guardrail evaluator.

## Canonical Eval and Run Ledger proof

Promotion does not accept arbitrary `run-ledger:*` or `eval-summary:*` strings as authority.

For both reference and candidate cohorts, the contract consumes canonical:

- Eval observations;
- Eval cohort summary;
- execution projections;
- Run Ledger records;
- execution reliability summary.

It rebuilds the Eval and execution summaries and exact-compares them to the supplied canonical summaries. Subject, suite, suite SHA-256, baseline, observation IDs, project identity, and admission summary identities must agree with the verified M5 admission decision.

Only after those checks pass are content-addressed Run Ledger and Eval references derived for the promotion proposal.

## Exact bounded-live sample coverage

Final progress counters are not accepted as standalone claims.

For every final live sample declared by `finalProgress.liveSamples`, `RoutingPromotionContext.publicationEvidence` must contain exactly one verified bounded-live sample authorization plus its exact durable publication/recovery evidence.

The verifier requires:

- `publicationEvidence.length === finalProgress.liveSamples`;
- candidate-assignment evidence count exactly equals `finalProgress.candidateLiveSamples`;
- reference-assignment evidence count exactly equals `finalProgress.liveSamples - finalProgress.candidateLiveSamples`;
- each sample ID and side-effect operation ID is unique;
- each live ordinal `0..liveSamples-1` appears exactly once through `liveSamplesBeforeDispatch`;
- `candidateLiveSamplesBeforeDispatch` forms the exact candidate-assignment progression;
- shadow counters never exceed authoritative final shadow progress and do not move backwards;
- every sample authorization is re-derived from its exact pre-dispatch guardrail, live R3/R4 workflow, durable approval IDs, experiment, experiment authorization, and admission decision.

Reference live assignments are therefore not ignored. They must appear explicitly in the same coverage set and are verified against the known-good reference subject. Candidate live assignments are verified against the candidate subject.

Missing, duplicated, or contradictory live-sample coverage is rejected before a proposal can become eligible.

## Fresh durable side-effect journal proof

A content-addressed receipt or recovery report is not enough to prove a committed side effect, and an already-open journal object's cached state is not freshness authority.

`RoutingPromotionContext` carries the canonical `JsonlBoundedLiveSideEffectJournal` identity, but promotion verification re-reads the journal file from disk for each proof pass. The fresh reader:

1. requires newline-terminated JSONL with no empty records;
2. validates schema version and contiguous sequence numbers;
3. re-runs `verifyBoundedLiveSideEffectEvent()` for every event;
4. re-validates reservation/terminal transition integrity and operation identity;
5. reconstructs the latest event per operation from the on-disk file;
6. derives unresolved operation IDs from that fresh snapshot;
7. fingerprints the exact journal bytes before bounded-live proof validation;
8. re-reads and re-hashes the file before the proof pass returns, rejecting any concurrent drift.

This closes the stale-reader gap: if another legitimate writer/reopened journal appends an unresolved operation after an older instance was opened, promotion sees the newer on-disk state and fails closed. If the journal changes while verification is running, the pass is rejected and must be repeated from fresh evidence.

Any unresolved durable side-effect operation makes the promotion classification `MANUAL_RECONCILIATION_REQUIRED`; automatic retry remains forbidden.

## Exact publication/recovery binding

Each relied-upon live publication must resolve to the exact current durable journal event for its operation.

The journal event, recovery report, authorization, and receipt must agree on the applicable:

- event ID and event type;
- operation ID;
- idempotency key;
- sink ID;
- sample authorization ID;
- selected reference/candidate subject;
- sample ID;
- output SHA-256;
- external publication reference;
- `sideEffectCommitEventId`.

For `consistent_committed`, the latest durable event must be `operation_committed`, and the exact publication receipt must match the authorization role. `candidateOutputExternallyVisible` must be true only for candidate assignments.

An auth-matching receipt/recovery object with no durable journal event is rejected. A same-subject publication under an unrelated authorization is rejected.

## Reference restore evidence

A completed reference restore is separately content-addressed and must bind the exact rollback authorization, experiment, reference subject, restore operation, idempotency key, sink, durable journal event, and recovery report.

Its presence makes permanent candidate promotion `PROMOTION_NOT_ELIGIBLE`. It is not automatic rollback authority.

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

`RoutingPromotionProposal` binds:

- project / route / capability;
- reference and candidate identities;
- M5 admission decision ID + SHA-256;
- controlled experiment ID + SHA-256;
- controlled-experiment authorization ID + SHA-256;
- experiment workflow;
- authoritative final progress SHA-256;
- re-derived final guardrail decision ID + SHA-256;
- canonical Run Ledger evidence references;
- canonical Eval evidence references;
- complete bounded-live sample authorization coverage;
- exact fresh durable side-effect journal event evidence;
- publication/recovery evidence;
- route precondition snapshot;
- reference -> candidate intent;
- rollback target equal to the reference subject;
- policy references and proposal time.

Classifications are:

- `PROMOTION_NOT_ELIGIBLE`;
- `PROMOTION_ELIGIBLE`;
- `MANUAL_RECONCILIATION_REQUIRED`.

Promotion eligibility requires all of the following:

1. authoritative final progress re-derives the exact final guardrail;
2. final guardrail classification is `COMPLETE`;
3. canonical Eval/Run Ledger evidence is exact and complete;
4. every final live sample is represented by one exact bounded-live authorization/operation proof;
5. candidate/reference live assignment counts exactly match final progress;
6. fresh durable journal evidence is present and stable for the proof pass;
7. every relied-upon side effect is durably `consistent_committed` with no pending operator action;
8. at least one exact committed candidate publication exists;
9. no committed reference-restore evidence is present;
10. the fresh durable journal has no unresolved side-effect operation;
11. the route precondition still points to the known-good reference subject.

## Separate promotion authorization

`RoutingPromotionAuthorization` requires a separate workflow from the controlled-experiment authorization workflow.

For `allow`, the workflow must be:

- same project as the proposal;
- risk class `R3` or `R4`;
- active;
- in `publish` phase;
- backed by durable approval IDs exactly equal to the authorization input.

The authorization binds:

- exact proposal ID + SHA-256;
- exact project/route/capability/reference/candidate scope;
- exact precondition snapshot ID + SHA-256;
- unchanged route revision;
- durable promotion workflow identity and risk class.

The same authorization cannot be reused for another route/capability or stale route state.

Even an allowed authorization records:

- `automaticRoutingMutationAllowed=false`;
- `automaticRollbackAllowed=false`;
- `automaticRetryAllowed=false`;
- `automaticRedispatchAllowed=false`.

Re-hashing an authorization with an automatic-action flag changed to `true` is rejected by semantic verification.

The authorization does not call a router adapter.

## Verified evidence conversion

The proposal and authorization can be translated to the existing `EvidenceRecord` boundary only through verified conversion functions. Those functions re-run exact proposal/authorization verification before creating deterministic-check or approval evidence.

No second Run Ledger or evidence database is introduced.

## Fail-closed invariants

- No evidence, no promotion eligibility.
- Missing authoritative final progress -> reject.
- Re-hashed `COMPLETE` not derived from final progress -> reject.
- Missing canonical Eval/Run Ledger provenance -> reject.
- Missing or duplicate final live-sample coverage -> reject.
- Candidate/reference live-assignment counter drift -> reject.
- Missing canonical durable side-effect journal event -> reject.
- Stale cached journal state is never authority; on-disk state is re-read.
- Journal drift during proof verification -> reject and require a fresh proof pass.
- Any unresolved durable journal operation -> manual reconciliation.
- Non-`COMPLETE` guardrail -> not eligible.
- Completed exact reference restore -> not eligible.
- Reference/candidate/project/route/capability drift -> reject.
- Stale route snapshot -> reject authorization.
- Re-using the experiment workflow for promotion authorization -> reject.
- Wrong risk class or workflow phase -> reject.
- Approval IDs not equal to durable workflow approvals -> reject.
- Automatic mutation/retry/redispatch/rollback flags cannot be forged true.
- Secret-like route/provider material is rejected before persistence.

## Explicit non-goals

This slice does not:

- mutate the live/production router;
- add a production routing adapter;
- change global model or skill rankings;
- add a traffic splitter;
- schedule autonomous experiments;
- automatically promote a candidate;
- automatically rollback;
- automatically retry or redispatch a side effect;
- implement bandits, reinforcement learning, self-modifying policy, or M6 behavior.

## Validation gate

Before readiness:

- exact changed-file scope remains frozen;
- `npm run check` PASS;
- `npm run eval` PASS;
- required Ubuntu and Windows CI PASS on exact HEAD;
- fresh independent review on exact HEAD;
- unresolved review threads = 0;
- no direct push/force-push to `main`.

## Next gate

After this contract passes required CI and independent review, the next separate gate is an **isolated/local bounded routing-mutation adapter with restart/recovery proof**. That future adapter must consume the exact promotion authorization and re-check the route precondition immediately before any side effect.
