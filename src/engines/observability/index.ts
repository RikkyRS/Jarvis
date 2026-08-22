import type { Store } from "../../infrastructure/db.js";
import { shortId } from "../../shared/util.js";

export function observe(store: Store, type: string, payload: unknown, cycleId?: string): void {
  store.appendEvent(shortId("evt"), type, payload, cycleId);
}
