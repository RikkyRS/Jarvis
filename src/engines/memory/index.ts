import { createHash } from "node:crypto";
import type { Store } from "../../infrastructure/db.js";
import { recallGlobalForProject, recordGlobal } from "../../infrastructure/global-memory.js";
import { shortId } from "../../shared/util.js";

function dedupKey(kind: string, payload: unknown): string {
  return createHash("sha256").update(`${kind}:${JSON.stringify(payload)}`).digest("hex").slice(0, 24);
}

export function recallMemory(store: Store, projectRoot?: string) {
  const project = store.listMemory().map((row) => ({
    id: row.id,
    level: row.level,
    kind: row.kind,
    payload: JSON.parse(row.payload) as unknown,
    confidence: row.confidence,
    cycleId: row.cycle_id,
  }));
  const global = recallGlobalForProject(projectRoot ?? "", 8).map((row) => ({
    id: row.id,
    level: "GLOBAL" as const,
    kind: row.kind,
    payload: row.payload,
    confidence: row.confidence,
    cycleId: row.cycleId ?? null,
  }));
  const items = [...project, ...global];
  return {
    status: items.length ? "RECALLED" : "EMPTY",
    items,
    globalCount: global.length,
    projectCount: project.length,
    note: "Memory never overrides filesystem or git evidence.",
  };
}

export function recordMemory(
  store: Store,
  level: "GLOBAL" | "PROJECT" | "CYCLE",
  kind: string,
  payload: unknown,
  confidence: string,
  cycleId?: string,
  projectRoot?: string,
): void {
  const key = dedupKey(kind, payload);
  if (level === "GLOBAL") {
    recordGlobal(kind, payload, confidence, { ...(projectRoot ? { projectRoot } : {}), ...(cycleId ? { cycleId } : {}) });
    return;
  }
  store.addMemory(shortId("mem"), level, kind, payload, confidence, cycleId, key);
}

export function promoteToGlobal(
  store: Store,
  kind: string,
  payload: unknown,
  confidence: string,
  meta?: { projectRoot?: string; cycleId?: string },
): boolean {
  recordMemory(store, "PROJECT", kind, payload, confidence, meta?.cycleId);
  return recordGlobal(kind, payload, confidence, meta) !== null;
}
