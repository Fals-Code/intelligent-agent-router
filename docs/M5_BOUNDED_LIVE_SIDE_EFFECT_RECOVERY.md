# M5 Bounded-Live Side-Effect Recovery & Reconciliation

## Purpose

This gate closes the crash/restart uncertainty window introduced when a bounded-live publication or explicit reference restore may have reached an external sink but the 9Router durable side-effect journal does not yet contain a matching commit.

It is a reliability/recovery gate only. It does not add production traffic, a production sink, autonomous retries, adaptive routing, automatic rollback, or permanent candidate promotion.

## Core invariant

**Never infer success from process return state and never repeat an uncertain external side effect automatically.**

A recovery decision must correlate the durable bounded-live side-effect journal with sink-owned authoritative observation. The recovery layer is read-only: it emits content-addressed evidence and never publishes, restores, retries, or mutates the journal by itself.

## Crash / Restart Uncertainty Model & Recovery Classification Matrix

| Journal Event Type | Sink Probe Status | Subject / Hash Matching | Classification | Explicit Operator Action | Automatic Actions Allowed |
| --- | --- | --- | --- | --- | --- |
| `operation_committed` | Not Probed | N/A | `consistent_committed` | `false` | `false` |
| `operation_reserved` | `applied` | Match | `external_commit_observed` | `true` | `false` |
| `operation_reserved` | `applied` | Drift | `manual_reconciliation_required` | `true` | `false` |
| `operation_reserved` | `absent` (Authoritative) | N/A | `explicit_retry_eligible` | `true` | `false` |
| `operation_error` | `absent` (Authoritative) | N/A | `manual_reconciliation_required` | `true` | `false` |
| `operation_reserved` / `operation_error` | `unknown` / Probe Error | N/A | `manual_reconciliation_required` | `true` | `false` |

All reports hard-code:

- `automaticRetryAllowed=false`
- `automaticMutationAllowed=false`

## Semantic Verifier Invariants

The `verifyBoundedLiveSideEffectRecoveryReport` function enforces exact envelope and payload structure alongside strict semantic combination validation:
1. `consistent_committed`: requires `operation_committed` event type, `externalReference`, `explicitOperatorActionRequired=false`, and forbids probe fields (`probeId`, `probeStatus`).
2. `external_commit_observed`: forbids `operation_committed` event type, requires `probeId`, `probeStatus=applied`, `externalReference`, and `explicitOperatorActionRequired=true`.
3. `explicit_retry_eligible`: requires `operation_reserved` event type, `probeId`, `probeStatus=absent`, forbids `externalReference`, and requires `explicitOperatorActionRequired=true`.
4. `manual_reconciliation_required`: cannot encode `operation_committed`; requires `probeId`, `probeStatus`, and `explicitOperatorActionRequired=true`; forbids `externalReference`; and cannot encode `operation_reserved` + authoritative `absent`, which must instead classify as `explicit_retry_eligible`.

Digest or SHA-256 validity alone will never make a semantically forged report pass validation.

## Authoritative Absence Trust Boundary

Before a sink probe can emit `status=absent` with `authoritative=true`, `IsolatedLoopbackBoundedLiveSinkClient` verifies the complete durable state of the sink:
- Top-level schema version and flags (`rawOutputPersisted=false`).
- Structural completeness of all publication and restore entries.
- Validation of required identities, SHA-256 hashes, timestamps, and references.
- Strict uniqueness of idempotency keys and external references per side-effect type, plus restore active-subject consistency.
- Absolute prohibition of raw provider output persistence.

Any structural drift, malformed entity, duplicate idempotency key, or raw output persistence causes probe failure, placing recovery into `manual_reconciliation_required`.

## Two-Process Crash/Restart Topology & Proof

The isolated recovery proof scripts (`scripts/run-isolated-bounded-live-side-effect-recovery-proof.mjs` and `scripts/windows-isolated-bounded-live-side-effect-recovery-proof.ps1`) run distinct Node processes Process A (the crashing control plane) and Process B (the recovery inspector):

1. **Scenario 1 — Reserved Before Call**: Process A persists `operation_reserved` and crashes. Process B inspects sink state (`absent`), classifying `explicit_retry_eligible` with zero automatic actions or mutations.
2. **Scenario 2 — Publication Applied, Journal Commit Lost**: Process A applies publication to loopback sink and crashes before writing `operation_committed`. Process B probes sink (`applied`), classifies `external_commit_observed`, proving publication count remains exactly 1 with zero duplicate side effects.
3. **Scenario 3 — Reference Restore Applied, Journal Commit Lost**: Process A applies restore to loopback sink and crashes before writing `operation_committed`. Process B probes sink (`applied`), classifies `external_commit_observed`, proving restore count remains exactly 1.
4. **Scenario 4 — Operation Error / Unknown**: Process A records `operation_error` with unknown state. Process B probes sink (`absent`), but classifies `manual_reconciliation_required` due to prior recorded error uncertainty.
5. **Control Case — Already Committed**: Process B inspects `operation_committed`, returning `consistent_committed` with zero probe calls executed.

Sink durable state is preserved and proven across process restarts.

## Generated Evidence Invariants

A proof PASS outputs machine-readable evidence asserting:
- `processRestartProven == true`
- `journalReopened == true`
- `publicationDuplicateCount == 0`
- `restoreDuplicateCount == 0`
- `automaticRetryAllowed == false`
- `automaticMutationAllowed == false`
- `recoveryPostSideEffectCalls == 0`
- `committedPathProbes == 0`
- `rawProviderOutputPersisted == false`
- `productionRoutingMutationAllowed == false`
- `automaticRedispatchAllowed == false`
- `isolatedSinkLoopbackOnly == true`
- `gitHeadUnchanged == true`
- `workingTreeUnchanged == true`
- SHA-256 hashes of durable state evidence files.

## Retained Non-Goals

- No production-facing sink
- No production traffic
- No global production routing mutation
- No permanent candidate promotion
- No automatic retry or redispatch
- No automatic rollback
- No raw provider-output persistence

## Next Gate

`INDEPENDENT_BOUNDED_LIVE_SIDE_EFFECT_RECOVERY_REVIEW`
