# Evidence Bundle + GitHub Publish Boundary

This boundary makes 9Router evidence publishable without making GitHub a canonical control-plane owner.

It follows the frozen ownership model:

- Git/GitHub owns source history, branches, commits, issues and pull requests.
- 9Router owns workflow/run state, policy, evidence and evaluation.
- Run Ledger remains authoritative for terminal control-plane outcome.
- GitHub publication receipts are external references only.

## Why publication has two stages

The frozen workflow orders publication before terminal Run Ledger finalization:

`... -> review -> approval? -> publish -> terminal Run Ledger`

The current `RunLedger` implementation intentionally stores terminal records only. PR publication therefore cannot require an already-terminal Run Ledger without reversing the workflow contract.

PR #28 uses one stable bundle identity with two content-addressed stages:

1. `candidate` - built only from a running workflow in `publish`, after the risk-class evidence gate is satisfied. This stage can create or update a GitHub pull request.
2. `sealed_terminal` - created after terminal Run Ledger persistence. It preserves the same `bundleId`, records the candidate digest, adds the canonical Run Ledger SHA-256 and terminal outcome, and may attach post-publication CI evidence.

The terminal seal is published back to the existing PR as evidence. GitHub never decides workflow success.

## Publication candidate

`EvidenceBundleBuilder.createCandidate()` accepts the current publish-phase workflow and the normalized facts that will later enter Run Ledger.

The bundle contains:

- run/project/risk/attempt identity;
- SHA-256 of task text, not task text;
- SHA-256 of workspace path, not the local path;
- runtime/model/context/skills/toolset references;
- policy decisions and durable workflow approval IDs;
- normalized evidence records;
- bounded resource metrics;
- trace identity;
- optional source identity: repository, base/head Git object IDs, changed-file scope, diff byte count and diff SHA-256;
- optional CI references tied to the exact source head;
- optional artifact digests.

Raw source patches are not accepted by the bundle contract.

R0/R1 workflows cannot create an external GitHub publication candidate. R2-R4 candidates must pass the existing `EvidenceGate`; R3/R4 additionally require durable workflow approval IDs.

## Terminal seal

`EvidenceBundleBuilder.sealTerminal()` binds the candidate to a terminal `RunLedgerRecord`.

The seal verifies that the terminal record agrees with the candidate on:

- run/project/risk identity;
- task and workspace digests;
- runtime, model route and context compiler;
- skills/toolsets;
- policy decisions;
- durable approval IDs;
- change references;
- resource metrics;
- trace identity;
- evidence already published in the candidate.

The sealed payload adds:

- candidate SHA-256;
- canonical Run Ledger SHA-256;
- terminal outcome;
- SHA-256 of failure reason when one exists;
- merged CI and artifact digest references.

For a succeeded terminal run, any CI evidence included in the seal must itself be successful. Absence of CI does not invent a universal CI requirement; risk-specific evidence remains governed by the existing `EvidenceGate`.

## Content identity

The stable `bundleId` is derived from `runId + projectId + traceId`.

Each stage has its own `bundleSha256` calculated from canonical, key-sorted serialization of the stage payload. No wall-clock `sealedAt` field participates in the digest, so identical canonical inputs produce identical hashes.

## Security and disclosure

The publishable bundle deliberately excludes:

- raw task text;
- raw local workspace path;
- raw source diff/patch;
- credentials and bearer tokens;
- provider-native full state.

Secret-like metadata values are redacted. Identity references containing secret-like material fail closed instead of being silently rewritten into a different identity.

The bundle is bounded by caller-selected limits for total bytes, CI records, artifact digests and changed-file count.

## GitHub adapter

`GitHubPublishAdapter` has two explicit operations.

### `publishCandidate()`

- accepts only a verified `candidate` bundle;
- requires an explicit `PublicationAuthorization` bound to the exact run ID and bundle SHA-256;
- requires policy references and the exact durable approval-ID set represented by the bundle;
- creates or updates one PR through an injected `GitHubPublishClient`;
- performs no automatic retry;
- returns an external publication receipt only.

### `publishTerminalSeal()`

- accepts only a verified `sealed_terminal` bundle;
- requires a fresh authorization bound to the sealed bundle digest;
- adds one bounded terminal evidence comment to the existing PR;
- does not modify Run Ledger, workflow, runtime, approvals or source state.

The adapter itself owns no GitHub token. Credential acquisition/brokering remains outside this slice so long-lived credentials are not introduced into core publication code.

## Idempotency boundary

Requests contain deterministic idempotency keys derived from bundle identity + stage digest. They help an outer GitHub client recognize duplicate publication attempts, but PR #28 does **not** claim exactly-once GitHub side effects because no distributed transaction exists between GitHub and 9Router.

A failed GitHub call is surfaced directly and is not automatically repeated.

## Non-goals

PR #28 does not add:

- automatic merge or deployment;
- branch push/commit ownership;
- GitHub credential storage;
- publication-receipt persistence;
- automatic workflow success after PR creation;
- raw patch persistence;
- a second approval store;
- OpenTelemetry or Eval Plane behavior.

## Next gate

After this boundary is validated, the next slice is OpenTelemetry-compatible internal event/export plumbing correlated by `traceId`, `bundleId`, runtime/session identity and publication receipt references. Run Ledger remains authoritative. The following slice establishes the Eval Plane / golden-task baseline required for M4 measurement.
