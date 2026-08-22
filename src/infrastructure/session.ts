import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { harnessRoot } from "./harness.js";
import { nowIso } from "../shared/util.js";

export function resolveSessionId(projectRoot: string, override?: string): string {
  if (override) return override;
  if (process.env.JARVIS_SESSION) return process.env.JARVIS_SESSION;
  const path = join(harnessRoot(projectRoot), "locks", "session.json");
  if (existsSync(path)) {
    try {
      const saved = JSON.parse(readFileSync(path, "utf8")) as { id?: string };
      if (saved.id) return saved.id;
    } catch {
      /* recreate */
    }
  }
  mkdirSync(join(harnessRoot(projectRoot), "locks"), { recursive: true });
  const id = randomUUID();
  writeFileSync(path, `${JSON.stringify({ id, createdAt: nowIso() }, null, 2)}\n`);
  return id;
}
