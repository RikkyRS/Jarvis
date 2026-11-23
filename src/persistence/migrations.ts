import type { DatabaseSync } from "node:sqlite";

type Migration = { version: number; sql: string };

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  workflow_run_id TEXT NOT NULL,
  requested_by_kind TEXT NOT NULL,
  requested_by_id TEXT NOT NULL,
  type TEXT NOT NULL,
  target TEXT NOT NULL,
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
  status TEXT NOT NULL CHECK (status IN ('PENDING','APPROVED','CONSUMED','REJECTED','EXPIRED')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  decided_by TEXT,
  decided_at TEXT,
  consumed_at TEXT
);
CREATE INDEX idx_approvals_scope ON approvals(project_id, workflow_run_id, status);

CREATE TABLE audit_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  payload TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;

CREATE TABLE executions (
  operation_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  workflow_run_id TEXT NOT NULL,
  type TEXT NOT NULL,
  target TEXT NOT NULL,
  decision TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('SUCCEEDED','FAILED','BLOCKED','DENIED')),
  evidence TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL
);
`,
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

export function runMigrations(db: DatabaseSync): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  const row = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as {
    v: number | null;
  };
  const current = row.v ?? 0;
  if (current > LATEST_SCHEMA_VERSION) {
    throw new Error(
      `Database schema ${current} is newer than this runtime (${LATEST_SCHEMA_VERSION}).`,
    );
  }
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
        migration.version,
        new Date().toISOString(),
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}
