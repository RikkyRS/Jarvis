import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApprovalService } from "../../src/approval/service.js";
import { KnowledgeStore } from "../../src/knowledge/index.js";
import { AuditLog } from "../../src/persistence/audit.js";
import { LATEST_SCHEMA_VERSION, openDatabase } from "../../src/persistence/db.js";
import { agent, cleanup, human, makeRepo, nextId, openJarvis, writeConfig } from "../helpers.js";

let root: string;
beforeEach(() => {
  root = makeRepo();
  writeConfig(root, { trustedProject: true });
});
afterEach(() => cleanup(root));

describe("restart recovery", () => {
  it("[R-RECOVERY-01] workflow state, approvals and budgets survive a process restart", async () => {
    let jarvis = openJarvis(root);
    const item = jarvis.store.createWorkItem({
      projectId: jarvis.project.id,
      actor: human,
      title: "t",
      objective: "o",
    });
    const run = jarvis.store.createRun(item.id, agent);
    for (const s of ["PREPARING", "AWAITING_EXECUTION_APPROVAL", "RUNNING"] as const)
      jarvis.store.transitionRun(run.id, s, human);
    jarvis.store.saveCheckpoint(run.id, { step: 3 });
    const mission = jarvis.budget.createMission({ projectId: jarvis.project.id, owner: human });
    jarvis.budget.grant({
      missionId: mission,
      phase: "EXECUTION",
      amount: 900,
      actor: human,
      reason: "r",
    });
    const gate = await jarvis.request(agent, {
      operationId: nextId(),
      workItemId: item.id,
      workflowRunId: run.id,
      type: "GIT_COMMIT",
      target: "main",
      parameters: { message: "m", diffHash: "c".repeat(64) },
    });
    if (gate.status !== "APPROVAL_REQUIRED") throw new Error("gate expected");
    jarvis.close(); // simulate a crash/restart

    jarvis = openJarvis(root);
    expect(jarvis.store.getRun(run.id)).toMatchObject({
      status: "RUNNING",
      checkpoint: { step: 3 },
    });
    expect(jarvis.budget.status(mission, "EXECUTION").allowance).toBe(900);
    expect(jarvis.approvals.get(gate.approvalId)?.status).toBe("PENDING");

    // Interrupted RUNNING work is moved to PAUSED explicitly, never silently resumed or dropped.
    const recovered = jarvis.store.recoverInterruptedRuns({ kind: "system", id: "recovery" });
    expect(recovered.map((r) => r.status)).toEqual(["PAUSED"]);
    expect(
      jarvis.audit
        .list()
        .some((e) => e.kind === "workflow_run.transitioned" && e.actor.id === "recovery"),
    ).toBe(true);
    expect(jarvis.audit.verify()).toBeNull();
    jarvis.close();
  });

  it("[R-RECOVERY-02] a tampered audit log is detected after restart", () => {
    const first = openJarvis(root);
    first.store.createWorkItem({
      projectId: first.project.id,
      actor: human,
      title: "t",
      objective: "o",
    });
    first.close();
    const raw = new DatabaseSync(join(root, ".jarvis", "state.sqlite"));
    raw.exec("DROP TRIGGER audit_no_update");
    raw.exec("UPDATE audit_events SET actor_id = 'someone-else' WHERE seq = 2");
    raw.close();
    const second = openJarvis(root);
    expect(second.audit.verify()).toBe(2);
    expect(second.status()["auditChain"]).toBe("BROKEN");
    second.close();
  });

  it("refuses a database written by a newer runtime", () => {
    const file = join(mkdtempSync(join(tmpdir(), "jarvis-db-")), "s.sqlite");
    const db = openDatabase(file);
    db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
      LATEST_SCHEMA_VERSION + 1,
      "x",
    );
    db.close();
    expect(() => openDatabase(file)).toThrow(/newer than this runtime/);
  });

  it("an interrupted knowledge write never corrupts the stored document", () => {
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "x" }));
    const kb = new KnowledgeStore(root);
    kb.scan();
    const dir = join(root, ".jarvis", "knowledge");
    writeFileSync(join(dir, "claims.json.99999.tmp"), "{ half written"); // leftover from a crashed writer
    expect(kb.load().length).toBeGreaterThan(0);
    expect(readdirSync(dir)).toContain("claims.json");
  });
});

describe("concurrency", () => {
  it("[R-BUDGET-02] two connections cannot reserve the same remaining tokens", () => {
    const jarvis = openJarvis(root);
    const mission = jarvis.budget.createMission({ projectId: jarvis.project.id, owner: human });
    jarvis.budget.grant({
      missionId: mission,
      phase: "EXECUTION",
      amount: 100,
      actor: human,
      reason: "r",
    });
    const second = openJarvis(root); // separate SQLite connection to the same file
    const a = jarvis.budget.reserve({
      missionId: mission,
      phase: "EXECUTION",
      estimate: 60,
      critical: true,
    });
    const b = second.budget.reserve({
      missionId: mission,
      phase: "EXECUTION",
      estimate: 60,
      critical: true,
    });
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(second.budget.status(mission, "EXECUTION").reserved).toBe(60);
    second.close();
    jarvis.close();
  });

  it("[R-APPROVAL-03] racing processes consume one approval exactly once", () => {
    const dir = mkdtempSync(join(tmpdir(), "jarvis-race-"));
    const file = join(dir, "s.sqlite");
    const db = openDatabase(file);
    db.exec(`INSERT INTO schema_migrations(version, applied_at) SELECT 0, 'x' WHERE 0`);
    const audit = new AuditLog(db);
    const approvals = new ApprovalService(db, audit);
    const op = {
      operationId: "race-op",
      projectId: "p",
      workItemId: "w",
      workflowRunId: "r",
      requestedBy: agent,
      type: "GIT_COMMIT" as const,
      target: "main",
      parameters: { diffHash: "d" },
      trust: "TRUSTED" as const,
    };
    approvals.approve(approvals.request(op, 60_000).id, human);
    db.close();

    const script = join(process.cwd(), "tests", "fixtures", "consume.ts");
    const results = Array.from({ length: 4 }, () => {
      try {
        return JSON.parse(
          execFileSync(process.execPath, ["--import", "tsx", script, file, "race-op"], {
            encoding: "utf8",
            cwd: process.cwd(),
          })
            .trim()
            .split("\n")
            .pop()!,
        ) as { ok: boolean };
      } catch {
        return { ok: false };
      }
    });
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const check = openDatabase(file);
    expect(check.prepare("SELECT status FROM approvals").get()).toEqual({ status: "CONSUMED" });
    expect(new AuditLog(check).verify()).toBeNull();
    check.close();
    cleanup(dir);
  });
});
