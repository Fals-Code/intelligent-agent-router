# M5 Bounded-Live Side-Effect Recovery & Reconciliation

## Purpose

This gate closes the crash/restart uncertainty window introduced when a bounded-live publication or explicit reference restore may have reached an external sink but the 9Router durable side-effect journal does not yet contain a matching commit.

It is a reliability/recovery gate only. It does not add production traffic, a production sink, autonomous retries, adaptive routing, automatic rollback, or permanent candidate promotion.

## Core invariant

**Never infer success from process return state and never repeat an uncertain external side effect automatically.**

A recovery decision must correlate the durable bounded-live side-effect journal with sink-owned authoritative observation. The recovery layer is read-only: it emits content-addressed evidence and never publishes, restores, retries, or mutates the journal by itself.

## Recovery classifications

- `consistent_committed` — the durable journal already contains an exact `operation_committed` event; no sink probe is needed.
- `external_commit_observed` — the journal is unresolved, but the sink proves the exact reserved side effect already occurred. Do not repeat it. Explicit durable journal closure is required later.
- `explicit_retry_eligible` — an unresolved reservation exists and authoritative sink state proves the effect is absent. Retry is still an explicit operator action; `automaticRetryAllowed=false`.
- `manual_reconciliation_required` — sink state is unknown, drifted, unavailable, or a prior `operation_error` left uncertainty that cannot be cleared automatically.

All reports hard-code:

- `automaticRetryAllowed=false`
- `automaticMutationAllowed=false`

## Content-addressed report

`BoundedLiveSideEffectRecoveryCoordinator` emits `m5livereconcile:<sha-prefix>` bound to:

- exact durable journal event ID/type;
- operation ID and idempotency key;
- sink/authority/subject identities;
- sample/output hash when publication-specific;
- probe identity/status when used;
- external reference only when the sink proves the side effect;
- recovery classification and operator-action requirement.

The report can be independently re-verified with `verifyBoundedLiveSideEffectRecoveryReport`.

## Isolated sink probe

`IsolatedLoopbackBoundedLiveSinkClient` now also implements the recovery probe interface using GET-only `/state` inspection.

It remains restricted to `http://127.0.0.1`, validates that sink state contains no raw provider output, and returns only durable publication/restore facts. The probe never invokes `/publish` or `/restore`.

## Conservative error rule

A plain unresolved reservation plus authoritative absence may be `explicit_retry_eligible`.

A prior `operation_error` remains `manual_reconciliation_required` even when a later probe reports absence. The error means a side-effecting call was attempted and the control plane previously recorded its state as unknown; clearing that uncertainty requires a stronger explicit reconciliation step rather than automatic retry.

## Next proof gate

After CI and contract review, add a two-process isolated recovery harness that injects crash windows around:

1. durable reservation before sink call;
2. sink publication success before journal commit;
3. sink restore success before journal commit;
4. operation error / unknown state.

Process B must reopen state and prove that recovery does not duplicate publication or restore. Durable reconciliation closure should be a separate explicit authority, not an implicit side effect of inspection.
