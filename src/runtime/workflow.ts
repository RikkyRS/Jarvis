import type { DatabaseSync } from "node:sqlite";
import type { OperationRequestInput, Principal, Trust, WorkflowRun } from "../domain/contracts.js";
import type { ExecutionGateway, ExecutionResult } from "../gateway/index.js";
import type { MissionBudget } from "../budget/index.js";
import type { DomainStore } from "../persistence/repositories.js";
import { DomainError } from "../persistence/repositories.js";

export class UnresolvedFailureError extends DomainError {
  constructor(readonly failures: { operationId: string; type: string; target: string }[]) {
    super(`Run has ${failures.length} unresolved failed operation(s); it cannot be completed.`);
    this.name = "UnresolvedFailureError";
  }
}

/**
 * Drives a Workflow Run through the gateway. Completion is derived from evidence in the
 * execution ledger, never from an agent's claim: a failed operation blocks delivery until a
 * later successful operation on the same target resolves it.
 */
export class WorkflowRuntime {
  constructor(
    private readonly db: DatabaseSync,
    private readonly store: DomainStore,
    private readonly gateway: ExecutionGateway,
    /** Decided by the human-owned project configuration; callers cannot override it. */
    private readonly trust: Trust = "UNTRUSTED",
    private readonly budget?: MissionBudget,
  ) {}

  /**
   * AWAITING_EXECUTION_APPROVAL -> RUNNING. Implementation never starts on its own: a human confirms
   * and the Mission must hold an authorized Execution allowance with budget left.
   */
  startExecution(runId: string, missionId: string, actor: Principal): WorkflowRun {
    if (actor.kind !== "human")
      throw new DomainError("Only a human can approve the start of execution.");
    if (!this.budget) throw new DomainError("No budget manager configured.");
    const status = this.budget.status(missionId, "EXECUTION");
    if (status.level === "NONE")
      throw new DomainError("The Mission has no authorized Execution Budget.");
    if (status.level === "EXHAUSTED")
      throw new DomainError("The Execution Budget is exhausted; an explicit grant is required.");
    return this.store.transitionRun(runId, "RUNNING", actor);
  }

  /** Executes one operation for a RUNNING run and checkpoints a failure instead of hiding it. */
  async run(
    runId: string,
    request: Omit<OperationRequestInput, "workflowRunId" | "projectId" | "workItemId">,
  ): Promise<ExecutionResult> {
    const run = this.store.getRun(runId);
    if (!run) throw new DomainError(`Unknown workflow run ${runId}.`);
    if (run.status !== "RUNNING")
      throw new DomainError(`Run is ${run.status}; operations require RUNNING.`);
    const result = await this.gateway.execute({
      ...request,
      projectId: run.projectId,
      workItemId: run.workItemId,
      workflowRunId: runId,
      trust: this.trust,
    });
    if (result.outcome === "FAILED") {
      this.store.saveCheckpoint(runId, {
        ...run.checkpoint,
        lastFailure: { operationId: result.operationId, reason: result.reason },
      });
    }
    return result;
  }

  unresolvedFailures(runId: string): { operationId: string; type: string; target: string }[] {
    return this.db
      .prepare(
        `SELECT f.operation_id AS operationId, f.type AS type, f.target AS target FROM executions f
         WHERE f.workflow_run_id = ? AND f.outcome = 'FAILED'
           AND NOT EXISTS (
             SELECT 1 FROM executions s
             WHERE s.workflow_run_id = f.workflow_run_id AND s.type = f.type AND s.target = f.target
               AND s.outcome = 'SUCCEEDED' AND s.rowid > f.rowid
           )`,
      )
      .all(runId) as { operationId: string; type: string; target: string }[];
  }

  /** RUNNING -> AWAITING_REVIEW only when the ledger shows no unresolved failure. */
  submitForReview(runId: string, actor: Principal): WorkflowRun {
    const failures = this.unresolvedFailures(runId);
    if (failures.length > 0) throw new UnresolvedFailureError(failures);
    const executed = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM executions WHERE workflow_run_id = ? AND outcome = 'SUCCEEDED'",
      )
      .get(runId) as {
      n: number;
    };
    if (executed.n === 0)
      throw new DomainError("Nothing was executed successfully; there is no evidence to review.");
    return this.store.transitionRun(runId, "AWAITING_REVIEW", actor);
  }

  /** Completion requires a human decision after review; the runtime never self-completes. */
  complete(runId: string, reviewer: Principal): WorkflowRun {
    if (reviewer.kind !== "human")
      throw new DomainError("Only a human can complete a reviewed run.");
    const failures = this.unresolvedFailures(runId);
    if (failures.length > 0) throw new UnresolvedFailureError(failures);
    return this.store.transitionRun(runId, "COMPLETED", reviewer);
  }

  /** Pause with a durable checkpoint, e.g. when the token budget is exhausted. */
  pause(runId: string, actor: Principal, reason: string): WorkflowRun {
    const run = this.store.getRun(runId);
    if (!run) throw new DomainError(`Unknown workflow run ${runId}.`);
    this.store.saveCheckpoint(runId, { ...run.checkpoint, pausedFor: reason });
    return this.store.transitionRun(runId, "PAUSED", actor);
  }
}
