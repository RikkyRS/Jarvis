import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Jarvis } from "../../src/app/jarvis.js";
import { run, type Io } from "../../src/cli/index.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { applyRetention } from "../../src/persistence/retention.js";
import { DomainError } from "../../src/persistence/repositories.js";
import { estimatePlan, PlanSchema, type PlanInput } from "../../src/planning/index.js";
import {
  agent,
  cleanup,
  human,
  makeRepo,
  nextId,
  openJarvis,
  startRunning,
  writeConfig,
} from "../helpers.js";

let root: string;
let jarvis: Jarvis;

beforeEach(() => {
  root = makeRepo();
  writeConfig(root, { trustedProject: true });
  jarvis = openJarvis(root);
});
afterEach(() => {
  jarvis.close();
  cleanup(root);
});

const goodPlan = (over: Partial<PlanInput> = {}): PlanInput => ({
  summary: "Update a.txt and commit",
  steps: [
    {
      id: "s1",
      title: "Edit a.txt",
      operations: ["FILE_EDIT"],
      paths: ["a.txt"],
      complexity: "LOW",
      verification: "node check exits 0",
    },
    {
      id: "s2",
      title: "Commit",
      operations: ["GIT_COMMIT"],
      complexity: "LOW",
      verification: "commit sha recorded",
      dependsOn: ["s1"],
    },
  ],
  risks: [{ description: "regression", mitigation: "run the suite before committing" }],
  testStrategy: "run a node check against the edited file",
  rollback: "git revert the commit",
  assumptions: ["a.txt is the only file involved"],
  ...over,
});

/** A plan whose only step is a test run (no files, no Git changes). */
const testOnlyPlan = (): PlanInput =>
  goodPlan({
    steps: [
      {
        id: "s1",
        title: "Run checks",
        operations: ["TEST_RUN"],
        paths: [],
        complexity: "LOW",
        verification: "node exits 0",
      },
    ],
    rollback: "",
  });

/** A plan whose only step reads a file. */
const readOnlyPlan = (): PlanInput =>
  goodPlan({
    steps: [
      {
        id: "s1",
        title: "Read a.txt",
        operations: ["FILE_READ"],
        paths: [],
        complexity: "LOW",
        verification: "evidence recorded",
      },
    ],
    rollback: "",
  });

function newItem(criteria: string[] = ["a.txt is updated"]) {
  return jarvis.store.createWorkItem({
    projectId: jarvis.project.id,
    actor: human,
    title: "Update a",
    objective: "Change a.txt safely",
    acceptanceCriteria: criteria,
  });
}

/** Answers every material question and accepts conventions for the rest. */
function clarify(workItemId: string): void {
  for (const q of jarvis.planning.generateQuestions(workItemId, human, jarvis.knowledge.load())) {
    if (q.impact === "MATERIAL" && q.status === "OPEN")
      jarvis.planning.answer(workItemId, q.category, `resposta para ${q.category}`, human);
  }
  jarvis.planning.assumeConventions(workItemId, human);
}

describe("clarification: find the unknowns before implementing", () => {
  it("[R-PLAN-01] walks the whole checklist, skips what is known, never re-asks, only humans answer", () => {
    const item = newItem(["a.txt is updated"]);
    const questions = jarvis.planning.generateQuestions(item.id, agent, []);
    const cats = questions.map((q) => q.category);
    expect(cats).toEqual(
      expect.arrayContaining([
        "purpose",
        "scope",
        "data",
        "security",
        "compatibility",
        "dependencies",
        "rollback",
        "deployment",
      ]),
    );
    expect(cats[0]).toBe("purpose"); // the first thing asked is why this is needed
    expect(questions.find((q) => q.category === "purpose")?.impact).toBe("MATERIAL");
    expect(cats).not.toContain("acceptance"); // already stated on the Work Item
    expect(questions.filter((q) => q.impact === "MATERIAL").length).toBeGreaterThanOrEqual(5);

    expect(() => jarvis.planning.answer(item.id, "scope", "tudo", agent)).toThrow(DomainError);
    jarvis.planning.answer(item.id, "scope", "só o arquivo a.txt", human);
    const again = jarvis.planning.generateQuestions(item.id, human, []);
    expect(again.filter((q) => q.category === "scope")).toHaveLength(1);
    expect(again.find((q) => q.category === "scope")?.status).toBe("ANSWERED");
    expect(() => jarvis.planning.answer(item.id, "scope", "outra vez", human)).toThrow(
      /No open question/,
    );
    expect(jarvis.store.getWorkItem(item.id)?.decisions.some((d) => d.startsWith("scope:"))).toBe(
      true,
    );

    // Fresh project knowledge answers the testing question instead of asking it.
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "x", scripts: { test: "vitest" } }),
    );
    jarvis.knowledge.scan();
    const other = newItem(["ok"]);
    expect(
      jarvis.planning
        .generateQuestions(other.id, human, jarvis.knowledge.load())
        .map((q) => q.category),
    ).not.toContain("tests");
  });

  it("only assumes conventions for low-impact questions, and says so", () => {
    const item = newItem();
    jarvis.planning.generateQuestions(item.id, human, []);
    const settled = jarvis.planning.assumeConventions(item.id, human);
    expect(settled).toBeGreaterThan(0);
    const after = jarvis.planning.questions(item.id);
    expect(after.filter((q) => q.impact === "MATERIAL").every((q) => q.status === "OPEN")).toBe(
      true,
    );
    expect(after.filter((q) => q.status === "ASSUMED").every((q) => q.impact === "LOW")).toBe(true);
    expect(
      jarvis.store
        .getWorkItem(item.id)
        ?.decisions.some((d) => d.includes("assumido por convenção")),
    ).toBe(true);
    expect(() => jarvis.planning.assumeConventions(item.id, agent)).toThrow(DomainError);
  });
});

describe("plan readiness and the execution gate", () => {
  it("[R-PLAN-02] lists every reason a plan is not ready", () => {
    const item = newItem();
    expect(jarvis.planning.readiness(item.id).blockers[0]?.code).toBe("NO_PLAN");
    jarvis.planning.generateQuestions(item.id, human, []);
    jarvis.planning.submitPlan(
      item.id,
      goodPlan({
        testStrategy: "",
        rollback: "",
        risks: [{ description: "data loss", mitigation: "" }],
        steps: [
          {
            id: "a",
            title: "A",
            operations: ["FILE_EDIT"],
            paths: ["../escape"],
            complexity: "LOW",
            verification: "check",
            dependsOn: ["b"],
          },
          {
            id: "b",
            title: "B",
            operations: ["GIT_PUSH"],
            paths: [],
            complexity: "LOW",
            verification: "check",
            dependsOn: ["a"],
          },
        ],
      }),
      agent,
    );
    const codes = jarvis.planning.readiness(item.id).blockers.map((b) => b.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        "OPEN_MATERIAL_QUESTIONS",
        "NO_TEST_STRATEGY",
        "NO_ROLLBACK",
        "UNMITIGATED_RISK",
        "PATH_OUTSIDE_PROJECT",
        "DEPENDENCY_CYCLE",
      ]),
    );
    expect(() => jarvis.planning.approvePlan(item.id, human)).toThrow(/not ready/);
    expect(() =>
      PlanSchema.parse({
        ...goodPlan(),
        steps: [
          { id: "x", title: "t", operations: ["FILE_EDIT"], complexity: "LOW", verification: "" },
        ],
      }),
    ).toThrow(); // a step without verification is invalid
  });

  it("[R-PLAN-03] execution cannot start without a human-approved, current plan that fits the budget", () => {
    const item = newItem();
    const runRow = jarvis.store.createRun(item.id, agent);
    jarvis.store.transitionRun(runRow.id, "PREPARING", human);
    jarvis.store.transitionRun(runRow.id, "AWAITING_EXECUTION_APPROVAL", human);
    const missionId = jarvis.budget.createMission({
      projectId: jarvis.project.id,
      owner: human,
      workItemId: item.id,
    });
    jarvis.budget.grant({
      missionId,
      phase: "EXECUTION",
      amount: 1_000_000,
      actor: human,
      reason: "big",
    });

    expect(() => jarvis.runtime.startExecution(runRow.id, missionId, human)).toThrow(
      /No approved plan/,
    );
    clarify(item.id);
    const draft = jarvis.planning.submitPlan(item.id, goodPlan(), agent);
    expect(draft.status).toBe("DRAFT");
    expect(() => jarvis.runtime.startExecution(runRow.id, missionId, human)).toThrow(
      /No approved plan/,
    ); // an agent's draft is not an approval
    expect(() => jarvis.planning.approvePlan(item.id, agent)).toThrow(DomainError);

    const approved = jarvis.planning.approvePlan(item.id, human);
    expect(approved).toMatchObject({ status: "APPROVED", approvedBy: "rikky" });

    // Budget below the approved estimate: an explicit grant is required first.
    const poor = jarvis.budget.createMission({ projectId: jarvis.project.id, owner: human });
    jarvis.budget.grant({
      missionId: poor,
      phase: "EXECUTION",
      amount: 100,
      actor: human,
      reason: "too small",
    });
    expect(() => jarvis.runtime.startExecution(runRow.id, poor, human)).toThrow(
      /below the plan estimate/,
    );

    // Changing the requirements after approval invalidates the plan.
    jarvis.planning.submitPlan(item.id, goodPlan(), agent);
    jarvis.planning.approvePlan(item.id, human);
    jarvis.store.updateScope(item.id, human, {
      requirements: ["new requirement"],
      acceptanceCriteria: ["a.txt is updated"],
    });
    expect(() => jarvis.runtime.startExecution(runRow.id, missionId, human)).toThrow(
      /SCOPE_CHANGED/,
    );

    jarvis.planning.submitPlan(item.id, goodPlan(), agent);
    jarvis.planning.approvePlan(item.id, human);
    expect(jarvis.runtime.startExecution(runRow.id, missionId, human).status).toBe("RUNNING");
  });

  it("[R-PLAN-04] estimates from complexity with a margin and calibrates on real history", () => {
    const plan = PlanSchema.parse(goodPlan());
    const base = estimatePlan(plan);
    expect(base.tokens).toBeGreaterThan(8_000); // two LOW steps plus the margin
    expect(base.basis).toMatchObject({ ratio: 1, samples: 0, margin: 0.25 });
    const costly = estimatePlan(
      plan,
      Array.from({ length: 6 }, () => ({ charged: 3_000, estimated: 1_000 })),
    );
    expect(costly.basis.ratio).toBe(2); // clamped
    expect(costly.tokens).toBeGreaterThan(base.tokens * 1.9);
    const few = estimatePlan(plan, [{ charged: 9_000, estimated: 1_000 }]);
    expect(few.tokens).toBe(base.tokens); // too few samples: neutral
  });
});

describe("learning journal", () => {
  it("[R-NOTES-01] writes an explainable note from facts at plan approval, completion and delivery", async () => {
    const item = newItem();
    clarify(item.id);
    jarvis.planning.submitPlan(item.id, testOnlyPlan(), agent);
    jarvis.planning.approvePlan(item.id, human);

    const file = jarvis.notes.fileFor(item);
    expect(existsSync(file)).toBe(true); // created by the approval itself
    let note = readFileSync(file, "utf8");
    expect(note).toContain("## 1. O que foi pedido");
    expect(note).toContain("Change a.txt safely");
    expect(note).toContain("scope");
    expect(note).toContain("(assumida por convenção)");
    expect(note).toContain("| s1 | ⬜ | Run checks |");
    expect(note).toContain("Nenhum teste foi executado pelo Jarvis"); // never claims testing that did not happen

    const missionId = jarvis.budget.createMission({
      projectId: jarvis.project.id,
      owner: human,
      workItemId: item.id,
    });
    jarvis.budget.grant({
      missionId,
      phase: "EXECUTION",
      amount: 500_000,
      actor: human,
      reason: "approved",
    });
    const runRow = jarvis.store.createRun(item.id, agent);
    jarvis.store.transitionRun(runRow.id, "PREPARING", human);
    jarvis.store.transitionRun(runRow.id, "AWAITING_EXECUTION_APPROVAL", human);
    jarvis.runtime.startExecution(runRow.id, missionId, human);
    const ran = await jarvis.runtime.run(runRow.id, {
      operationId: nextId(),
      requestedBy: agent,
      type: "TEST_RUN",
      target: ".",
      parameters: { command: "node", args: ["-e", "process.exit(0)"] },
    });
    jarvis.planning.markStep(item.id, "s1", [ran.operationId], agent);
    jarvis.runtime.submitForReview(runRow.id, agent);
    jarvis.runtime.complete(runRow.id, human);

    note = readFileSync(file, "utf8");
    expect(note).toContain("Tentativa 1 — COMPLETED");
    expect(note).toContain("✅ passou");
    expect(note).toContain("Execução: autorizado 500.000");

    jarvis.store.transitionWorkItem(item.id, "IN_PROGRESS", human);
    jarvis.store.transitionWorkItem(item.id, "DELIVERED", human);
    note = readFileSync(file, "utf8");
    expect(note).toContain("status **DELIVERED**");
    expect(note).toContain("## 8. Como explicar isso");
    expect(note).toContain("## 9. Perguntas que podem te fazer");
    expect(note).toContain("regression"); // risks become likely interview questions

    const index = readFileSync(join(jarvis.notes.dir, "INDEX.md"), "utf8");
    expect(index).toContain("Update a");
    expect(index).toContain("DELIVERED");
  });

  it("is idempotent, writes a project overview and redacts anything that looks like a secret", () => {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "demo", scripts: { test: "vitest" } }),
    );
    jarvis.scan();
    expect(readFileSync(join(jarvis.notes.dir, "PROJETO.md"), "utf8")).toContain(
      "npm scripts available",
    );

    const item = newItem();
    jarvis.store.addDecision(item.id, human, "credenciais: password = hunter2hunter2");
    const file = jarvis.notes.refresh(item.id);
    const first = readFileSync(file, "utf8");
    expect(first).not.toContain("hunter2");
    expect(first).toContain("[removido: possível segredo]");
    jarvis.notes.refresh(item.id);
    expect(readFileSync(file, "utf8").replace(/atualizado em [\d-]+/, "")).toBe(
      first.replace(/atualizado em [\d-]+/, ""),
    );
  });

  it("[R-NOTES-02] a journal failure never blocks or undoes the real work", () => {
    jarvis.close();
    const blocked = join(root, "notes-is-a-file");
    writeFileSync(blocked, "not a directory");
    jarvis = openJarvis(root, { notesDir: join(blocked, "inside") });
    const item = newItem();
    jarvis.store.transitionWorkItem(item.id, "IN_PROGRESS", human); // would refresh the journal and fail
    expect(jarvis.store.getWorkItem(item.id)?.status).toBe("IN_PROGRESS");
    expect(jarvis.audit.list().some((e) => e.kind === "notes.failed")).toBe(true);
    expect(jarvis.audit.verify()).toBeNull();
  });
});

describe("retention", () => {
  it("[R-RETENTION-01] archives operational data only: audit, ledgers, plans and live runs are untouched", async () => {
    const item = newItem();
    clarify(item.id);
    jarvis.planning.submitPlan(item.id, readOnlyPlan(), agent);
    jarvis.planning.approvePlan(item.id, human);
    const missionId = jarvis.budget.createMission({
      projectId: jarvis.project.id,
      owner: human,
      workItemId: item.id,
    });
    jarvis.budget.grant({
      missionId,
      phase: "EXECUTION",
      amount: 500_000,
      actor: human,
      reason: "r",
    });

    const finished = jarvis.store.createRun(item.id, agent);
    for (const s of ["PREPARING", "AWAITING_EXECUTION_APPROVAL"] as const)
      jarvis.store.transitionRun(finished.id, s, human);
    jarvis.runtime.startExecution(finished.id, missionId, human);
    const read = await jarvis.runtime.run(finished.id, {
      operationId: nextId(),
      requestedBy: agent,
      type: "FILE_READ",
      target: "a.txt",
    });
    jarvis.planning.markStep(item.id, "s1", [read.operationId], agent);
    jarvis.runtime.submitForReview(finished.id, agent);
    jarvis.runtime.complete(finished.id, human);
    jarvis.store.transitionWorkItem(item.id, "IN_PROGRESS", human);
    jarvis.store.transitionWorkItem(item.id, "DELIVERED", human);
    jarvis.store.transitionWorkItem(item.id, "REOPENED", human);

    const live = jarvis.store.createRun(item.id, agent);
    for (const s of ["PREPARING", "AWAITING_EXECUTION_APPROVAL"] as const)
      jarvis.store.transitionRun(live.id, s, human);
    jarvis.runtime.startExecution(live.id, missionId, human);
    await jarvis.runtime.run(live.id, {
      operationId: nextId(),
      requestedBy: agent,
      type: "FILE_READ",
      target: "a.txt",
    });

    const reservation = jarvis.budget.reserve({
      missionId,
      phase: "EXECUTION",
      estimate: 10,
      critical: true,
    });
    if (!reservation.ok) throw new Error("reserve");
    jarvis.budget.settle(
      reservation.reservationId,
      { state: "ACTUAL", inputTokens: 5, outputTokens: 5 },
      { agent: "a", provider: "p", model: "m" },
    );

    const count = (table: string) =>
      (jarvis.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    const before = {
      audit: count("audit_events"),
      grants: count("token_grants"),
      usage: count("token_usage"),
      plans: count("plans"),
    };

    const result = applyRetention(jarvis.db, jarvis.audit, {
      projectId: jarvis.project.id,
      olderThanDays: 30,
      now: new Date(Date.now() + 40 * 86_400_000),
    });
    expect(result.executions).toBe(1); // only the finished run
    expect(result.reservations).toBeGreaterThanOrEqual(1);

    const rows = jarvis.db.prepare("SELECT workflow_run_id, evidence FROM executions").all() as {
      workflow_run_id: string;
      evidence: string;
    }[];
    expect(JSON.parse(rows.find((r) => r.workflow_run_id === finished.id)!.evidence)).toMatchObject(
      { archived: true, outcome: "SUCCEEDED" },
    );
    expect(
      JSON.parse(rows.find((r) => r.workflow_run_id === live.id)!.evidence),
    ).not.toHaveProperty("archived");

    expect(count("audit_events")).toBe(before.audit + 1); // only the retention event itself
    expect(count("token_grants")).toBe(before.grants);
    expect(count("token_usage")).toBe(before.usage);
    expect(count("plans")).toBe(before.plans);
    expect(jarvis.audit.verify()).toBeNull();
    expect(jarvis.budget.status(missionId, "EXECUTION").used).toBe(10);

    const again = applyRetention(jarvis.db, jarvis.audit, {
      projectId: jarvis.project.id,
      olderThanDays: 30,
      now: new Date(Date.now() + 40 * 86_400_000),
    });
    expect(again.executions).toBe(0); // idempotent
    expect(() =>
      applyRetention(jarvis.db, jarvis.audit, { projectId: jarvis.project.id, olderThanDays: 0 }),
    ).toThrow();
  });
});

describe("adapters for planning", () => {
  function memoryIo(answer = true): Io & { lines: string[] } {
    const lines: string[] = [];
    return {
      lines,
      out: (l) => void lines.push(l),
      err: (l) => void lines.push(`ERR ${l}`),
      confirm: async () => answer,
    };
  }
  const env = () => ({ JARVIS_USER: "rikky", JARVIS_NOTES_DIR: join(root, ".jarvis", "notes") });

  it("CLI drives questions -> answers -> plan -> approval", async () => {
    const item = newItem();
    const io = memoryIo();
    expect(await run(["plan", "questions", item.id], io, root, env())).toBe(0);
    expect(io.lines.join("\n")).toContain("(MATERIAL) scope");

    for (const cat of ["purpose", "scope", "data", "security", "compatibility", "dependencies"]) {
      expect(
        await run(["plan", "answer", item.id, cat, "ok", "assim"], memoryIo(), root, env()),
      ).toBe(0);
    }
    expect(await run(["plan", "assume", item.id], memoryIo(), root, env())).toBe(0);

    const planFile = join(root, "plan.json");
    writeFileSync(planFile, JSON.stringify(goodPlan()));
    const sub = memoryIo();
    expect(await run(["plan", "submit", item.id, planFile], sub, root, env())).toBe(0);
    expect(sub.lines[0]).toMatch(/Estimate: \d+ tokens/);

    expect(await run(["plan", "check", item.id], memoryIo(), root, env())).toBe(0);
    expect(await run(["plan", "approve", item.id], memoryIo(false), root, env())).toBe(1); // declined
    expect(jarvis.planning.currentPlan(item.id)?.status).toBe("DRAFT");
    expect(await run(["plan", "approve", item.id, "--yes"], memoryIo(), root, env())).toBe(0);
    expect(jarvis.planning.currentPlan(item.id)?.status).toBe("APPROVED");
    const notes = memoryIo();
    await run(["notes", "path"], notes, root, env());
    expect(notes.lines[0]).toContain("notes");
  });

  it("CLI approvals --watch announces new requests; retention apply works", async () => {
    const item = newItem();
    const runRow = startRunning(jarvis, item.id);
    await jarvis.request(agent, {
      operationId: nextId(),
      workItemId: item.id,
      workflowRunId: runRow.id,
      type: "GIT_COMMIT",
      target: "main",
      parameters: { message: "m", diffHash: "e".repeat(64) },
    });
    const io = memoryIo();
    expect(
      await run(["approvals", "--watch", "--interval", "5", "--max", "2"], io, root, env()),
    ).toBe(0);
    expect(io.lines.filter((l) => l.startsWith("NEW"))).toHaveLength(1);
    expect(io.lines.join("\n")).toContain("jarvis approve");

    const ret = memoryIo();
    expect(await run(["retention", "apply", "--days", "30", "--yes"], ret, root, env())).toBe(0);
    expect(JSON.parse(ret.lines.join("\n"))).toHaveProperty("executions");
    expect(await run(["retention", "apply", "--days", "0", "--yes"], memoryIo(), root, env())).toBe(
      2,
    );
  });

  it("[R-MCP-03] an agent can ask questions and draft a plan but can never approve it", async () => {
    const item = newItem();
    const server = createMcpServer(jarvis, "claude");
    const client = new Client({ name: "t", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = (await client.callTool({ name, arguments: args })) as {
        content: { text: string }[];
        isError?: boolean;
      };
      return {
        data: JSON.parse(r.content[0]!.text) as Record<string, unknown> & unknown[],
        isError: Boolean(r.isError),
      };
    };
    const questions = await call("jarvis_open_questions", { workItemId: item.id });
    expect(questions.data.length).toBeGreaterThan(5);
    const submitted = await call("jarvis_submit_plan", { workItemId: item.id, plan: goodPlan() });
    expect(submitted.data["status"]).toBe("DRAFT");
    const readiness = await call("jarvis_plan_readiness", { workItemId: item.id });
    expect(readiness.data["ready"]).toBe(false); // material questions are still open
    expect((await call("jarvis_open_questions", { workItemId: "wi_nope" })).isError).toBe(true);
    expect(jarvis.planning.currentPlan(item.id)?.status).toBe("DRAFT");
    mkdirSync(join(root, "x"), { recursive: true });
  });
});
