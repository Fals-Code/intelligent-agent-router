# M4 Metric Taxonomy and M5 Controlled-Experiment Admission Gate

## Purpose

This slice closes the M4 measurement boundary without granting adaptive-routing authority. It standardizes the meaning of the metrics already produced by the Eval Plane, Eval History, execution projections, and reliability summaries, then evaluates whether two compatible evidence cohorts are sufficiently measured and sufficiently safe to be considered for a future controlled M5 experiment.

The gate does **not** start an experiment. It does not alter routing weights, model rankings, skill rankings, provider dispatch, workflow state, publication approval, or production traffic.

## Canonical metric taxonomy

`buildCanonicalMetricTaxonomy()` defines eight normalized metrics:

| Metric | Domain | Unit | Direction | Canonical source |
|---|---|---|---|---|
| `eval.weighted_score` | quality | ratio | higher is better | Eval Report |
| `eval.task_pass_rate` | quality | ratio | higher is better | Eval Report |
| `eval.critical_pass_rate` | quality | ratio | higher is better | Eval Report |
| `eval.baseline_pass_rate` | reliability | ratio | higher is better | Eval History |
| `execution.success_rate_excluding_cancelled` | reliability | ratio | higher is better | Run Ledger projection |
| `execution.cancellation_rate` | reliability | ratio | lower is better | Run Ledger projection |
| `execution.latency_ms` | efficiency | milliseconds | lower is better | Run Ledger projection |
| `execution.cost_usd` | efficiency | USD | lower is better | Run Ledger projection |

The taxonomy is SHA-256 content-addressed and fixed for this schema version. A caller cannot silently reverse a direction, rename a unit, or change the canonical source owner while retaining a valid taxonomy.

## Explicit policy, no hidden thresholds

`prepareM5AdmissionPolicy()` requires explicit thresholds for:

- minimum evaluation observation count;
- whether execution reliability is mandatory;
- whether every Eval Summary observation must have canonical execution provenance;
- minimum execution and decided execution sample counts;
- minimum latency and cost coverage;
- maximum tolerated coverage regression;
- maximum quality/baseline regressions;
- maximum execution-success regression and cancellation increase;
- optional absolute mean latency and cost increases.

No production defaults are frozen in this slice. The policy itself is content-addressed and bound to the exact metric taxonomy identity.

## Evidence precedence

The admission gate verifies every supplied summary before classification. Incompatible suite/baseline identities, execution summaries that reference observations outside the Eval cohort, or tampered content-addressed envelopes fail closed as errors rather than being converted into a softer admission status.

When evidence is structurally valid, classification precedence is:

1. `INSUFFICIENT_EVIDENCE` — minimum sample/coverage/provenance requirements are not met or a configured efficiency guard cannot be evaluated.
2. `MEASUREMENT_DRIFT` — the candidate remains above minimum sufficiency but its latency/cost/execution measurement coverage regresses beyond policy tolerance relative to the reference cohort.
3. `NOT_ELIGIBLE_FOR_CONTROLLED_EXPERIMENT` — evidence is sufficient and comparable, but one or more quality, reliability, latency, or cost guardrails regress beyond policy tolerance.
4. `ELIGIBLE_FOR_CONTROLLED_EXPERIMENT` — evidence is sufficient, measurement coverage is stable, and configured guardrails are satisfied.

These statuses deliberately separate missing evidence, telemetry/provenance drift, and actual candidate performance regression.

## Full canonical execution provenance

When `requireFullExecutionProvenance` is enabled, both cohorts must provide `ExecutionReliabilitySummary` evidence and its `observationIds` must match the corresponding `EvalCohortSummary.observationIds` exactly as a set.

This is the downstream bridge to the execution-projection boundary introduced before this slice: the reliability summary can only be built from Eval History observations carrying validated execution projections that were reconciled back to canonical Run Ledger identity, outcome, and projected resource metric values.

## Statistical boundary

“Evidence sufficiency” in this slice means deterministic minimum sample counts, decided execution counts, metric coverage, and cross-cohort coverage stability. It is **not** inferential statistical significance.

This slice does not implement confidence intervals, hypothesis tests, p-values, power analysis, causal claims, stochastic trial scheduling, bandits, reinforcement learning, or automatic policy adaptation.

A later M5 experiment layer may add inferential methods, but only behind a separate contract and explicit experiment authorization.

## Authority boundary

Every admission decision hard-codes:

- `controlledExperimentAutomaticallyAuthorized: false`
- `productionRoutingMutationAllowed: false`
- `automaticDispatchAllowed: false`

`experimentAdmissionEligible: true` means only that the evidence passed this admission screen. It is not an execution token and cannot authorize traffic mutation by itself.

## Non-goals

- no automatic routing-weight changes;
- no model/skill re-ranking;
- no production traffic allocation;
- no provider dispatch;
- no workflow transition;
- no experiment scheduler;
- no confidence interval or significance engine;
- no self-modifying policy;
- no universal provider billing ingestion;
- no change to Run Ledger, Eval History, or OpenTelemetry schemas.

## Next gate

After this slice is stable, the next coherent M5 step is a separate **controlled experiment contract**: immutable experiment definition, explicit authorization, bounded traffic/sample budget, deterministic rollback/stop conditions, shadow-first execution where possible, and evidence collection back into the existing Run Ledger/Eval History plane. Admission evidence must remain advisory until that separate authority boundary exists.
