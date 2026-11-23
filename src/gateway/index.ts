import type { DatabaseSync } from "node:sqlite";
import {
  OperationRequestSchema,
  type OperationRequest,
  type OperationRequestInput,
  type OperationType,
  type PolicyDecision,
  type RiskLevel,
} from "../domain/contracts.js";
import type { ApprovalService } from "../approval/service.js";
import type { AuditLog } from "../persistence/audit.js";
import { evaluatePolicy, type PolicyConfig } from "../policy/index.js";
import { systemClock, type Clock } from "../shared/clock.js";
import { PathEscapeError, canonicalizeTarget } from "./paths.js";
import type { ProcessRunner } from "./runner.js";

export type { ProcessRunner, ProcessSpec, ProcessResult } from "./runner.js";
export { HostRunner } from "./runner.js";
export { canonicalizeTarget, PathEscapeError } from "./paths.js";

/** Operations whose target is a project path; others (git refs) are validated by their handler. */
const PATH_TARGET_TYPES: ReadonlySet<OperationType> = new Set([
  "FILE_READ",
  "FILE_EDIT",
  "TEST_RUN",
  "GIT_STAGE",
]);
/** Operations that execute project-provided code and therefore need the trust check. */
const EXECUTES_PROJECT_CODE: ReadonlySet<OperationType> = new Set(["TEST_RUN"]);

export type HandlerContext = {
  request: OperationRequest;
  projectRoot: string;
  /** Canonical project-relative target for path operations; the raw target otherwise. */
  target: string;
  absoluteTarget: string | null;
  runner: ProcessRunner;
};

export type HandlerResult = { ok: boolean; evidence: Record<string, unknown> };
export type OperationHandler = (context: HandlerContext) => Promise<HandlerResult>;

export type Outcome = "SUCCEEDED" | "FAILED" | "BLOCKED" | "DENIED";

export type ExecutionResult = {
  operationId: string;
  outcome: Outcome;
  decision: PolicyDecision | null;
  risk: RiskLevel | null;
  reason: string;
  evidence: Record<string, unknown>;
};

export type GatewayOptions = {
  projectId: string;
  projectRoot: string;
  db: DatabaseSync;
  audit: AuditLog;
  approvals: ApprovalService;
  handlers: Partial<Record<OperationType, OperationHandler>>;
  hostRunner: ProcessRunner;
  /** Isolation container. Without it, untrusted code is blocked, never run on the host. */
  containerRunner?: ProcessRunner;
  policy?: PolicyConfig;
  clock?: Clock;
};

/**
 * The only route to side effects: validate, canonicalize, evaluate policy,
 * consume approval, run inside an isolation boundary, persist evidence.
 */
export class ExecutionGateway {
  private readonly clock: Clock;

  constructor(private readonly options: GatewayOptions) {
    this.clock = options.clock ?? systemClock;
  }

  /** Creates a PENDING approval bound to the canonical target the gateway will later execute. */
  requestApproval(input: OperationRequestInput, ttlMs: number) {
    const request = OperationRequestSchema.parse(input);
    const target = PATH_TARGET_TYPES.has(request.type)
      ? canonicalizeTarget(this.options.projectRoot, request.target).relative
      : request.target;
    return this.options.approvals.request({ ...request, target }, ttlMs);
  }

  async execute(input: OperationRequestInput): Promise<ExecutionResult> {
    const request = OperationRequestSchema.parse(input);
    const { audit, db } = this.options;
    const startedAt = this.clock().toISOString();

    const finish = (
      outcome: Outcome,
      reason: string,
      decision: PolicyDecision | null,
      risk: RiskLevel | null,
      evidence: Record<string, unknown> = {},
      target = request.target,
    ): ExecutionResult => {
      db.prepare(
        `INSERT OR IGNORE INTO executions (operation_id, project_id, workflow_run_id, type, target, decision,
           outcome, evidence, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        request.operationId,
        request.projectId,
        request.workflowRunId,
        request.type,
        target,
        decision ?? "NONE",
        outcome,
        JSON.stringify({ reason, ...evidence }),
        startedAt,
        this.clock().toISOString(),
      );
      audit.append({
        projectId: request.projectId,
        kind: `execution.${outcome.toLowerCase()}`,
        actor: request.requestedBy,
        subject: request.operationId,
        payload: { type: request.type, target, reason, risk },
      });
      return { operationId: request.operationId, outcome, decision, risk, reason, evidence };
    };

    if (request.projectId !== this.options.projectId) {
      return finish("DENIED", "PROJECT_MISMATCH", null, null);
    }
    const replay = db
      .prepare("SELECT 1 FROM executions WHERE operation_id = ?")
      .get(request.operationId);
    if (replay) {
      return finish("DENIED", "OPERATION_ALREADY_EXECUTED", null, null);
    }

    let target = request.target;
    let absoluteTarget: string | null = null;
    if (PATH_TARGET_TYPES.has(request.type)) {
      try {
        const canonical = canonicalizeTarget(this.options.projectRoot, request.target);
        target = canonical.relative;
        absoluteTarget = canonical.absolute;
      } catch (error) {
        if (error instanceof PathEscapeError) return finish("DENIED", "PATH_ESCAPE", null, null);
        throw error;
      }
    }
    // Approvals bind to the canonical target, so a different spelling of the same path still matches.
    const bound: OperationRequest = { ...request, target };

    const policy = evaluatePolicy(bound, this.options.policy);
    if (policy.decision === "BLOCKED") {
      return finish("BLOCKED", policy.reason, policy.decision, policy.risk, {}, target);
    }

    const handler = this.options.handlers[request.type];
    if (!handler) return finish("DENIED", "NO_HANDLER", policy.decision, policy.risk, {}, target);

    let runner: ProcessRunner = this.options.hostRunner;
    if (EXECUTES_PROJECT_CODE.has(request.type) && request.trust !== "TRUSTED") {
      if (!this.options.containerRunner) {
        return finish("BLOCKED", "ISOLATION_UNAVAILABLE", policy.decision, policy.risk, {}, target);
      }
      runner = this.options.containerRunner;
    }

    if (policy.decision === "APPROVAL_REQUIRED") {
      const consumed = this.options.approvals.consume(bound);
      if (!consumed.ok) {
        return finish(
          "DENIED",
          `APPROVAL_${consumed.reason}`,
          policy.decision,
          policy.risk,
          {},
          target,
        );
      }
    }

    audit.append({
      projectId: request.projectId,
      kind: "execution.started",
      actor: request.requestedBy,
      subject: request.operationId,
      payload: { type: request.type, target, isolation: runner.kind },
    });

    try {
      const result = await handler({
        request: bound,
        projectRoot: this.options.projectRoot,
        target,
        absoluteTarget,
        runner,
      });
      if (result.ok && Object.keys(result.evidence).length === 0) {
        return finish(
          "FAILED",
          "SUCCESS_WITHOUT_EVIDENCE",
          policy.decision,
          policy.risk,
          {},
          target,
        );
      }
      return finish(
        result.ok ? "SUCCEEDED" : "FAILED",
        result.ok ? "OK" : "HANDLER_REPORTED_FAILURE",
        policy.decision,
        policy.risk,
        { ...result.evidence, isolation: runner.kind },
        target,
      );
    } catch (error) {
      return finish(
        "FAILED",
        "HANDLER_ERROR",
        policy.decision,
        policy.risk,
        { error: error instanceof Error ? error.message : String(error) },
        target,
      );
    }
  }
}
