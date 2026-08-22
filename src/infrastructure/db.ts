import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { harnessRoot } from "./harness.js";
import { nowIso } from "../shared/util.js";
import { runMigrations } from "./migrations.js";
import type { CycleStatus } from "../shared/contracts.js";

export { LATEST_SCHEMA_VERSION } from "./migrations.js";

export type Json = unknown;

export type CycleRow = {
  id: string;
  uuid: string;
  number: number;
  slug: string;
  project_id: string;
  objective: string;
  status: CycleStatus;
  payload: string;
  created_at: string;
  updated_at: string;
};


export class Store {
  private constructor(
    readonly db: DatabaseSync,
    readonly projectId: string,
  ) {}

  static open(projectRoot: string): Store {
    const file = join(harnessRoot(projectRoot), "state", "jarvis.sqlite");
    mkdirSync(join(harnessRoot(projectRoot), "state"), { recursive: true });
    const db = new DatabaseSync(file);
    runMigrations(db);
    const existing = db.prepare("SELECT id FROM projects WHERE root = ?").get(projectRoot) as { id: string } | undefined;
    const projectId = existing?.id ?? `proj-${projectRoot.length}-${Buffer.from(projectRoot).toString("hex").slice(0, 12)}`;
    if (!existing) {
      db.prepare("INSERT INTO projects (id, root, created_at) VALUES (?, ?, ?)").run(projectId, projectRoot, nowIso());
    }
    const state = db.prepare("SELECT project_id FROM current_state WHERE project_id = ?").get(projectId);
    if (!state) {
      db.prepare("INSERT INTO current_state (project_id, current_cycle_id, payload, updated_at) VALUES (?, NULL, ?, ?)").run(
        projectId,
        "{}",
        nowIso(),
      );
    }
    return new Store(db, projectId);
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  nextCycleNumber(): number {
    const row = this.db.prepare("SELECT MAX(number) AS n FROM cycles WHERE project_id = ?").get(this.projectId) as {
      n: number | null;
    };
    return (row.n ?? 0) + 1;
  }

  insertCycle(row: CycleRow): void {
    this.db
      .prepare(
        `INSERT INTO cycles (id, uuid, number, slug, project_id, objective, status, payload, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.uuid,
        row.number,
        row.slug,
        row.project_id,
        row.objective,
        row.status,
        row.payload,
        row.created_at,
        row.updated_at,
      );
  }

  updateCycle(id: string, status: CycleStatus, payload: string): void {
    this.db
      .prepare("UPDATE cycles SET status = ?, payload = ?, updated_at = ? WHERE id = ?")
      .run(status, payload, nowIso(), id);
  }

  getCycle(id: string): CycleRow | undefined {
    return this.db.prepare("SELECT * FROM cycles WHERE id = ?").get(id) as CycleRow | undefined;
  }

  activeCycle(): CycleRow | undefined {
    const state = this.db.prepare("SELECT current_cycle_id FROM current_state WHERE project_id = ?").get(this.projectId) as
      | { current_cycle_id: string | null }
      | undefined;
    if (!state?.current_cycle_id) return undefined;
    return this.getCycle(state.current_cycle_id);
  }

  setCurrentCycle(cycleId: string | null): void {
    this.db
      .prepare("UPDATE current_state SET current_cycle_id = ?, updated_at = ? WHERE project_id = ?")
      .run(cycleId, nowIso(), this.projectId);
  }

  appendEvent(id: string, type: string, payload: Json, cycleId?: string): void {
    this.db
      .prepare("INSERT INTO events (id, cycle_id, type, payload, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, cycleId ?? null, type, JSON.stringify(payload), nowIso());
  }

  appendEvidence(id: string, cycleId: string, type: string, payload: Json): void {
    this.db
      .prepare("INSERT INTO evidence (id, cycle_id, type, payload, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, cycleId, type, JSON.stringify(payload), nowIso());
  }

  addCheckpoint(id: string, cycleId: string, reason: string, payload: Json): void {
    this.db
      .prepare("INSERT INTO checkpoints (id, cycle_id, reason, payload, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, cycleId, reason, JSON.stringify(payload), nowIso());
  }

  getLock(cycleId: string): { cycle_id: string; session_id: string; heartbeat_at: string; expires_at: string } | undefined {
    return this.db.prepare("SELECT * FROM locks WHERE cycle_id = ?").get(cycleId) as
      | { cycle_id: string; session_id: string; heartbeat_at: string; expires_at: string }
      | undefined;
  }

  upsertLock(cycleId: string, sessionId: string, heartbeatAt: string, expiresAt: string): void {
    this.db
      .prepare(
        `INSERT INTO locks (cycle_id, session_id, heartbeat_at, expires_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(cycle_id) DO UPDATE SET session_id = excluded.session_id, heartbeat_at = excluded.heartbeat_at, expires_at = excluded.expires_at`,
      )
      .run(cycleId, sessionId, heartbeatAt, expiresAt);
  }

  deleteLock(cycleId: string): void {
    this.db.prepare("DELETE FROM locks WHERE cycle_id = ?").run(cycleId);
  }

  addApproval(id: string, cycleId: string, command: string): void {
    this.db
      .prepare("INSERT INTO approvals (id, cycle_id, command, created_at) VALUES (?, ?, ?, ?)")
      .run(id, cycleId, command, nowIso());
  }

  addMemory(
    id: string,
    level: string,
    kind: string,
    payload: Json,
    confidence: string,
    cycleId?: string,
    dedupKey?: string,
  ): boolean {
    if (dedupKey) {
      const dup = this.db.prepare("SELECT id FROM memory WHERE dedup_key = ? LIMIT 1").get(dedupKey) as
        | { id: string }
        | undefined;
      if (dup) return false;
    }
    this.db
      .prepare(
        "INSERT INTO memory (id, level, kind, payload, confidence, cycle_id, dedup_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, level, kind, JSON.stringify(payload), confidence, cycleId ?? null, dedupKey ?? null, nowIso());
    return true;
  }

  listMemory(limit = 8): Array<{ id: string; level: string; kind: string; payload: string; confidence: string; cycle_id: string | null }> {
    return this.db
      .prepare("SELECT id, level, kind, payload, confidence, cycle_id FROM memory ORDER BY created_at DESC LIMIT ?")
      .all(limit) as Array<{
      id: string;
      level: string;
      kind: string;
      payload: string;
      confidence: string;
      cycle_id: string | null;
    }>;
  }

  recentEvents(cycleId: string, limit = 20): Array<{ type: string; payload: string; created_at: string }> {
    return this.db
      .prepare("SELECT type, payload, created_at FROM events WHERE cycle_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(cycleId, limit) as Array<{ type: string; payload: string; created_at: string }>;
  }

  listEvents(cycleId?: string, limit = 50): Array<{ type: string; payload: string; created_at: string; cycle_id: string | null }> {
    if (cycleId) {
      return this.db
        .prepare(
          "SELECT type, payload, created_at, cycle_id FROM events WHERE cycle_id = ? ORDER BY created_at DESC LIMIT ?",
        )
        .all(cycleId, limit) as Array<{ type: string; payload: string; created_at: string; cycle_id: string | null }>;
    }
    return this.db
      .prepare("SELECT type, payload, created_at, cycle_id FROM events ORDER BY created_at DESC LIMIT ?")
      .all(limit) as Array<{ type: string; payload: string; created_at: string; cycle_id: string | null }>;
  }
}

export function sqlitePath(projectRoot: string): string {
  return join(harnessRoot(projectRoot), "state", "jarvis.sqlite");
}
