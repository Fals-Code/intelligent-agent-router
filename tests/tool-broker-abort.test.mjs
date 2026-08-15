import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryToolSource, ToolBroker } from "../dist/index.js";

const tool = {
  id: "ignore-signal",
  sourceId: "abort-source",
  providerToolName: "ignore-signal",
  title: "Ignore signal",
  description: "Simulates an adapter that does not settle when aborted.",
  capabilities: ["test.abort"],
  mode: "read",
  sideEffectClass: "none",
  riskCeiling: "R4",
  requiredPermissions: [],
  providerPermissions: [],
  idempotency: "safe",
};

test("Tool Broker parent abort wins even when a source handler ignores AbortSignal", async () => {
  const source = new InMemoryToolSource({
    sourceId: "abort-source",
    tools: [tool],
    handlers: {
      "ignore-signal": async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return { output: "late" };
      },
    },
  });
  const broker = new ToolBroker({ defaultTimeoutMs: 1_000 }).registerSource(source);
  const selection = await broker.select({
    riskClass: "R0",
    requestedToolIds: [tool.id],
    allowedPermissions: ["*"],
    allowMutations: false,
    maxTools: 1,
  });
  const controller = new AbortController();
  const started = Date.now();
  const pending = broker.invoke({
    grant: selection.grants[0],
    input: {},
    traceId: "trace-abort",
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(new Error("cancelled by workflow")), 5);
  const result = await pending;

  assert.equal(result.status, "aborted");
  assert.equal(result.error.category, "aborted");
  assert.ok(Date.now() - started < 100);
});
