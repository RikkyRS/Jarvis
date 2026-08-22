import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { nowIso } from "../shared/util.js";

const GLOBAL_DIR = join(homedir(), ".jarvis", "global");
const GLOBAL_FILE = join(GLOBAL_DIR, "memory.jsonl");

export type GlobalMemoryRecord = {
  id: string;
  kind: string;
  payload: unknown;
  confidence: string;
  projectRoot?: string;
  cycleId?: string;
  timestamp: string;
  dedupKey: string;
};

function dedupKey(kind: string, payload: unknown): string {
  return createHash("sha256").update(`${kind}:${JSON.stringify(payload)}`).digest("hex").slice(0, 24);
}

export function recallGlobal(limit = 8): GlobalMemoryRecord[] {
  if (!existsSync(GLOBAL_FILE)) return [];
  const lines = readFileSync(GLOBAL_FILE, "utf8").split("\n").filter(Boolean);
  const items: GlobalMemoryRecord[] = [];
  for (const line of lines.slice(-limit)) {
    try {
      items.push(JSON.parse(line) as GlobalMemoryRecord);
    } catch {
      /* skip corrupt line */
    }
  }
  return items;
}

export function recallGlobalForProject(projectRoot: string, limit = 8): GlobalMemoryRecord[] {
  const normalized = projectRoot.replaceAll("\\", "/").toLowerCase();
  const all = recallGlobal(200);
  const filtered = all.filter((item) => {
    if (!item.projectRoot) return true;
    return item.projectRoot.replaceAll("\\", "/").toLowerCase() === normalized;
  });
  return filtered.slice(-limit);
}

export function recordGlobal(
  kind: string,
  payload: unknown,
  confidence: string,
  meta?: { projectRoot?: string; cycleId?: string },
): GlobalMemoryRecord | null {
  const key = dedupKey(kind, payload);
  const existing = recallGlobal(200);
  if (existing.some((item) => item.dedupKey === key)) return null;
  mkdirSync(GLOBAL_DIR, { recursive: true });
  const record: GlobalMemoryRecord = {
    id: `gmem-${key.slice(0, 12)}`,
    kind,
    payload,
    confidence,
    dedupKey: key,
    timestamp: nowIso(),
    ...(meta?.projectRoot ? { projectRoot: meta.projectRoot } : {}),
    ...(meta?.cycleId ? { cycleId: meta.cycleId } : {}),
  };
  appendFileSync(GLOBAL_FILE, `${JSON.stringify(record)}\n`, "utf8");
  return record;
}
