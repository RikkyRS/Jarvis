import { execFileSync } from "node:child_process";
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
import {
  AutonomyConfigSchema,
  DEFAULT_AUTONOMY,
  evaluateAutonomy,
  type AutonomyConfig,
} from "../autonomy/index.js";
import { autonomyFingerprint } from "../autonomy/index.js";
import { ContractStore } from "../contract/index.js";
import {
  failedFixAttempts,
  hasFailingTest,
  hasPassingTestAfterFix,
  isTestPath,
  MAX_FAILED_FIX_ATTEMPTS,
  missingChecks,
} from "../method/gates.js";
import { hardenDataDir } from "./privacy.js";
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
        "ruff",
        "mypy",
        "mvn",
        "gradle",
        "go",
        "cargo",
      ]),
    /** Checks that must have passed since the last change before anything is committed or submitted. */
    checks: z
      .array(
        z
          .object({
            name: z.string().min(1).max(40),
            command: z.string().min(1),
            args: z.array(z.string()).default([]),
          })
          .strict(),
      )
      .default([]),
    approvalTtlMs: z
      .number()
      .int()
      .positive()
      .default(15 * 60 * 1000),
    requireApproval: z.array(z.string()).default([]),
    /** How much JARVIS may do without asking. Edited only by the human; default SUPERVISED. */
    autonomy: AutonomyConfigSchema.default(DEFAULT_AUTONOMY),
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
  /** This project's contract, scope and delivery history. Humans add, agents only read. */
  readonly contract: ContractStore;
  readonly planning: Planning;
  readonly notes: Notes;
  readonly ai: AiRuntime | undefined;
  readonly project: Project;
  readonly config: ProjectConfig;
  readonly root: string;
  /** Where the learning journal is written. */
  readonly notesDir: string;
  readonly human: Principal;
  /** The effective policy (project configuration can only tighten it). */
  readonly policyConfig: PolicyConfig;

  private constructor(options: JarvisOptions) {
    if (options.human.kind !== "human")
      throw new Error("The installation owner must be a human principal.");
    this.root = realpathSync.native(options.root);
    this.human = options.human;
    const clock = options.clock ?? systemClock;
    const dir = join(this.root, ".jarvis");
    mkdirSync(dir, { recursive: true });
    hardenDataDir(dir);
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
    this.policyConfig = {
      ...options.policy,
      requireApproval: [
        ...(options.policy?.requireApproval ?? []),
        ...(this.config.requireApproval as never[]),
      ],
    };
    this.gateway = new ExecutionGateway({
      projectId: this.project.id,
      projectRoot: this.root,
      runGuard: (op) => this.runGuard(op),
      delegatedApproval: (op) => this.delegatedApproval(op),
      db: this.db,
      audit: this.audit,
      approvals: this.approvals,
      handlers: defaultHandlers(),
      hostRunner: new HostRunner(this.config.allowedCommands, { inheritHome: true }),
      ...(options.containerRunner ? { containerRunner: options.containerRunner } : {}),
      policy: this.policyConfig,
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
      (runId, workItemId) => this.qualityGate(runId, workItemId),
    );
    this.knowledge = new KnowledgeStore(this.root);
    this.contract = new ContractStore(this.db, this.audit, this.project.id);
    const notesDir =
      options.notesDir ??
      this.config.notesDir ??
      join(homedir(), "Jarvis-Notas", this.project.name.replace(/[^A-Za-z0-9._-]+/g, "-"));
    this.notesDir = notesDir;
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
    target?: string;
  }): string | null {
    const run = this.store.getRun(op.workflowRunId);
    if (!run || run.projectId !== op.projectId || run.workItemId !== op.workItemId)
      return "RUN_MISMATCH";
    if (op.type === "FILE_READ" || op.type === "GIT_INSPECT") {
      return ["COMPLETED", "FAILED", "CANCELLED"].includes(run.status) ? "RUN_FINISHED" : null;
    }
    if (run.status !== "RUNNING") return "RUN_NOT_EXECUTING";
    // A bug is fixed against a test that really failed first: the code is only touched once it is reproduced.
    if (op.type === "FILE_EDIT" && op.target && !isTestPath(op.target)) {
      const stored = this.planning.currentPlan(op.workItemId);
      if (
        stored?.status === "APPROVED" &&
        stored.plan.kind === "BUGFIX" &&
        !hasFailingTest(this.db, run.id)
      )
        return "BUGFIX_NEEDS_FAILING_TEST";
    }
    // Fix loop: after repeated failed attempts the code stays untouched until the human approves an amended plan.
    if (op.type === "FILE_EDIT" && op.target && !isTestPath(op.target)) {
      const approved = this.db
        .prepare(
          "SELECT approved_at FROM plans WHERE work_item_id = ? AND status = 'APPROVED' ORDER BY version DESC LIMIT 1",
        )
        .get(op.workItemId) as { approved_at: string | null } | undefined;
      if (
        failedFixAttempts(this.db, run.id, approved?.approved_at ?? null) >= MAX_FAILED_FIX_ATTEMPTS
      )
        return "FIX_LOOP_STOP:" + MAX_FAILED_FIX_ATTEMPTS;
    }
    // Nothing is committed while a mandatory check is red or stale.
    if (op.type === "GIT_COMMIT" && this.config.checks.length > 0) {
      const missing = missingChecks(this.db, run.id, this.config.checks);
      if (missing.length) return "CHECKS_NOT_PASSING:" + missing.join(",");
    }
    return null;
  }

  /** Why a run may not go to review yet (bug without a reproduced-then-green test, or a check not passing). */
  private qualityGate(runId: string, workItemId: string): string | null {
    const stored = this.planning.currentPlan(workItemId);
    if (stored?.status === "APPROVED" && stored.plan.kind === "BUGFIX") {
      if (!hasFailingTest(this.db, runId))
        return "A bug-fix needs a test that failed before the fix: none was recorded.";
      if (!hasPassingTestAfterFix(this.db, runId))
        return "A bug-fix needs a test that passes after the last change: none was recorded.";
    }
    const missing = missingChecks(this.db, runId, this.config.checks);
    if (missing.length)
      return "Mandatory checks not passing since the last change: " + missing.join(", ") + ".";
    return null;
  }

  /**
   * The human's delegation standing in for a commit approval. Only a LOCAL commit, only on a work
   * branch (never the default or a protected one), only when the owner allowed it, the approved plan
   * has a commit step, and the mandatory checks pass. Push and merge are never covered.
   */
  private delegatedApproval(op: {
    type: string;
    workItemId: string;
  }): { reason: string; evidence: Record<string, unknown> } | null {
    const cfg = this.config.autonomy;
    if (op.type !== "GIT_COMMIT" || cfg.level !== "INTERMEDIATE" || !cfg.allowLocalCommit)
      return null;
    const stored = this.planning.currentPlan(op.workItemId);
    if (
      !stored ||
      stored.status !== "APPROVED" ||
      !stored.plan.steps.some((s) => s.operations.includes("GIT_COMMIT"))
    )
      return null;
    const branch = this.currentBranch();
    if (!branch || this.isProtectedBranch(branch)) return null;
    return {
      reason: "DELEGATED_LOCAL_COMMIT",
      evidence: { branch, configFingerprint: autonomyFingerprint(cfg) },
    };
  }

  private currentBranch(): string | null {
    try {
      const out = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: this.root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      }).trim();
      return out && out !== "HEAD" ? out : null;
    } catch {
      return null;
    }
  }

  private isProtectedBranch(branch: string): boolean {
    if (/^(main|master|trunk|develop|development|production|prod|stable)$/i.test(branch))
      return true;
    if (/^(release|hotfix)[/]/i.test(branch)) return true;
    try {
      const head = execFileSync("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
        cwd: this.root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      }).trim();
      if (head.replace(/^origin[/]/, "") === branch) return true;
    } catch {
      // No remote default recorded: the name list above is the guard.
    }
    return false;
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

  /** The checks that must pass before a commit or a review. */
  get checks(): { name: string; command: string; args: string[] }[] {
    return this.config.checks;
  }

  /** The autonomy the human configured. SUPERVISED unless they changed `.jarvis/config.json`. */
  get autonomy(): AutonomyConfig {
    return this.config.autonomy;
  }

  /**
   * What the delegation would do for each Work Item right now, and why not when it would not.
   * Read-only: it changes nothing.
   */
  autonomyStatus(missionId: string): {
    level: AutonomyConfig["level"];
    items: { workItemId: string; title: string; eligible: boolean; reasons: string[] }[];
  } {
    const allowance = this.budget.status(missionId, "EXECUTION").allowance;
    const items = [];
    for (const item of this.store.listWorkItems(this.project.id)) {
      if (item.status === "CLOSED") continue;
      const current = this.planning.currentPlan(item.id);
      if (!current || current.status !== "DRAFT") continue;
      const verdict = evaluateAutonomy({
        plan: current.plan,
        estimate: current.estimate,
        readiness: this.planning.readiness(item.id),
        config: this.config.autonomy,
        policy: this.policyConfig,
        executionAllowance: allowance,
      });
      items.push({ workItemId: item.id, title: item.title, ...verdict });
    }
    return { level: this.config.autonomy.level, items };
  }

  /**
   * One pass of delegated work. For every draft plan that is eligible, approve it by delegation;
   * then start every run that is waiting on an approved plan. Run by the human (or on their schedule).
   * Anything above MEDIUM risk, or not eligible, is left for the human and reported with the reason.
   */
  autonomyTick(missionId: string): {
    approvedPlans: string[];
    startedRuns: string[];
    confirmedRequests: string[];
    waiting: { workItemId: string; reasons: string[] }[];
  } {
    const cfg = this.config.autonomy;
    const out = {
      approvedPlans: [] as string[],
      startedRuns: [] as string[],
      confirmedRequests: [] as string[],
      waiting: [] as { workItemId: string; reasons: string[] }[],
    };
    if (cfg.level !== "INTERMEDIATE") return out;

    if (cfg.autoConfirmInScope) {
      const intake = this.intake({ missionId, phase: "PREPARATION", allowedSenders: new Set() });
      for (const p of intake.listPending()) {
        try {
          out.confirmedRequests.push(intake.confirmByDelegation(p.id, cfg).workItemId);
        } catch {
          // Not an automatic case: it stays in the human's list.
        }
      }
    }

    const allowance = this.budget.status(missionId, "EXECUTION").allowance;
    for (const item of this.store.listWorkItems(this.project.id)) {
      if (item.status === "CLOSED") continue;
      const current = this.planning.currentPlan(item.id);
      if (current?.status === "DRAFT") {
        try {
          this.planning.approvePlanByDelegation(item.id, cfg, this.policyConfig, allowance);
          out.approvedPlans.push(item.id);
        } catch (error) {
          out.waiting.push({
            workItemId: item.id,
            reasons: [error instanceof Error ? error.message : String(error)],
          });
        }
      }
      for (const run of this.store.listRuns(item.id)) {
        if (run.status !== "AWAITING_EXECUTION_APPROVAL") continue;
        try {
          this.runtime.startExecutionByDelegation(run.id, missionId, cfg, this.policyConfig);
          out.startedRuns.push(run.id);
        } catch (error) {
          out.waiting.push({
            workItemId: item.id,
            reasons: [error instanceof Error ? error.message : String(error)],
          });
        }
      }
    }
    return out;
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
      contract: this.contract,
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
