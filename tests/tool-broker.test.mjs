import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryToolSource, ToolBroker } from "../dist/index.js";

function descriptor(id, overrides = {}) {
  return {
    id,
    sourceId: "source-a",
    providerToolName: id,
    title: id,
    description: `Tool ${id}`,
    capabilities: [id],
    mode: "read",
    sideEffectClass: "none",
    riskCeiling: "R4",
    requiredPermissions: [],
    providerPermissions: [id],
    idempotency: "safe",
    ...overrides,
  };
}

function sourceWith(tools, handlers = {}, options = {}) {
  return new InMemoryToolSource({
    sourceId: options.sourceId ?? "source-a",
    tools,
    handlers,
    health: options.health,
    version: options.version,
  });
}

async function grantFor(broker, toolId, overrides = {}) {
  const result = await broker.select({
    riskClass: "R2",
    requestedToolIds: [toolId],
    allowedPermissions: ["*"],
    allowMutations: true,
    maxTools: 4,
    ...overrides,
  });
  assert.equal(result.grants.length, 1);
  return result.grants[0];
}

test("Tool Broker exposes the smallest capability set instead of the whole catalog", async () => {
  const tools = [
    descriptor("repo.read", { capabilities: ["repository.read"] }),
    descriptor("repo.search", { capabilities: ["repository.read", "repository.search"] }),
    descriptor("browser.verify", { capabilities: ["browser.verify"] }),
    descriptor("repo.write", {
      capabilities: ["repository.write"],
      mode: "write",
      sideEffectClass: "reversible",
      requiredPermissions: ["repo:write"],
    }),
  ];
  const broker = new ToolBroker().registerSource(sourceWith(tools));
  const selection = await broker.select({
    riskClass: "R0",
    requiredCapabilities: ["repository.read", "repository.search"],
    allowedPermissions: ["repo:read"],
    allowMutations: false,
    maxTools: 2,
  });

  assert.deepEqual(selection.grants.map((grant) => grant.tool.id), ["repo.search"]);
  assert.equal(selection.discoveredToolCount, 4);
  assert.equal(selection.exposedToolCount, 1);
  assert.deepEqual(selection.uncoveredCapabilities, []);
});

test("R0 never exposes mutation tools even when caller asks for them", async () => {
  const writeTool = descriptor("repo.write", {
    capabilities: ["repository.write"],
    mode: "write",
    sideEffectClass: "reversible",
  });
  const broker = new ToolBroker().registerSource(sourceWith([writeTool]));
  const selection = await broker.select({
    riskClass: "R0",
    requestedToolIds: ["repo.write"],
    allowedPermissions: ["*"],
    allowMutations: true,
    approvalGranted: true,
    maxTools: 1,
  });

  assert.equal(selection.grants.length, 0);
  assert.deepEqual(selection.missingRequestedToolIds, ["repo.write"]);
  assert.equal(selection.rejections[0].reason, "mutation_not_allowed");
});

test("R3 mutation requires durable approval before a tool can be granted", async () => {
  const tool = descriptor("schema.write", {
    mode: "write",
    sideEffectClass: "reversible",
    requiredPermissions: ["db:schema:write"],
  });
  const broker = new ToolBroker().registerSource(sourceWith([tool]));

  const denied = await broker.select({
    riskClass: "R3",
    requestedToolIds: [tool.id],
    allowedPermissions: ["db:schema:write"],
    allowMutations: true,
    maxTools: 1,
  });
  assert.equal(denied.grants.length, 0);
  assert.equal(denied.rejections[0].reason, "approval_required");

  const approved = await broker.select({
    riskClass: "R3",
    requestedToolIds: [tool.id],
    allowedPermissions: ["db:schema:write"],
    allowMutations: true,
    approvalGranted: true,
    maxTools: 1,
  });
  assert.equal(approved.grants[0].tool.id, tool.id);
});

test("Tool Broker maps policy permissions to provider-specific permission names", async () => {
  const tool = descriptor("github.issue.read", {
    requiredPermissions: ["github:issues:read"],
    providerPermissions: ["github_get_issue", "github_list_issue_comments"],
  });
  const broker = new ToolBroker().registerSource(sourceWith([tool]));
  const selection = await broker.select({
    riskClass: "R0",
    requestedToolIds: [tool.id],
    allowedPermissions: ["github:issues:read"],
    allowMutations: false,
    maxTools: 1,
  });

  assert.deepEqual(selection.grants[0].providerPermissions, ["github_get_issue", "github_list_issue_comments"]);
});

test("permission scopes and risk ceilings are hard filters", async () => {
  const tool = descriptor("security.scan", {
    riskCeiling: "R2",
    requiredPermissions: ["repo:read", "secrets:none"],
  });
  const broker = new ToolBroker().registerSource(sourceWith([tool]));

  const permissionDenied = await broker.select({
    riskClass: "R2",
    requestedToolIds: [tool.id],
    allowedPermissions: ["repo:read"],
    allowMutations: false,
    maxTools: 1,
  });
  assert.equal(permissionDenied.rejections[0].reason, "permission_denied");

  const riskDenied = await broker.select({
    riskClass: "R3",
    requestedToolIds: [tool.id],
    allowedPermissions: ["*"],
    allowMutations: false,
    maxTools: 1,
  });
  assert.equal(riskDenied.rejections[0].reason, "risk_ceiling");
});

test("unhealthy and incompatible sources fail closed without corrupting healthy discovery", async () => {
  const healthy = sourceWith([descriptor("healthy.read")]);
  const unhealthy = sourceWith(
    [descriptor("broken.read", { sourceId: "source-b" })],
    {},
    {
      sourceId: "source-b",
      health: { status: "unhealthy", checkedAt: "2026-08-16T00:00:00.000Z", reason: "server down" },
    },
  );
  const incompatible = sourceWith(
    [descriptor("old.read", { sourceId: "source-c" })],
    {},
    {
      sourceId: "source-c",
      version: { version: "0.1", protocolVersion: "legacy", compatible: false },
    },
  );
  const broker = new ToolBroker().registerSource(healthy).registerSource(unhealthy).registerSource(incompatible);
  const snapshots = await broker.discover();

  assert.equal(snapshots.find((item) => item.sourceId === "source-a").tools.length, 1);
  assert.equal(snapshots.find((item) => item.sourceId === "source-b").tools.length, 0);
  assert.equal(snapshots.find((item) => item.sourceId === "source-c").tools.length, 0);
});

test("duplicate logical tool IDs across sources are quarantined instead of arbitrarily selecting a writer", async () => {
  const a = sourceWith([descriptor("duplicate.read")]);
  const b = sourceWith(
    [descriptor("duplicate.read", { sourceId: "source-b" })],
    {},
    { sourceId: "source-b" },
  );
  const broker = new ToolBroker().registerSource(a).registerSource(b);
  const selection = await broker.select({
    riskClass: "R0",
    requestedToolIds: ["duplicate.read"],
    allowedPermissions: ["*"],
    allowMutations: false,
    maxTools: 1,
  });

  assert.equal(selection.grants.length, 0);
  assert.ok(selection.rejections.every((item) => item.reason === "source_incompatible"));
});

test("safe idempotent tool retries a normalized rate-limit failure and records attempts", async () => {
  let calls = 0;
  const tool = descriptor("search.safe");
  const source = sourceWith([tool], {
    [tool.id]: async () => {
      calls += 1;
      if (calls === 1) {
        return {
          error: {
            name: "RateLimitError",
            message: "429 provider busy",
            category: "rate_limit",
            retryable: true,
            httpStatus: 429,
            retryAfterMs: 1,
          },
        };
      }
      return { output: { ok: true }, usage: { providerRequestId: "request-2" } };
    },
  });
  const broker = new ToolBroker({ maxRetryDelayMs: 1 }).registerSource(source);
  const grant = await grantFor(broker, tool.id);
  const result = await broker.invoke({
    grant,
    input: { q: "router" },
    traceId: "trace-tool",
    maxAttempts: 2,
  });

  assert.equal(result.status, "succeeded");
  assert.equal(calls, 2);
  assert.deepEqual(result.attempts.map((attempt) => attempt.status), ["failed", "succeeded"]);
  assert.equal(result.usage.providerRequestId, "request-2");
});

test("unsafe or destructive tools are never automatically repeated after retryable failure", async () => {
  let calls = 0;
  const tool = descriptor("delete.unsafe", {
    mode: "write",
    sideEffectClass: "destructive",
    idempotency: "unsafe",
  });
  const source = sourceWith([tool], {
    [tool.id]: async () => {
      calls += 1;
      return {
        error: {
          name: "ProviderError",
          message: "retry me",
          category: "provider_error",
          retryable: true,
        },
      };
    },
  });
  const broker = new ToolBroker().registerSource(source);
  const grant = await grantFor(broker, tool.id, {
    riskClass: "R4",
    approvalGranted: true,
  });
  const result = await broker.invoke({ grant, input: {}, traceId: "trace-delete", maxAttempts: 3 });

  assert.equal(result.status, "failed");
  assert.equal(calls, 1);
  assert.equal(result.attempts.length, 1);
});

test("tool timeout is normalized and retried only when explicitly enabled and idempotency is safe", async () => {
  let calls = 0;
  const tool = descriptor("slow.safe", { defaultTimeoutMs: 5 });
  const source = sourceWith([tool], {
    [tool.id]: async () => {
      calls += 1;
      if (calls === 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { output: "late" };
      }
      return { output: "ok" };
    },
  });
  const broker = new ToolBroker().registerSource(source);
  const grant = await grantFor(broker, tool.id);
  const result = await broker.invoke({
    grant,
    input: {},
    traceId: "trace-timeout",
    maxAttempts: 2,
    retryOnTimeout: true,
  });

  assert.equal(result.status, "succeeded");
  assert.equal(calls, 2);
  assert.deepEqual(result.attempts.map((attempt) => attempt.status), ["timed_out", "succeeded"]);
});

test("timeout does not blindly retry when retryOnTimeout is disabled", async () => {
  let calls = 0;
  const tool = descriptor("slow.no-retry", { defaultTimeoutMs: 5 });
  const source = sourceWith([tool], {
    [tool.id]: async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { output: "late" };
    },
  });
  const broker = new ToolBroker().registerSource(source);
  const grant = await grantFor(broker, tool.id);
  const result = await broker.invoke({ grant, input: {}, traceId: "trace-timeout-1", maxAttempts: 2 });

  assert.equal(result.status, "timed_out");
  assert.equal(calls, 1);
});

test("provider error messages are sanitized before they enter broker evidence", async () => {
  const tool = descriptor("secret.error");
  const source = sourceWith([tool], {
    [tool.id]: async () => ({
      error: {
        name: "ProviderError",
        message: "authorization=Bearer-secret-value",
        category: "provider_error",
        retryable: false,
      },
    }),
  });
  const broker = new ToolBroker().registerSource(source);
  const grant = await grantFor(broker, tool.id);
  const result = await broker.invoke({ grant, input: {}, traceId: "trace-secret" });

  assert.equal(result.status, "failed");
  assert.ok(!result.error.message.includes("Bearer-secret-value"));
  assert.ok(result.error.message.includes("[redacted]"));
});
