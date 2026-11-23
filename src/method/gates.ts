import type { DatabaseSync } from "node:sqlite";

/**
 * Evidence-based quality gates. Everything here is read from the execution ledger (what really
 * ran and how it ended), never from an agent's claim.
 */

export type CheckSpec = { name: string; command: string; args: string[] };

/** A path that holds tests: editing it never needs a failing test first (it is how one is written). */
export function isTestPath(path: string): boolean {
  const p = path.split("\\").join("/");
  return (
    /(^|\/)(tests?|__tests__|specs?)\//i.test(p) ||
    /\.(test|spec)\.[a-z0-9]+$/i.test(p) ||
    /(^|\/)test_[^/]+\.py$/i.test(p) ||
    /_test\.(py|go)$/i.test(p) ||
    /(^|\/)conftest\.py$/i.test(p) ||
    /Tests?\.(java|kt|cs)$/.test(p)
  );
}

type ExecRow = { type: string; outcome: string; evidence: string; finished_at: string };

function rows(db: DatabaseSync, runId: string): ExecRow[] {
  return db
    .prepare(
      "SELECT type, outcome, evidence, finished_at FROM executions WHERE workflow_run_id = ? ORDER BY finished_at, rowid",
    )
    .all(runId) as ExecRow[];
}

/** When the last file change or staging succeeded in this run, or null. */
export function lastChangeAt(db: DatabaseSync, runId: string): string | null {
  const changes = rows(db, runId).filter(
    (r) => r.outcome === "SUCCEEDED" && (r.type === "FILE_EDIT" || r.type === "GIT_STAGE"),
  );
  return changes.length ? changes[changes.length - 1]!.finished_at : null;
}

/** A test that really ran and failed in this run (the bug, reproduced) before the fix. */
export function hasFailingTest(db: DatabaseSync, runId: string): boolean {
  return rows(db, runId).some((r) => r.type === "TEST_RUN" && r.outcome === "FAILED");
}

function evidenceOf(row: ExecRow): { command?: string; args?: string[] } {
  try {
    return JSON.parse(row.evidence) as { command?: string; args?: string[] };
  } catch {
    return {};
  }
}

/** Passing test runs recorded after the last change. */
function passingAfterLastChange(db: DatabaseSync, runId: string): ExecRow[] {
  const changed = lastChangeAt(db, runId);
  return rows(db, runId).filter(
    (r) =>
      r.type === "TEST_RUN" &&
      r.outcome === "SUCCEEDED" &&
      (changed === null || r.finished_at >= changed),
  );
}

/** For a bug fix: some test passes after the last change. */
export function hasPassingTestAfterFix(db: DatabaseSync, runId: string): boolean {
  return passingAfterLastChange(db, runId).length > 0;
}

/** Which mandatory checks have NOT passed since the last change. */
export function missingChecks(
  db: DatabaseSync,
  runId: string,
  checks: readonly CheckSpec[],
): string[] {
  const passed = passingAfterLastChange(db, runId).map(evidenceOf);
  return checks
    .filter(
      (c) =>
        !passed.some(
          (e) => e.command === c.command && JSON.stringify(e.args ?? []) === JSON.stringify(c.args),
        ),
    )
    .map((c) => c.name);
}
