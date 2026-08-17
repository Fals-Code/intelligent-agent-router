# Evidence Bundle + GitHub Publish Boundary

This layer turns an already-terminal 9Router Run Ledger record into a bounded, sanitized, immutable publication snapshot and then allows GitHub to publish only that sealed snapshot through an explicit policy/approval gate.

It does **not** make GitHub a canonical state owner.

## Ownership

- `RunLedgerRecord` remains the canonical terminal audit record.
- `EvidenceBundleBuilder` creates a publishable snapshot from that record plus source/CI/artifact evidence supplied by the caller.
- `GitHubPublishAdapter` is an output adapter only. It receives a sealed bundle and explicit publication authorization.
- GitHub comments are publication receipts, not workflow truth and not Run Ledger replacements.

The adapter has no workflow checkpoint store, runtime adapter, approval store, Run Ledger writer, or execution engine dependency.

## Evidence bundle contents

Schema version 1 contains:

- sanitized terminal Run Ledger snapshot;
- SHA-256 of the canonical Run Ledger record;
- runtime/deterministic verification evidence already present in the Run Ledger;
- canonical workflow approval IDs and approval evidence already present in the Run Ledger;
- optional source diff identity: repository, base/head Git object IDs, changed-file scope, diff byte count, and SHA-256;
- optional GitHub CI records tied to the exact source head;
- optional artifact digests, such as durable JSONL proof files;
- SHA-256 sealing the complete bundle envelope.

Raw source patches are deliberately excluded from the bundle contract. The source diff is represented by scope and digest so publication does not become a new secret-bearing patch store.

## Canonical validation

The builder first admits the supplied Run Ledger record through `InMemoryRunLedger`. It therefore reuses the existing structural validation and `EvidenceGate` requirements rather than inventing a second success definition.

The builder also:

- requires explicit collection and byte bounds;
- normalizes and deduplicates changed-file scope;
- requires CI commit identity to match the source head when source evidence is attached;
- validates SHA-256 and Git object identifiers;
- rejects duplicate CI run identities and artifact names;
- redacts common Bearer and credential key/value patterns before publication data is sealed;
- deep-freezes the completed bundle.

The Run Ledger SHA-256 is calculated from the canonical Run Ledger record before publication sanitization. The bundle SHA-256 is calculated from the sanitized publication envelope.

## Publication authorization

`PublicationAuthorization` binds policy approval to:

- exact `runId`;
- exact sealed `bundleSha256`;
- an explicit `allow` or `deny` decision;
- decision actor and timestamp;
- one or more policy references;
- the exact set of workflow approval IDs already recorded in the Run Ledger.

A deny decision never calls GitHub.

For R3/R4 publication, durable workflow approval IDs are mandatory. The adapter also requires authorization approval IDs to exactly match the bundle's canonical approval IDs. It does not accept a fabricated approval ID that is absent from the Run Ledger.

R0-R2 publication may be policy-authorized without workflow approval IDs when the canonical workflow itself has none.

## GitHub adapter behavior

The first adapter target is a pull-request comment.

The adapter:

1. validates `owner/name` and pull-request identity;
2. validates publication authorization against the sealed bundle;
3. renders a bounded Markdown evidence summary;
4. performs exactly one `GitHubPublishClient.createPullRequestComment()` call;
5. returns a publication receipt containing the external comment identity/reference and sealed bundle SHA-256.

The client receives an idempotency key derived from run ID + bundle SHA-256, but the adapter does **not** claim exactly-once publication because GitHub comment creation itself may not provide an atomic idempotency guarantee.

A failed GitHub call is surfaced directly. The adapter does not automatically retry publication.

## Public Markdown scope

The rendered comment includes:

- bundle and Run Ledger SHA-256;
- run outcome/risk/runtime/trace identity;
- source base/head, diff digest, and changed-file scope;
- verification evidence references;
- attached CI run conclusions;
- approval IDs;
- artifact digests.

It intentionally does not render the Run Ledger task text or workspace path, reducing accidental exposure of local paths or sensitive task context.

## Explicit non-goals

This PR does not add:

- automatic GitHub publication from workflow success;
- a GitHub App/token implementation inside core;
- durable publication receipt persistence;
- publication retries;
- PR merge, branch push, release creation, issue creation, or deployment;
- raw patch persistence;
- richer durable approval actor/reason records that do not yet exist in the canonical workflow contract;
- OpenTelemetry or Eval Plane integration.

Those should remain separate slices.

## Next gate

After the evidence bundle and GitHub publication contract are validated, the next recommended slice is an observability boundary: OpenTelemetry trace/span export plus Eval Plane correlation using existing `traceId`, Run Ledger, evidence bundle digest, runtime/session identity, and publication receipt references without making telemetry canonical workflow state.
