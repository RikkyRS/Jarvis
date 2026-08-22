import type { Store } from "../../infrastructure/db.js";
import type { Cycle } from "../cycle/index.js";
import { nowIso } from "../../shared/util.js";

export function reconcileCycle(store: Store, cycle: Cycle): Cycle {
  const events = store.recentEvents(cycle.id, 10);
  const started = events.find((item) => item.type === "ACTION_STARTED");
  const finished = events.find((item) => item.type === "ACTION_FINISHED");
  if (started && !finished && cycle.status === "EXECUTING") {
    cycle.payload.lastActionUnknown = true;
  }
  const lock = store.getLock(cycle.id);
  if (lock && Date.parse(lock.expires_at) < Date.now()) {
    store.deleteLock(cycle.id);
  }
  cycle.updatedAt = nowIso();
  return cycle;
}
