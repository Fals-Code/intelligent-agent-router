import test from "node:test";
import assert from "node:assert/strict";
import {
  ContextCompiler,
  InMemoryAgentRuntimeAdapter,
  InMemoryProjectGraph,
} from "../dist/index.js";

test("project graph stores canonical references and relationships without copying provider state", () => {
  const graph = new InMemoryProjectGraph()
    .addNode({ id: "repo", kind: "repository", reference: "github:Fals-Code/stok-reconciliation-system@main" })
    .addNode({ id: "policy", kind: "policy", reference: "repo:AGENTS.md", revision: "abc123" })
    .addNode({ id: "tests", kind: "test", reference: "repo:tests/e2e" })
    .addEdge({ from: "repo", to: "policy", relation: "governed_by" })
    .addEdge({ from: "repo", to: "tests", relation: "verified_by" });

  assert.equal(graph.getNode("repo")?.reference, "github:Fals-Code/stok-reconciliation-system@main");
  assert.deepEqual(graph.related("repo", "governed_by").map((node) => node.id), ["policy"]);
  const snapshot = graph.snapshot();
  assert.equal(snapshot.nodes.length, 3);
  assert.equal(snapshot.edges.length, 2);
  assert.ok(Object.isFrozen(snapshot));
});

test("project graph rejects relationships to unknown canonical references", () => {
  const graph = new InMemoryProjectGraph().addNode({ id: "repo", kind: "repository", reference: "github:repo" });
  assert.throws(
    () => graph.addEdge({ from: "repo", to: "missing", relation: "depends_on" }),
    /Unknown project graph target node/,
  );
});

test("context compiler keeps scoped rules, selected skills and selected tools inside an explicit budget", () => {
  const compiler = new ContextCompiler({ version: "test-context-v1" });
  const compiled = compiler.compile({
    task: "Fix the stock reconciliation bug",
    projectId: "stok-reconciliation",
    riskClass: "R2",
    maxContextTokens: 700,
    selectedSkillIds: ["testing-skill"],
    selectedToolIds: ["github.read"],
    designInScope: false,
    candidates: [
      { id: "rules", source: "project_rule", content: "AGENTS", estimatedTokens: 100, relevance: 0.1, applicable: true },
      { id: "code", source: "source_code", content: "relevant code", estimatedTokens: 200, relevance: 0.9, applicable: true },
      { id: "skill-meta", source: "skill", content: "skill metadata", estimatedTokens: 50, relevance: 0.5, applicable: true, skillId: "other-skill", disclosure: "metadata" },
      { id: "skill-full", source: "skill", content: "selected full skill", estimatedTokens: 300, relevance: 0.8, applicable: true, skillId: "testing-skill", disclosure: "full" },
      { id: "skill-unselected", source: "skill", content: "do not disclose", estimatedTokens: 300, relevance: 1, applicable: true, skillId: "dangerous-skill", disclosure: "full" },
      { id: "tool", source: "tool", content: "github read tool", estimatedTokens: 50, relevance: 0.7, applicable: true, toolId: "github.read" },
      { id: "tool-unselected", source: "tool", content: "unneeded write tool", estimatedTokens: 50, relevance: 1, applicable: true, toolId: "github.write" },
      { id: "design", source: "design", content: "penpot page", estimatedTokens: 100, relevance: 0.95, applicable: true },
    ],
  });

  assert.equal(compiled.version, "test-context-v1");
  assert.equal(compiled.totalTokens, 700);
  assert.equal(compiled.toolCatalogSize, 1);
  assert.deepEqual(
    compiled.items.map((item) => item.id).sort(),
    ["code", "rules", "skill-full", "skill-meta", "tool"].sort(),
  );
  assert.ok(compiled.droppedIds.includes("skill-unselected"));
  assert.ok(compiled.droppedIds.includes("tool-unselected"));
  assert.ok(compiled.droppedIds.includes("design"));
});

test("context compiler refuses to drop mandatory project rules when the budget is too small", () => {
  const compiler = new ContextCompiler();
  assert.throws(
    () =>
      compiler.compile({
        task: "Task",
        projectId: "project",
        riskClass: "R1",
        maxContextTokens: 50,
        candidates: [
          { id: "rules", source: "project_rule", content: "required", estimatedTokens: 100, relevance: 0, applicable: true },
        ],
      }),
    /Mandatory project rules exceed context budget/,
  );
});

test("runtime adapter supports interrupt, resume, durable approval response, diff and event retrieval", async () => {
  let eventCounter = 0;
  const runtime = new InMemoryAgentRuntimeAdapter({
    runtimeId: "test-runtime",
    now: () => "2026-08-16T00:00:00.000Z",
    createSessionId: () => "session-1",
    createEventId: () => `event-${++eventCounter}`,
  });

  const session = await runtime.createSession({
    projectId: "stok-reconciliation",
    workspace: "worktree/session-1",
    riskClass: "R3",
  });
  assert.equal(session.status, "created");

  await runtime.sendTask(session.id, {
    taskId: "task-1",
    prompt: "Fix auth boundary",
    context: ["AGENTS.md"],
    toolIds: ["github.read"],
  });
  assert.equal(await runtime.getStatus(session.id), "running");

  await runtime.interrupt(session.id);
  assert.equal(await runtime.getStatus(session.id), "interrupted");
  await runtime.resume(session.id);

  runtime.requestApproval(session.id, "approval-1");
  assert.equal(await runtime.getStatus(session.id), "waiting_approval");
  await runtime.respondToApproval(session.id, {
    approvalId: "approval-1",
    decision: "approved",
    actor: "human:test",
  });
  assert.equal(await runtime.getStatus(session.id), "running");

  runtime.completeTask(session.id, {
    filesChanged: ["src/auth.ts"],
    patch: "@@ -1 +1 @@",
    commitSha: "abc123",
  });
  assert.equal(await runtime.getStatus(session.id), "completed");
  assert.deepEqual((await runtime.getDiff(session.id)).filesChanged, ["src/auth.ts"]);

  const events = await runtime.getEvents(session.id);
  assert.deepEqual(
    events.map((event) => event.type),
    ["session_created", "task_started", "interrupted", "resumed", "approval_requested", "approval_responded", "task_completed"],
  );
  const tail = await runtime.getEvents(session.id, "event-4");
  assert.deepEqual(tail.map((event) => event.id), ["event-5", "event-6", "event-7"]);

  await runtime.destroy(session.id);
  assert.equal(await runtime.getStatus(session.id), "destroyed");
});

test("denied runtime approval aborts the session and prevents further tasks", async () => {
  const runtime = new InMemoryAgentRuntimeAdapter({
    createSessionId: () => "session-denied",
    createEventId: (() => {
      let id = 0;
      return () => `e-${++id}`;
    })(),
  });
  const session = await runtime.createSession({ projectId: "project", workspace: "worktree", riskClass: "R4" });
  await runtime.sendTask(session.id, { taskId: "task", prompt: "destructive action", context: [], toolIds: [] });
  runtime.requestApproval(session.id, "approval-denied");
  await runtime.respondToApproval(session.id, { approvalId: "approval-denied", decision: "denied", actor: "human" });
  assert.equal(await runtime.getStatus(session.id), "aborted");
  await assert.rejects(
    () => runtime.sendTask(session.id, { taskId: "again", prompt: "retry", context: [], toolIds: [] }),
    /is aborted/,
  );
});
