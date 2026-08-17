import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  GitWorktreeManager,
  NodeCommandRunner,
  OpenCodeRuntimeAdapter,
} from "../dist/index.js";
import {
  SOURCE_RUNTIME_ALLOWED_FILES,
  sanitizeCommandOutput,
  validateSourceRuntimeCommandEvidence,
  validateSourceRuntimeScope,
} from "./source-runtime-slice-policy.mjs";

const projectDir = resolve(process.env.ROUTER_SOURCE_RUNTIME_PROJECT_DIR?.trim() || process.cwd());
const baseUrl = process.env.OPENCODE_BASE_URL?.trim() || "http://127.0.0.1:4096";
const username = process.env.OPENCODE_SERVER_USERNAME?.trim() || "opencode";
const password = process.env.OPENCODE_SERVER_PASSWORD;
const worktreeRoot = resolve(
  process.env.ROUTER_SOURCE_RUNTIME_WORKTREE_ROOT?.trim() || join(tmpdir(), "9router-source-runtime-slices"),
);
const runner = new NodeCommandRunner();
const manager = new GitWorktreeManager({
  runner,
  policy: {
    rootDir: worktreeRoot,
    maxActiveWorktrees: 3,
    branchPrefix: "9router/reference-source/",
    retainDirtyWorktrees: true,
  },
});
const runtime = new OpenCodeRuntimeAdapter({ baseUrl, username, password });

let lease;
let finalLease;
let sessionId;
let sessionDestroyed = false;
let runtimeDiff;
let finalStatus;
let originalHead;
let originalOriginMain;
let originalTargetSnapshot = [];
let baseRef;
let baseHead;
const commandEvidence = [];

try {
  await assertRouterRepository(projectDir);
  const tscPath = join(projectDir, "node_modules", "typescript", "bin", "tsc");
  await access(tscPath);

  originalTargetSnapshot = await workingTreeSnapshot(projectDir);
  originalHead = await gitOutput(projectDir, ["rev-parse", "HEAD"]);
  originalOriginMain = await optionalGitOutput(projectDir, ["rev-parse", "refs/remotes/origin/main"]);
  if (!originalOriginMain) {
    throw new Error("Reference source/runtime slice requires refs/remotes/origin/main");
  }
  if (originalOriginMain !== originalHead) {
    throw new Error(
      `Router HEAD is not synchronized with origin/main: HEAD=${originalHead}, origin/main=${originalOriginMain}`,
    );
  }

  baseRef = "refs/remotes/origin/main";
  baseHead = originalOriginMain;

  lease = await manager.create({
    runId: `source-runtime-sanitizer-${Date.now()}`,
    repositoryPath: projectDir,
    baseRef,
    riskClass: "R2",
    mode: "mutate",
  });

  finalLease = await manager.inspect(lease);
  if (finalLease.dirty) {
    throw new Error(`Fresh source/runtime worktree unexpectedly dirty: ${lease.worktreePath}`);
  }

  const worktreeHead = await gitOutput(lease.worktreePath, ["rev-parse", "HEAD"]);
  if (worktreeHead !== baseHead) {
    throw new Error(`Source/runtime worktree HEAD mismatch: expected ${baseHead}, received ${worktreeHead}`);
  }

  const session = await runtime.createSession({
    projectId: "9router-reference-source-runtime-sanitizer",
    workspace: lease.worktreePath,
    riskClass: "R2",
    metadata: {
      purpose: "prompt-driven-reference-source-runtime-slice",
      target: "node-command-runner-output-sanitizer",
    },
  });
  sessionId = session.id;

  await runtime.sendTask(session.id, {
    taskId: `source-runtime-sanitizer-${Date.now()}`,
    prompt: buildPrompt(),
    context: [
      "You are operating inside an isolated Git worktree created by 9Router.",
      "This is a constrained source/runtime reference slice. Never access or modify files outside the current worktree.",
      "Do not use shell/bash. Do not attempt network access. Do not commit, push, deploy, install packages, or modify external state.",
      `Only these files may be created or modified: ${SOURCE_RUNTIME_ALLOWED_FILES.join(", ")}. All other files are read-only context.`,
      "The 9Router harness, not the coding agent, will compile and run independent verification after you finish editing.",
    ],
    toolIds: ["read", "glob", "grep", "list", "edit", "todowrite"],
  });

  finalStatus = await waitForCompletion(session.id, 8 * 60_000);
  if (finalStatus !== "completed") {
    throw new Error(`Reference source/runtime task did not complete successfully: ${finalStatus}`);
  }

  runtimeDiff = await runtime.getDiff(session.id);
  const runtimeFiles = runtimeDiff.filesChanged.map(normalizeGitPath);
  const trackedFiles = (await gitLines(lease.worktreePath, ["diff", "--name-only", "--"])).map(normalizeGitPath);
  const untrackedFiles = (await gitLines(lease.worktreePath, ["ls-files", "--others", "--exclude-standard"])).map(normalizeGitPath);
  const allFiles = [...new Set([...trackedFiles, ...untrackedFiles])].sort();
  const scopeEvidence = validateSourceRuntimeScope({ runtimeFiles, gitFiles: allFiles });

  const diffCheck = await runner.run("git", ["-C", lease.worktreePath, "diff", "--check"]);
  if (diffCheck.exitCode !== 0) {
    throw new Error(`git diff --check failed for source/runtime slice: ${diffCheck.stderr || diffCheck.stdout || diffCheck.exitCode}`);
  }
  await assertTextHygiene(lease.worktreePath, SOURCE_RUNTIME_ALLOWED_FILES);

  const commands = [
    {
      id: "typescript-build",
      command: process.execPath,
      args: [tscPath, "-p", join(lease.worktreePath, "tsconfig.json")],
      displayCommand: "node <router-node_modules>/typescript/bin/tsc -p tsconfig.json",
      timeoutMs: 120_000,
    },
    {
      id: "focused-regression",
      command: process.execPath,
      args: ["--test", "tests/node-command-runner-sanitize.test.mjs"],
      displayCommand: "node --test tests/node-command-runner-sanitize.test.mjs",
      timeoutMs: 120_000,
    },
    {
      id: "independent-verifier",
      command: process.execPath,
      args: ["scripts/verify-reference-source-runtime-slice.mjs"],
      displayCommand: "node scripts/verify-reference-source-runtime-slice.mjs",
      timeoutMs: 120_000,
    },
  ];

  for (const command of commands) {
    const evidence = await runAllowlistedCommand(command, lease.worktreePath);
    commandEvidence.push(evidence);
    if (evidence.timedOut || evidence.exitCode !== 0) {
      throw new Error(
        `Allowlisted source/runtime command failed: ${evidence.id}; exit=${evidence.exitCode}; timedOut=${evidence.timedOut}`,
      );
    }
  }

  const commandContract = validateSourceRuntimeCommandEvidence(commandEvidence);
  const verifier = commandEvidence.find((row) => row.id === "independent-verifier");
  if (!verifier || !verifier.stdout.includes('"overall":"PASS"')) {
    throw new Error("Independent deterministic verifier did not report PASS");
  }

  const fileSha256 = {};
  for (const file of SOURCE_RUNTIME_ALLOWED_FILES) {
    fileSha256[file] = await sha256File(resolve(lease.worktreePath, file));
  }

  const postHead = await gitOutput(projectDir, ["rev-parse", "HEAD"]);
  if (postHead !== originalHead) {
    throw new Error(`Router repository HEAD changed during isolated source/runtime slice: ${originalHead} -> ${postHead}`);
  }
  const postTargetSnapshot = await workingTreeSnapshot(projectDir);
  assertSnapshotUnchanged(originalTargetSnapshot, postTargetSnapshot);

  finalLease = await manager.inspect(lease);
  if (!finalLease.dirty) {
    throw new Error("Source/runtime slice completed without a dirty isolated worktree; expected reviewed source + regression changes");
  }
  finalLease = await manager.release({ lease: finalLease });
  if (finalLease.state !== "retained") {
    throw new Error(`Validated source/runtime worktree should be retained for review, received state=${finalLease.state}`);
  }

  await runtime.destroy(session.id);
  sessionDestroyed = true;

  console.log(JSON.stringify({
    overall: "PASS",
    referenceSlice: "9router-source-runtime-output-sanitizer",
    targetProject: projectDir,
    targetHead: originalHead,
    originMain: originalOriginMain,
    baseRef,
    baseHead,
    riskClass: "R2",
    runtime: {
      id: runtime.runtimeId,
      status: finalStatus,
      sessionCreated: true,
      sessionDestroyed,
      allowedPermissions: ["read", "glob", "grep", "list", "edit", "todowrite"],
      bashAllowed: false,
      networkToolsAllowed: false,
      diffFiles: scopeEvidence.runtimeFiles,
      diffEvidence: scopeEvidence.runtimeDiffObservation,
      diffRequiredForSuccess: false,
    },
    evidence: {
      canonicalMutationEvidence: scopeEvidence.canonicalMutationEvidence,
      gitFilesChanged: scopeEvidence.gitFiles,
      diffCheck: "PASS",
      textHygiene: "PASS",
      sourceAndRegressionPair: "PASS",
      commandAllowlist: "PASS",
      commandCount: commandContract.commandCount,
      commandIds: commandContract.commandIds,
      commandEvidence: commandEvidence.map(publicCommandEvidence),
      independentVerifier: "PASS",
      independentVerifierType: "deterministic-node",
      fileSha256,
      targetHeadUnchanged: true,
      targetWorkingTreeUnchanged: true,
      targetWorkingTreeInitiallyDirty: originalTargetSnapshot.length > 0,
      targetDirtyEntryCount: originalTargetSnapshot.length,
    },
    isolatedWorktree: {
      root: worktreeRoot,
      path: lease.worktreePath,
      branch: lease.branchName,
      state: finalLease.state,
      retainedForReview: true,
    },
    publish: {
      committed: false,
      pushed: false,
      pullRequestCreated: false,
      merged: false,
    },
    nextGate: "INDEPENDENT_SOURCE_REVIEW_AND_PUBLISH",
  }, null, 2));
} catch (error) {
  const cleanup = await safeCleanup();
  console.error(JSON.stringify({
    overall: "FAIL",
    error: sanitizeCommandOutput(error instanceof Error ? error.message : String(error), 2_000),
    target: {
      head: originalHead ?? null,
      originMain: originalOriginMain ?? null,
      initiallyDirty: originalTargetSnapshot.length > 0,
      dirtyEntryCount: originalTargetSnapshot.length,
    },
    runtime: {
      sessionCreated: Boolean(sessionId),
      sessionDestroyed,
      lastStatus: finalStatus ?? null,
      diffFiles: runtimeDiff?.filesChanged?.map(normalizeGitPath) ?? [],
    },
    commandEvidence: commandEvidence.map(publicCommandEvidence),
    cleanup,
  }, null, 2));
  process.exitCode = 1;
}

async function assertRouterRepository(cwd) {
  const packageJson = JSON.parse(await readFile(join(cwd, "package.json"), "utf8"));
  if (packageJson?.name !== "intelligent-agent-router") {
    throw new Error(`Source/runtime reference slice must target intelligent-agent-router, received=${String(packageJson?.name ?? "unknown")}`);
  }
}

async function waitForCompletion(id, timeoutMs) {
  const startedAt = Date.now();
  const deniedApprovals = new Set();
  while (Date.now() - startedAt < timeoutMs) {
    const events = await runtime.getEvents(id);
    for (const event of events) {
      if (event.type !== "approval_requested") continue;
      const approvalId = typeof event.metadata?.approvalId === "string" ? event.metadata.approvalId : undefined;
      if (!approvalId || deniedApprovals.has(approvalId)) continue;
      deniedApprovals.add(approvalId);
      await runtime.respondToApproval(id, {
        approvalId,
        decision: "denied",
        actor: "9router-reference-source-runtime-policy",
      });
      throw new Error(
        `Reference source/runtime slice requested an unapproved capability (${String(event.metadata?.permission ?? "unknown")}); request denied`,
      );
    }
    const status = await runtime.getStatus(id);
    if (["completed", "failed", "aborted", "destroyed", "interrupted"].includes(status)) return status;
    await sleep(1000);
  }
  try { await runtime.abort(id, "reference source/runtime slice timeout"); } catch {}
  throw new Error(`Reference source/runtime task exceeded bounded runtime of ${Math.round(timeoutMs / 1000)} seconds`);
}

function buildPrompt() {
  return `Fix one real output-sanitization bug in 9Router and add a regression test.

Read src/workspace/node-command-runner.ts and the existing test conventions first. Treat every file except the two explicitly allowed files as read-only context.

Problem to fix:
The current NodeCommandRunner output sanitizer can match only the word "Bearer" in a value such as "Authorization: Bearer <token>", leaving the actual token visible after the redaction marker. This can leak credentials through captured stdout/stderr.

Required change:
1. Modify src/workspace/node-command-runner.ts so an Authorization Bearer credential is fully redacted, including the credential after the Bearer scheme.
2. Preserve the existing redaction behavior for authorization/api-key/access-token/password/secret/credential key-value forms.
3. Preserve output trimming and output-truncation behavior.
4. Create tests/node-command-runner-sanitize.test.mjs using Node's built-in test/assert modules. The regression test must exercise NodeCommandRunner against a child process that writes sensitive examples to stdout and stderr, prove the secret literals are absent from captured output, and prove redaction markers remain present.
5. Do not add dependencies and do not change public APIs unless strictly necessary.

Exact mutation scope:
- src/workspace/node-command-runner.ts
- tests/node-command-runner-sanitize.test.mjs

Do not modify package.json, scripts, workflows, other source files, or existing tests. Do not run shell/bash or network commands. Do not install packages. Do not commit or push. The 9Router harness will compile the worktree, run the focused regression test, and run an independent deterministic verifier after you finish editing.`;
}

async function runAllowlistedCommand(spec, cwd) {
  const startedAt = Date.now();
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(spec.command, [...spec.args], {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, spec.timeoutMs);

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolvePromise(Object.freeze({
        id: spec.id,
        command: spec.displayCommand,
        exitCode: timedOut ? 124 : (code ?? 1),
        timedOut,
        durationMs: Date.now() - startedAt,
        stdout: sanitizeCommandOutput(Buffer.concat(stdout).toString("utf8")),
        stderr: sanitizeCommandOutput(Buffer.concat(stderr).toString("utf8")),
      }));
    });
  });
}

function publicCommandEvidence(row) {
  return {
    id: row.id,
    command: row.command,
    exitCode: row.exitCode,
    timedOut: row.timedOut,
    durationMs: row.durationMs,
    stdout: row.stdout,
    stderr: row.stderr,
  };
}

async function assertTextHygiene(cwd, files) {
  for (const file of files) {
    const text = await readFile(resolve(cwd, file), "utf8");
    if (/[ \t]+$/m.test(text)) {
      throw new Error(`Trailing whitespace detected in source/runtime mutation: ${file}`);
    }
  }
}

async function sha256File(path) {
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

async function workingTreeSnapshot(cwd) {
  return (await gitLines(cwd, ["status", "--porcelain=v1", "--untracked-files=all"])).sort();
}

function assertSnapshotUnchanged(before, after) {
  if (before.length === after.length && before.every((value, index) => value === after[index])) return;
  throw new Error(`Router working tree changed during isolated source/runtime slice; before=${before.length}, after=${after.length}`);
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

async function optionalGitOutput(cwd, args) {
  const result = await runner.run("git", ["-C", cwd, ...args]);
  if (result.exitCode !== 0) return undefined;
  return result.stdout.trim() || undefined;
}

async function gitLines(cwd, args) {
  const result = await runner.run("git", ["-C", cwd, ...args]);
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout || result.exitCode}`);
  }
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function normalizeGitPath(value) {
  return String(value).replace(/\\/g, "/").replace(/^\.\//, "");
}

async function safeCleanup() {
  const result = {
    sessionDestroyAttempted: false,
    sessionDestroyed,
    worktreeCleanupAttempted: false,
    worktreeState: finalLease?.state ?? lease?.state ?? null,
    retainedPath: null,
  };

  if (sessionId && !sessionDestroyed) {
    result.sessionDestroyAttempted = true;
    try {
      await runtime.destroy(sessionId);
      sessionDestroyed = true;
      result.sessionDestroyed = true;
    } catch (error) {
      result.sessionDestroyError = sanitizeCommandOutput(error instanceof Error ? error.message : String(error), 2_000);
    }
  }

  if (lease && finalLease?.state !== "released") {
    result.worktreeCleanupAttempted = true;
    try {
      const inspected = await manager.inspect(finalLease ?? lease);
      finalLease = inspected;
      if (inspected.dirty) {
        finalLease = await manager.release({ lease: inspected });
        result.worktreeState = finalLease.state;
        result.retainedPath = inspected.worktreePath;
      } else {
        finalLease = await manager.release({ lease: inspected, deleteBranch: true });
        result.worktreeState = finalLease.state;
        result.retainedPath = finalLease.state === "released" ? null : finalLease.worktreePath;
      }
    } catch (error) {
      result.worktreeState = "cleanup-failed";
      result.retainedPath = lease.worktreePath;
      result.worktreeCleanupError = sanitizeCommandOutput(error instanceof Error ? error.message : String(error), 2_000);
    }
  }
  return result;
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
