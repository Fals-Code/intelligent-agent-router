import test from "node:test";
import assert from "node:assert/strict";
import { InternalObservabilityEventBuilder, ObservabilityProjector, verifyInternalObservabilityEvent } from "../dist/index.js";

const NOW = "2026-08-18T04:40:00.000Z";
function builder(overrides = {}) { return new InternalObservabilityEventBuilder({ maxEventBytes: 32 * 1024, maxAttributes: 32, maxLinks: 16, maxStringBytes: 2048, ...overrides }); }
function r2Ledger(overrides = {}) { return { runId: "run-v1", projectId: "project-1", task: "raw task not projected", riskClass: "R2", runtimeId: "opencode", modelRoute: ["9router/hemat"], contextCompilerVersion: "v1", skills: [], toolsets: [], workspace: "D:/raw/workspace", policyDecisions: [], approvalIds: [], changeReferences: [], evidence: [{ kind: "policy", status: "passed", reference: "policy:r2", producer: "policy", collectedAt: NOW }, { kind: "test", status: "passed", reference: "test:pass", producer: "tests", collectedAt: NOW }, { kind: "review", status: "passed", reference: "review:pass", producer: "reviewer", collectedAt: NOW }], resourceMetrics: {}, traceId: "trace-v1", outcome: "succeeded", createdAt: NOW, ...overrides }; }

test("internal observability events are deterministic, bounded and secret-sanitized", async () => {
  const input = { name: "9router.verification.completed", occurredAt: NOW, severity: "info", traceId: "trace-observe-1", runId: "run-observe-1", projectId: "project-1", attributes: { "router.verification.passed": true, "router.verifier.id": "verifier password=should-not-leak" }, links: [{ type: "runtime_session", reference: "runtime:opencode:ses-1" }] };
  const first = await builder().create(input); const second = await builder().create(input);
  assert.deepEqual(first, second); assert.match(first.eventId, /^obs:[0-9a-f]{32}$/); assert.equal(Object.isFrozen(first), true); assert.equal(Object.isFrozen(first.payload), true); assert.doesNotMatch(JSON.stringify(first), /should-not-leak/); assert.match(JSON.stringify(first), /redacted/); await verifyInternalObservabilityEvent(first);
});

test("internal event schema uses per-event allowlists and rejects raw/arbitrary payload attributes, secret identities, bounds and tampering", async () => {
  await assert.rejects(() => builder().create({ name: "9router.run.terminal", occurredAt: NOW, traceId: "trace-1", attributes: { "router.task": "raw task" } }), /not allowed/);
  await assert.rejects(() => builder().create({ name: "9router.run.terminal", occurredAt: NOW, traceId: "trace-1", attributes: { "router.note": "raw prompt smuggled through generic metadata" } }), /not allowed/);
  await assert.rejects(() => builder().create({ name: "9router.verification.completed", occurredAt: NOW, traceId: "trace-1", attributes: { "router.event.id": "caller-spoof" } }), /not allowed/);
  await assert.rejects(() => builder().create({ name: "9router.run.terminal", occurredAt: NOW, traceId: "authorization=Bearer top-secret" }), /secret-like material/);
  await assert.rejects(() => builder({ maxAttributes: 1 }).create({ name: "9router.run.terminal", occurredAt: NOW, traceId: "trace-1", attributes: { "router.run.outcome": "succeeded", "router.runtime.id": "opencode" } }), /exceed maxAttributes/);
  const event = await builder().create({ name: "9router.run.terminal", occurredAt: NOW, traceId: "trace-1", attributes: { "router.run.outcome": "succeeded" } });
  await assert.rejects(() => verifyInternalObservabilityEvent({ ...event, eventId: "obs:00000000000000000000000000000000" }), /eventId does not match/);
  await assert.rejects(() => verifyInternalObservabilityEvent({ ...event, unexpected: true }), /unknown field/);
});

test("projector maps runtime reconciliation without raw provider state or automatic redispatch claims", async () => {
  const projector = new ObservabilityProjector(builder());
  const event = await projector.runtimeReconciliation({ traceId: "trace-runtime-1", report: { workflowRunId: "run-runtime-1", recovery: { runId: "run-runtime-1", status: "running", phase: "execute", disposition: "reconcile_runtime", automaticResumeAllowed: false, runtimeReconciliationRequired: true, reason: "restart" }, binding: { workflowRunId: "run-runtime-1", projectId: "project-1", workflowAttempt: 1, runtimeId: "opencode", sessionId: "ses-1", workspace: "D:/raw/workspace/must-not-export", boundAt: NOW }, observation: { runtimeId: "opencode", sessionId: "ses-1", status: "completed", observedAt: NOW, events: { count: 4, types: ["message"], lastEventId: "evt-1", lastEventAt: NOW }, diff: { filesChanged: ["src/a.ts"], patchObserved: true } }, disposition: "verify_runtime_result", automaticRedispatchAllowed: false, verificationRequired: true } });
  assert.equal(event.payload.name, "9router.runtime.reconciled"); assert.equal(event.payload.attributes["router.runtime.status"], "completed"); assert.equal(event.payload.attributes["router.runtime.automatic_redispatch_allowed"], false); assert.equal(event.payload.attributes["router.runtime.files_changed_count"], 1); assert.equal(event.payload.attributes["router.runtime.diff_observed"], true); assert.deepEqual(event.payload.links, [{ type: "runtime_session", reference: "runtime:opencode:ses-1" }]); assert.doesNotMatch(JSON.stringify(event), /raw\/workspace/); assert.doesNotMatch(JSON.stringify(event), /src\/a\.ts/);
});

test("projector correlates verification, publication and canonical terminal Run Ledger through references", async () => {
  const projector = new ObservabilityProjector(builder());
  const verification = await projector.runtimeVerification({ traceId: "trace-v1", projectId: "project-1", verification: { workflowRunId: "run-v1", runtimeId: "opencode", sessionId: "ses-v1", verifierId: "deterministic-verifier", passed: true, evidence: [{ kind: "deterministic_check", status: "passed", reference: "verify:pass", producer: "deterministic-verifier", collectedAt: NOW }] } });
  assert.equal(verification.payload.attributes["router.verification.passed"], true);
  const publication = await projector.githubPublication({ traceId: "trace-v1", runId: "run-v1", projectId: "project-1", receipt: { adapter: "github", operation: "terminal_seal", repository: "Fals-Code/intelligent-agent-router", pullRequestNumber: 29, reference: "github:pr:29#evidence", externalId: "comment-1", bundleId: "9router-evidence:run-v1:abc", bundleSha256: "A".repeat(64), publishedAt: NOW } });
  assert.equal(publication.payload.attributes["router.publication.pull_request_number"], 29); assert.deepEqual(publication.payload.links, [{ type: "evidence_bundle", reference: "9router-evidence:run-v1:abc" }, { type: "publication", reference: "github:pr:29#evidence" }]);
  const terminal = await projector.runTerminal({ terminalAt: NOW, record: r2Ledger() });
  assert.equal(terminal.payload.attributes["router.run.outcome"], "succeeded"); assert.equal(terminal.payload.attributes["router.run.evidence_count"], 3); assert.doesNotMatch(JSON.stringify(terminal), /raw task/); assert.doesNotMatch(JSON.stringify(terminal), /raw\/workspace/);
});

test("terminal projector reuses canonical Run Ledger evidence validation instead of emitting fabricated success telemetry", async () => {
  const projector = new ObservabilityProjector(builder());
  await assert.rejects(() => projector.runTerminal({ terminalAt: NOW, record: r2Ledger({ evidence: [{ kind: "policy", status: "passed", reference: "p", producer: "p", collectedAt: NOW }] }) }), /Evidence gate rejected successful run/);
});
