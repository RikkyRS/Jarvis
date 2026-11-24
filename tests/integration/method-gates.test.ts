import { afterEach, describe, expect, it } from "vitest";
import type { Jarvis } from "../../src/app/jarvis.js";
import { detectChecks } from "../../src/method/detect.js";
import { isTestPath } from "../../src/method/gates.js";
import { checkPlan, PlanSchema, type PlanInput } from "../../src/planning/index.js";
import {
  agent,
  cleanup,
  human,
  makeRepo,
  nextId,
  openJarvis,
  sh,
  writeConfig,
} from "../helpers.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

let root: string;
let jarvis: Jarvis | undefined;
afterEach(() => {
  jarvis?.close();
  jarvis = undefined;
  cleanup(root);
});

const PASS = { command: "node", args: ["-e", "process.exit(0)"] };
const FAIL = { command: "node", args: ["-e", "process.exit(1)"] };

const bugPlan = (): PlanInput => ({
  summary: "Corrigir app.js",
  kind: "BUGFIX",
  diagnosis: {
    cause: "app.js não trata o caso vazio",
    location: "app.js:3",
    evidence: "reproduzido com entrada vazia",
  },
  steps: [
    {
      id: "fix",
      title: "Teste e correção",
      operations: ["FILE_EDIT"],
      paths: ["app.test.js", "app.js"],
      complexity: "LOW",
      verification: "teste passa",
    },
    {
      id: "check",
      title: "Rodar testes",
      operations: ["TEST_RUN"],
      paths: [],
      complexity: "LOW",
      verification: "node sai com 0",
      dependsOn: ["fix"],
    },
  ],
  risks: [{ description: "regressão", mitigation: "rodar a suíte" }],
  testStrategy: "node check",
  rollback: "git revert",
  assumptions: ["só app.js muda"],
});

function runningWork(config: Record<string, unknown>, plan: PlanInput) {
  root = makeRepo();
  writeConfig(root, { trustedProject: true, ...config });
  jarvis = openJarvis(root);
  const item = jarvis.store.createWorkItem({
    projectId: jarvis.project.id,
    actor: human,
    title: "Item",
    objective: "Objetivo",
    acceptanceCriteria: ["funciona"],
  });
  for (const q of jarvis.planning.generateQuestions(item.id, human, [])) {
    if (q.impact === "MATERIAL" && q.status === "OPEN")
      jarvis.planning.answer(item.id, q.category, "ok", human);
  }
  jarvis.planning.assumeConventions(item.id, human);
  jarvis.planning.submitPlan(item.id, plan, agent);
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
  const run = jarvis.store.createRun(item.id, agent);
  jarvis.store.transitionRun(run.id, "PREPARING", human);
  jarvis.store.transitionRun(run.id, "AWAITING_EXECUTION_APPROVAL", human);
  jarvis.runtime.startExecution(run.id, missionId, human);
  return { item, run };
}

const edit = (runId: string, target: string) =>
  jarvis!.runtime.run(runId, {
    operationId: nextId(),
    requestedBy: agent,
    type: "FILE_EDIT",
    target,
    parameters: { content: `// ${nextId()}\n` },
  });
const test = (runId: string, spec: { command: string; args: string[] }) =>
  jarvis!.runtime.run(runId, {
    operationId: nextId(),
    requestedBy: agent,
    type: "TEST_RUN",
    target: ".",
    parameters: spec,
  });

describe("bug fixes are proven by a test that failed first", () => {
  it("[R-QUALITY-01] code is not touched until a test has really failed; test files always can be", async () => {
    const { run } = runningWork({}, bugPlan());
    const blocked = await edit(run.id, "app.js");
    expect(blocked).toMatchObject({ outcome: "DENIED", reason: "BUGFIX_NEEDS_FAILING_TEST" });
    expect((await edit(run.id, "app.test.js")).outcome).toBe("SUCCEEDED"); // the reproduction is written first
    expect((await test(run.id, FAIL)).outcome).toBe("FAILED"); // and it fails: the bug is reproduced
    expect((await edit(run.id, "app.js")).outcome).toBe("SUCCEEDED"); // now the fix may be written
  });

  it("[R-QUALITY-01] review needs a test that passes after the last change", async () => {
    const { item, run } = runningWork({}, bugPlan());
    await edit(run.id, "app.test.js");
    await test(run.id, FAIL);
    const fix = await edit(run.id, "app.js");
    const green = await test(run.id, PASS);
    const late = await edit(run.id, "app.js"); // a change AFTER the green run makes it stale
    jarvis!.planning.markStep(item.id, "fix", [fix.operationId, late.operationId], agent);
    jarvis!.planning.markStep(item.id, "check", [green.operationId], agent);
    expect(() => jarvis!.runtime.submitForReview(run.id, agent)).toThrow(
      /passes after the last change/,
    );

    const fresh = await test(run.id, PASS);
    jarvis!.planning.markStep(item.id, "check", [fresh.operationId], agent);
    expect(jarvis!.runtime.submitForReview(run.id, agent).status).toBe("AWAITING_REVIEW");
  });

  it("[R-QUALITY-01] a feature plan is not affected", async () => {
    const feature = { ...bugPlan(), kind: "FEATURE" as const };
    delete (feature as { diagnosis?: unknown }).diagnosis;
    const { run } = runningWork({}, feature);
    expect((await edit(run.id, "app.js")).outcome).toBe("SUCCEEDED");
  });

  it("recognizes test files across Python, JS and Java conventions", () => {
    for (const p of [
      "tests/a.py",
      "app.test.ts",
      "src/test_utils.py",
      "pkg/x_test.go",
      "conftest.py",
      "UserServiceTest.java",
    ])
      expect(isTestPath(p), p).toBe(true);
    for (const p of ["src/app.ts", "main.py", "service/User.java"])
      expect(isTestPath(p), p).toBe(false);
  });
});

describe("fix loop breaker", () => {
  /** Reproduce the bug, then fail `n` fix attempts in a row (edit the code, run a failing test). */
  async function failedAttempts(runId: string, n: number) {
    await edit(runId, "app.test.js");
    await test(runId, FAIL); // the reproduction is not a failed fix attempt
    for (let i = 0; i < n; i++) {
      expect((await edit(runId, "app.js")).outcome).toBe("SUCCEEDED");
      await test(runId, FAIL);
    }
  }

  it("[R-QUALITY-06] after three failed fix attempts the code is frozen, but tests and diagnosis stay open", async () => {
    const { run } = runningWork({}, bugPlan());
    await failedAttempts(run.id, 3);
    const stopped = await edit(run.id, "app.js");
    expect(stopped).toMatchObject({ outcome: "DENIED", reason: "FIX_LOOP_STOP:3" });
    expect((await edit(run.id, "app.test.js")).outcome).toBe("SUCCEEDED"); // a better test is allowed
    expect((await test(run.id, FAIL)).outcome).toBe("FAILED"); // and so is investigating
  });

  it("[R-QUALITY-06] two failures, or a green run in between, do not stop anything", async () => {
    const { run } = runningWork({}, bugPlan());
    await failedAttempts(run.id, 2);
    expect((await edit(run.id, "app.js")).outcome).toBe("SUCCEEDED");
    await test(run.id, PASS); // progress resets the count
    await edit(run.id, "app.js");
    await test(run.id, FAIL);
    await edit(run.id, "app.js");
    await test(run.id, FAIL);
    expect((await edit(run.id, "app.js")).outcome).toBe("SUCCEEDED");
  });

  it("[R-QUALITY-06] only a human-approved amended plan releases the code; a draft does not", async () => {
    const { item, run } = runningWork({}, bugPlan());
    await failedAttempts(run.id, 3);
    jarvis!.planning.submitPlan(item.id, bugPlan(), agent); // the agent proposes a new approach
    expect(await edit(run.id, "app.js")).toMatchObject({ reason: "FIX_LOOP_STOP:3" });
    jarvis!.planning.approvePlan(item.id, human); // the human decides to try again
    expect((await edit(run.id, "app.js")).outcome).toBe("SUCCEEDED");
  });
});

describe("mandatory checks", () => {
  const featurePlan = (): PlanInput => {
    const p = bugPlan();
    delete (p as { diagnosis?: unknown }).diagnosis;
    return { ...p, kind: "FEATURE" };
  };

  it("[R-QUALITY-02] nothing is committed or submitted while a check is red or stale", async () => {
    const { item, run } = runningWork({ checks: [{ name: "unit", ...PASS }] }, featurePlan());
    const e = await edit(run.id, "app.js");
    const commit = await jarvis!.runtime.run(run.id, {
      operationId: nextId(),
      requestedBy: agent,
      type: "GIT_COMMIT",
      target: "main",
      parameters: { message: "m", diffHash: "a".repeat(64) },
    });
    expect(commit).toMatchObject({ outcome: "DENIED", reason: "CHECKS_NOT_PASSING:unit" });

    const t = await test(run.id, PASS); // same command and args as the configured check
    jarvis!.planning.markStep(item.id, "fix", [e.operationId], agent);
    jarvis!.planning.markStep(item.id, "check", [t.operationId], agent);
    expect(jarvis!.runtime.submitForReview(run.id, agent).status).toBe("AWAITING_REVIEW");
  });

  it("[R-QUALITY-02] a different command does not satisfy the check, and the real one does", async () => {
    const { item, run } = runningWork({ checks: [{ name: "unit", ...PASS }] }, featurePlan());
    const e = await edit(run.id, "app.js");
    const other = await test(run.id, { command: "node", args: ["-e", "0"] }); // passes, but it is not THE check
    jarvis!.planning.markStep(item.id, "fix", [e.operationId], agent);
    jarvis!.planning.markStep(item.id, "check", [other.operationId], agent);
    expect(() => jarvis!.runtime.submitForReview(run.id, agent)).toThrow(
      /Mandatory checks not passing since the last change: unit/,
    );

    const real = await test(run.id, PASS);
    jarvis!.planning.markStep(item.id, "check", [real.operationId], agent);
    expect(jarvis!.runtime.submitForReview(run.id, agent).status).toBe("AWAITING_REVIEW");
  });
});

describe("acceptance criteria coverage", () => {
  const item = {
    objective: "o",
    requirements: [],
    acceptanceCriteria: ["a", "b"],
  } as unknown as Parameters<typeof checkPlan>[1];
  const base = bugPlan();
  const withCovers = (covers: number[][]) =>
    PlanSchema.parse({
      ...base,
      kind: "FEATURE",
      diagnosis: undefined,
      steps: base.steps.map((s, i) => ({ ...s, covers: covers[i] ?? [] })),
    });
  const codes = (p: ReturnType<typeof withCovers>) =>
    checkPlan(p, item, []).blockers.map((b) => b.code);

  it("[R-QUALITY-03] once a step declares coverage, every criterion needs a step", () => {
    expect(codes(withCovers([[1], []]))).toContain("CRITERION_WITHOUT_STEP");
    expect(codes(withCovers([[1], [2]]))).not.toContain("CRITERION_WITHOUT_STEP");
    expect(codes(withCovers([[1, 3], [2]]))).toContain("UNKNOWN_CRITERION");
  });

  it("[R-QUALITY-03] with no coverage declared it only warns", () => {
    const r = checkPlan(withCovers([]), item, []);
    expect(r.blockers.map((b) => b.code)).not.toContain("CRITERION_WITHOUT_STEP");
    expect(r.warnings.join(" ")).toMatch(/covers/);
  });
});

describe("local commit by delegation", () => {
  const commitPlan = (): PlanInput => ({
    summary: "Ajustar a.txt e gravar",
    steps: [
      {
        id: "edit",
        title: "Editar",
        operations: ["FILE_EDIT"],
        paths: ["a.txt"],
        complexity: "LOW",
        verification: "arquivo editado",
      },
      {
        id: "stage",
        title: "Preparar",
        operations: ["GIT_STAGE"],
        paths: ["a.txt"],
        complexity: "LOW",
        verification: "staged",
        dependsOn: ["edit"],
      },
      {
        id: "commit",
        title: "Gravar",
        operations: ["GIT_COMMIT"],
        paths: [],
        complexity: "LOW",
        verification: "commit criado",
        dependsOn: ["stage"],
      },
    ],
    risks: [{ description: "commit errado", mitigation: "branch de trabalho" }],
    testStrategy: "node check",
    rollback: "git reset --soft HEAD~1 na branch de trabalho",
    assumptions: ["branch de trabalho"],
  });

  async function startAutonomous(allowLocalCommit: boolean) {
    root = makeRepo();
    writeConfig(root, {
      trustedProject: true,
      autonomy: { level: "INTERMEDIATE", allowLocalCommit },
    });
    jarvis = openJarvis(root);
    const item = jarvis.store.createWorkItem({
      projectId: jarvis.project.id,
      actor: human,
      title: "Item",
      objective: "o",
      acceptanceCriteria: ["ok"],
    });
    for (const q of jarvis.planning.generateQuestions(item.id, human, [])) {
      if (q.impact === "MATERIAL" && q.status === "OPEN")
        jarvis.planning.answer(item.id, q.category, "ok", human);
    }
    jarvis.planning.assumeConventions(item.id, human);
    jarvis.planning.submitPlan(item.id, commitPlan(), agent);
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
    const run = jarvis.store.createRun(item.id, agent);
    jarvis.store.transitionRun(run.id, "PREPARING", human);
    jarvis.store.transitionRun(run.id, "AWAITING_EXECUTION_APPROVAL", human);
    const tick = jarvis.autonomyTick(missionId);
    return { item, run, tick };
  }

  async function stageAndCommit(runId: string) {
    await edit(runId, "a.txt");
    const staged = await jarvis!.runtime.run(runId, {
      operationId: nextId(),
      requestedBy: agent,
      type: "GIT_STAGE",
      target: "a.txt",
    });
    return jarvis!.runtime.run(runId, {
      operationId: nextId(),
      requestedBy: agent,
      type: "GIT_COMMIT",
      target: "work",
      parameters: { message: "feat: ajuste", diffHash: String(staged.evidence["stagedDiffHash"]) },
    });
  }

  it("[R-QUALITY-04] on a work branch a local commit goes through without asking, attributed to the delegation", async () => {
    const { run, tick } = await startAutonomous(true);
    expect(tick.startedRuns).toEqual([run.id]);
    sh(root, "checkout", "-q", "-b", "feat/ajuste");
    const result = await stageAndCommit(run.id);
    expect(result.outcome).toBe("SUCCEEDED");
    const delegated = jarvis!.db
      .prepare("SELECT actor_id FROM audit_events WHERE kind = 'execution.delegated'")
      .all() as { actor_id: string }[];
    expect(delegated).toEqual([{ actor_id: "autonomy" }]);
  });

  it("[R-QUALITY-04] on the default or a protected branch the commit still needs the human", async () => {
    const { run } = await startAutonomous(true);
    // makeRepo starts on main
    const result = await stageAndCommit(run.id);
    expect(result.outcome).toBe("DENIED");
    expect(result.reason).toMatch(/^APPROVAL_/);
  });

  it("[R-QUALITY-04] without the owner's permission, or for a push, the human is still needed", async () => {
    const off = await startAutonomous(false);
    expect(off.tick.approvedPlans).toEqual([]); // a plan with a commit is not eligible without allowLocalCommit
    jarvis!.close();
    cleanup(root);

    const { run } = await startAutonomous(true);
    sh(root, "checkout", "-q", "-b", "feat/ajuste");
    const push = await jarvis!.runtime.run(run.id, {
      operationId: nextId(),
      requestedBy: agent,
      type: "GIT_PUSH",
      target: "origin",
      parameters: {
        remote: "origin",
        branch: "feat/ajuste",
        expectedHead: "a".repeat(40),
        remoteUrl: "x",
      },
    });
    expect(push.outcome).toBe("DENIED");
    expect(push.reason).toMatch(/^APPROVAL_/);
  });
});

describe("check detection for Node, Python and Java", () => {
  it("[R-QUALITY-05] suggests the right checks from the files a project already has", () => {
    root = makeRepo();
    writeFileSync(
      join(root, "pyproject.toml"),
      "[tool.pytest.ini_options]\n[tool.ruff]\n[tool.mypy]\n",
    );
    mkdirSync(join(root, "tests"), { recursive: true });
    writeFileSync(join(root, "pom.xml"), "<project/>");
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ scripts: { lint: "x", test: "y", dev: "z" } }),
    );
    const found = Object.fromEntries(
      detectChecks(root).map((d) => [d.language, d.checks.map((c) => c.name)]),
    );
    expect(found["Python"]).toEqual(["pytest", "ruff", "mypy"]);
    expect(found["Java (Maven)"]).toEqual(["test"]);
    expect(found["Node/TypeScript"]).toEqual(["lint", "test"]);
    expect(detectChecks(makeRepo())).toEqual([]);
  });
});
