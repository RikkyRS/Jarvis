import type { DatabaseSync } from "node:sqlite";
import type { Principal } from "../domain/contracts.js";
import { canonicalJson, sha256Hex } from "../shared/canonical.js";
import { systemClock, type Clock } from "../shared/clock.js";
import { inTransaction } from "./db.js";

const GENESIS = "0".repeat(64);

export type AuditInput = {
  projectId: string;
  kind: string;
  actor: Principal;
  subject: string;
  payload?: Record<string, unknown>;
};

export type AuditRecord = AuditInput & { seq: number; at: string; hash: string; prevHash: string };

type Row = {
  seq: number;
  at: string;
  project_id: string;
  kind: string;
  actor_kind: string;
  actor_id: string;
  subject: string;
  payload: string;
  prev_hash: string;
  hash: string;
};

function digest(
  prev: string,
  row: Pick<Row, "at" | "project_id" | "kind" | "actor_kind" | "actor_id" | "subject" | "payload">,
): string {
  return sha256Hex(
    prev +
      canonicalJson({
        at: row.at,
        project_id: row.project_id,
        kind: row.kind,
        actor_kind: row.actor_kind,
        actor_id: row.actor_id,
        subject: row.subject,
        payload: row.payload,
      }),
  );
}

/**
 * Append-only, hash-chained audit log. SQLite triggers reject UPDATE/DELETE;
 * the chain makes out-of-band tampering detectable. Payloads must be secret-free.
 */
export class AuditLog {
  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: Clock = systemClock,
  ) {}

  append(input: AuditInput): number {
    return inTransaction(this.db, () => {
      const last = this.db
        .prepare("SELECT hash FROM audit_events ORDER BY seq DESC LIMIT 1")
        .get() as { hash: string } | undefined;
      const prev = last?.hash ?? GENESIS;
      const body = {
        at: this.clock().toISOString(),
        project_id: input.projectId,
        kind: input.kind,
        actor_kind: input.actor.kind,
        actor_id: input.actor.id,
        subject: input.subject,
        payload: canonicalJson(input.payload ?? {}),
      };
      const hash = digest(prev, body);
      const result = this.db
        .prepare(
          `INSERT INTO audit_events (at, project_id, kind, actor_kind, actor_id, subject, payload, prev_hash, hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          body.at,
          body.project_id,
          body.kind,
          body.actor_kind,
          body.actor_id,
          body.subject,
          body.payload,
          prev,
          hash,
        );
      return Number(result.lastInsertRowid);
    });
  }

  list(projectId?: string): AuditRecord[] {
    const rows = (
      projectId
        ? this.db
            .prepare("SELECT * FROM audit_events WHERE project_id = ? ORDER BY seq")
            .all(projectId)
        : this.db.prepare("SELECT * FROM audit_events ORDER BY seq").all()
    ) as Row[];
    return rows.map((r) => ({
      seq: r.seq,
      at: r.at,
      projectId: r.project_id,
      kind: r.kind,
      actor: { kind: r.actor_kind as Principal["kind"], id: r.actor_id },
      subject: r.subject,
      payload: JSON.parse(r.payload) as Record<string, unknown>,
      prevHash: r.prev_hash,
      hash: r.hash,
    }));
  }

  /** Returns the first broken sequence number, or null if the whole chain verifies. */
  verify(): number | null {
    const rows = this.db.prepare("SELECT * FROM audit_events ORDER BY seq").all() as Row[];
    let prev = GENESIS;
    for (const row of rows) {
      if (row.prev_hash !== prev || digest(prev, row) !== row.hash) return row.seq;
      prev = row.hash;
    }
    return null;
  }
}
