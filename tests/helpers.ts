import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Jarvis, type JarvisOptions } from "../src/app/jarvis.js";

export const human = { kind: "human", id: "rikky" } as const;
export const agent = { kind: "agent", id: "claude" } as const;

export const sh = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

export function makeRepo(prefix = "jarvis-repo-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  sh(root, "init", "-b", "main");
  sh(root, "config", "user.email", "t@example.com");
  sh(root, "config", "user.name", "Test");
  sh(root, "config", "commit.gpgsign", "false");
  writeFileSync(join(root, "a.txt"), "one\n");
  writeFileSync(join(root, ".gitignore"), ".jarvis/\n");
  sh(root, "add", ".");
  sh(root, "commit", "-m", "init");
  return root;
}

export function writeConfig(root: string, config: Record<string, unknown>): void {
  mkdirSync(join(root, ".jarvis"), { recursive: true });
  writeFileSync(join(root, ".jarvis", "config.json"), JSON.stringify(config));
}

export function openJarvis(root: string, extra: Partial<JarvisOptions> = {}): Jarvis {
  // Never write the learning journal into the real home folder during tests.
  const notesDir = join(root, ".jarvis", "notes");
  return Jarvis.open({ root, human, notesDir, ...extra });
}

/** A run in the RUNNING state (after plan approval and human start), as the guard requires for any change. */
export function startRunning(jarvis: Jarvis, workItemId: string) {
  const run = jarvis.store.createRun(workItemId, agent);
  for (const s of ["PREPARING", "AWAITING_EXECUTION_APPROVAL", "RUNNING"] as const) {
    jarvis.store.transitionRun(run.id, s, human);
  }
  return jarvis.store.getRun(run.id)!;
}

export const cleanup = (...dirs: string[]): void => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
};

let counter = 0;
export const nextId = (prefix = "op"): string =>
  `${prefix}-${++counter}-${Math.random().toString(36).slice(2, 8)}`;
