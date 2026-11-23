import type { DatabaseSync } from "node:sqlite";
import {
  ProjectSchema,
  WorkItemSchema,
  WorkflowRunSchema,
  type Principal,
  type Project,
  type ProjectPermission,
  type WorkItem,
  type WorkItemStatus,
  type WorkflowRun,
  type WorkflowRunStatus,
} from "../domain/contracts.js";
import { newId } from "../domain/ids.js";
import { transitionItem, transitionRun } from "../domain/workflow.js";
import { systemClock, type Clock } from "../shared/clock.js";
import type { AuditLog } from "./audit.js";
import { inTransaction } from "./db.js";

export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainError";
  }
}

export class ConflictError extends DomainError {
  constructor(entity: string, id: string) {
    super(`${entity} ${id} was modified concurrently.`);
    this.name = "ConflictError";
  }
}

type Row = Record<string, unknown>;
const json = <T>(value: unknown): T => JSON.parse(String(value)) as T;

/** Durable domain state: Project -> Work Item -> Workflow Run. Every transition is audited. */
export class DomainStore {
  constructor(
    readonly db: DatabaseSync,
    readonly audit: AuditLog,
    private readonly clock: Clock = systemClock,
  ) {}

  private now(): string {
    return this.clock().toISOString();
  }

  // --- projects & membership -------------------------------------------------

  createProject(input: { name: string; root: string; createdBy: Principal }): Project {
    if (input.createdBy.kind !== "human")
      throw new DomainError("Only a human can create a project.");
    const id = newId("prj");
    const at = this.now();
    inTransaction(this.db, () => {
      this.db
        .prepare(
          "INSERT INTO projects (id, name, root, created_by, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(id, input.name, input.root, input.createdBy.id, at);
      this.db
        .prepare(
          "INSERT INTO project_members (project_id, principal_id, permissions, granted_by, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(
          id,
          input.createdBy.id,
          JSON.stringify(["project.admin", "mission.grant"]),
          input.createdBy.id,
          at,
        );
      this.audit.append({
        projectId: id,
        kind: "project.created",
        actor: input.createdBy,
        subject: id,
      });
    });
    return this.getProject(id)!;
  }

  getProject(id: string): Project | undefined {
    const r = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Row | undefined;
    return r
      ? ProjectSchema.parse({
          id: r.id,
          name: r.name,
          root: r.root,
          createdBy: r.created_by,
          createdAt: r.created_at,
        })
      : undefined;
  }

  getProjectByRoot(root: string): Project | undefined {
    const r = this.db.prepare("SELECT id FROM projects WHERE root = ?").get(root) as
      { id: string } | undefined;
    return r ? this.getProject(r.id) : undefined;
  }

  permissionsOf(projectId: string, principalId: string): ProjectPermission[] {
    const r = this.db
      .prepare("SELECT permissions FROM project_members WHERE project_id = ? AND principal_id = ?")
      .get(projectId, principalId) as { permissions: string } | undefined;
    return r ? json<ProjectPermission[]>(r.permissions) : [];
  }

  /** Requires project.admin; an administrator cannot change their own permissions. */
  setPermissions(
    projectId: string,
    actor: Principal,
    targetId: string,
    permissions: ProjectPermission[],
  ): void {
    if (actor.kind !== "human") throw new DomainError("Only a human can change permissions.");
    if (actor.id === targetId) throw new DomainError("Nobody can change their own permissions.");
    if (!this.permissionsOf(projectId, actor.id).includes("project.admin")) {
      throw new DomainError("project.admin permission required.");
    }
    inTransaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO project_members (project_id, principal_id, permissions, granted_by, created_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(project_id, principal_id) DO UPDATE SET permissions = excluded.permissions, granted_by = excluded.granted_by`,
        )
        .run(projectId, targetId, JSON.stringify(permissions), actor.id, this.now());
      this.audit.append({
        projectId,
        kind: "permissions.changed",
        actor,
        subject: targetId,
        payload: { permissions },
      });
    });
  }

  // --- work items ------------------------------------------------------------

  createWorkItem(input: {
    projectId: string;
    actor: Principal;
    title: string;
    objective: string;
    requirements?: string[];
    acceptanceCriteria?: string[];
  }): WorkItem {
    if (!this.getProject(input.projectId)) throw new DomainError("Unknown project.");
    const id = newId("wi");
    const at = this.now();
    inTransaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO work_items (id, project_id, title, objective, requirements, acceptance_criteria, decisions,
             review_feedback, status, reference_branch, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, '[]', '[]', 'OPEN', ?, 1, ?, ?)`,
        )
        .run(
          id,
          input.projectId,
          input.title,
          input.objective,
          JSON.stringify(input.requirements ?? []),
          JSON.stringify(input.acceptanceCriteria ?? []),
          `jarvis/${id}`,
          at,
          at,
        );
      this.audit.append({
        projectId: input.projectId,
        kind: "work_item.created",
        actor: input.actor,
        subject: id,
      });
    });
    return this.getWorkItem(id)!;
  }

  getWorkItem(id: string): WorkItem | undefined {
    const r = this.db.prepare("SELECT * FROM work_items WHERE id = ?").get(id) as Row | undefined;
    return r ? this.toItem(r) : undefined;
  }

  listWorkItems(projectId: string): WorkItem[] {
    return (
      this.db
        .prepare("SELECT * FROM work_items WHERE project_id = ? ORDER BY created_at")
        .all(projectId) as Row[]
    ).map((r) => this.toItem(r));
  }

  private toItem(r: Row): WorkItem {
    return WorkItemSchema.parse({
      id: r.id,
      projectId: r.project_id,
      title: r.title,
      objective: r.objective,
      requirements: json(r.requirements),
      acceptanceCriteria: json(r.acceptance_criteria),
      decisions: json(r.decisions),
      reviewFeedback: json(r.review_feedback),
      status: r.status,
      referenceBranch: r.reference_branch,
      version: r.version,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    });
  }

  addDecision(workItemId: string, actor: Principal, decision: string): WorkItem {
    return this.mutateItemList(
      workItemId,
      actor,
      "decisions",
      decision,
      "work_item.decision_recorded",
    );
  }

  addReviewFeedback(workItemId: string, actor: Principal, feedback: string): WorkItem {
    return this.mutateItemList(
      workItemId,
      actor,
      "review_feedback",
      feedback,
      "work_item.feedback_recorded",
    );
  }

  private mutateItemList(
    id: string,
    actor: Principal,
    column: "decisions" | "review_feedback",
    value: string,
    kind: string,
  ): WorkItem {
    return inTransaction(this.db, () => {
      const item = this.requireItem(id);
      const list = column === "decisions" ? item.decisions : item.reviewFeedback;
      this.db
        .prepare(
          `UPDATE work_items SET ${column} = ?, version = version + 1, updated_at = ? WHERE id = ?`,
        )
        .run(JSON.stringify([...list, value]), this.now(), id);
      this.audit.append({
        projectId: item.projectId,
        kind,
        actor,
        subject: id,
        payload: { value },
      });
      return this.getWorkItem(id)!;
    });
  }

  transitionWorkItem(
    id: string,
    to: WorkItemStatus,
    actor: Principal,
    expectedVersion?: number,
  ): WorkItem {
    return inTransaction(this.db, () => {
      const item = this.requireItem(id);
      if (expectedVersion !== undefined && item.version !== expectedVersion)
        throw new ConflictError("WorkItem", id);
      transitionItem(item.status, to);
      this.db
        .prepare(
          "UPDATE work_items SET status = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?",
        )
        .run(to, this.now(), id, item.version);
      this.audit.append({
        projectId: item.projectId,
        kind: "work_item.transitioned",
        actor,
        subject: id,
        payload: { from: item.status, to },
      });
      return this.getWorkItem(id)!;
    });
  }

  private requireItem(id: string): WorkItem {
    const item = this.getWorkItem(id);
    if (!item) throw new DomainError(`Unknown work item ${id}.`);
    return item;
  }

  // --- workflow runs ---------------------------------------------------------

  /**
   * Starts a new attempt for a Work Item. A reopened or delivered item keeps all
   * its requirements, decisions and feedback; the run only adds a fresh sequence number.
   */
  createRun(workItemId: string, actor: Principal): WorkflowRun {
    return inTransaction(this.db, () => {
      const item = this.requireItem(workItemId);
      const active = this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM workflow_runs WHERE work_item_id = ? AND status NOT IN ('COMPLETED','FAILED','CANCELLED')",
        )
        .get(workItemId) as { n: number };
      if (active.n > 0) throw new DomainError("Work item already has an active workflow run.");
      if (item.status === "CLOSED")
        throw new DomainError("Closed work items must be reopened first.");
      const seq = (
        this.db
          .prepare(
            "SELECT COALESCE(MAX(sequence), 0) + 1 AS n FROM workflow_runs WHERE work_item_id = ?",
          )
          .get(workItemId) as { n: number }
      ).n;
      const id = newId("run");
      const at = this.now();
      this.db
        .prepare(
          `INSERT INTO workflow_runs (id, project_id, work_item_id, sequence, status, branch, worktree_path, checkpoint, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'PLANNED', ?, NULL, '{}', 1, ?, ?)`,
        )
        .run(id, item.projectId, workItemId, seq, `${item.referenceBranch}/run-${seq}`, at, at);
      this.audit.append({
        projectId: item.projectId,
        kind: "workflow_run.created",
        actor,
        subject: id,
        payload: { workItemId, sequence: seq },
      });
      return this.getRun(id)!;
    });
  }

  getRun(id: string): WorkflowRun | undefined {
    const r = this.db.prepare("SELECT * FROM workflow_runs WHERE id = ?").get(id) as
      Row | undefined;
    return r ? this.toRun(r) : undefined;
  }

  listRuns(workItemId: string): WorkflowRun[] {
    return (
      this.db
        .prepare("SELECT * FROM workflow_runs WHERE work_item_id = ? ORDER BY sequence")
        .all(workItemId) as Row[]
    ).map((r) => this.toRun(r));
  }

  private toRun(r: Row): WorkflowRun {
    return WorkflowRunSchema.parse({
      id: r.id,
      projectId: r.project_id,
      workItemId: r.work_item_id,
      sequence: r.sequence,
      status: r.status,
      branch: r.branch,
      worktreePath: r.worktree_path,
      checkpoint: json(r.checkpoint),
      version: r.version,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    });
  }

  transitionRun(
    id: string,
    to: WorkflowRunStatus,
    actor: Principal,
    expectedVersion?: number,
  ): WorkflowRun {
    return inTransaction(this.db, () => {
      const run = this.getRun(id);
      if (!run) throw new DomainError(`Unknown workflow run ${id}.`);
      if (expectedVersion !== undefined && run.version !== expectedVersion)
        throw new ConflictError("WorkflowRun", id);
      transitionRun(run.status, to);
      this.db
        .prepare(
          "UPDATE workflow_runs SET status = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?",
        )
        .run(to, this.now(), id, run.version);
      this.audit.append({
        projectId: run.projectId,
        kind: "workflow_run.transitioned",
        actor,
        subject: id,
        payload: { from: run.status, to },
      });
      return this.getRun(id)!;
    });
  }

  /** Durable checkpoint so a restart resumes from data, never from chat history. */
  saveCheckpoint(id: string, checkpoint: Record<string, unknown>): WorkflowRun {
    return inTransaction(this.db, () => {
      const run = this.getRun(id);
      if (!run) throw new DomainError(`Unknown workflow run ${id}.`);
      this.db
        .prepare(
          "UPDATE workflow_runs SET checkpoint = ?, version = version + 1, updated_at = ? WHERE id = ?",
        )
        .run(JSON.stringify(checkpoint), this.now(), id);
      return this.getRun(id)!;
    });
  }

  attachWorktree(id: string, worktreePath: string, branch: string): WorkflowRun {
    return inTransaction(this.db, () => {
      const run = this.getRun(id);
      if (!run) throw new DomainError(`Unknown workflow run ${id}.`);
      this.db
        .prepare(
          "UPDATE workflow_runs SET worktree_path = ?, branch = ?, version = version + 1, updated_at = ? WHERE id = ?",
        )
        .run(worktreePath, branch, this.now(), id);
      return this.getRun(id)!;
    });
  }

  /** Runs left RUNNING by a crashed process: explicit recovery to PAUSED, never silent. */
  recoverInterruptedRuns(actor: Principal): WorkflowRun[] {
    const rows = this.db.prepare("SELECT id FROM workflow_runs WHERE status = 'RUNNING'").all() as {
      id: string;
    }[];
    return rows.map((r) => this.transitionRun(r.id, "PAUSED", actor));
  }
}
