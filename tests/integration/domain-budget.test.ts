import { beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { MissionBudget } from "../../src/budget/index.js";
import { InvalidTransitionError } from "../../src/domain/workflow.js";
import { AuditLog } from "../../src/persistence/audit.js";
import { openDatabase } from "../../src/persistence/db.js";
import { ConflictError, DomainError, DomainStore } from "../../src/persistence/repositories.js";

const owner = { kind: "human", id: "owner" } as const;
const admin = { kind: "human", id: "admin" } as const;
const agent = { kind: "agent", id: "claude" } as const;

let db: DatabaseSync;
let store: DomainStore;
let budget: MissionBudget;
let projectId: string;
let missionId: string;
let now = new Date("2026-11-23T12:00:00.000Z");

beforeEach(() => {
  now = new Date("2026-11-23T12:00:00.000Z");
  db = openDatabase(":memory:");
  const audit = new AuditLog(db, () => now);
  store = new DomainStore(db, audit, () => now);
  budget = new MissionBudget(
    db,
    audit,
    store,
    { warnRatio: 0.75, restrictRatio: 0.9, reserveRatio: 0.1 },
    () => now,
  );
  projectId = store.createProject({ name: "p", root: "/tmp/p", createdBy: owner }).id;
  missionId = budget.createMission({ projectId, owner });
});

const who = { agent: "implementer", provider: "test", model: "m1" };

describe("domain store", () => {
  it("[R-STATE-02] runs the work item lifecycle and keeps context on reopen", () => {
    const item = store.createWorkItem({
      projectId,
      actor: owner,
      title: "t",
      objective: "o",
      acceptanceCriteria: ["a"],
    });
    store.addDecision(item.id, owner, "use sqlite");
    const run1 = store.createRun(item.id, agent);
    expect(run1.sequence).toBe(1);
    expect(() => store.createRun(item.id, agent)).toThrow(DomainError); // one active run at a time
    for (const s of [
      "PREPARING",
      "AWAITING_EXECUTION_APPROVAL",
      "RUNNING",
      "AWAITING_REVIEW",
      "COMPLETED",
    ] as const) {
      store.transitionRun(run1.id, s, owner);
    }
    store.transitionWorkItem(item.id, "IN_PROGRESS", owner);
    store.transitionWorkItem(item.id, "DELIVERED", owner);
    store.addReviewFeedback(item.id, owner, "rename x");
    store.transitionWorkItem(item.id, "REOPENED", owner);
    const run2 = store.createRun(item.id, agent);
    const reopened = store.getWorkItem(item.id)!;
    expect(run2.sequence).toBe(2);
    expect(reopened.decisions).toEqual(["use sqlite"]);
    expect(reopened.reviewFeedback).toEqual(["rename x"]);
    expect(store.listRuns(item.id)).toHaveLength(2);
  });

  it("rejects invalid transitions and stale versions", () => {
    const item = store.createWorkItem({ projectId, actor: owner, title: "t", objective: "o" });
    const run = store.createRun(item.id, agent);
    expect(() => store.transitionRun(run.id, "RUNNING", owner)).toThrow(InvalidTransitionError);
    expect(() => store.transitionRun(run.id, "PREPARING", owner, run.version + 5)).toThrow(
      ConflictError,
    );
  });

  it("recovers interrupted runs explicitly to PAUSED", () => {
    const item = store.createWorkItem({ projectId, actor: owner, title: "t", objective: "o" });
    const run = store.createRun(item.id, agent);
    for (const s of ["PREPARING", "AWAITING_EXECUTION_APPROVAL", "RUNNING"] as const)
      store.transitionRun(run.id, s, owner);
    const recovered = store.recoverInterruptedRuns({ kind: "system", id: "recovery" });
    expect(recovered.map((r) => r.status)).toEqual(["PAUSED"]);
  });

  it("only humans create projects; nobody edits their own permissions", () => {
    expect(() => store.createProject({ name: "x", root: "/x", createdBy: agent })).toThrow(
      DomainError,
    );
    expect(() => store.setPermissions(projectId, owner, owner.id, [])).toThrow(DomainError);
    expect(() => store.setPermissions(projectId, admin, "z", ["mission.grant"])).toThrow(
      DomainError,
    );
  });
});

describe("mission token budget", () => {
  it("requires an owner initial grant and separates phases", () => {
    expect(() =>
      budget.grant({ missionId, phase: "EXECUTION", amount: 100, actor: agent, reason: "r" }),
    ).toThrow(DomainError);
    budget.grant({ missionId, phase: "PREPARATION", amount: 1000, actor: owner, reason: "prep" });
    expect(budget.status(missionId, "PREPARATION").allowance).toBe(1000);
    expect(budget.status(missionId, "EXECUTION").level).toBe("NONE");
    expect(budget.reserve({ missionId, phase: "EXECUTION", estimate: 1 })).toMatchObject({
      ok: false,
      reason: "NO_ALLOWANCE",
    });
  });

  it("[R-GRANT-01] needs BOTH permission and owner delegation for admin grants", () => {
    budget.grant({ missionId, phase: "EXECUTION", amount: 1000, actor: owner, reason: "init" });
    const add = () =>
      budget.grant({ missionId, phase: "EXECUTION", amount: 500, actor: admin, reason: "more" });
    expect(add).toThrow(DomainError); // neither
    store.setPermissions(projectId, owner, admin.id, ["mission.grant"]);
    expect(add).toThrow(DomainError); // permission only
    const dlg = budget.delegate(missionId, owner, admin.id);
    expect(add()).toBeTruthy(); // both
    expect(budget.status(missionId, "EXECUTION").allowance).toBe(1500);
    budget.revokeDelegation(dlg, owner);
    expect(add).toThrow(DomainError); // revoked
  });

  it("rejects delegation expiry, self-delegation and non-owner delegation", () => {
    store.setPermissions(projectId, owner, admin.id, ["mission.grant"]);
    budget.grant({ missionId, phase: "EXECUTION", amount: 1000, actor: owner, reason: "init" });
    expect(() => budget.delegate(missionId, admin, admin.id)).toThrow(DomainError);
    expect(() => budget.delegate(missionId, owner, owner.id)).toThrow(DomainError);
    budget.delegate(missionId, owner, admin.id, "2026-11-23T12:30:00.000Z");
    now = new Date("2026-11-23T13:00:00.000Z");
    expect(() =>
      budget.grant({ missionId, phase: "EXECUTION", amount: 5, actor: admin, reason: "late" }),
    ).toThrow(DomainError);
  });

  it("[R-BUDGET-03] applies warning, restriction and hard stop thresholds", () => {
    budget.grant({ missionId, phase: "EXECUTION", amount: 1000, actor: owner, reason: "init" });
    const spend = (n: number) => {
      const r = budget.reserve({ missionId, phase: "EXECUTION", estimate: n, critical: true });
      if (!r.ok) throw new Error(r.reason);
      budget.settle(r.reservationId, { state: "ACTUAL", inputTokens: n, outputTokens: 0 }, who);
      return budget.status(missionId, "EXECUTION").level;
    };
    expect(spend(700)).toBe("NORMAL");
    expect(spend(60)).toBe("WARNING"); // 76%
    expect(spend(150)).toBe("RESTRICTED"); // 91%
    expect(
      budget.reserve({ missionId, phase: "EXECUTION", estimate: 5, essential: false }),
    ).toMatchObject({ ok: false, reason: "RESTRICTED" });
    expect(budget.reserve({ missionId, phase: "EXECUTION", estimate: 5, essential: true }).ok).toBe(
      false,
    ); // inside the critical reserve
    expect(spend(90)).toBe("EXHAUSTED");
    expect(
      budget.reserve({ missionId, phase: "EXECUTION", estimate: 1, critical: true }),
    ).toMatchObject({ ok: false, reason: "EXHAUSTED" });
  });

  it("never lets concurrent reservations exceed the allowance", () => {
    budget.grant({ missionId, phase: "EXECUTION", amount: 100, actor: owner, reason: "init" });
    const results = Array.from({ length: 5 }, () =>
      budget.reserve({ missionId, phase: "EXECUTION", estimate: 30, critical: true }),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    expect(budget.status(missionId, "EXECUTION").reserved).toBe(90);
  });

  it("settles in-flight calls beyond the limit and records estimates honestly", () => {
    budget.grant({ missionId, phase: "EXECUTION", amount: 100, actor: owner, reason: "init" });
    const r = budget.reserve({ missionId, phase: "EXECUTION", estimate: 90, critical: true });
    if (!r.ok) throw new Error("reserve failed");
    budget.settle(
      r.reservationId,
      { state: "ACTUAL", inputTokens: 100, outputTokens: 20, cachedInputTokens: 40 },
      who,
    );
    const s = budget.status(missionId, "EXECUTION");
    expect(s.used).toBe(120); // cached input is stored, not double counted
    expect(s.level).toBe("EXHAUSTED");
    expect(budget.report(missionId, "EXECUTION")[0]).toMatchObject({
      state: "ACTUAL",
      tokens: 120,
    });
  });

  it("[R-LEDGER-02] keeps unavailable usage as UNAVAILABLE and reconciles without erasing", () => {
    budget.grant({ missionId, phase: "EXECUTION", amount: 1000, actor: owner, reason: "init" });
    const r = budget.reserve({ missionId, phase: "EXECUTION", estimate: 200, critical: true });
    if (!r.ok) throw new Error("reserve failed");
    const usageId = budget.settle(r.reservationId, { state: "UNAVAILABLE" }, who);
    expect(budget.status(missionId, "EXECUTION").used).toBe(200);
    expect(budget.report(missionId, "EXECUTION")[0]?.state).toBe("UNAVAILABLE");
    budget.reconcile(usageId, { inputTokens: 80, outputTokens: 20 });
    expect(budget.status(missionId, "EXECUTION").used).toBe(100);
    expect(db.prepare("SELECT COUNT(*) AS n FROM token_usage").get()).toEqual({ n: 2 });
    expect(() => budget.reconcile(usageId, { inputTokens: 1, outputTokens: 1 })).toThrow(
      DomainError,
    );
  });

  it("[R-LEDGER-01] ledgers are immutable", () => {
    budget.grant({ missionId, phase: "EXECUTION", amount: 100, actor: owner, reason: "init" });
    expect(() => db.exec("UPDATE token_grants SET amount = 999999")).toThrow(/immutable/);
    expect(() => db.exec("DELETE FROM token_grants")).toThrow(/immutable/);
  });

  it("[R-BUDGET-04] rejects thresholds that weaken the hard stop", () => {
    const audit = new AuditLog(db);
    expect(
      () =>
        new MissionBudget(db, audit, store, {
          warnRatio: 0.9,
          restrictRatio: 1.2,
          reserveRatio: 0,
        }),
    ).toThrow(DomainError);
  });
});
