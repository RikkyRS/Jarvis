import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCommand } from "../../src/cli/commands.js";
import { discoverL2 } from "../../src/engines/context/l2.js";
import { recallMemory, recordMemory } from "../../src/engines/memory/index.js";
import { accumulateRisk, assessRisk } from "../../src/engines/risk/index.js";
import { impactedTestPaths } from "../../src/engines/test/index.js";
import { Store, LATEST_SCHEMA_VERSION } from "../../src/infrastructure/db.js";
import { runMigrations } from "../../src/infrastructure/migrations.js";
import { DatabaseSync } from "node:sqlite";

describe("v0.2 features", () => {
  it("applies sqlite migrations including dedup_key", () => {
    const db = new DatabaseSync(":memory:");
    const applied = runMigrations(db);
    expect(applied).toBeGreaterThanOrEqual(2);
    const cols = db.prepare("PRAGMA table_info(memory)").all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === "dedup_key")).toBe(true);
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(2);
    db.close();
  });

  it("deduplicates project memory records", () => {
    const dir = mkdtempSync(join(tmpdir(), "jarvis-mem-"));
    try {
      runCommand("init", dir, {});
      const store = Store.open(dir);
      recordMemory(store, "PROJECT", "NOTE", { text: "same" }, "LOW");
      recordMemory(store, "PROJECT", "NOTE", { text: "same" }, "LOW");
      const recalled = recallMemory(store);
      expect(recalled.projectCount).toBe(1);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accumulates risk across assessments", () => {
    const emptyLayers = {
      DIRECT: [],
      INDIRECT: [],
      CONTRACT: [],
      DATA: [],
      TEST: [],
      CONFIG: [],
      EXTERNAL: [],
      HUMAN: [],
    };
    const low = assessRisk("docs only", { layers: emptyLayers, unknownExternalConsumers: [], confidence: "LOW" }, "LOW");
    const high = assessRisk("alterar endpoint da API", {
      layers: { ...emptyLayers, CONTRACT: [{ path: "routes.ts", layer: "CONTRACT" as const, reason: "x", knowledgeState: "INFERRED" as const }] },
      unknownExternalConsumers: ["UNKNOWN_EXTERNAL_CONSUMER"],
      confidence: "MEDIUM",
    });
    const merged = accumulateRisk(low, high);
    expect(merged.accumulated).toBe("HIGH");
    expect(merged.level).toBe("HIGH");
  });

  it("discovers L2 exports from typescript source tree", () => {
    const l2 = discoverL2("src/engines/context");
    expect(l2.filesScanned).toBeGreaterThan(0);
    expect(l2.parser).toBe("structural-regex");
  });

  it("maps impacted tests from source paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "jarvis-imp-"));
    try {
      writeFileSync(join(dir, "usersService.ts"), "export {}\n", "utf8");
      writeFileSync(join(dir, "usersService.test.ts"), "test('x',()=>{})\n", "utf8");
      const paths = impactedTestPaths(dir, {
        layers: { DIRECT: [{ path: "usersService.ts", layer: "DIRECT", reason: "x", knowledgeState: "INFERRED" }] },
        unknownExternalConsumers: [],
        confidence: "MEDIUM",
      });
      expect(paths).toContain("usersService.test.ts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("supports pause and resume on active cycle", () => {
    const dir = mkdtempSync(join(tmpdir(), "jarvis-pause-"));
    try {
      runCommand("init", dir, {});
      runCommand("plan", dir, { objective: "pausar ciclo" });
      const paused = runCommand("pause", dir, {}) as { status: string; pausedFrom?: string };
      expect(paused.status).toBe("PAUSED");
      expect(paused.pausedFrom).toBeTruthy();
      const resumed = runCommand("resume", dir, {}) as { status: string; cycleStatus: string };
      expect(resumed.status).toBe("RESUMED");
      expect(resumed.cycleStatus).not.toBe("PAUSED");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("maps aguarde to wait", () => {
    const dir = mkdtempSync(join(tmpdir(), "jarvis-wait-"));
    try {
      runCommand("init", dir, {});
      runCommand("plan", dir, { objective: "esperar CI" });
      const waiting = runCommand("wait", dir, { objective: "CI pipeline" }) as { status: string; reason: string };
      expect(waiting.status).toBe("WAITING_EXTERNAL");
      expect(waiting.reason).toContain("CI");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
