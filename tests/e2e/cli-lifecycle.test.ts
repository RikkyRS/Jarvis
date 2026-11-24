import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run as cli, type Io } from "../../src/cli/index.js";
import { Jarvis } from "../../src/app/jarvis.js";
import { agent, cleanup, human, makeRepo, nextId, writeConfig } from "../helpers.js";

let root: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  root = makeRepo();
  writeConfig(root, { trustedProject: true });
  env = { JARVIS_USER: "rikky", JARVIS_NOTES_DIR: join(root, ".jarvis", "notes") };
});
afterEach(() => cleanup(root));

function io(): Io & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    out: (l) => void lines.push(l),
    err: (l) => void lines.push(`ERR ${l}`),
    confirm: async () => true,
  };
}

/** Runs one CLI command and returns its first output line (the id, for create commands). */
async function step(args: string[], expectCode = 0): Promise<string[]> {
  const out = io();
  const code = await cli(args, out, root, env);
  expect(code, `${args.join(" ")} -> ${out.lines.join(" | ")}`).toBe(expectCode);
  return out.lines;
}

describe("the whole lifecycle is drivable by a human from the CLI", () => {
  it("[R-E2E-02] work -> questions -> plan -> approval -> run -> agent work -> review -> delivery -> reopen", async () => {
    const wi = (
      await step([
        "work",
        "create",
        "Editar",
        "a",
        "--objective",
        "Editar a.txt",
        "--accept",
        "a.txt editado",
      ])
    )[0]!;

    await step(["plan", "questions", wi]);
    for (const category of [
      "purpose",
      "scope",
      "data",
      "security",
      "compatibility",
      "dependencies",
    ]) {
      await step(["plan", "answer", wi, category, "sem", "impacto"]);
    }
    await step(["plan", "assume", wi]);
    writeFileSync(
      join(root, "plan.json"),
      JSON.stringify({
        summary: "Editar a.txt",
        steps: [
          {
            id: "edit",
            title: "Editar",
            operations: ["FILE_EDIT"],
            paths: ["a.txt"],
            complexity: "LOW",
            verification: "conteudo conferido",
          },
          {
            id: "check",
            title: "Conferir",
            operations: ["TEST_RUN"],
            complexity: "LOW",
            verification: "node sai 0",
            dependsOn: ["edit"],
          },
        ],
        risks: [{ description: "edicao errada", mitigation: "revisar o diff" }],
        testStrategy: "node check",
        rollback: "git revert",
        assumptions: ["so a.txt muda"],
      }),
    );
    await step(["plan", "submit", wi, join(root, "plan.json")]);
    await step(["plan", "check", wi]);
    await step(["plan", "approve", wi, "--yes"]);

    const mission = (await step(["mission", "create", "--work-item", wi]))[0]!;
    const runId = (await step(["run", "create", wi]))[0]!;
    // Execution cannot start yet: no Execution Budget.
    await step(["run", "ready", runId]);
    await step(["run", "start", runId, mission], 1);
    await step(["budget", "grant", mission, "EXECUTION", "200000", "--reason", "plano v1"]);
    expect((await step(["run", "start", runId, mission]))[0]).toBe("RUNNING");

    // The agent works through the gateway (this is what the MCP adapter does).
    const jarvis = Jarvis.open({ root, human, notesDir: env["JARVIS_NOTES_DIR"]! });
    const e = await jarvis.request(agent, {
      operationId: nextId(),
      workItemId: wi,
      workflowRunId: runId,
      type: "FILE_EDIT",
      target: "a.txt",
      parameters: { content: "novo\n" },
    } as never);
    const t = await jarvis.request(agent, {
      operationId: nextId(),
      workItemId: wi,
      workflowRunId: runId,
      type: "TEST_RUN",
      target: ".",
      parameters: { command: "node", args: ["-e", "0"] },
    } as never);
    jarvis.close();
    if (e.status !== "EXECUTED" || t.status !== "EXECUTED")
      throw new Error("operations did not run");

    await step(["run", "submit", runId], 1); // steps not proven yet
    await step(["plan", "done", wi, "edit", e.result.operationId]);
    await step(["plan", "done", wi, "check", t.result.operationId]);
    expect((await step(["run", "submit", runId]))[0]).toBe("AWAITING_REVIEW");
    expect((await step(["run", "complete", runId]))[0]).toBe("COMPLETED");
    await step(["work", "status", wi, "IN_PROGRESS"]);
    expect((await step(["work", "status", wi, "DELIVERED"]))[0]).toBe("DELIVERED");
    expect((await step(["work", "status", wi, "REOPENED"]))[0]).toBe("REOPENED");

    const listed = await step(["run", "list", wi]);
    expect(listed.join("\n")).toContain("COMPLETED");
    const notes = await step(["notes", "write", wi]);
    expect(notes[0]).toContain(".md");
    expect((await step(["audit", "verify"]))[0]).toContain("verified");
  });
});
