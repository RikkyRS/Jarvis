import type { DatabaseSync } from "node:sqlite";
import { nowIso } from "../shared/util.js";

type Migration = {
  version: number;
  up: (db: DatabaseSync) => void;
};

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: (db) => {
      db.exec(`
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  root TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cycles (
  id TEXT PRIMARY KEY,
  uuid TEXT NOT NULL,
  number INTEGER NOT NULL,
  slug TEXT NOT NULL,
  project_id TEXT NOT NULL,
  objective TEXT NOT NULL,
  status TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, number)
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  cycle_id TEXT,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  cycle_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS checkpoints (
  id TEXT PRIMARY KEY,
  cycle_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS locks (
  cycle_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  cycle_id TEXT NOT NULL,
  command TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory (
  id TEXT PRIMARY KEY,
  level TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  confidence TEXT NOT NULL,
  cycle_id TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS current_state (
  project_id TEXT PRIMARY KEY,
  current_cycle_id TEXT,
  payload TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`);
    },
  },
  {
    version: 2,
    up: (db) => {
      const cols = db.prepare("PRAGMA table_info(memory)").all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === "dedup_key")) {
        db.exec("ALTER TABLE memory ADD COLUMN dedup_key TEXT;");
      }
      db.exec("CREATE INDEX IF NOT EXISTS idx_memory_dedup ON memory(dedup_key);");
      db.exec("CREATE INDEX IF NOT EXISTS idx_memory_level ON memory(level);");
    },
  },
];

export function runMigrations(db: DatabaseSync): number {
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
`);
  let applied = 0;
  for (const migration of MIGRATIONS) {
    const row = db.prepare("SELECT version FROM schema_migrations WHERE version = ?").get(migration.version) as
      | { version: number }
      | undefined;
    if (row) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      migration.up(db);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(migration.version, nowIso());
      db.exec("COMMIT");
      applied += 1;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  return applied;
}

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 1;
