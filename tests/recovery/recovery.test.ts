import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCommand } from "../../src/cli/commands.js";
import { Store } from "../../src/infrastructure/db.js";

describe("recovery", () => {
  it("does not assume an interrupted EXECUTING action finished", () => {
    const dir = mkdtempSync(join(tmpdir(), "jarvis-rec-"));
    try {
      runCommand("init", dir, {});
      runCommand("plan", dir, { objective: "recuperar estado" });
      const store = Store.open(dir);
      const cycle = store.activeCycle();
      expect(cycle).toBeTruthy();
      if (!cycle) return;
      store.appendEvent("evt-start", "ACTION_STARTED", { command: "dev" }, cycle.id);
      store.updateCycle(cycle.id, "EXECUTING", cycle.payload);
      store.close();
      const status = runCommand("status", dir, {}) as {
        currentCycle: { status: string } | null;
      };
      expect(status.currentCycle?.status).toBe("EXECUTING");
      runCommand("review", dir, {});
      const store2 = Store.open(dir);
      const again = store2.activeCycle();
      const payload = again ? (JSON.parse(again.payload) as { lastActionUnknown?: boolean }) : {};
      store2.close();
      expect(payload.lastActionUnknown).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
