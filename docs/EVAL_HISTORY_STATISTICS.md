# Durable Eval History and Comparative Statistics

PR #31 extends the M4 measurement boundary introduced by the Golden Task Eval Plane. It does not add adaptive routing authority.

## Ownership

The Eval Plane owns measurement artifacts. Routing policy/model selection remains owned by the existing router and policy boundaries. Historical observations and statistical summaries are evidence for later decisions, not instructions that mutate routing.

## Durable history

`JsonlEvalHistory` is a local single-writer append-only JSONL store.

Each observation contains:

- a verified content-addressed `RoutingEvalReport`;
- the exact baseline definition used for that observation;
- the recomputed baseline comparison;
- canonical observation timestamp;
- optional normalized latency/cost measurements;
- mandatory source references whenever latency or cost is supplied.

Optional measurements never default to zero. Missing latency/cost is represented as unavailable.

Persistence properties:

- schema version 1;
- monotonic sequence numbers;
- SHA-256 content identity per observation;
- explicit file/observation/string/reference bounds;
- owner-only append open mode;
- fsync before in-memory admission;
- fail-closed replay for malformed JSON, unsupported schema, truncated final records, sequence gaps, digest mismatch, duplicate observations, baseline/report drift, and stale-writer file-size drift.

The backend is deliberately local and single-writer. It is not a distributed database and does not claim multi-process locking or consensus.

## Measurement source boundary

Quality and routing reliability come from the verified Eval Report and its baseline comparison.

`latencyMs` and `costUsd` are optional observations because PR #30 does not manufacture those metrics. When supplied, the caller must provide at least one bounded source reference such as a CI timing reference, Run Ledger/resource reference, or other canonical measurement evidence. Secret-like references are rejected.

## Comparative statistics

`buildEvalCohortSummary()` accepts observations for one exact:

- suite ID and SHA-256;
- baseline ID;
- subject ID.

It produces content-addressed descriptive statistics:

- weighted score: sample count, min, max, mean, p50, p95;
- task pass rate: sample count, min, max, mean, p50, p95;
- critical pass rate: sample count, min, max, mean, p50, p95;
- baseline pass rate and pass/fail observation counts;
- latency distribution when latency samples exist;
- cost distribution when cost samples exist.

`compareEvalCohorts()` requires the same suite identity and baseline. It reports candidate-minus-reference deltas. Positive quality/reliability deltas favor the candidate; positive latency/cost deltas mean slower/more expensive. If either cohort lacks a latency/cost dimension, that delta is `null` rather than zero.

## Statistical limits

This slice intentionally provides descriptive statistics only. It does not claim statistical significance, confidence intervals, causal attribution, or sufficient sample size for production routing changes.

## No adaptive authority

Neither durable history nor comparative summaries may:

- change model/skill rankings;
- modify routing weights;
- re-dispatch provider work;
- change workflow state;
- write Run Ledger success;
- approve publication;
- trigger bandits/RL/self-optimization.

Those actions remain outside M4 measurement. A future M5 gate must explicitly define evidence sufficiency, approval policy, rollback behavior, and safe adaptive boundaries before measurement can influence routing.
