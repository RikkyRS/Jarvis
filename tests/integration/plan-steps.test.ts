import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Jarvis } from "../../src/app/jarvis.js";
import { run as cli, type Io } from "../../src/cli/index.js";
import { DomainError } from "../../src/persistence/repositories.js";
import type { PlanInput } from "../../src/planning/index.js";
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

const plan = (paths = ["a.txt"]): PlanInput => ({
  summary: "Edit a.txt and run a check",
  steps: [
    {
      id: "edit",
      title: "Edit",
      operations: ["FILE_EDIT"],
      paths,
      complexity: "LOW",
      verification: "file content verified",
    },
    {
      id: "check",
      title: "Check",
      operations: ["TEST_RUN"],
      paths: [],
      complexity: "LOW",
      verification: "node exits 0",
      dependsOn: ["edit"],
    },
  ],
  risks: [{ description: "wrong edit", mitigation: "review the diff" }],
  testStrategy: "node check",
  rollback: "git revert",
  assumptions: ["only a.txt changes"],
});

function approvedWork(p: PlanInput = plan()) {
  const item = jarvis.store.createWorkItem({
    projectId: jarvis.project.id,
    actor: human,
    title: "Edit a",
    objective: "Edit a.txt",
    acceptanceCriteria: ["a.txt edited"],
  });
  for (const q of jarvis.planning.generateQuestions(item.id, human, [])) {
    if (q.impact === "MATERIAL" && q.status === "OPEN")
      jarvis.planning.answer(item.id, q.category, "ok", human);
  }
  jarvis.planning.assumeConventions(item.id, human);
  jarvis.planning.submitPlan(item.id, p, agent);
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
  const runRow = jarvis.store.createRun(item.id, agent);
  jarvis.store.transitionRun(runRow.id, "PREPARING", human);
  jarvis.store.transitionRun(runRow.id, "AWAITING_EXECUTION_APPROVAL", human);
  jarvis.runtime.startExecution(runRow.id, missionId, human);
  return { item, runRow, missionId };
}

const edit = (runId: string, target = "a.txt") =>
  jarvis.runtime.run(runId, {
    operationId: nextId(),
    requestedBy: agent,
    type: "FILE_EDIT",
    target,
    parameters: { content: "x\n" },
  });
const check = (runId: string) =>
  jarvis.runtime.run(runId, {
    operationId: nextId(),
    requestedBy: agent,
    type: "TEST_RUN",
    target: ".",
    parameters: { command: "node", args: ["-e", "0"] },
  });

describe("run guard", () => {
  it("[R-RUN-02] changes and executions need a RUNNING run of the same Work Item", async () => {
    const item = jarvis.store.createWorkItem({
      projectId: jarvis.project.id,
      actor: human,
      title: "t",
      objective: "o",
    });
    const other = jarvis.store.createWorkItem({
      projectId: jarvis.project.id,
      actor: human,
      title: "other",
      objective: "o",
    });
    const planned = jarvis.store.createRun(item.id, agent);
    const req = (
      type: string,
      runId: string,
      workItemId = item.id,
      extra: Record<string, unknown> = {},
    ) =>
      jarvis.request(agent, {
        operationId: nextId(),
        workItemId,
        workflowRunId: runId,
        type,
        target: "a.txt",
        ...extra,
      } as never);

    // PLANNED: reading is fine, anything that changes or runs is refused.
    expect((await req("FILE_READ", planned.id)).status === "EXECUTED").toBe(true);
    const denied = await req("FILE_EDIT", planned.id, item.id, { parameters: { content: "x" } });
    expect(denied.status === "EXECUTED" && denied.result.reason).toBe("RUN_NOT_EXECUTING");
    // A high-risk request does not even create an approval for a run that is not executing.
    const commit = await req("GIT_COMMIT", planned.id, item.id, {
      target: "main",
      parameters: { message: "m", diffHash: "a".repeat(64) },
    });
    expect(commit.status === "EXECUTED" && commit.result.outcome).toBe("DENIED");
    expect(commit.status === "EXECUTED" && commit.result.reason).toBe("RUN_NOT_EXECUTING");
    expect(jarvis.approvals.listPending(jarvis.project.id)).toHaveLength(0);

    // A run of another Work Item (or an unknown run) is a mismatch.
    const running = startRunning(jarvis, other.id);
    const mismatch = await req("FILE_READ", running.id, item.id);
    expect(mismatch.status === "EXECUTED" && mismatch.result.reason).toBe("RUN_MISMATCH");
    const ghost = await req("FILE_READ", "run_does_not_exist");
    expect(ghost.status === "EXECUTED" && ghost.result.reason).toBe("RUN_MISMATCH");

    // Finished runs accept nothing, not even reads.
    jarvis.store.transitionRun(running.id, "AWAITING_REVIEW", human);
    jarvis.store.transitionRun(running.id, "FAILED", human);
    const finished = await req("FILE_READ", running.id, other.id);
    expect(finished.status === "EXECUTED" && finished.result.reason).toBe("RUN_FINISHED");
  });
});

describe("plan step tracking", () => {
  it("[R-PLAN-05] review needs every step proven by real, matching operations", async () => {
    const { item, runRow } = approvedWork();
    const e = await edit(runRow.id);
    const t = await check(runRow.id);
    expect(() => jarvis.runtime.submitForReview(runRow.id, agent)).toThrow(
      /Plan steps not done: edit, check/,
    );

    expect(() => jarvis.planning.markStep(item.id, "edit", [t.operationId], agent)).toThrow(
      /declared by step/,
    ); // wrong operation type
    expect(() => jarvis.planning.markStep(item.id, "edit", ["op_made_up"], agent)).toThrow(
      /successful operation/,
    ); // fabricated evidence
    expect(() => jarvis.planning.markStep(item.id, "edit", [], agent)).toThrow(DomainError);
    expect(() => jarvis.planning.markStep(item.id, "nope", [e.operationId], agent)).toThrow(
      /Unknown step/,
    );

    jarvis.planning.markStep(item.id, "edit", [e.operationId], agent);
    expect(jarvis.planning.progress(item.id).complete).toBe(false);
    expect(() => jarvis.runtime.submitForReview(runRow.id, agent)).toThrow(
      /Plan steps not done: check/,
    );
    jarvis.planning.markStep(item.id, "check", [t.operationId], agent);
    expect(jarvis.planning.progress(item.id)).toMatchObject({ complete: true, outOfPlan: [] });
    expect(jarvis.runtime.submitForReview(runRow.id, agent).status).toBe("AWAITING_REVIEW");
  });

  it("[R-PLAN-05] evidence from another Work Item or a failed operation does not count", async () => {
    const first = approvedWork();
    const stolen = await edit(first.runRow.id);
    const second = (() => {
      const item = jarvis.store.createWorkItem({
        projectId: jarvis.project.id,
        actor: human,
        title: "second",
        objective: "o",
        acceptanceCriteria: ["x"],
      });
      for (const q of jarvis.planning.generateQuestions(item.id, human, [])) {
        if (q.impact === "MATERIAL" && q.status === "OPEN")
          jarvis.planning.answer(item.id, q.category, "ok", human);
      }
      jarvis.planning.assumeConventions(item.id, human);
      jarvis.planning.submitPlan(item.id, plan(), agent);
      jarvis.planning.approvePlan(item.id, human);
      return item;
    })();
    expect(() => jarvis.planning.markStep(second.id, "edit", [stolen.operationId], agent)).toThrow(
      /successful operation of this Work Item/,
    );

    const failing = await jarvis.runtime.run(first.runRow.id, {
      operationId: nextId(),
      requestedBy: agent,
      type: "TEST_RUN",
      target: ".",
      parameters: { command: "node", args: ["-e", "process.exit(1)"] },
    });
    expect(failing.outcome).toBe("FAILED");
    expect(() =>
      jarvis.planning.markStep(first.item.id, "check", [failing.operationId], agent),
    ).toThrow(/successful operation/);
  });

  it("[R-PLAN-06] changes outside the approved plan are detected and need an amended, approved plan", async () => {
    const { item, runRow } = approvedWork();
    const e = await edit(runRow.id);
    const extra = await edit(runRow.id, "extra.txt"); // scope creep
    const t = await check(runRow.id);
    jarvis.planning.markStep(item.id, "edit", [e.operationId], agent);
    jarvis.planning.markStep(item.id, "check", [t.operationId], agent);

    expect(jarvis.planning.progress(item.id).outOfPlan.map((o) => o.target)).toEqual(["extra.txt"]);
    expect(() => jarvis.runtime.submitForReview(runRow.id, agent)).toThrow(
      /outside the approved plan: extra\.txt/,
    );
    expect(() => jarvis.planning.markStep(item.id, "edit", [extra.operationId], agent)).toThrow(
      /outside the paths/,
    );

    // The amended plan must be approved by a human; then the steps are re-proven against it.
    jarvis.planning.submitPlan(item.id, plan(["a.txt", "extra.txt"]), agent);
    expect(jarvis.planning.currentPlan(item.id)?.status).toBe("DRAFT");
    expect(() => jarvis.planning.markStep(item.id, "edit", [e.operationId], agent)).toThrow(
      /approved plan/,
    ); // a draft cannot track progress
    jarvis.planning.approvePlan(item.id, human);
    jarvis.planning.markStep(item.id, "edit", [e.operationId, extra.operationId], agent);
    jarvis.planning.markStep(item.id, "check", [t.operationId], agent);
    expect(jarvis.runtime.submitForReview(runRow.id, agent).status).toBe("AWAITING_REVIEW");
  });

  it("[R-PLAN-07] a step that edits files must declare the paths it may touch", () => {
    const item = jarvis.store.createWorkItem({
      projectId: jarvis.project.id,
      actor: human,
      title: "t",
      objective: "o",
      acceptanceCriteria: ["x"],
    });
    jarvis.planning.submitPlan(item.id, plan([]), agent);
    expect(jarvis.planning.readiness(item.id).blockers.map((b) => b.code)).toContain(
      "STEP_WITHOUT_PATHS",
    );
  });

  it("CLI shows progress and marks steps; the journal reflects it", async () => {
    const { item, runRow } = approvedWork();
    const e = await edit(runRow.id);
    const lines: string[] = [];
    const io: Io = {
      out: (l) => void lines.push(l),
      err: (l) => void lines.push(l),
      confirm: async () => true,
    };
    const env = { JARVIS_USER: "rikky", JARVIS_NOTES_DIR: `${root}/.jarvis/notes` };
    expect(await cli(["plan", "done", item.id, "edit", e.operationId], io, root, env)).toBe(0);
    expect(await cli(["plan", "progress", item.id], io, root, env)).toBe(1);
    expect(lines.join("\n")).toContain("[x] edit");
    expect(lines.join("\n")).toContain("[ ] check");
    const { readFileSync } = await import("node:fs");
    const note = readFileSync(jarvis.notes.fileFor(item), "utf8");
    expect(note).toContain("| edit | ✅ |");
    expect(note).toContain("| check | ⬜ |");
  });
});
