# Eval Plane + Golden Task Baseline

PR #30 establishes the first **M4 (Measured)** evaluation boundary for 9Router.

The purpose is measurement, regression detection, and reproducible evidence. It does **not** give the Eval Plane authority to mutate routing, retry provider work, change workflow state, or silently promote/demote models.

## Ownership boundary

The frozen ownership model remains unchanged:

- routing/model/skill selection is owned by the router and policy layers;
- workflow and Run Ledger remain canonical control-plane state;
- observability remains derived/export-only;
- the Eval Plane consumes normalized router decisions and produces measurement artifacts;
- baseline failure is a gate/signal, not permission for self-modification.

PR #30 intentionally stops before M5 adaptive routing.

## Golden Task Suite v1

`GoldenTaskSuite` is a versioned, content-addressed definition of synthetic evaluation tasks.

The first supported task kind is `routing`.

Each task contains:

- stable task ID;
- synthetic prompt checked for secret-like material and explicit byte bounds;
- `critical` marker;
- minimum task score;
- one or more weighted deterministic assertions.

The v1 routing assertions are:

- `primary_model_equals`;
- `selected_skills_include`;
- `requires_verification_equals`.

The suite is normalized before hashing. Duplicate task/assertion IDs, unsupported fields, invalid weights, oversized prompts/collections, malformed expectations, and secret-like material fail closed.

The committed seed suite is:

`evals/golden-routing-v1.json`

It migrates the original six routing cases rather than creating a second overlapping set of expectations.

Its canonical SHA-256 is bound by the M4 baseline, so changing any task, prompt, assertion, weight, criticality, or threshold requires an explicit baseline decision.

## Routing Eval Report v1

`RoutingEvalPlane.evaluate()` runs the suite serially against an injected `RoutingEvalSubject`.

The report stores only normalized routing facts needed for measurement:

- primary model ID;
- sorted selected skill IDs;
- `requiresVerification`;
- assertion pass/fail and weights;
- per-task score/pass state;
- aggregate weighted score, task pass rate, critical pass rate, and task counts.

The report deliberately excludes:

- raw provider responses;
- model output text;
- execution output;
- workspace/source patch data;
- credentials;
- the router's random trace ID.

Excluding random trace identity keeps the report content-addressable for the same suite and normalized routing behavior.

The report is SHA-256 addressed and bounded by `maxReportBytes`.

## Baseline v1

`EvalBaselineDefinition` binds a regression gate to:

- exact `suiteId`;
- exact `suiteSha256`;
- exact evaluation subject ID;
- minimum aggregate weighted score;
- minimum task pass rate;
- minimum critical-task pass rate;
- maximum failed task count.

The first baseline is:

`evals/baselines/routing-m4-v1.json`

It is intentionally strict (`1.0` scores and zero failed tasks) because it formalizes behavior that the previous six-case harness already required to pass.

A suite digest mismatch is not treated as an ordinary score regression. It fails closed as a baseline identity mismatch, forcing an explicit review when the golden set changes.

## CLI / CI behavior

`npm run eval` now:

1. builds the project;
2. loads and validates the golden suite with explicit resource bounds;
3. loads the exact M4 baseline;
4. routes each synthetic task through `IntelligentAgentRouter`;
5. creates a content-addressed eval report;
6. compares the report with the baseline;
7. prints bounded normalized measurement details;
8. exits non-zero on baseline regression.

The output does not print the synthetic prompts or router trace IDs.

The normal CI workflow already executes `npm run eval` on Ubuntu and Windows, so this becomes the first cross-platform M4 regression gate without adding a new CI service.

## Critical-task semantics

Critical tasks do not receive hidden scoring bonuses. They are measured normally and also contribute to the independent `criticalPassRate` gate.

This keeps the measurement explainable: a critical security/research routing regression cannot be masked by high scores on low-impact tasks.

## What this baseline does not prove

Passing the first six golden tasks does not prove global routing quality. It proves only that the committed baseline behavior remains intact for this synthetic suite.

PR #30 does not yet add:

- large-scale benchmark storage;
- stochastic repeated trials;
- confidence intervals or significance testing;
- pairwise model judging;
- human-label workflows;
- live provider quality/cost/latency experiments;
- automatic route-weight updates;
- bandits, reinforcement learning, or self-modifying policy;
- Eval Plane authority over workflow success.

Those are later measurement/adaptation slices and must remain evidence-driven.

## Next gate

After this baseline is stable, the next coherent measurement slice is to expand the Eval Plane with **historical evaluation result persistence + comparative/statistical summaries** (quality/cost/latency/reliability) while still keeping routing changes reviewable and policy-gated.

Only after sufficient measurement evidence exists should M5 adaptive routing begin.
