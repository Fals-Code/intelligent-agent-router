# AGENTS.md

## Mission

Build and maintain a capability-aware AI agent router that selects the smallest reliable set of models, skills, tools, and verification steps for each prompt.

## Non-negotiable rules

1. Treat routing as a constrained optimization problem, not a prompt-keyword switch statement.
2. Keep provider model IDs outside routing logic. Use stable internal model IDs and environment configuration.
3. Hard-filter routes that violate modality, privacy, context, provider, risk, or tool constraints before scoring.
4. Every skill must declare capabilities, modalities, side effects, authentication, risk ceiling, cost, and latency.
5. Read-only and write-capable tools must remain distinguishable in code and traces.
6. Sensitive or destructive actions require an explicit approval step.
7. High-risk and complex tasks require verification by an equal or stronger reliability tier.
8. Never silently fall back to a less capable model for high-risk work.
9. Every routing change must include or update evaluation cases.
10. Preserve deterministic fallback behavior when semantic analysis is unavailable.

## Required workflow

1. Read `README.md`, `docs/ARCHITECTURE.md`, registries, routers, planner, and tests before changing behavior.
2. Identify whether the change affects task analysis, model selection, skill selection, planning, policy, or evaluation.
3. Update contracts first when the change introduces new metadata.
4. Add the smallest implementation that satisfies the contract.
5. Run `npm run check` and `npm run eval`.
6. Report changed routing behavior, regressions considered, and remaining limitations.

## Code standards

- TypeScript strict mode.
- No untyped tool payloads at orchestration boundaries.
- No provider-specific branching outside provider adapters and registries.
- Explain scoring changes with named weights and tests.
- Prefer reversible changes and explicit failure states.
- Do not commit `.env`, secrets, traces containing private prompts, or generated `dist/` output.
