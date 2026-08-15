import type { WorkflowPhase, WorkflowRun } from "./contracts.js";

const PHASES: readonly WorkflowPhase[] = [
  "start",
  "classify",
  "compile_context",
  "execute",
  "verify",
  "review",
  "approval",
  "publish",
];

export interface CreateWorkflowRunInput {
  readonly id: string;
  readonly projectId: string;
  readonly riskClass: WorkflowRun["riskClass"];
  readonly now?: string;
}

export class WorkflowStateMachine {
  create(input: CreateWorkflowRunInput): WorkflowRun {
    const now = input.now ?? new Date().toISOString();
    return {
      id: input.id,
      projectId: input.projectId,
      riskClass: input.riskClass,
      phase: "start",
      status: "queued",
      attempt: 0,
      approvalIds: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  start(run: WorkflowRun, now = new Date().toISOString()): WorkflowRun {
    this.assertStatus(run, ["queued"]);
    return this.patch(run, { status: "running", phase: "classify", attempt: 1 }, now);
  }

  advance(run: WorkflowRun, now = new Date().toISOString()): WorkflowRun {
    this.assertStatus(run, ["running", "retrying"]);
    const currentIndex = PHASES.indexOf(run.phase);
    if (currentIndex < 0 || currentIndex >= PHASES.length - 1) {
      throw new Error(`Workflow ${run.id} cannot advance beyond phase ${run.phase}`);
    }
    const nextPhase = PHASES[currentIndex + 1];
    if (nextPhase === "approval") {
      throw new Error("Approval phase must be entered through requestApproval()");
    }
    return this.patch(run, { status: "running", phase: nextPhase }, now);
  }

  requestApproval(run: WorkflowRun, now = new Date().toISOString()): WorkflowRun {
    this.assertStatus(run, ["running"]);
    if (run.phase !== "review") throw new Error("Approval can only be requested after review");
    return this.patch(run, { status: "waiting_approval", phase: "approval" }, now);
  }

  approve(run: WorkflowRun, approvalId: string, now = new Date().toISOString()): WorkflowRun {
    this.assertStatus(run, ["waiting_approval"]);
    if (run.phase !== "approval") throw new Error("Workflow is not in approval phase");
    if (!approvalId.trim()) throw new Error("approvalId must not be empty");
    return this.patch(
      run,
      {
        status: "running",
        phase: "publish",
        approvalIds: [...run.approvalIds, approvalId],
      },
      now,
    );
  }

  skipApproval(run: WorkflowRun, now = new Date().toISOString()): WorkflowRun {
    this.assertStatus(run, ["running"]);
    if (run.phase !== "review") throw new Error("Approval can only be skipped after review");
    return this.patch(run, { phase: "publish" }, now);
  }

  pause(run: WorkflowRun, now = new Date().toISOString()): WorkflowRun {
    this.assertStatus(run, ["running", "retrying"]);
    return this.patch(run, { status: "waiting_external" }, now);
  }

  resume(run: WorkflowRun, now = new Date().toISOString()): WorkflowRun {
    this.assertStatus(run, ["waiting_external"]);
    return this.patch(run, { status: "running" }, now);
  }

  retry(run: WorkflowRun, now = new Date().toISOString()): WorkflowRun {
    this.assertStatus(run, ["failed"]);
    return this.patch(
      run,
      { status: "retrying", attempt: run.attempt + 1, failureReason: undefined },
      now,
    );
  }

  recover(run: WorkflowRun, now = new Date().toISOString()): WorkflowRun {
    this.assertStatus(run, ["waiting_external", "retrying"]);
    return this.patch(run, { status: "running" }, now);
  }

  fail(run: WorkflowRun, reason: string, now = new Date().toISOString()): WorkflowRun {
    if (this.isTerminal(run)) throw new Error(`Workflow ${run.id} is already terminal`);
    if (!reason.trim()) throw new Error("Failure reason must not be empty");
    return this.patch(run, { status: "failed", failureReason: reason }, now);
  }

  cancel(run: WorkflowRun, now = new Date().toISOString()): WorkflowRun {
    if (this.isTerminal(run)) throw new Error(`Workflow ${run.id} is already terminal`);
    return this.patch(run, { status: "cancelled" }, now);
  }

  succeed(
    run: WorkflowRun,
    evidenceGatePassed: boolean,
    now = new Date().toISOString(),
  ): WorkflowRun {
    this.assertStatus(run, ["running"]);
    if (run.phase !== "publish") throw new Error("Workflow can only succeed from publish phase");
    if (!evidenceGatePassed) throw new Error("Evidence gate must pass before workflow success");
    return this.patch(run, { status: "succeeded" }, now);
  }

  private patch(
    run: WorkflowRun,
    changes: Partial<WorkflowRun>,
    updatedAt: string,
  ): WorkflowRun {
    return { ...run, ...changes, updatedAt };
  }

  private assertStatus(run: WorkflowRun, allowed: readonly WorkflowRun["status"][]): void {
    if (!allowed.includes(run.status)) {
      throw new Error(`Workflow ${run.id} is ${run.status}; expected ${allowed.join(" or ")}`);
    }
  }

  private isTerminal(run: WorkflowRun): boolean {
    return run.status === "failed" || run.status === "cancelled" || run.status === "succeeded";
  }
}
