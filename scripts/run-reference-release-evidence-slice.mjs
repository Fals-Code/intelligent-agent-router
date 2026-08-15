import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  GitWorktreeManager,
  NodeCommandRunner,
  OpenCodeRuntimeAdapter,
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
  process.env.ROUTER_REFERENCE_WORKTREE_ROOT?.trim() || join(tmpdir(), "9router-reference-slices"),
);
const allowedFile = "docs/19-release-evidence-template.md";
const runner = new NodeCommandRunner();
const manager = new GitWorktreeManager({
  runner,
  policy: {
    rootDir: worktreeRoot,
    maxActiveWorktrees: 3,
    branchPrefix: "9router/reference/",
    retainDirtyWorktrees: true,
  },
});
const runtime = new OpenCodeRuntimeAdapter({
  baseUrl,
  username,
  password,
});

let lease;
let finalLease;
let sessionId;
let sessionDestroyed = false;
let runtimeDiff;
let originalHead;
let originalOriginMain;
let originalTargetSnapshot = [];
let finalStatus;
let baseRef;
let baseHead;

try {
  originalTargetSnapshot = await workingTreeSnapshot(projectDir);
  originalHead = await gitOutput(projectDir, ["rev-parse", "HEAD"]);
  originalOriginMain = await optionalGitOutput(projectDir, ["rev-parse", "refs/remotes/origin/main"]);

  if (originalOriginMain && originalOriginMain !== originalHead) {
    throw new Error(
      `Target HEAD is not synchronized with origin/main: HEAD=${originalHead}, origin/main=${originalOriginMain}`,
    );
  }

  // A dirty primary workspace is allowed. The isolated reference slice is based
  // only on a committed ref and the exact primary-workspace snapshot is checked
  // again before PASS. Local WIP is neither copied nor modified.
  baseRef = originalOriginMain ? "refs/remotes/origin/main" : "HEAD";
  baseHead = originalOriginMain ?? originalHead;

  lease = await manager.create({
    runId: `release-evidence-${Date.now()}`,
    repositoryPath: projectDir,
    baseRef,
    riskClass: "R2",
    mode: "mutate",
  });

  finalLease = await manager.inspect(lease);
  if (finalLease.dirty) {
    throw new Error(`Fresh reference worktree unexpectedly dirty: ${lease.worktreePath}`);
  }

  const worktreeHead = await gitOutput(lease.worktreePath, ["rev-parse", "HEAD"]);
  if (worktreeHead !== baseHead) {
    throw new Error(`Reference worktree HEAD mismatch: expected ${baseHead}, received ${worktreeHead}`);
  }

  const session = await runtime.createSession({
    projectId: "stok-reconciliation-reference-release-evidence",
    workspace: lease.worktreePath,
    riskClass: "R2",
    metadata: {
      purpose: "prompt-driven-reference-vertical-slice",
      target: "release-evidence-template",
    },
  });
  sessionId = session.id;

  await runtime.sendTask(session.id, {
    taskId: `release-evidence-doc-${Date.now()}`,
    prompt: buildPrompt(),
    context: [
      "You are operating inside an isolated Git worktree created by 9Router.",
      "This is a constrained reference vertical slice. Never access or modify files outside the current worktree.",
      "Do not use shell/bash. Do not attempt network access. Do not commit, push, deploy, or modify production state.",
      `Only ${allowedFile} may be created or modified. Existing project files are read-only context.`,
    ],
    toolIds: ["read", "glob", "grep", "list", "edit", "todowrite"],
  });

  finalStatus = await waitForCompletion(session.id, 8 * 60_000);
  if (finalStatus !== "completed") {
    throw new Error(`Reference task did not complete successfully: ${finalStatus}`);
  }

  runtimeDiff = await runtime.getDiff(session.id);
  const runtimeFiles = runtimeDiff.filesChanged.map(normalizeGitPath);
  if (!runtimeFiles.includes(allowedFile)) {
    throw new Error(
      `OpenCode diff evidence does not include the required file ${allowedFile}; files=${runtimeFiles.join(",") || "none"}`,
    );
  }
  const runtimeUnexpected = runtimeFiles.filter((file) => file !== allowedFile);
  if (runtimeUnexpected.length > 0) {
    throw new Error(`OpenCode diff reports out-of-scope files: ${runtimeUnexpected.join(", ")}`);
  }

  const gitFiles = await gitLines(lease.worktreePath, ["diff", "--name-only", "--"]);
  const untrackedFiles = (await gitLines(lease.worktreePath, ["ls-files", "--others", "--exclude-standard"]))
    .map(normalizeGitPath);
  const allFiles = [...new Set([...gitFiles.map(normalizeGitPath), ...untrackedFiles])].sort();
  if (allFiles.length !== 1 || allFiles[0] !== allowedFile) {
    throw new Error(
      `Git scope gate requires exactly ${allowedFile}; observed=${allFiles.join(",") || "none"}`,
    );
  }

  const diffCheck = await runner.run("git", ["-C", lease.worktreePath, "diff", "--check"]);
  if (diffCheck.exitCode !== 0) {
    throw new Error(`git diff --check failed: ${diffCheck.stderr || diffCheck.stdout || diffCheck.exitCode}`);
  }

  const documentPath = resolve(lease.worktreePath, allowedFile);
  const document = await readFile(documentPath, "utf8");
  validateDocument(document);

  const postHead = await gitOutput(projectDir, ["rev-parse", "HEAD"]);
  if (postHead !== originalHead) {
    throw new Error(`Target repository HEAD changed during isolated slice: ${originalHead} -> ${postHead}`);
  }
  const postTargetSnapshot = await workingTreeSnapshot(projectDir);
  assertSnapshotUnchanged(originalTargetSnapshot, postTargetSnapshot);

  finalLease = await manager.inspect(lease);
  if (!finalLease.dirty) {
    throw new Error("Reference slice completed without a dirty isolated worktree; expected one reviewed document change");
  }
  finalLease = await manager.release({ lease: finalLease });
  if (finalLease.state !== "retained") {
    throw new Error(`Validated reference worktree should be retained for review, received state=${finalLease.state}`);
  }

  await runtime.destroy(session.id);
  sessionDestroyed = true;

  console.log(
    JSON.stringify(
      {
        overall: "PASS",
        referenceSlice: "stok-reconciliation-release-evidence-template",
        targetProject: projectDir,
        targetHead: originalHead,
        originMain: originalOriginMain ?? null,
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
          diffFiles: runtimeFiles,
        },
        evidence: {
          gitFilesChanged: allFiles,
          diffCheck: "PASS",
          requiredDocumentContract: "PASS",
          secretPatternScan: "PASS",
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
        nextGate: "INDEPENDENT_REVIEW_AND_PUBLISH",
      },
      null,
      2,
    ),
  );
} catch (error) {
  const cleanup = await safeCleanup();
  console.error(
    JSON.stringify(
      {
        overall: "FAIL",
        error: sanitize(error instanceof Error ? error.message : String(error)),
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
        cleanup,
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
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
        actor: "9router-reference-slice-policy",
      });
      throw new Error(
        `Reference slice requested an unapproved capability (${String(event.metadata?.permission ?? "unknown")}); request denied`,
      );
    }

    const status = await runtime.getStatus(id);
    if (["completed", "failed", "aborted", "destroyed", "interrupted"].includes(status)) return status;
    await sleep(1000);
  }

  try {
    await runtime.abort(id, "reference slice timeout");
  } catch {}
  throw new Error(`Reference task exceeded bounded runtime of ${Math.round(timeoutMs / 1000)} seconds`);
}

function buildPrompt() {
  return `Create exactly one new documentation file: ${allowedFile}.

This is the first prompt-driven 9Router reference slice for the Stok Reconciliation project. The change must be useful to the current release-readiness work while remaining completely non-runtime and non-production.

Before writing, read the existing deployment/release conventions from docs/16-deployment-guide.md and README.md. You may inspect CHANGELOG.md only if useful. Treat all existing files as read-only context.

Create ${allowedFile} in Indonesian with this exact purpose: a reusable TEMPLATE for recording production release evidence. It must not claim that production deployment has happened or that any check passed. Use obvious placeholders instead of real environment values.

The document must include these headings exactly:
# Template Bukti Rilis Produksi
## Status Dokumen
## Identitas Rilis
## Validation Gates
## Migration State
## Health dan Readiness
## Scheduler / Job Health
## Backup / PITR
## Production Smoke
## Rollback / Recovery
## Final Sign-off
## Aturan Keamanan Bukti

Required content under those headings:
- State explicitly that this is TEMPLATE / BELUM DIISI, not proof of a completed deployment.
- Fields for deployed commit SHA, release tag/reference, environment, timestamp with Asia/Jakarta, operator/reviewer, and evidence location.
- A validation-gates table that can record command/gate, result, timestamp, and evidence reference without inventing results.
- Supabase migration-state evidence fields without credentials or secret values.
- Separate liveness and readiness evidence for /api/health/live and /api/health/ready.
- Scheduler/job evidence including configured jobs, last success/failure, and evidence reference; do not invent job results.
- Backup/PITR prerequisite and verification evidence fields.
- Production smoke/golden-smoke evidence fields.
- Rollback/recovery decision, trigger, target application version/commit, and forward-fix database note.
- Final sign-off plus remaining blockers/known limitations.
- Security rules: never record passwords, service-role/secret keys, bearer tokens, cookies, raw sensitive payloads, or private customer data; redact sensitive values; distinguish NOT_RUN / PASS / FAIL / BLOCKED explicitly.
- Preserve project invariants: no direct manual ledger/projection edits and no disabling RLS as part of release evidence or recovery.

Do not modify README.md, docs/16-deployment-guide.md, package files, source code, migrations, workflows, or any other file. Do not use bash/shell. Do not commit or push.`;
}

function validateDocument(document) {
  if (Buffer.byteLength(document, "utf8") > 30_000) {
    throw new Error("Release evidence template exceeds the 30 KB reference-slice bound");
  }

  const exactHeadings = [
    "# Template Bukti Rilis Produksi",
    "## Status Dokumen",
    "## Identitas Rilis",
    "## Validation Gates",
    "## Migration State",
    "## Health dan Readiness",
    "## Scheduler / Job Health",
    "## Backup / PITR",
    "## Production Smoke",
    "## Rollback / Recovery",
    "## Final Sign-off",
    "## Aturan Keamanan Bukti",
  ];
  for (const heading of exactHeadings) {
    if (!document.includes(heading)) throw new Error(`Required release-evidence heading missing: ${heading}`);
  }

  const requiredPatterns = [
    /TEMPLATE/i,
    /BELUM DIISI|NOT_RUN/i,
    /commit SHA/i,
    /Asia\/Jakarta/i,
    /\/api\/health\/live/i,
    /\/api\/health\/ready/i,
    /migration/i,
    /scheduler/i,
    /PITR/i,
    /rollback/i,
    /RLS/i,
    /ledger/i,
    /projection/i,
    /PASS/i,
    /FAIL/i,
    /BLOCKED/i,
    /service[-_ ]?role/i,
    /bearer token/i,
  ];
  for (const pattern of requiredPatterns) {
    if (!pattern.test(document)) throw new Error(`Required release-evidence marker missing: ${pattern}`);
  }

  const suspiciousSecretPatterns = [
    /\bghp_[A-Za-z0-9]{20,}\b/,
    /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
    /\bsb_secret_[A-Za-z0-9_-]{16,}\b/,
    /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/,
    /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/,
  ];
  for (const pattern of suspiciousSecretPatterns) {
    if (pattern.test(document)) throw new Error(`Potential live secret detected in generated template: ${pattern}`);
  }
}

async function workingTreeSnapshot(cwd) {
  return (await gitLines(cwd, ["status", "--porcelain=v1", "--untracked-files=all"])).sort();
}

function assertSnapshotUnchanged(before, after) {
  if (before.length === after.length && before.every((value, index) => value === after[index])) return;
  throw new Error(
    `Target working tree changed during isolated slice; before=${before.length} entries, after=${after.length} entries`,
  );
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
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function normalizeGitPath(value) {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
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
      result.sessionDestroyError = sanitize(error instanceof Error ? error.message : String(error));
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
      result.worktreeCleanupError = sanitize(error instanceof Error ? error.message : String(error));
    }
  }

  return result;
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function sanitize(value) {
  return value
    .replace(/(authorization|api[_-]?key|access[_-]?token|password|secret|credential)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .slice(0, 2000);
}
