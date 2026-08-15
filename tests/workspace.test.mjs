import test from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { GitWorktreeManager, NodeCommandRunner } from "../dist/index.js";

const TEST_REPO_ROOT = resolve("/repo");
const TEST_REPO_SUBDIR = resolve(TEST_REPO_ROOT, "subdir");
const TEST_WORKTREE_ROOT = resolve("/tmp/9router-worktrees");

class FakeRunner {
  constructor(handler) {
    this.handler = handler;
    this.calls = [];
  }

  async run(command, args, cwd) {
    const call = { command, args: [...args], cwd };
    this.calls.push(call);
    return this.handler(call, this.calls.length);
  }
}

function ok(stdout = "") {
  return { exitCode: 0, stdout, stderr: "" };
}

function managerWith(runner, overrides = {}) {
  return new GitWorktreeManager({
    runner,
    policy: {
      rootDir: TEST_WORKTREE_ROOT,
      maxActiveWorktrees: 2,
      branchPrefix: "9router/",
      retainDirtyWorktrees: true,
      ...overrides.policy,
    },
    now: overrides.now ?? (() => "2026-08-16T00:00:00.000Z"),
    createLeaseId: overrides.createLeaseId ?? (() => "lease-001"),
  });
}

function createRunner({ worktreeList = `worktree ${TEST_REPO_ROOT}\n`, status = "", addExit = 0 } = {}) {
  return new FakeRunner(({ args }) => {
    if (args.includes("--show-toplevel")) return ok(`${TEST_REPO_ROOT}\n`);
    if (args.includes("--verify")) return ok("abc123\n");
    if (args.includes("list") && args.includes("--porcelain")) return ok(worktreeList);
    if (args.includes("check-ref-format")) return ok();
    if (args.includes("add")) return addExit === 0 ? ok("Preparing worktree\n") : { exitCode: addExit, stdout: "", stderr: "add failed" };
    if (args.includes("status")) return ok(status);
    if (args.includes("remove")) return ok();
    if (args.includes("branch")) return ok();
    throw new Error(`unexpected git args: ${args.join(" ")}`);
  });
}

test("Git worktree manager creates an isolated mutation workspace under the managed root", async () => {
  const runner = createRunner();
  const manager = managerWith(runner);
  const lease = await manager.create({
    runId: "run-123",
    repositoryPath: TEST_REPO_SUBDIR,
    baseRef: "main",
    riskClass: "R2",
    mode: "mutate",
  });

  const expectedWorktreePath = resolve(TEST_WORKTREE_ROOT, "run-123-lease-001");
  assert.equal(lease.repositoryPath, TEST_REPO_ROOT);
  assert.equal(lease.worktreePath, expectedWorktreePath);
  assert.equal(lease.branchName, "9router/run-123-lease-00");
  assert.equal(lease.state, "active");
  assert.equal(lease.dirty, false);

  const add = runner.calls.find((call) => call.args.includes("add"));
  assert.deepEqual(add.args, [
    "-C",
    TEST_REPO_ROOT,
    "worktree",
    "add",
    "-b",
    "9router/run-123-lease-00",
    expectedWorktreePath,
    "main",
  ]);
});

test("R0 cannot request a mutation workspace", async () => {
  const runner = createRunner();
  const manager = managerWith(runner);
  await assert.rejects(
    () =>
      manager.create({
        runId: "run-r0",
        repositoryPath: TEST_REPO_ROOT,
        baseRef: "main",
        riskClass: "R0",
        mode: "mutate",
      }),
    /R0 is read-only/,
  );
  assert.equal(runner.calls.length, 0);
});

test("worktree manager enforces max managed worktrees before creating another one", async () => {
  const runner = createRunner({
    worktreeList: `worktree ${TEST_REPO_ROOT}\n\nworktree ${join(TEST_WORKTREE_ROOT, "existing")}\n`,
  });
  const manager = managerWith(runner, { policy: { maxActiveWorktrees: 1 } });
  await assert.rejects(
    () =>
      manager.create({
        runId: "run-limit",
        repositoryPath: TEST_REPO_ROOT,
        baseRef: "main",
        riskClass: "R2",
        mode: "mutate",
      }),
    /Managed worktree limit reached: 1\/1/,
  );
  assert.equal(runner.calls.some((call) => call.args.includes("add")), false);
});

test("unsafe base refs and branch names are rejected instead of being treated as git options", async () => {
  const manager = managerWith(createRunner());
  await assert.rejects(
    () =>
      manager.create({
        runId: "run-ref",
        repositoryPath: TEST_REPO_ROOT,
        baseRef: "--help",
        riskClass: "R2",
        mode: "mutate",
      }),
    /baseRef is not safe/,
  );

  const runner = createRunner();
  const manager2 = managerWith(runner);
  await assert.rejects(
    () =>
      manager2.create({
        runId: "run-branch",
        repositoryPath: TEST_REPO_ROOT,
        baseRef: "main",
        branchName: "-unsafe",
        riskClass: "R2",
        mode: "mutate",
      }),
    /Unsafe worktree branch name/,
  );
  assert.equal(runner.calls.some((call) => call.args.includes("add")), false);
});

test("clean worktree release removes the worktree and only uses safe branch deletion", async () => {
  const runner = createRunner({ status: "" });
  const manager = managerWith(runner);
  const lease = await manager.create({
    runId: "run-clean",
    repositoryPath: TEST_REPO_ROOT,
    baseRef: "main",
    riskClass: "R2",
    mode: "mutate",
  });
  const released = await manager.release({ lease, deleteBranch: true });

  assert.equal(released.state, "released");
  assert.equal(released.dirty, false);
  assert.ok(released.releasedAt);
  const remove = runner.calls.find((call) => call.args.includes("remove"));
  assert.deepEqual(remove.args, ["-C", TEST_REPO_ROOT, "worktree", "remove", lease.worktreePath]);
  const branch = runner.calls.find((call) => call.args.includes("branch"));
  assert.deepEqual(branch.args, ["-C", TEST_REPO_ROOT, "branch", "-d", lease.branchName]);
  assert.equal(branch.args.includes("-D"), false);
});

test("dirty worktrees are retained by default and never removed silently", async () => {
  const runner = createRunner({ status: " M src/auth.ts\n?? evidence.txt\n" });
  const manager = managerWith(runner);
  const lease = await manager.create({
    runId: "run-dirty",
    repositoryPath: TEST_REPO_ROOT,
    baseRef: "main",
    riskClass: "R3",
    mode: "mutate",
  });
  const retained = await manager.release({ lease });

  assert.equal(retained.state, "retained");
  assert.equal(retained.dirty, true);
  assert.equal(runner.calls.some((call) => call.args.includes("remove")), false);
});

test("dirty removal requires both policy permission and explicit forceDirty", async () => {
  const runner = createRunner({ status: " M src/a.ts\n" });
  const manager = managerWith(runner, { policy: { retainDirtyWorktrees: false } });
  const lease = await manager.create({
    runId: "run-force",
    repositoryPath: TEST_REPO_ROOT,
    baseRef: "main",
    riskClass: "R2",
    mode: "mutate",
  });

  const retained = await manager.release({ lease });
  assert.equal(retained.state, "retained");
  assert.equal(runner.calls.some((call) => call.args.includes("remove")), false);

  const released = await manager.release({ lease, forceDirty: true });
  assert.equal(released.state, "released");
  const remove = runner.calls.find((call) => call.args.includes("remove"));
  assert.deepEqual(remove.args, ["-C", TEST_REPO_ROOT, "worktree", "remove", "--force", lease.worktreePath]);
});

test("retainDirtyWorktrees policy cannot be overridden by forceDirty", async () => {
  const runner = createRunner({ status: " M src/a.ts\n" });
  const manager = managerWith(runner, { policy: { retainDirtyWorktrees: true } });
  const lease = await manager.create({
    runId: "run-policy-retain",
    repositoryPath: TEST_REPO_ROOT,
    baseRef: "main",
    riskClass: "R4",
    mode: "mutate",
  });
  const retained = await manager.release({ lease, forceDirty: true });
  assert.equal(retained.state, "retained");
  assert.equal(runner.calls.some((call) => call.args.includes("remove")), false);
});

test("git failures remain explicit and do not fabricate an active lease", async () => {
  const runner = createRunner({ addExit: 128 });
  const manager = managerWith(runner);
  await assert.rejects(
    () =>
      manager.create({
        runId: "run-fail",
        repositoryPath: TEST_REPO_ROOT,
        baseRef: "main",
        riskClass: "R2",
        mode: "mutate",
      }),
    /Failed to create isolated worktree.*add failed/,
  );
});

test("Node command runner uses argv execution and sanitizes sensitive output", async () => {
  const runner = new NodeCommandRunner();
  const result = await runner.run("node", [
    "-e",
    "console.error('secret=super-secret-value'); process.exit(7)",
  ]);
  assert.equal(result.exitCode, 7);
  assert.ok(result.stderr.includes("secret=[redacted]"));
  assert.ok(!result.stderr.includes("super-secret-value"));
});
