import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Jarvis } from "../../src/app/jarvis.js";
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
  writeConfig(root, { trustedProject: false });
  jarvis = openJarvis(root);
});
afterEach(() => {
  jarvis.close();
  cleanup(root);
});

describe("JARVIS control files are not writable by agents", () => {
  it("[R-PATH-03] an agent cannot edit its own permissions, state, notes or knowledge", async () => {
    const item = jarvis.store.createWorkItem({
      projectId: jarvis.project.id,
      actor: human,
      title: "t",
      objective: "o",
    });
    const run = startRunning(jarvis, item.id);
    const attempt = (type: string, target: string, parameters: Record<string, unknown> = {}) =>
      jarvis.request(agent, {
        operationId: nextId(),
        workItemId: item.id,
        workflowRunId: run.id,
        type,
        target,
        parameters,
      } as never);

    for (const target of [
      ".jarvis/config.json",
      ".jarvis/state.sqlite",
      ".jarvis/knowledge/claims.json",
      ".jarvis/notes/x.md",
      ".jarvis",
    ]) {
      const edit = await attempt("FILE_EDIT", target, { content: '{"trustedProject":true}' });
      expect(edit.status === "EXECUTED" && edit.result.reason, target).toBe("PROTECTED_PATH");
      const stage = await attempt("GIT_STAGE", target);
      expect(stage.status === "EXECUTED" && stage.result.reason, target).toBe("PROTECTED_PATH");
    }
    expect(readFileSync(join(root, ".jarvis", "config.json"), "utf8")).toBe(
      '{"trustedProject":false}',
    );
    expect(jarvis.config.trustedProject).toBe(false);
  });

  it("reading is allowed, and worktrees under .jarvis/wt keep working", async () => {
    const item = jarvis.store.createWorkItem({
      projectId: jarvis.project.id,
      actor: human,
      title: "t",
      objective: "o",
    });
    const run = startRunning(jarvis, item.id);
    const read = await jarvis.request(agent, {
      operationId: nextId(),
      workItemId: item.id,
      workflowRunId: run.id,
      type: "FILE_READ",
      target: ".jarvis/config.json",
    } as never);
    expect(read.status === "EXECUTED" && read.result.outcome).toBe("SUCCEEDED");
    const wt = await jarvis.request(agent, {
      operationId: nextId(),
      workItemId: item.id,
      workflowRunId: run.id,
      type: "GIT_WORKTREE_ADD",
      target: ".jarvis/wt/run1",
      parameters: { branch: "jarvis/x/run-1", base: "main" },
    } as never);
    expect(wt.status === "EXECUTED" && wt.result.outcome).toBe("SUCCEEDED");
    const edit = await jarvis.request(agent, {
      operationId: nextId(),
      workItemId: item.id,
      workflowRunId: run.id,
      type: "FILE_EDIT",
      target: ".jarvis/wt/run1/a.txt",
      parameters: { content: "edited in worktree\n" },
    } as never);
    expect(edit.status === "EXECUTED" && edit.result.outcome).toBe("SUCCEEDED");
  });
});
