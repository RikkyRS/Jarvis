import type { DatabaseSync } from "node:sqlite";
import {
  ApprovalSchema,
  OperationRequestSchema,
  PrincipalSchema,
  type Approval,
  type OperationRequest,
  type OperationRequestInput,
  type Principal,
} from "../domain/contracts.js";
import { newId } from "../domain/ids.js";
import type { AuditLog } from "../persistence/audit.js";
import { inTransaction } from "../persistence/db.js";
import { fingerprint } from "../shared/canonical.js";
import { systemClock, type Clock } from "../shared/clock.js";

/** Everything an approval is bound to. Changing any field invalidates it. */
export function operationFingerprint(request: OperationRequest): string {
  return fingerprint({
    operationId: request.operationId,
    projectId: request.projectId,
    workItemId: request.workItemId,
    workflowRunId: request.workflowRunId,
    requestedBy: request.requestedBy,
    type: request.type,
    target: request.target,
    parameters: request.parameters,
  });
}

export type ConsumeFailure =
  "NOT_FOUND" | "NOT_APPROVED" | "ALREADY_CONSUMED" | "REJECTED" | "EXPIRED" | "MISMATCH";

export type ConsumeResult =
  { ok: true; approval: Approval } | { ok: false; reason: ConsumeFailure };

export class ApprovalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalError";
  }
}

type Row = {
  id: string;
  operation_id: string;
  project_id: string;
  work_item_id: string;
  workflow_run_id: string;
  requested_by_kind: string;
  requested_by_id: string;
  type: string;
  target: string;
  fingerprint: string;
  status: string;
  created_at: string;
  expires_at: string;
  decided_by: string | null;
  decided_at: string | null;
  consumed_at: string | null;
};

function toApproval(r: Row): Approval {
  return ApprovalSchema.parse({
    id: r.id,
    operationId: r.operation_id,
    projectId: r.project_id,
    workItemId: r.work_item_id,
    workflowRunId: r.workflow_run_id,
    requestedBy: { kind: r.requested_by_kind, id: r.requested_by_id },
    type: r.type,
    target: r.target,
    fingerprint: r.fingerprint,
    status: r.status,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    decidedBy: r.decided_by,
    decidedAt: r.decided_at,
    consumedAt: r.consumed_at,
  });
}

/**
 * Operation-specific, single-use approvals. Only a human principal can approve;
 * LLM output, prompts and client flags are never proof of approval.
 */
export class ApprovalService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly audit: AuditLog,
    private readonly clock: Clock = systemClock,
  ) {}

  request(input: OperationRequestInput, ttlMs: number): Approval {
    const request = OperationRequestSchema.parse(input);
    if (!Number.isFinite(ttlMs) || ttlMs <= 0)
      throw new ApprovalError("Approval TTL must be positive.");
    const now = this.clock();
    const id = newId("apr");
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
    inTransaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO approvals (id, operation_id, project_id, work_item_id, workflow_run_id,
             requested_by_kind, requested_by_id, type, target, fingerprint, status, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`,
        )
        .run(
          id,
          request.operationId,
          request.projectId,
          request.workItemId,
          request.workflowRunId,
          request.requestedBy.kind,
          request.requestedBy.id,
          request.type,
          request.target,
          operationFingerprint(request),
          createdAt,
          expiresAt,
        );
      this.audit.append({
        projectId: request.projectId,
        kind: "approval.requested",
        actor: request.requestedBy,
        subject: id,
        payload: { operationId: request.operationId, type: request.type, target: request.target },
      });
    });
    return this.get(id)!;
  }

  get(id: string): Approval | undefined {
    const row = this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as Row | undefined;
    return row ? toApproval(row) : undefined;
  }

  findByOperation(operationId: string): Approval | undefined {
    const row = this.db
      .prepare("SELECT * FROM approvals WHERE operation_id = ?")
      .get(operationId) as Row | undefined;
    return row ? toApproval(row) : undefined;
  }

  approve(id: string, approver: Principal): Approval {
    return this.decide(id, approver, "APPROVED");
  }

  reject(id: string, approver: Principal): Approval {
    return this.decide(id, approver, "REJECTED");
  }

  private decide(id: string, approverInput: Principal, to: "APPROVED" | "REJECTED"): Approval {
    const approver = PrincipalSchema.parse(approverInput);
    if (approver.kind !== "human") {
      throw new ApprovalError("Only a human principal can decide an approval.");
    }
    return inTransaction(this.db, () => {
      const current = this.get(id);
      if (!current) throw new ApprovalError("Approval not found.");
      const now = this.clock();
      if (current.status !== "PENDING")
        throw new ApprovalError(`Approval is ${current.status}, not PENDING.`);
      if (Date.parse(current.expiresAt) <= now.getTime()) {
        this.db
          .prepare("UPDATE approvals SET status='EXPIRED' WHERE id=? AND status='PENDING'")
          .run(id);
        this.audit.append({
          projectId: current.projectId,
          kind: "approval.expired",
          actor: approver,
          subject: id,
        });
        throw new ApprovalError("Approval has expired.");
      }
      const changes = this.db
        .prepare(
          "UPDATE approvals SET status=?, decided_by=?, decided_at=? WHERE id=? AND status='PENDING'",
        )
        .run(to, approver.id, now.toISOString(), id).changes;
      if (Number(changes) !== 1) throw new ApprovalError("Approval changed concurrently.");
      this.audit.append({
        projectId: current.projectId,
        kind: to === "APPROVED" ? "approval.approved" : "approval.rejected",
        actor: approver,
        subject: id,
        payload: { operationId: current.operationId },
      });
      return this.get(id)!;
    });
  }

  /**
   * Validates that `request` is exactly what was approved, then consumes the
   * approval atomically. A second call with the same approval always fails.
   */
  consume(requestInput: OperationRequestInput): ConsumeResult {
    const request = OperationRequestSchema.parse(requestInput);
    return inTransaction(this.db, () => {
      const approval = this.findByOperation(request.operationId);
      const fail = (reason: ConsumeFailure): ConsumeResult => {
        this.audit.append({
          projectId: request.projectId,
          kind: "approval.consume_denied",
          actor: request.requestedBy,
          subject: approval?.id ?? request.operationId,
          payload: { reason, type: request.type },
        });
        return { ok: false, reason };
      };
      if (!approval) return fail("NOT_FOUND");
      if (approval.status === "CONSUMED") return fail("ALREADY_CONSUMED");
      if (approval.status === "REJECTED") return fail("REJECTED");
      if (approval.status === "EXPIRED") return fail("EXPIRED");
      if (approval.status !== "APPROVED") return fail("NOT_APPROVED");
      const now = this.clock();
      if (Date.parse(approval.expiresAt) <= now.getTime()) {
        this.db
          .prepare("UPDATE approvals SET status='EXPIRED' WHERE id=? AND status='APPROVED'")
          .run(approval.id);
        return fail("EXPIRED");
      }
      if (
        approval.projectId !== request.projectId ||
        approval.workItemId !== request.workItemId ||
        approval.workflowRunId !== request.workflowRunId ||
        approval.type !== request.type ||
        approval.target !== request.target ||
        approval.requestedBy.kind !== request.requestedBy.kind ||
        approval.requestedBy.id !== request.requestedBy.id ||
        approval.fingerprint !== operationFingerprint(request)
      ) {
        return fail("MISMATCH");
      }
      const changes = this.db
        .prepare(
          "UPDATE approvals SET status='CONSUMED', consumed_at=? WHERE id=? AND status='APPROVED'",
        )
        .run(now.toISOString(), approval.id).changes;
      if (Number(changes) !== 1) return fail("ALREADY_CONSUMED");
      this.audit.append({
        projectId: request.projectId,
        kind: "approval.consumed",
        actor: request.requestedBy,
        subject: approval.id,
        payload: { operationId: request.operationId, type: request.type },
      });
      return { ok: true, approval: this.get(approval.id)! };
    });
  }
}
