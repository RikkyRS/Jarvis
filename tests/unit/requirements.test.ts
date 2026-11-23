import { beforeEach, describe, expect, it } from "vitest";
import { MissionBudget } from "../../src/budget/index.js";
import { AuditLog } from "../../src/persistence/audit.js";
import { openDatabase } from "../../src/persistence/db.js";
import { DomainError, DomainStore } from "../../src/persistence/repositories.js";
import { WorkflowRuntime } from "../../src/runtime/workflow.js";
import {
  applyAnswers,
  planRound,
  presentDecision,
  type Question,
} from "../../src/requirements/index.js";
import type { ExecutionGateway } from "../../src/gateway/index.js";

const human = { kind: "human", id: "rikky" } as const;
const agent = { kind: "agent", id: "claude" } as const;

const q = (
  id: string,
  topic: string,
  impact: Question["impact"],
  extra: Partial<Question> = {},
): Question => ({ id, topic, text: `${topic}?`, impact, ...extra });

describe("requirement clarification", () => {
  it("[R-REQ-01] asks only material, unknown questions, deduplicated and grouped into one bounded round", () => {
    const round = planRound(
      [
        q("1", "auth", "MATERIAL"),
        q("2", "auth", "MATERIAL"),
        q("3", "database", "MATERIAL"),
        q("4", "naming", "LOW", { conventionDefault: "camelCase" }),
        q("5", "cost", "MATERIAL"),
        q("6", "ui", "MATERIAL"),
      ],
      new Set(["database"]),
      2,
    );
    expect(round.questions.map((x) => x.topic)).toEqual(["auth", "cost"]); // database already known, auth asked once
    expect(round.deferred.map((x) => x.topic)).toEqual(["ui"]);
    expect(round.assumedByConvention).toEqual([{ topic: "naming", assumption: "camelCase" }]);
  });

  it("requires a single recommendation among real alternatives", () => {
    const d = presentDecision("storage", [
      { name: "SQLite", tradeoffs: ["local"], recommended: true },
      { name: "Postgres", tradeoffs: ["ops"] },
    ]);
    expect(d.recommendation).toBe("SQLite");
    expect(() => presentDecision("x", [{ name: "only", tradeoffs: [] }])).toThrow(DomainError);
    expect(() =>
      presentDecision("x", [
        { name: "a", tradeoffs: [], recommended: true },
        { name: "b", tradeoffs: [], recommended: true },
      ]),
    ).toThrow(DomainError);
  });

  it("turns confirmed answers into explicit requirements, acceptance criteria and decisions (humans only)", () => {
    const db = openDatabase(":memory:");
    const store = new DomainStore(db, new AuditLog(db));
    const projectId = store.createProject({ name: "p", root: "/p", createdBy: human }).id;
    const item = store.createWorkItem({ projectId, actor: human, title: "t", objective: "o" });
    const answers = [
      { questionId: "1", topic: "auth", answer: "Use OAuth", kind: "DECISION" as const },
      { questionId: "2", topic: "scope", answer: "Export to Excel", kind: "REQUIREMENT" as const },
      {
        questionId: "3",
        topic: "done",
        answer: "File opens in Excel",
        kind: "ACCEPTANCE" as const,
      },
    ];
    expect(() => applyAnswers(store, item.id, agent, answers)).toThrow(DomainError);
    const updated = applyAnswers(store, item.id, human, answers);
    expect(updated).toMatchObject({
      requirements: ["Export to Excel"],
      acceptanceCriteria: ["File opens in Excel"],
      decisions: ["auth: Use OAuth"],
    });
    expect(applyAnswers(store, item.id, human, answers).requirements).toEqual(["Export to Excel"]); // idempotent
  });
});

describe("execution authorization", () => {
  let db: ReturnType<typeof openDatabase>;
  let store: DomainStore;
  let budget: MissionBudget;
  let runtime: WorkflowRuntime;
  let missionId: string;
  let runId: string;

  beforeEach(() => {
    db = openDatabase(":memory:");
    const audit = new AuditLog(db);
    store = new DomainStore(db, audit);
    budget = new MissionBudget(db, audit, store);
    runtime = new WorkflowRuntime(db, store, {} as ExecutionGateway, "UNTRUSTED", budget);
    const projectId = store.createProject({ name: "p", root: "/p", createdBy: human }).id;
    missionId = budget.createMission({ projectId, owner: human });
    const item = store.createWorkItem({ projectId, actor: human, title: "t", objective: "o" });
    runId = store.createRun(item.id, agent).id;
    store.transitionRun(runId, "PREPARING", human);
    store.transitionRun(runId, "AWAITING_EXECUTION_APPROVAL", human);
  });

  it("[R-BUDGET-05] implementation cannot start without a human and an authorized Execution Budget", () => {
    expect(() => runtime.startExecution(runId, missionId, agent)).toThrow(/human/);
    expect(() => runtime.startExecution(runId, missionId, human)).toThrow(
      /no authorized Execution Budget/,
    );
    budget.grant({
      missionId,
      phase: "PREPARATION",
      amount: 1000,
      actor: human,
      reason: "prep only",
    }); // preparation tokens do not count
    expect(() => runtime.startExecution(runId, missionId, human)).toThrow(
      /no authorized Execution Budget/,
    );
    budget.grant({
      missionId,
      phase: "EXECUTION",
      amount: 1000,
      actor: human,
      reason: "approved scope v1",
    });
    expect(runtime.startExecution(runId, missionId, human).status).toBe("RUNNING");
  });

  it("does not start execution on an exhausted budget", () => {
    budget.grant({ missionId, phase: "EXECUTION", amount: 10, actor: human, reason: "r" });
    const r = budget.reserve({ missionId, phase: "EXECUTION", estimate: 10, critical: true });
    if (!r.ok) throw new Error("reserve");
    budget.settle(
      r.reservationId,
      { state: "ACTUAL", inputTokens: 10, outputTokens: 0 },
      { agent: "a", provider: "p", model: "m" },
    );
    expect(() => runtime.startExecution(runId, missionId, human)).toThrow(/exhausted/);
  });
});
