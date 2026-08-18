# Canonical Execution Metrics -> Eval History Projection

PR #32 connects real terminal execution measurements to the M4 Eval Plane without making Eval History or telemetry authoritative for workflow outcomes.

## Ownership

Canonical execution outcome remains owned by the immutable `RunLedgerRecord`. Eval History does not copy outcome state. Instead, projected measurement samples contain a `run-ledger:<runId>` source reference. Optional terminal observability evidence is independently verified and referenced as `observability:<eventId>`.

This preserves the existing ownership model:

- Run Ledger: canonical terminal execution/evidence record
- OpenTelemetry boundary: derived/read-only observability
- Eval History: durable measurement history
- comparative statistics: descriptive measurement only

None of these measurement components may mutate model ranking, skill ranking, workflow state, provider dispatch, publication approval, or Run Ledger outcome.

## Explicit metric mapping

`RunLedgerRecord.resourceMetrics` is provider-neutral and intentionally does not define magic cost/latency key names. `ExecutionMetricProjector` therefore requires an explicit projection policy:

- `latencyMetricKey` maps one Run Ledger metric to `latencyMs`
- `costMetricKey` maps one Run Ledger metric to `costUsd`
- `requireLatency` / `requireCost` can make missing samples fail closed
- `requireTerminalObservabilityEvent` can require a matching `9router.run.terminal` event

The projector never guesses a metric key. Sensitive-looking metric keys and negative/non-finite latency or cost values are rejected.

## Terminal observability binding

When a terminal observability event is supplied, it must pass the existing internal-event verifier and match the Run Ledger on:

- `runId`
- `projectId`
- `traceId`
- `runtimeId`
- terminal `outcome`

The event contributes provenance only. It cannot override the Run Ledger.

## Projection envelope

`ExecutionMetricProjection` is SHA-256 content-addressed and contains only normalized derived metadata:

- run/project/trace/runtime IDs
- canonical terminal outcome
- projected latency and/or cost
- exact Run Ledger metric-key mapping
- source references

It does **not** contain task text, workspace paths, provider output, raw patches, prompts, credentials, or evidence bodies.

`executionProjectionToEvalMeasurement()` converts the verified projection into the existing `EvalMeasurementSample`. The Eval History observation then carries:

- `latencyMs` and/or `costUsd`
- `run-ledger:<runId>`
- optional `observability:<eventId>`
- content-addressed `execution-metric:<projectionId>`

No Eval History schema migration is required.

## Execution reliability

`buildExecutionReliabilitySummary()` resolves the content-addressed projection references back to canonical Run Ledger records. Every observation must match exactly one projection and its matching Run Ledger identity/outcome.

Reliability is reported as separate terminal classes:

- succeeded
- failed
- cancelled

Cancellation is not silently counted as failure. Success/failure rates use only decided samples (`succeeded + failed`), while cancellation rate is reported separately over all samples. If every sample is cancelled, success/failure rates are `null` rather than fabricated.

`compareExecutionReliabilitySummaries()` produces candidate-minus-reference descriptive deltas only. It performs no significance test and grants no routing authority.

## Security and fail-closed rules

The slice fails closed when:

- Run Ledger validation fails
- required metric keys are absent
- latency/cost is negative or non-finite
- a required terminal observability event is absent
- terminal event identity/outcome differs from Run Ledger
- a projection digest is tampered
- an Eval History observation references zero or multiple execution projections
- projection, observation, and Run Ledger identity/outcome do not agree
- one projection is reused across multiple reliability observations

## Non-goals

This slice does not standardize all future `resourceMetrics` names, calculate provider billing, ingest external invoices, create statistical confidence intervals, infer causality, decide sample sufficiency, alter adaptive routing, or start M5 optimization.

A later M4/M5 admission slice may define metric-name conventions and statistical sufficiency criteria after enough real observations exist.
