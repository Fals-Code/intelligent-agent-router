# Local Run Ledger Persistence

This document describes the first durable backend for the frozen 9Router Run Ledger contract. It is intentionally local and single-writer. It does not replace the future durable Workflow Engine or a shared production database.

## Existing contract

The canonical record remains `RunLedgerRecord` from the control plane. The persistence layer does not introduce a second run schema. `RunLedger` continues to expose only append, get, and list operations, preserving append-only semantics.

## JSONL v1 format

`JsonlRunLedger` stores one envelope per UTF-8 line:

```json
{"schemaVersion":1,"record":{"runId":"..."}}
```

The version belongs to the persistence envelope, while the nested record remains the frozen control-plane contract. Unknown schema versions fail closed so a future migration cannot be interpreted silently.

## Explicit resource bounds

The caller must supply both `maxFileBytes` and `maxRecordBytes`; there are no hidden persistence-size defaults. Both values must be positive integers and `maxRecordBytes` cannot exceed `maxFileBytes`.

The backend checks the existing file against `maxFileBytes` when it opens, checks each loaded or new JSONL record against `maxRecordBytes`, and rejects an append before writing if it would exceed either bound. Reaching the file ceiling is therefore a fail-closed capacity signal. Rotation, archival, retention, or migration to a shared backend must be handled by a higher-level storage policy rather than silently deleting or overwriting ledger history.

## Guarantees in this backend

- explicit file path; no hidden default storage location
- explicit `maxFileBytes` and `maxRecordBytes`; no unbounded local persistence
- append-only API with duplicate `runId` rejection
- the existing evidence gate still rejects unsupported success claims
- records are cloned and deeply frozen before exposure
- each append is written synchronously and file `fsync` completes before the record is admitted to the in-process index
- restart/reopen rebuilds the index from the JSONL file
- malformed JSON, blank records, unsupported schema versions, malformed record shapes, evidence-invalid successful records, non-finite numeric metadata, and non-newline-terminated partial writes fail closed
- oversized existing ledgers, oversized records, and capacity-exceeding appends fail closed without a partial logical append
- observed file-size drift causes append to fail and requires the caller to reopen the ledger, preventing a stale local writer from silently continuing
- new files are opened with owner-only mode where the host platform honors POSIX file modes

## Security boundary

The backend persists the supplied control-plane record exactly. It does not attempt heuristic redaction because doing so would mutate evidence after collection. Producers must only place already-sanitized control metadata and evidence references in the ledger. Credentials, raw provider secrets, private payloads, and unrestricted command output do not belong in `RunLedgerRecord`.

The file-size drift check is a stale-writer guard, not a cryptographic tamper detector. Multi-process locking, integrity signing, encryption at rest, and distributed storage remain separate concerns.

## Deliberate non-goals

This slice does not provide:

- multi-process locking or distributed writer coordination
- a shared SQL/object-store backend
- cryptographic integrity signing or tamper-evident chaining
- encryption at rest, automatic rotation, archival, or retention policy
- durable Workflow Engine checkpoints or machine-restart orchestration
- automatic wiring from `ExecutionEngine`, OpenCode sessions, or the reference-slice scripts into the ledger
- OpenTelemetry export or Eval Plane storage

Those remain separate ownership boundaries. The next integration step should adapt completed workflow/runtime evidence into `RunLedgerRecord` and persist it through this backend without letting provider-native state become canonical 9Router state.
