# M5 Controlled Experiment Contract

This slice defines the evidence and authorization boundary between M4 measurement/admission and any future M5 experiment executor. It does not schedule work, allocate production traffic, call providers, or mutate routing.

## Definition boundary

A `ControlledExperimentDefinition` is immutable and SHA-256 content-addressed. It binds the exact eligible M5 admission decision to:

- project and risk class,
- reference and candidate subject identities,
- suite/baseline/taxonomy/admission-policy provenance,
- `shadow_only` or `shadow_then_bounded_live` exposure mode,
- explicit sample and live-traffic ceilings,
- deterministic stop conditions,
- a rollback policy reference and reference subject.

Every experiment is shadow-first. Bounded-live experiments require R3/R4 and a positive minimum shadow sample count. The definition itself always records `automaticDispatchAllowed=false` and `productionRoutingMutationAllowed=false`.

## Authorization boundary

Admission eligibility is not authorization. `ControlledExperimentAuthorization` must bind the exact experiment and admission digests to a WorkflowRun in `publish` phase after approval. An `allow` authorization requires an active workflow and approval IDs that exactly match the WorkflowRun approval IDs. Authorization is content-addressed and cannot grant automatic dispatch or production routing mutation.

The contract can emit an `approval` EvidenceRecord so the authorization identity can be referenced by the existing Run Ledger evidence plane. It does not append or mutate the Run Ledger itself.

## Guardrail boundary

`evaluateControlledExperimentGuardrails()` is deterministic and read-only. It verifies:

- exact experiment/admission/authorization/workflow binding,
- Eval cohort suite/baseline/subject identity,
- full execution-summary coverage of the corresponding Eval observation sets,
- shadow/live sample accounting,
- candidate live-traffic share,
- quality, baseline, execution success, failure, cancellation, latency, and cost stop conditions.

The evaluator emits one content-addressed classification:

- `CONTINUE_SHADOW`
- `ELIGIBLE_FOR_BOUNDED_LIVE`
- `CONTINUE_BOUNDED_LIVE`
- `STOP_REQUIRED`
- `ROLLBACK_REQUIRED`
- `COMPLETE`

`ELIGIBLE_FOR_BOUNDED_LIVE` is evidence only. It is not a dispatch token. `STOP_REQUIRED` and `ROLLBACK_REQUIRED` require an external orchestrator to stop or restore the reference route under a separately implemented execution adapter. `automaticRollbackAllowed` remains false in this slice.

## Budget semantics

For `shadow_then_bounded_live`:

- `maxTotalSamples` is an absolute experiment ceiling,
- `minimumShadowSamplesBeforeLive` must be positive,
- `maxLiveSamples` limits all live experiment observations,
- `maxCandidateLiveSamples` limits candidate live exposure,
- `maxCandidateTrafficBasisPoints` bounds candidate share of live observations.

The guardrail evaluator requires `shadowSamples + liveSamples` to equal the candidate Eval cohort observation count. Live exposure before the minimum shadow count, or traffic/sample exposure beyond contract, becomes a guardrail breach. If live exposure has already occurred, the classification is `ROLLBACK_REQUIRED`; otherwise it is `STOP_REQUIRED`.

## Evidence return

Both authorization and guardrail decisions can be converted to existing `EvidenceRecord` objects. This keeps the Run Ledger as the canonical terminal evidence plane and Eval History as the canonical measurement history. This slice creates no second experiment database.

## Non-goals

This PR intentionally does not implement:

- experiment scheduling,
- provider dispatch,
- traffic splitting infrastructure,
- automatic production route mutation,
- automatic rollback execution,
- a new approval store,
- bandits/RL,
- statistical significance testing,
- self-modifying policy.

## Next gate

A future slice may implement a bounded experiment executor/adaptor that consumes an explicitly authorized contract, starts shadow execution first, obeys these budgets and guardrail decisions, and writes resulting evidence back through the existing Run Ledger/Eval History boundaries. That executor must not reinterpret admission eligibility as execution authority.
