# v0.1.1 Release-Evidence Artifact Identity Verifier

## Scope

Issue #50 adds one narrow stabilization primitive: deterministic, read-only, offline-capable, byte-exact verification of supplied release-evidence artifacts.

The core verifier does **not** call GitHub, does not require network access, does not mutate the repository, does not create or move tags/releases, does not modify supplied artifacts, and does not authorize production routing.

A verifier `PASS` means only this:

> every required artifact in the supplied manifest was read from the bounded verification root and its exact byte length and SHA-256 digest matched the expected identity.

It does **not** independently prove that a Git tag, Git commit, or Git tree exists. Those identities remain explicitly represented as `DECLARED_NOT_VERIFIED`. Artifact equality, tree equality, and commit identity are separate claims and must never be promoted into one another.

## Input contract

The verifier accepts a verification root plus a JSON manifest using schema version `1`:

```json
{
  "schemaVersion": 1,
  "release": {
    "tag": "v0.1.0",
    "commitSha": "<40-hex-git-commit-id>",
    "treeSha": "<40-hex-git-tree-id>"
  },
  "artifacts": [
    {
      "name": "ubuntu-check",
      "path": "ci/ubuntu-check.json",
      "sha256": "<64-hex-sha256>",
      "bytes": 1234
    }
  ]
}
```

Schema v1 is intentionally closed-world: unknown fields, malformed identity values, duplicate artifact names, duplicate artifact paths, or an empty artifact set fail closed.

Artifact paths are untrusted input and must be portable root-relative paths. Absolute paths, `..`, `.`, backslashes, drive-colon forms, empty path segments, control characters, trailing-space segments, trailing-dot segments, and Windows-invalid filename characters (`<`, `>`, `"`, `|`, `?`, `*`) are rejected. Each path segment also rejects the Windows reserved device basenames `CON`, `PRN`, `AUX`, `NUL`, `COM1` through `COM9`, and `LPT1` through `LPT9`, case-insensitively and including extension forms such as `CON.json` or `nested/LPT9.proof`. Ordinary names that only contain those strings, such as `console.json`, `auxiliary.txt`, or `company1.log`, remain valid. Artifact paths are case-insensitively unique so the same manifest has unambiguous behavior on Windows and Ubuntu.

The verifier rejects direct symbolic-link artifacts. It also resolves the real artifact path before reading bytes, so a parent-directory symlink or junction cannot make an outside-root artifact PASS even when the outside artifact's bytes and digest exactly match the manifest.

## Output contract

The result is deterministic JSON with:

- `overall`: `PASS` or `FAIL`;
- `scope`: always `ARTIFACT_IDENTITY_ONLY`;
- `mode`: always `OFFLINE_READ_ONLY`;
- separate declared tag, commit, and tree identities;
- one per-artifact byte-identity result;
- expected and actual SHA-256 / byte count when available;
- stable machine-readable failure reason codes.

No timestamp is emitted by the core verifier. Re-running identical immutable inputs therefore yields equivalent output.

The verifier never emits raw artifact content.

## CLI

Build first, then invoke the offline wrapper with exactly two arguments:

```text
node scripts/verify-release-evidence-artifacts.mjs <verification-root> <manifest.json>
```

The wrapper writes exactly one JSON result line to stdout. Exit code `0` means `PASS`; exit code `1` means fail-closed verification or invalid invocation/input. Invalid CLI arguments, malformed manifest JSON, and unreadable manifest input each have stable machine-readable reason codes. Subprocess tests also verify that identical valid invocations produce byte-identical stdout and that raw artifact-content sentinels never appear in stdout or stderr.

The wrapper uses only local filesystem reads plus the compiled core verifier. GitHub/API/network access is not part of the verification path. The offline acceptance test preloads fail-fast tripwires for global `fetch`, `node:http` / `node:https` request functions, `node:net` connections, and `node:tls` connections; a valid local fixture must still PASS with exit `0` and zero tripwire hits.

## Filesystem containment evidence

Behavioral tests cover the containment boundary directly:

- a direct artifact symlink fails with `ARTIFACT_SYMLINK_FORBIDDEN`;
- a parent-directory symlink or Windows junction resolving outside the verification root fails with `ARTIFACT_PATH_ESCAPES_ROOT`;
- an outside-root artifact cannot PASS through path indirection even when its bytes and digest are exact;
- an ordinary nested regular file inside the verification root PASSes.

Symlink creation is treated as required test capability. If the execution environment cannot create the required link/junction, the test reports an explicit `SYMLINK_TEST_ENVIRONMENT_LIMITATION` failure rather than silently converting missing evidence into PASS.

## Failure semantics

Representative reason codes include:

```text
CLI_ARGUMENTS_INVALID
MANIFEST_INPUT_UNREADABLE
MANIFEST_JSON_INVALID
INVALID_MANIFEST
DUPLICATE_ARTIFACT_NAME
DUPLICATE_ARTIFACT_PATH
INVALID_ARTIFACT_PATH
VERIFICATION_ROOT_UNAVAILABLE
ARTIFACT_MISSING
ARTIFACT_NOT_REGULAR_FILE
ARTIFACT_SYMLINK_FORBIDDEN
ARTIFACT_PATH_ESCAPES_ROOT
ARTIFACT_READ_FAILED
ARTIFACT_BYTES_MISMATCH
ARTIFACT_SHA256_MISMATCH
SHA256_UNAVAILABLE
```

Missing or unavailable evidence is never converted to zero and never inferred as a pass.

## Frozen boundaries

This implementation does not revise Architecture Contract v1.0. It does not change the immutable v0.1.0 tag, release SHA, release tree, or frozen release artifacts. It does not grant or exercise production-apply authority.

Explicitly out of scope here: compatibility admission, Tool Broker ACI expansion, realistic-task campaign work, OpenHands, VoltAgent, Penpot, Excalidraw, Hermes, OpenClaw, n8n, AppFlowy, Baserow, Teable, Appsmith, Cal.diy, broad multi-agent orchestration, M6 autonomy, bandit/RL adaptive routing, and real production apply.
