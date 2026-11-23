import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { AiRuntime, type AiRuntimeConfig, type ProviderAdapter } from "../ai/index.js";
import { ApprovalService } from "../approval/service.js";
import { MissionBudget, type BudgetConfig } from "../budget/index.js";
import {
  OperationRequestSchema,
  type Approval,
  type OperationRequestInput,
  type Principal,
  type Project,
} from "../domain/contracts.js";
import {
  ExecutionGateway,
  HostRunner,
  PathEscapeError,
  type ExecutionResult,
  type ProcessRunner,
} from "../gateway/index.js";
import { defaultHandlers } from "../git/handlers.js";
import { Intake, type IntakeConfig } from "../intake/index.js";
import { KnowledgeStore } from "../knowledge/index.js";
import { Notes } from "../notes/index.js";
import { Planning } from "../planning/index.js";
import { AuditLog } from "../persistence/audit.js";
import { openDatabase } from "../persistence/db.js";
import { DomainStore } from "../persistence/repositories.js";
import type { PolicyConfig } from "../policy/index.js";
import { Scheduler, type SchedulerLimits } from "../runtime/scheduler.js";
import { WorkflowRuntime } from "../runtime/workflow.js";
import { systemClock, type Clock } from "../shared/clock.js";

/** Project-level configuration. A human edits `.jarvis/config.json`; agents cannot. */
export const ProjectConfigSchema = z
  .object({
    /** A human declaration that this repository's own scripts may run as host processes. Default: untrusted. */
    trustedProject: z.boolean().default(false),
    allowedCommands: z
      .array(z.string())
      .default([
        "git",
        "node",
        "npm",
        "npx",
        "pnpm",
        "yarn",
        "python",
        "python3",
        "pytest",
        "go",
        "cargo",
      ]),
    approvalTtlMs: z
      .number()
      .int()
      .positive()
      .default(15 * 60 * 1000),
    requireApproval: z.array(z.string()).default([]),
    /** Where the learning journal is written. Default: ~/Jarvis-Notas/<project>. */
    notesDir: z.string().optional(),
  })
  .strict();
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export type JarvisOptions = {
  root: string;
  /** The human operating this installation. */
  human: Principal;
  containerRunner?: ProcessRunner;
  providers?: ProviderAdapter[];
  policy?: PolicyConfig;
  budget?: BudgetConfig;
  limits?: SchedulerLimits;
  ai?: AiRuntimeConfig;
  clock?: Clock;
  dbFile?: string;
  /** Overrides the learning journal folder (tests, custom layouts). */
  notesDir?: string;
};

export type RequestOutcome =
  | { status: "EXECUTED"; result: ExecutionResult }
  | { status: "BLOCKED"; result: ExecutionResult }
  | {
      status: "APPROVAL_REQUIRED";
      approvalId: string;
      operationId: string;
      risk: string;
      summary: string;
    };

/** Typed Application API. CLI and MCP are thin adapters over this class; neither owns policy. */
export class Jarvis {
  readonly db;
  readonly audit: AuditLog;
  readonly store: DomainStore;
  readonly approvals: ApprovalService;
  readonly gateway: ExecutionGateway;
  readonly budget: MissionBudget;
  readonly scheduler: Scheduler;
  readonly runtime: WorkflowRuntime;
  readonly knowledge: KnowledgeStore;
  readonly planning: Planning;
  readonly notes: Notes;
  readonly ai: AiRuntime | undefined;
  readonly project: Project;
  readonly config: ProjectConfig;
  readonly root: string;
  readonly human: Principal;

  private constructor(options: JarvisOptions) {
    if (options.human.kind !== "human")
      throw new Error("The installation owner must be a human principal.");
    this.root = realpathSync.native(options.root);
    this.human = options.human;
    const clock = options.clock ?? systemClock;
    const dir = join(this.root, ".jarvis");
    mkdirSync(dir, { recursive: true });
    const configFile = join(dir, "config.json");
    this.config = ProjectConfigSchema.parse(
      existsSync(configFile) ? JSON.parse(readFileSync(configFile, "utf8")) : {},
    );
    this.db = openDatabase(options.dbFile ?? join(dir, "state.sqlite"));
    this.audit = new AuditLog(this.db, clock);
    this.store = new DomainStore(this.db, this.audit, clock);
    this.project =
      this.store.getProjectByRoot(this.root) ??
      this.store.createProject({
        name: this.root.split(/[\\/]/).filter(Boolean).pop() ?? "project",
        root: this.root,
        createdBy: options.human,
      });
    this.planning = new Planning(this.db, this.audit, this.store, clock, (id) =>
      this.refreshNotes(id),
    );
    this.store.onWorkItemTransition = (id) => this.refreshNotes(id);
    this.approvals = new ApprovalService(this.db, this.audit, clock);
    this.gateway = new ExecutionGateway({
      projectId: this.project.id,
      projectRoot: this.root,
      runGuard: (op) => this.runGuard(op),
      db: this.db,
      audit: this.audit,
      approvals: this.approvals,
      handlers: defaultHandlers(),
      hostRunner: new HostRunner(this.config.allowedCommands, { inheritHome: true }),
      ...(options.containerRunner ? { containerRunner: options.containerRunner } : {}),
      policy: {
        ...options.policy,
        requireApproval: [
          ...(options.policy?.requireApproval ?? []),
          ...(this.config.requireApproval as never[]),
        ],
      },
      clock,
    });
    this.budget = new MissionBudget(this.db, this.audit, this.store, options.budget, clock);
    this.scheduler = new Scheduler(options.limits);
    this.runtime = new WorkflowRuntime(
      this.db,
      this.store,
      this.gateway,
      this.config.trustedProject ? "TRUSTED" : "UNTRUSTED",
      this.budget,
      this.planning,
      (id) => this.refreshNotes(id),
    );
    this.knowledge = new KnowledgeStore(this.root);
    const notesDir =
      options.notesDir ??
      this.config.notesDir ??
      join(homedir(), "Jarvis-Notas", this.project.name.replace(/[^A-Za-z0-9._-]+/g, "-"));
    this.notes = new Notes(this.db, this.store, this.planning, this.knowledge, notesDir, {
      id: this.project.id,
      name: this.project.name,
    });
    this.ai = options.providers?.length
      ? new AiRuntime(options.providers, this.budget, this.scheduler, options.ai)
      : undefined;
  }

  static open(options: JarvisOptions): Jarvis {
    return new Jarvis(options);
  }

  /**
   * Operations belong to a Workflow Run. Reading and inspecting are fine while the run is alive;
   * anything that changes or executes needs a RUNNING run of the same Work Item, i.e. after the
   * plan was approved and execution was started by a human.
   */
  private runGuard(op: {
    projectId: string;
    workItemId: string;
    workflowRunId: string;
    type: string;
  }): string | null {
    const run = this.store.getRun(op.workflowRunId);
    if (!run || run.projectId !== op.projectId || run.workItemId !== op.workItemId)
      return "RUN_MISMATCH";
    if (op.type === "FILE_READ" || op.type === "GIT_INSPECT") {
      return ["COMPLETED", "FAILED", "CANCELLED"].includes(run.status) ? "RUN_FINISHED" : null;
    }
    return run.status === "RUNNING" ? null : "RUN_NOT_EXECUTING";
  }

  /** Regenerates the learning note for a Work Item. A journal failure is audited, never fatal. */
  refreshNotes(workItemId: string): string | null {
    try {
      return this.notes.refresh(workItemId);
    } catch (error) {
      this.audit.append({
        projectId: this.project.id,
        kind: "notes.failed",
        actor: { kind: "system", id: "notes" },
        subject: workItemId,
        payload: { error: error instanceof Error ? error.message : String(error) },
      });
      return null;
    }
  }

  /** Project analysis plus a refreshed overview in the journal. */
  scan(): ReturnType<KnowledgeStore["scan"]> {
    const result = this.knowledge.scan();
    this.notes.writeProjectOverview();
    this.notes.writeIndex();
    return result;
  }

  close(): void {
    this.db.close();
  }

  /** Human-side access to proposals; classification additionally needs an AI provider. */
  proposals(): Intake {
    return this.intake({ missionId: "", phase: "PREPARATION", allowedSenders: new Set() });
  }

  intake(config: Omit<IntakeConfig, "projectId">): Intake {
    return new Intake(this.db, this.audit, this.store, this.ai, {
      ...config,
      projectId: this.project.id,
    });
  }

  /**
   * Entry point for an operation requested by any client. The caller's own `trust` claim is
   * discarded: trust is decided by the human-owned project configuration only.
   */
  async request(
    requestedBy: Principal,
    input: Omit<OperationRequestInput, "requestedBy" | "projectId" | "trust">,
  ): Promise<RequestOutcome> {
    const op = OperationRequestSchema.parse({
      ...input,
      requestedBy,
      projectId: this.project.id,
      trust: this.config.trustedProject ? "TRUSTED" : "UNTRUSTED",
    });
    let pre: ReturnType<ExecutionGateway["preflight"]>;
    try {
      pre = this.gateway.preflight(op);
    } catch (error) {
      // Invalid targets (e.g. path escape) are refused and audited by the gateway itself.
      if (error instanceof PathEscapeError) {
        return { status: "EXECUTED", result: await this.gateway.execute(op) };
      }
      throw error;
    }
    if (pre.decision === "APPROVAL_REQUIRED") {
      const existing = this.approvals.findByOperation(op.operationId);
      if (!existing) {
        const approval = this.gateway.requestApproval(op, this.config.approvalTtlMs);
        return {
          status: "APPROVAL_REQUIRED",
          approvalId: approval.id,
          operationId: op.operationId,
          risk: pre.risk,
          summary: `${op.type} ${pre.target}`,
        };
      }
      if (existing.status === "PENDING") {
        return {
          status: "APPROVAL_REQUIRED",
          approvalId: existing.id,
          operationId: op.operationId,
          risk: pre.risk,
          summary: `${op.type} ${pre.target}`,
        };
      }
    }
    const result = await this.gateway.execute(op);
    return { status: result.outcome === "BLOCKED" ? "BLOCKED" : "EXECUTED", result };
  }

  /** Human decision channel. Never exposed to agents. */
  approve(approvalId: string): Approval {
    return this.approvals.approve(approvalId, this.human);
  }

  reject(approvalId: string): Approval {
    return this.approvals.reject(approvalId, this.human);
  }

  /** Executes exactly the stored, approved request; the gateway re-verifies the fingerprint. */
  async resume(operationId: string): Promise<ExecutionResult> {
    const approval = this.approvals.findByOperation(operationId);
    if (!approval) throw new Error("No approval exists for this operation.");
    const request = this.approvals.requestOf(approval.id);
    if (!request) throw new Error("Stored request is unavailable.");
    return this.gateway.execute(request);
  }

  pendingApprovals(): { approval: Approval; request: ReturnType<ApprovalService["requestOf"]> }[] {
    return this.approvals
      .listPending(this.project.id)
      .map((approval) => ({ approval, request: this.approvals.requestOf(approval.id) }));
  }

  status(): Record<string, unknown> {
    const items = this.store.listWorkItems(this.project.id);
    const byStatus: Record<string, number> = {};
    for (const i of items) byStatus[i.status] = (byStatus[i.status] ?? 0) + 1;
    return {
      project: { id: this.project.id, name: this.project.name, root: this.project.root },
      trustedProject: this.config.trustedProject,
      workItems: byStatus,
      pendingApprovals: this.approvals
        .listPending(this.project.id)
        .filter((a) => a.status === "PENDING").length,
      auditChain: this.audit.verify() === null ? "VERIFIED" : "BROKEN",
    };
  }
}
