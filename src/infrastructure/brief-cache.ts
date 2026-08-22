import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { harnessRoot } from "./harness.js";
import { nowIso } from "../shared/util.js";

export type BriefCache = {
  cachedAt: string;
  projectRoot: string;
  brief: unknown;
};

export function briefCachePath(projectRoot: string): string {
  return join(harnessRoot(projectRoot), "cache", "agent-brief.json");
}

export function writeBriefCache(projectRoot: string, brief: unknown): void {
  const dir = join(harnessRoot(projectRoot), "cache");
  mkdirSync(dir, { recursive: true });
  const payload: BriefCache = { cachedAt: nowIso(), projectRoot, brief };
  writeFileSync(briefCachePath(projectRoot), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

export function readBriefCache(projectRoot: string): BriefCache | null {
  const path = briefCachePath(projectRoot);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as BriefCache;
  } catch {
    return null;
  }
}
