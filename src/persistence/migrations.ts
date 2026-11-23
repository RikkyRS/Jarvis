import type { DatabaseSync } from "node:sqlite";

type Migration = { version: number; sql: string };

const MIGRATIONS: Migration[] = [
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

MIGRATIONS.push({
  version: 2,
  sql: `
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE project_members (
  project_id TEXT NOT NULL REFERENCES projects(id),
  principal_id TEXT NOT NULL,
  permissions TEXT NOT NULL,
  granted_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, principal_id)
);

CREATE TABLE work_items (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  objective TEXT NOT NULL,
  requirements TEXT NOT NULL,
  acceptance_criteria TEXT NOT NULL,
  decisions TEXT NOT NULL,
  review_feedback TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('OPEN','IN_PROGRESS','DELIVERED','REOPENED','CLOSED')),
  reference_branch TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_work_items_project ON work_items(project_id, status);

CREATE TABLE workflow_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  work_item_id TEXT NOT NULL REFERENCES work_items(id),
  sequence INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PLANNED','PREPARING','AWAITING_EXECUTION_APPROVAL','RUNNING','PAUSED','AWAITING_REVIEW','COMPLETED','FAILED','CANCELLED')),
  branch TEXT,
  worktree_path TEXT,
  checkpoint TEXT NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (work_item_id, sequence)
);
CREATE INDEX idx_runs_item ON workflow_runs(work_item_id, status);

CREATE TABLE missions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  work_item_id TEXT REFERENCES work_items(id),
  owner_id TEXT NOT NULL,
  scope_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE mission_delegations (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id),
  admin_id TEXT NOT NULL,
  delegated_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT
);

CREATE TABLE token_grants (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id),
  phase TEXT NOT NULL CHECK (phase IN ('PREPARATION','EXECUTION')),
  kind TEXT NOT NULL CHECK (kind IN ('INITIAL','ADDITIONAL')),
  amount INTEGER NOT NULL CHECK (amount > 0),
  authorized_by TEXT NOT NULL,
  authorization_basis TEXT NOT NULL,
  scope_version INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TRIGGER token_grants_no_update BEFORE UPDATE ON token_grants
BEGIN SELECT RAISE(ABORT, 'token_grants is immutable'); END;
CREATE TRIGGER token_grants_no_delete BEFORE DELETE ON token_grants
BEGIN SELECT RAISE(ABORT, 'token_grants is immutable'); END;

CREATE TABLE token_reservations (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id),
  phase TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount >= 0),
  critical INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('RESERVED','SETTLED','RELEASED')),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_reservations_mission ON token_reservations(mission_id, phase, status);

CREATE TABLE token_usage (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id),
  phase TEXT NOT NULL,
  work_item_id TEXT,
  workflow_run_id TEXT,
  operation_id TEXT,
  agent TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('ESTIMATED','ACTUAL','UNAVAILABLE')),
  input_tokens INTEGER,
  output_tokens INTEGER,
  cached_input_tokens INTEGER,
  estimated_tokens INTEGER,
  charged_tokens INTEGER NOT NULL CHECK (charged_tokens >= 0),
  reservation_id TEXT,
  reconciles TEXT REFERENCES token_usage(id),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_usage_mission ON token_usage(mission_id, phase);
CREATE TRIGGER token_usage_no_update BEFORE UPDATE ON token_usage
BEGIN SELECT RAISE(ABORT, 'token_usage is append-only'); END;
CREATE TRIGGER token_usage_no_delete BEFORE DELETE ON token_usage
BEGIN SELECT RAISE(ABORT, 'token_usage is append-only'); END;
`,
});

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
