import type { RiskClass } from "../control-plane/contracts.js";

export type WorkspaceMode = "read" | "mutate";
export type WorktreeState = "active" | "released" | "retained";

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandRunner {
  run(command: string, args: readonly string[], cwd?: string): Promise<CommandResult>;
}

export interface WorktreePolicy {
  readonly rootDir: string;
  readonly maxActiveWorktrees: number;
  readonly branchPrefix: string;
  readonly retainDirtyWorktrees: boolean;
}

export interface CreateWorktreeRequest {
  readonly runId: string;
  readonly repositoryPath: string;
  readonly baseRef: string;
  readonly riskClass: RiskClass;
  readonly mode: WorkspaceMode;
  readonly branchName?: string;
}

export interface WorktreeLease {
  readonly id: string;
  readonly runId: string;
  readonly repositoryPath: string;
  readonly worktreePath: string;
  readonly branchName: string;
  readonly baseRef: string;
  readonly riskClass: RiskClass;
  readonly mode: WorkspaceMode;
  readonly state: WorktreeState;
  readonly createdAt: string;
  readonly releasedAt?: string;
  readonly dirty?: boolean;
}

export interface ReleaseWorktreeRequest {
  readonly lease: WorktreeLease;
  readonly deleteBranch?: boolean;
}

export interface WorkspaceManager {
  create(request: CreateWorktreeRequest): Promise<WorktreeLease>;
  release(request: ReleaseWorktreeRequest): Promise<WorktreeLease>;
  inspect(lease: WorktreeLease): Promise<WorktreeLease>;
}
