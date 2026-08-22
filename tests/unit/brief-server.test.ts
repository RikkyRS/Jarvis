import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCommand } from "../../src/cli/commands.js";
import { fromRow } from "../../src/core/runtime-helpers.js";
import { buildAgentBrief } from "../../src/engines/memory/brief.js";
import { DEFAULT_HOST, DEFAULT_PORT, startJarvisServer } from "../../src/infrastructure/server.js";
import { Store } from "../../src/infrastructure/db.js";
import { readBriefCache } from "../../src/infrastructure/brief-cache.js";

describe("memory brief and local server", () => {
  it("builds a compact agent brief", () => {
    const dir = mkdtempSync(join(tmpdir(), "jarvis-brief-"));
    try {
      runCommand("init", dir, {});
      runCommand("plan", dir, { objective: "melhorar readme" });
      const store = Store.open(dir);
      const row = store.activeCycle();
      expect(row).toBeTruthy();
      const brief = buildAgentBrief(dir, store, row ? fromRow(row) : null);
      store.close();
      expect(brief.memory.bullets.length).toBeGreaterThan(0);
      expect(brief.cycle?.objective).toContain("readme");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns brief via CLI and writes cache", () => {
    const dir = mkdtempSync(join(tmpdir(), "jarvis-brief-cli-"));
    try {
      runCommand("init", dir, {});
      runCommand("plan", dir, { objective: "cache brief" });
      const result = runCommand("brief", dir, {}) as { status: string; brief: { cycle: { objective: string } | null } };
      expect(result.status).toBe("BRIEF");
      expect(result.brief.cycle?.objective).toContain("cache");
      const cached = readBriefCache(dir);
      expect(cached?.brief).toBeTruthy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records host notes via memorize", () => {
    const dir = mkdtempSync(join(tmpdir(), "jarvis-mem-note-"));
    try {
      runCommand("init", dir, {});
      const recorded = runCommand("memorize", dir, { objective: "usa npm run ci antes de PR" }) as {
        status: string;
        kind: string;
      };
      expect(recorded.status).toBe("RECORDED");
      expect(recorded.kind).toBe("HOST_NOTE");
      const brief = runCommand("brief", dir, {}) as { brief: { memory: { bullets: string[] } } };
      expect(brief.brief.memory.bullets.some((b) => b.includes("npm run ci"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("serves health and brief over localhost", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jarvis-http-"));
    try {
      runCommand("init", dir, {});
      runCommand("plan", dir, { objective: "http brief" });
      const started = await startJarvisServer(DEFAULT_PORT + 7, DEFAULT_HOST);
      try {
        const health = await fetch(`http://${DEFAULT_HOST}:${DEFAULT_PORT + 7}/health`);
        expect(health.status).toBe(200);
        const briefRes = await fetch(
          `http://${DEFAULT_HOST}:${DEFAULT_PORT + 7}/brief?project=${encodeURIComponent(dir)}`,
        );
        expect(briefRes.status).toBe(200);
        const body = (await briefRes.json()) as {
          brief?: { cycle?: { objective?: string } };
          status?: string;
          cycle?: { objective?: string };
        };
        const nested = body.brief ?? body;
        expect(nested.cycle?.objective).toContain("http");
      } finally {
        started.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
