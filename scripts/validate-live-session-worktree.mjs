import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  GitWorktreeManager,
  NodeCommandRunner,
  runOpenCodeLivePreflight,
} from "../dist/index.js";

const projectDir = process.env.OPENCODE_PROJECT_DIR?.trim();
if (!projectDir) {
  console.error("OPENCODE_PROJECT_DIR is required.");
  process.exit(2);
}

const baseUrl = process.env.OPENCODE_BASE_URL?.trim() || "http://127.0.0.1:4096";
const username = process.env.OPENCODE_SERVER_USERNAME?.trim() || "opencode";
const password = process.env.OPENCODE_SERVER_PASSWORD;
const worktreeRoot = resolve(
  process.env.ROUTER_WORKTREE_SMOKE_ROOT?.trim() || join(tmpdir(), "9router-worktree-smoke"),
);
const runner = new NodeCommandRunner();
const manager = new GitWorktreeManager({
  runner,
  policy: {
    rootDir: worktreeRoot,
    maxActiveWorktrees: 2,
    branchPrefix: "9router/smoke/",
    retainDirtyWorktrees: true,
  },
});

let lease;
let finalLease;
let originalHead;
let worktreeHead;
let originalSessionSmoke;
let worktreeSessionSmoke;

try {
  originalHead = await gitOutput(projectDir, ["rev-parse", "HEAD"]);

  originalSessionSmoke = await runOpenCodeLivePreflight({
    baseUrl,
    projectDir,
    username,
    password,
    allowRemote: false,
    sessionSmoke: true,
  });
  assertReadySessionSmoke(originalSessionSmoke, "target repository");

  lease = await manager.create({
    runId: `live-${Date.now()}`,
    repositoryPath: projectDir,
    baseRef: "HEAD",
    riskClass: "R2",
    mode: "mutate",
  });

  finalLease = await manager.inspect(lease);
  if (finalLease.dirty) {
    throw new Error(`Fresh worktree unexpectedly dirty: ${lease.worktreePath}`);
  }

  worktreeHead = await gitOutput(lease.worktreePath, ["rev-parse", "HEAD"]);
  if (worktreeHead !== originalHead) {
    throw new Error(`Worktree HEAD mismatch: expected ${originalHead}, received ${worktreeHead}`);
  }

  worktreeSessionSmoke = await runOpenCodeLivePreflight({
    baseUrl,
    projectDir: lease.worktreePath,
    username,
    password,
    allowRemote: false,
    sessionSmoke: true,
  });
  assertReadySessionSmoke(worktreeSessionSmoke, "isolated worktree");

  finalLease = await manager.inspect(lease);
  if (finalLease.dirty) {
    throw new Error(
      `OpenCode session smoke changed the isolated worktree; retaining it for inspection: ${lease.worktreePath}`,
    );
  }

  finalLease = await manager.release({ lease: finalLease, deleteBranch: true });
  if (finalLease.state !== "released") {
    throw new Error(`Worktree was not released cleanly: ${finalLease.state}`);
  }

  const branchStillExists = await gitBranchExists(projectDir, lease.branchName);
  if (branchStillExists) {
    throw new Error(`Smoke branch still exists after release: ${lease.branchName}`);
  }

  console.log(
    JSON.stringify(
      {
        overall: "PASS",
        targetProject: projectDir,
        targetHead: originalHead,
        originalSessionSmoke: summarizeSmoke(originalSessionSmoke),
        isolatedWorktree: {
          root: worktreeRoot,
          path: lease.worktreePath,
          branch: lease.branchName,
          head: worktreeHead,
          cleanBeforeSession: true,
          cleanAfterSession: true,
          released: finalLease.state === "released",
          branchDeleted: !branchStillExists,
        },
        worktreeSessionSmoke: summarizeSmoke(worktreeSessionSmoke),
      },
      null,
      2,
    ),
  );
} catch (error) {
  let cleanup = { attempted: false, state: finalLease?.state ?? lease?.state ?? null, retainedPath: null };

  if (lease && finalLease?.state !== "released") {
    cleanup = { attempted: true, state: finalLease?.state ?? lease.state, retainedPath: lease.worktreePath };
    try {
      const inspected = await manager.inspect(finalLease ?? lease);
      finalLease = inspected;
      if (inspected.dirty) {
        cleanup = { attempted: true, state: "retained", retainedPath: inspected.worktreePath };
      } else {
        finalLease = await manager.release({ lease: inspected, deleteBranch: true });
        cleanup = {
          attempted: true,
          state: finalLease.state,
          retainedPath: finalLease.state === "released" ? null : finalLease.worktreePath,
        };
      }
    } catch (cleanupError) {
      cleanup = {
        attempted: true,
        state: "cleanup-failed",
        retainedPath: lease.worktreePath,
        error: sanitize(cleanupError instanceof Error ? cleanupError.message : String(cleanupError)),
      };
    }
  }

  console.error(
    JSON.stringify(
      {
        overall: "FAIL",
        error: sanitize(error instanceof Error ? error.message : String(error)),
        cleanup,
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
}

async function gitOutput(cwd, args) {
  const result = await runner.run("git", ["-C", cwd, ...args]);
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout || result.exitCode}`);
  }
  const value = result.stdout.trim();
  if (!value) throw new Error(`git ${args.join(" ")} returned empty output`);
  return value;
}

async function gitBranchExists(cwd, branchName) {
  const result = await runner.run("git", ["-C", cwd, "show-ref", "--verify", "--quiet", `refs/heads/${branchName}`]);
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;
  throw new Error(`Unable to verify smoke branch cleanup: ${result.stderr || result.stdout || result.exitCode}`);
}

function assertReadySessionSmoke(result, scope) {
  if (!result.ready) throw new Error(`OpenCode live preflight not ready for ${scope}`);
  if (!result.sessionSmoke.requested || !result.sessionSmoke.created || !result.sessionSmoke.destroyed) {
    throw new Error(`OpenCode R0 session smoke incomplete for ${scope}`);
  }
}

function summarizeSmoke(result) {
  return {
    ready: result.ready,
    health: result.health.status,
    version: result.version.version,
    compatible: result.version.compatible,
    scopedStatusReadable: result.scopedStatusReadable,
    sessionCreated: result.sessionSmoke.created,
    sessionDestroyed: result.sessionSmoke.destroyed,
    initialStatus: result.sessionSmoke.initialStatus ?? null,
  };
}

function sanitize(value) {
  return value
    .replace(/(authorization|api[_-]?key|access[_-]?token|password|secret|credential)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .slice(0, 2000);
}
