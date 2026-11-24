import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run, type Io } from "../../src/cli/index.js";
import { scopeToStep } from "../../src/review/blind.js";
import { PlanSchema } from "../../src/planning/index.js";
import { cleanup, human, makeRepo, openJarvis } from "../helpers.js";

const dirs: string[] = [];
afterEach(() => {
  cleanup(...dirs.splice(0));
});

function memoryIo(): Io & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    out: (l) => void lines.push(l),
    err: (l) => void lines.push(`ERR ${l}`),
    confirm: async () => false,
  };
}
const env = { JARVIS_USER: "rikky" };

describe("session context for AI clients", () => {
  it("[R-CONTEXT-01] in a folder without JARVIS it prints nothing and creates no state", async () => {
    const plain = mkdtempSync(join(tmpdir(), "jarvis-plain-"));
    dirs.push(plain);
    const io = memoryIo();
    expect(await run(["context"], io, plain, env)).toBe(0);
    expect(io.lines).toEqual([]);
    expect(existsSync(join(plain, ".jarvis"))).toBe(false);
  });

  it("[R-CONTEXT-01] in a JARVIS project it states autonomy, open work, plan state and the method", async () => {
    const root = makeRepo();
    dirs.push(root);
    const jarvis = openJarvis(root);
    const item = jarvis.store.createWorkItem({
      projectId: jarvis.project.id,
      actor: human,
      title: "Trocar o logo",
      objective: "o",
      acceptanceCriteria: ["logo novo"],
    });
    jarvis.close();
    const io = memoryIo();
    expect(await run(["context"], io, root, env)).toBe(0);
    const text = io.lines.join("\n");
    expect(text).toContain("Autonomia: SUPERVISED");
    expect(text).toContain(item.id);
    expect(text).toContain("sem plano");
    expect(text).toMatch(/você nunca aprova/);
  });

  it("[R-PLUGIN-02] the plugin session hook runs a command that exists, and never approves anything", async () => {
    const hooks = JSON.parse(
      readFileSync(join(process.cwd(), "plugin", "hooks", "hooks.json"), "utf8"),
    ) as { hooks: { SessionStart: { hooks: { type: string; command: string }[] }[] } };
    const commands = hooks.hooks.SessionStart.flatMap((g) => g.hooks.map((h) => h.command));
    expect(commands.length).toBeGreaterThan(0);
    for (const c of commands) {
      expect(c).toMatch(/dist\/cli\/main\.js" context$/);
      expect(c).not.toMatch(/approve|grant|confirm/);
    }
    const help = memoryIo();
    await run(["--help"], help);
    expect(help.lines.join("\n")).toMatch(/^\s+context\s/m);
  });
});

describe("blind review of a single plan step", () => {
  const plan = PlanSchema.parse({
    summary: "Duas mudanças",
    kind: "FEATURE",
    steps: [
      {
        id: "api",
        title: "API",
        operations: ["FILE_EDIT"],
        paths: ["src/api.ts"],
        complexity: "LOW",
        verification: "teste da API passa",
      },
      {
        id: "ui",
        title: "Tela",
        operations: ["FILE_EDIT"],
        paths: ["src/ui/"],
        complexity: "LOW",
        verification: "tela abre",
        dependsOn: ["api"],
      },
      {
        id: "check",
        title: "Rodar testes",
        operations: ["TEST_RUN"],
        paths: [],
        complexity: "LOW",
        verification: "sai com 0",
        dependsOn: ["ui"],
      },
    ],
    risks: [{ description: "r", mitigation: "m" }],
    testStrategy: "suíte",
    rollback: "git revert",
    assumptions: ["a"],
  });
  const diff = [
    "diff --git a/src/api.ts b/src/api.ts\n+api\n",
    "diff --git a/src/ui/home.ts b/src/ui/home.ts\n+home\n",
    "diff --git a/README.md b/README.md\n+readme\n",
  ].join("");
  const whole = {
    plan,
    acceptanceCriteria: ["tudo funciona"],
    changedPaths: ["src/api.ts", "src/ui/home.ts", "README.md"],
    diff,
  };

  it("[R-METHOD-07] shows the reviewer only that step, its declared files and their diff", () => {
    const api = scopeToStep(whole, "api")!;
    expect(api.plan.steps.map((s) => s.id)).toEqual(["api"]);
    expect(api.changedPaths).toEqual(["src/api.ts"]);
    expect(api.diff).toContain("+api");
    expect(api.diff).not.toContain("+home");
    expect(api.diff).not.toContain("+readme");
    expect(api.acceptanceCriteria).toEqual([]);

    const ui = scopeToStep(whole, "ui")!; // a declared directory covers the files under it
    expect(ui.changedPaths).toEqual(["src/ui/home.ts"]);
    expect(ui.diff).toContain("+home");
  });

  it("[R-METHOD-07] an unknown step, or one that declares no paths, has nothing to review", () => {
    expect(scopeToStep(whole, "nope")).toBeNull();
    expect(scopeToStep(whole, "check")).toBeNull();
  });
});
