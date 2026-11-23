import type { DatabaseSync } from "node:sqlite";
import { sha256Hex } from "../shared/canonical.js";
import type { AuditLog } from "./audit.js";
import { inTransaction } from "./db.js";

/**
 * Retention for OPERATIONAL data only. Critical records are never touched: the audit log, token
 * grants and usage ledger, plans, decisions and work items stay forever. Archived payloads keep
 * their identifiers, timestamps and a content hash, so decisions remain verifiable.
 */
export type RetentionResult = {
  inboxMessages: number;
  executions: number;
  reservations: number;
  approvalRequests: number;
};

type Row = Record<string, unknown>;

export function applyRetention(
  db: DatabaseSync,
  audit: AuditLog,
  options: { projectId: string; olderThanDays: number; now?: Date },
): RetentionResult {
  if (!Number.isFinite(options.olderThanDays) || options.olderThanDays < 1) {
    throw new Error("Retention period must be at least 1 day.");
  }
  const cutoff = new Date(
    (options.now ?? new Date()).getTime() - options.olderThanDays * 86_400_000,
  ).toISOString();
  return inTransaction(db, () => {
    let inbox = 0;
    const messages = db
      .prepare(
        "SELECT id, text FROM inbox_messages WHERE project_id = ? AND status != 'NEW' AND received_at < ? AND text NOT LIKE '[arquivado sha256:%'",
      )
      .all(options.projectId, cutoff) as Row[];
    for (const m of messages) {
      db.prepare("UPDATE inbox_messages SET text = ? WHERE id = ?").run(
        `[arquivado sha256:${sha256Hex(String(m["text"]))}]`,
        m["id"] as string,
      );
      inbox += 1;
    }

    // Only executions of finished runs: a live run still needs its evidence.
    let executions = 0;
    const rows = db
      .prepare(
        `SELECT e.operation_id, e.outcome, e.evidence FROM executions e
         JOIN workflow_runs r ON r.id = e.workflow_run_id
         WHERE e.project_id = ? AND e.finished_at < ? AND r.status IN ('COMPLETED','FAILED','CANCELLED')
           AND e.evidence NOT LIKE '{"archived":true%'`,
      )
      .all(options.projectId, cutoff) as Row[];
    for (const e of rows) {
      const raw = String(e["evidence"]);
      let reason: unknown;
      try {
        reason = (JSON.parse(raw) as { reason?: unknown }).reason ?? null;
      } catch {
        reason = null;
      }
      db.prepare("UPDATE executions SET evidence = ? WHERE operation_id = ?").run(
        JSON.stringify({ archived: true, sha256: sha256Hex(raw), outcome: e["outcome"], reason }),
        e["operation_id"] as string,
      );
      executions += 1;
    }

    const reservations = Number(
      db
        .prepare(
          `DELETE FROM token_reservations WHERE status IN ('SETTLED','RELEASED') AND created_at < ?
             AND mission_id IN (SELECT id FROM missions WHERE project_id = ?)`,
        )
        .run(cutoff, options.projectId).changes,
    );

    const approvalRequests = Number(
      db
        .prepare(
          `UPDATE approvals SET request_json = NULL
           WHERE project_id = ? AND status IN ('CONSUMED','REJECTED','EXPIRED') AND created_at < ? AND request_json IS NOT NULL`,
        )
        .run(options.projectId, cutoff).changes,
    );

    const result = { inboxMessages: inbox, executions, reservations, approvalRequests };
    audit.append({
      projectId: options.projectId,
      kind: "retention.applied",
      actor: { kind: "system", id: "retention" },
      subject: "operational-data",
      payload: { olderThanDays: options.olderThanDays, cutoff, ...result },
    });
    return result;
  });
}
