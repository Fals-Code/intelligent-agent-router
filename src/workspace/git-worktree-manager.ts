import { isAbsolute, join, relative, resolve } from "node:path";
import type {
  CommandResult,
  CommandRunner,
  CreateWorktreeRequest,
  ReleaseWorktreeRequest,
  WorktreeLease,
  WorktreePolicy,
  WorkspaceManager,
} from "./contracts.js";

export interface GitWorktreeManagerOptions {
  readonly runner: CommandRunner;
  readonly policy: WorktreePolicy;
  readonly now?: () => string;
  readonly createLeaseId?: () => string;
}

export class GitWorktreeManager implements WorkspaceManager {
  private readonly now: () => string;
  private readonly createLeaseId: () => string;
  private readonly rootDir: string;

  constructor(private readonly options: GitWorktreeManagerOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.createLeaseId = options.createLeaseId ?? (() => globalThis.crypto.randomUUID());
    if (!options.policy.rootDir.trim()) throw new Error("Worktree policy rootDir must not be empty");
    if (!Number.isInteger(options.policy.maxActiveWorktrees) || options.policy.maxActiveWorktrees <= 0) {
      throw new Error("Worktree policy maxActiveWorktrees must be a positive integer");
    }
    if (!options.policy.branchPrefix.trim()) throw new Error("Worktree policy branchPrefix must not be empty");
    this.rootDir = resolve(options.policy.rootDir);
  }

  async create(request: CreateWorktreeRequest): Promise<WorktreeLease> {
    this.validateCreateRequest(request);
    const repositoryPath = await this.resolveRepositoryRoot(request.repositoryPath);
    await this.assertBaseRef(repositoryPath, request.baseRef);

    const worktrees = await this.listWorktrees(repositoryPath);
    const managedCount = worktrees.filter((path) => isInside(this.rootDir, resolve(path))).length;
    if (managedCount >= this.options.policy.maxActiveWorktrees) {
      throw new Error(
        `Managed worktree limit reached: ${managedCount}/${this.options.policy.maxActiveWorktrees}`,
      );
    }

    const id = this.createLeaseId();
    const pathSuffix = `${slug(request.runId)}-${slug(id).slice(0, 12)}`;
    const worktreePath = resolve(join(this.rootDir, pathSuffix));
    assertInsideRoot(this.rootDir, worktreePath);
    if (worktrees.some((path) => samePath(resolve(path), worktreePath))) {
      throw new Error(`Worktree path is already registered: ${worktreePath}`);
    }

    const branchName = request.branchName?.trim() || `${this.options.policy.branchPrefix}${slug(request.runId)}-${slug(id).slice(0, 8)}`;
    await this.assertBranchName(repositoryPath, branchName);

    const result = await this.options.runner.run(
      "git",
      ["-C", repositoryPath, "worktree", "add", "-b", branchName, worktreePath, request.baseRef],
    );
    this.assertSuccess(result, `Failed to create isolated worktree ${worktreePath}`);

    return Object.freeze({
      id,
      runId: request.runId,
      repositoryPath,
      worktreePath,
      branchName,
      baseRef: request.baseRef,
      riskClass: request.riskClass,
      mode: request.mode,
      state: "active",
      createdAt: this.now(),
      dirty: false,
    });
  }

  async inspect(lease: WorktreeLease): Promise<WorktreeLease> {
    if (lease.state === "released") return lease;
    assertInsideRoot(this.rootDir, resolve(lease.worktreePath));
    const status = await this.options.runner.run(
      "git",
      ["-C", lease.worktreePath, "status", "--porcelain", "--untracked-files=all"],
    );
    this.assertSuccess(status, `Failed to inspect worktree ${lease.worktreePath}`);
    return Object.freeze({
      ...lease,
      dirty: status.stdout.trim().length > 0,
    });
  }

  async release(request: ReleaseWorktreeRequest): Promise<WorktreeLease> {
    const current = await this.inspect(request.lease);
    if (current.state === "released") return current;
    const dirty = current.dirty === true;

    if (dirty && (this.options.policy.retainDirtyWorktrees || request.forceDirty !== true)) {
      return Object.freeze({
        ...current,
        state: "retained",
        dirty: true,
      });
    }

    const args = ["-C", current.repositoryPath, "worktree", "remove"];
    if (dirty && request.forceDirty === true) args.push("--force");
    args.push(current.worktreePath);
    const remove = await this.options.runner.run("git", args);
    this.assertSuccess(remove, `Failed to release worktree ${current.worktreePath}`);

    if (request.deleteBranch === true) {
      const branchDelete = await this.options.runner.run(
        "git",
        ["-C", current.repositoryPath, "branch", "-d", current.branchName],
      );
      if (branchDelete.exitCode !== 0) {
        throw new Error(
          `Worktree ${current.worktreePath} was released but branch ${current.branchName} was retained: ${errorDetails(branchDelete)}`,
        );
      }
    }

    return Object.freeze({
      ...current,
      state: "released",
      releasedAt: this.now(),
      dirty,
    });
  }

  private validateCreateRequest(request: CreateWorktreeRequest): void {
    if (!request.runId.trim()) throw new Error("Worktree runId must not be empty");
    if (!request.repositoryPath.trim()) throw new Error("Worktree repositoryPath must not be empty");
    if (!request.baseRef.trim()) throw new Error("Worktree baseRef must not be empty");
    if (/^[\-]/.test(request.baseRef) || /[\0\r\n]/.test(request.baseRef)) {
      throw new Error("Worktree baseRef is not safe for git argument parsing");
    }
    if (request.mode === "mutate" && request.riskClass === "R0") {
      throw new Error("R0 is read-only and cannot create a mutation worktree");
    }
  }

  private async resolveRepositoryRoot(repositoryPath: string): Promise<string> {
    const input = resolve(repositoryPath);
    const result = await this.options.runner.run("git", ["-C", input, "rev-parse", "--show-toplevel"]);
    this.assertSuccess(result, `Not a usable Git repository: ${input}`);
    const root = resolve(firstLine(result.stdout));
    if (!isAbsolute(root)) throw new Error(`Git returned a non-absolute repository root: ${root}`);
    return root;
  }

  private async assertBaseRef(repositoryPath: string, baseRef: string): Promise<void> {
    const result = await this.options.runner.run(
      "git",
      ["-C", repositoryPath, "rev-parse", "--verify", `${baseRef}^{commit}`],
    );
    this.assertSuccess(result, `Base ref does not resolve to a commit: ${baseRef}`);
  }

  private async assertBranchName(repositoryPath: string, branchName: string): Promise<void> {
    if (!branchName || branchName.startsWith("-") || /[\0\r\n\s]/.test(branchName)) {
      throw new Error(`Unsafe worktree branch name: ${branchName}`);
    }
    const result = await this.options.runner.run(
      "git",
      ["-C", repositoryPath, "check-ref-format", "--branch", branchName],
    );
    this.assertSuccess(result, `Invalid worktree branch name: ${branchName}`);
  }

  private async listWorktrees(repositoryPath: string): Promise<readonly string[]> {
    const result = await this.options.runner.run(
      "git",
      ["-C", repositoryPath, "worktree", "list", "--porcelain"],
    );
    this.assertSuccess(result, `Failed to list worktrees for ${repositoryPath}`);
    return result.stdout
      .split(/\r?\n/)
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length).trim())
      .filter(Boolean);
  }

  private assertSuccess(result: CommandResult, message: string): void {
    if (result.exitCode === 0) return;
    throw new Error(`${message}: ${errorDetails(result)}`);
  }
}

function assertInsideRoot(rootDir: string, target: string): void {
  if (!isInside(rootDir, target) || samePath(rootDir, target)) {
    throw new Error(`Worktree path escapes managed root: ${target}`);
  }
}

function isInside(rootDir: string, target: string): boolean {
  const rel = relative(rootDir, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function samePath(a: string, b: string): boolean {
  return normalizeCase(a) === normalizeCase(b);
}

function normalizeCase(value: string): string {
  return /^[A-Za-z]:[\\/]/.test(value) ? value.toLowerCase() : value;
}

function slug(value: string): string {
  const safe = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/\.{2,}/g, ".")
    .slice(0, 48);
  if (!safe) throw new Error("Worktree identifier does not contain a safe path component");
  return safe;
}

function firstLine(value: string): string {
  const line = value.split(/\r?\n/, 1)[0]?.trim();
  if (!line) throw new Error("Git returned an empty response");
  return line;
}

function errorDetails(result: CommandResult): string {
  return (result.stderr || result.stdout || `exit ${result.exitCode}`).slice(0, 2_000);
}
