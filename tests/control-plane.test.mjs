import test from "node:test";
import assert from "node:assert/strict";
import {
  CapabilityRegistry,
  EvidenceGate,
  InMemoryRunLedger,
  WorkflowStateMachine,
  assertAutonomousRunBounded,
  minimumControlsFor,
} from "../dist/control-plane/index.js";

function provider(id, capabilities, modes = ["read"]) {
  return {
    id,
    capabilities,
    modes,
    transports: ["native-api"],
    requiredPermissions: [],
    isolationRequirements: [],
    costProfile: { relativeTier: 1, quotaAware: true },
    contextProfile: { supportsSelectiveContext: true },
    sideEffectClass: modes.includes("write") ? "reversible" : "none",
    health: () => ({ status: "healthy", checkedAt: "2026-08-15T00:00:00.000Z" }),
    version: () => ({ version: "1.0.0", compatible: true }),
  };
}

function evidence(kind) {
  return {
    kind,
    status: "passed",
    reference: `${kind}:ref`,
    producer: "test-suite",
    collectedAt: "2026-08-15T00:00:00.000Z",
  };
}

function ledgerRecord(overrides = {}) {
  return {
    runId: "run-1",
    projectId: "project-1",
    task: "Implement a normal code change",
    riskClass: "R2",
    runtimeId: "opencode",
    modelRoute: ["openai-balanced"],
    contextCompilerVersion: "context-v1",
    skills: ["code-review"],
    toolsets: ["github"],
    workspace: "worktree/run-1",
    policyDecisions: ["isolated-worktree"],
    approvalIds: [],
    changeReferences: ["commit:abc"],
    evidence: [evidence("policy"), evidence("test"), evidence("review")],
    resourceMetrics: { inputTokens: 100, outputTokens: 20 },
    traceId: "trace-1",
    outcome: "succeeded",
    createdAt: "2026-08-15T00:00:00.000Z",
    ...overrides,
  };
}

test("capability registry orders PRIMARY, FALLBACK, then SHADOW", () => {
  const registry = new CapabilityRegistry()
    .registerProvider(provider("primary", ["code.interactive"], ["execute"]))
    .registerProvider(provider("fallback", ["code.interactive"], ["execute"]))
    .registerProvider(provider("shadow", ["code.interactive"], ["execute"]));

  registry
    .bind({ capability: "code.interactive", providerId: "shadow", role: "SHADOW", enabled: true })
    .bind({ capability: "code.interactive", providerId: "fallback", role: "FALLBACK", enabled: true })
    .bind({ capability: "code.interactive", providerId: "primary", role: "PRIMARY", enabled: true });

  assert.deepEqual(
    registry.routesFor("code.interactive").map((item) => item.providerId),
    ["primary", "fallback", "shadow"],
  );
});

test("single-writer rule rejects two PRIMARY writers for one canonical state domain", () => {
  const registry = new CapabilityRegistry()
    .registerProvider(provider("baserow", ["data.operational"], ["read", "write"]))
    .registerProvider(provider("teable", ["data.operational"], ["read", "write"]));

  registry.bind({
    capability: "data.operational",
    providerId: "baserow",
    role: "PRIMARY",
    canonicalWriteDomain: "dataset:inventory",
    enabled: true,
  });

  assert.throws(
    () =>
      registry.bind({
        capability: "data.operational",
        providerId: "teable",
        role: "PRIMARY",
        canonicalWriteDomain: "dataset:inventory",
        enabled: true,
      }),
    /Single-writer violation/,
  );
});

test("shadow provider may coexist without write authority conflict", () => {
  const registry = new CapabilityRegistry()
    .registerProvider(provider("baserow", ["data.operational"], ["read", "write"]))
    .registerProvider(provider("teable", ["data.operational"], ["read", "write"]));

  registry
    .bind({
      capability: "data.operational",
      providerId: "baserow",
      role: "PRIMARY",
      canonicalWriteDomain: "dataset:inventory",
      enabled: true,
    })
    .bind({
      capability: "data.operational",
      providerId: "teable",
      role: "SHADOW",
      canonicalWriteDomain: "dataset:inventory",
      enabled: true,
    });

  assert.equal(registry.primaryFor("data.operational")?.providerId, "baserow");
});

test("autonomous runs require explicit resource bounds without freezing numeric defaults", () => {
  assert.throws(
    () => assertAutonomousRunBounded({ maxRuntimeMs: 60_000 }),
    /Autonomous run policy is unbounded/,
  );

  assert.doesNotThrow(() =>
    assertAutonomousRunBounded({
      maxRuntimeMs: 60_000,
      maxToolCalls: 20,
      maxRetries: 3,
      maxContextTokens: 32_000,
      maxConcurrentSteps: 4,
    }),
  );
});

test("risk policy preserves explicit approval and rollback controls for high-impact classes", () => {
  assert.equal(minimumControlsFor("R0").mutationAllowed, false);
  assert.equal(minimumControlsFor("R3").explicitApprovalRequired, true);
  assert.equal(minimumControlsFor("R4").backupRollbackEvidenceRequired, true);
});

test("workflow approval is a durable state and success requires evidence gate", () => {
  const workflow = new WorkflowStateMachine();
  let run = workflow.create({ id: "wf-1", projectId: "project-1", riskClass: "R3", now: "2026-08-15T00:00:00.000Z" });
  run = workflow.start(run);
  run = workflow.advance(run);
  run = workflow.advance(run);
  run = workflow.advance(run);
  run = workflow.advance(run);
  run = workflow.requestApproval(run);

  assert.equal(run.status, "waiting_approval");
  assert.equal(run.phase, "approval");

  run = workflow.approve(run, "approval-1");
  assert.equal(run.phase, "publish");
  assert.deepEqual(run.approvalIds, ["approval-1"]);
  assert.throws(() => workflow.succeed(run, false), /Evidence gate must pass/);
  run = workflow.succeed(run, true);
  assert.equal(run.status, "succeeded");
});

test("evidence gate rejects agent self-report style success without required proof", () => {
  const gate = new EvidenceGate();
  const result = gate.evaluate("R2", [evidence("policy")]);
  assert.equal(result.passed, false);
  assert.deepEqual(result.missing, ["test", "review"]);
});

test("run ledger rejects successful records with missing evidence and stays append-only", () => {
  const ledger = new InMemoryRunLedger();

  assert.throws(
    () => ledger.append(ledgerRecord({ evidence: [evidence("policy")] })),
    /Evidence gate rejected successful run/,
  );

  ledger.append(ledgerRecord());
  assert.equal(ledger.list().length, 1);
  assert.ok(Object.isFrozen(ledger.get("run-1")));
  assert.throws(() => ledger.append(ledgerRecord()), /already exists/);
});
