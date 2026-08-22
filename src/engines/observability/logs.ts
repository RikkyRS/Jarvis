import type { Store } from "../../infrastructure/db.js";

export type TimelineEntry = {
  at: string;
  type: string;
  payload: unknown;
  cycleId: string | null;
};

export function buildTimeline(
  store: Store,
  options: { cycleId?: string; limit?: number } = {},
): { status: "TIMELINE"; count: number; entries: TimelineEntry[] } {
  const limit = options.limit ?? 50;
  const entries = store.listEvents(options.cycleId, limit).map((row) => ({
    at: row.created_at,
    type: row.type,
    payload: JSON.parse(row.payload) as unknown,
    cycleId: row.cycle_id,
  }));
  return { status: "TIMELINE", count: entries.length, entries };
}
