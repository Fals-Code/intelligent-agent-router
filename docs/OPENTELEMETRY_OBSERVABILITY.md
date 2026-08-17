# OpenTelemetry Observability Boundary

PR #29 adds a versioned internal observability event schema and an OpenTelemetry export adapter without making telemetry canonical control-plane state.

## Frozen ownership

- Run Ledger remains authoritative for terminal control-plane decisions.
- Workflow checkpoints remain authoritative for workflow state.
- Runtime bindings/reconciliation remain authoritative for runtime recovery decisions.
- Evidence bundles remain publication snapshots derived from canonical state.
- OpenTelemetry is an export/observability boundary only.

Telemetry loss or exporter failure must not silently mutate workflow state, create success, trigger retry, or weaken evidence policy.

## Why 9Router keeps its own event schema

OpenTelemetry semantic conventions evolve independently from 9Router. The implementation therefore uses a small `InternalObservabilityEvent` schema and translates it at the adapter boundary.

The adapter deliberately avoids binding core contracts to provider-specific or rapidly evolving GenAI semantic-convention keys. It uses standard OpenTelemetry Resource/Span concepts, stable `service.name` on the Resource, a 9Router-owned `router.*` namespace for control-plane correlation, and an injected exporter client for SDK/OTLP/Collector transport details.

The internal `traceId` is exported as `router.trace.id`. PR #29 does not pretend an arbitrary existing 9Router trace identifier is a native OpenTelemetry trace ID. A future trace-context propagation slice may add real parent/child OTel context without changing the internal control-plane identity.

## InternalObservabilityEvent v1

Supported events:

- `9router.runtime.reconciled`
- `9router.verification.completed`
- `9router.publication.completed`
- `9router.run.terminal`

Every event is schema-versioned, content-addressed with SHA-256, bounded by event bytes/attribute count/link count/string bytes, timestamped by the source event rather than export time, and correlated through `traceId`, optional run/project IDs, scalar `router.*` attributes and typed references.

### Disclosure boundary

The schema rejects raw-payload attribute keys such as task, prompt, workspace, output, patch, body and content. Credential-like identity values fail closed. Secret-like scalar metadata values are redacted before event hashing.

Raw provider events, raw source patches, raw task prompts, local workspace paths and unrestricted credentials are not part of the event contract.

## Read-only projectors

`ObservabilityProjector` derives events from existing normalized state.

### Runtime reconciliation

Exports normalized disposition, workflow status/phase, runtime status, event/file counts, patch-observed boolean, verification-required flag and `automaticRedispatchAllowed=false`. It links to runtime/session identity but does not export local workspace path, raw provider history or patch content.

### Runtime verification

Exports verifier identity, pass/fail state, evidence count and runtime/session reference. Failed verification maps to error severity.

### GitHub publication

Exports adapter operation and PR number, with references to the evidence bundle and external publication receipt. It does not treat the GitHub receipt as workflow truth.

### Terminal Run Ledger

Exports terminal outcome/risk/runtime/evidence/approval/change-reference counts. The terminal source is first validated through the existing Run Ledger semantics. When a sealed terminal evidence bundle is supplied, the projector may link the bundle and Run Ledger digest after matching run/project/trace/outcome identity.

## OpenTelemetry adapter

`OpenTelemetryExportAdapter` maps one verified internal event to one OpenTelemetry-shaped request:

- Resource: `service.name`
- Instrumentation scope: default `9router.observability`
- one `INTERNAL` span named after the internal event
- `router.*` correlation attributes
- typed 9Router references represented as span events named `9router.reference`

Canonical envelope attributes are written after event attributes so a caller cannot spoof event/run/project/trace identity in the exported span.

The injected `OpenTelemetryExportClient` owns SDK/OTLP transport, batching, authentication, Collector connectivity and backend selection. Core code does not import a specific OpenTelemetry SDK package.

## Status mapping

- error severity -> `ERROR`
- deterministic verification PASS -> `OK`
- deterministic verification FAIL -> `ERROR`
- terminal succeeded -> `OK`
- terminal failed -> `ERROR`
- otherwise -> `UNSET`

This is observability status only. It never updates workflow or Run Ledger status.

## Failure behavior

The adapter verifies event integrity before any exporter call, enforces an explicit export-byte bound, performs one exporter call, performs no automatic retry, returns only an export receipt/reference, and propagates exporter failure to the caller.

A Collector/backend outage is observability infrastructure failure, not permission to re-run agent work or change canonical state.

## Explicit non-goals

PR #29 does not add an OpenTelemetry Collector deployment, a specific OTel SDK dependency, native OTel trace-context propagation, metrics aggregation, persistent telemetry storage, telemetry-driven routing changes, Eval Plane/golden-task scoring, or automatic workflow mutation after exporter failure.

## Next gate

PR #30 should build the Eval Plane / golden-task baseline from canonical Run Ledger + evidence bundle + normalized telemetry references. Adaptive routing remains deferred until measurements are sufficiently useful and safety policy remains invariant.
