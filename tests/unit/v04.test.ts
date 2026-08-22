import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCommand } from "../../src/cli/commands.js";
import { decidePermission } from "../../src/engines/permission/index.js";
import { loadProjectPolicy } from "../../src/infrastructure/project-policy.js";

describe("v0.4 senior features", () => {
  it("loads project policy from .jarvis.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "jarvis-policy-"));
    try {
      writeFileSync(
        join(dir, ".jarvis.json"),
        JSON.stringify({
          version: 1,
          risk: { requireApprovalFrom: "MEDIUM", blockCritical: true },
          workflow: { requireTestBeforeClose: true },
        }),
        "utf8",
      );
      const policy = loadProjectPolicy(dir);
      expect(policy.source).toBe(".jarvis.json");
      expect(policy.risk.requireApprovalFrom).toBe("MEDIUM");
      expect(policy.workflow.requireTestBeforeClose).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("applies policy threshold to permission", () => {
    const strict = { requireApprovalFrom: "MEDIUM" as const, blockCritical: true };
    const medium = decidePermission("MEDIUM", false, strict);
    expect(medium.decision).toBe("APPROVAL_REQUIRED");
    const low = decidePermission("LOW", false, strict);
    expect(low.decision).toBe("ALLOW");
  });

  it("returns event timeline via logs command", () => {
    const dir = mkdtempSync(join(tmpdir(), "jarvis-logs-"));
    try {
      runCommand("init", dir, {});
      runCommand("plan", dir, { objective: "timeline test" });
      const logs = runCommand("logs", dir, { limit: 10 }) as { status: string; count: number };
      expect(logs.status).toBe("TIMELINE");
      expect(logs.count).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reconciles git state with optional remote fetch", () => {
    const dir = mkdtempSync(join(tmpdir(), "jarvis-reconcile-"));
    try {
      runCommand("init", dir, {});
      runCommand("plan", dir, { objective: "git reconcile" });
      const result = runCommand("reconcile", dir, { remote: false }) as {
        status: string;
        reconciliation: { status: string };
      };
      expect(result.status).toBe("RECONCILED");
      expect(["IN_SYNC", "DIVERGED", "UNKNOWN", "NO_BASELINE"]).toContain(result.reconciliation.status);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("doctor reports gh probe and policy source", () => {
    const dir = mkdtempSync(join(tmpdir(), "jarvis-doc-"));
    try {
      writeFileSync(join(dir, ".jarvis.json"), JSON.stringify({ version: 1 }), "utf8");
      runCommand("init", dir, {});
      const doc = runCommand("doctor", dir, {}) as {
        gh: { available: boolean };
        policy: { source: string } | null;
        schemaVersion: number;
      };
      expect(doc.schemaVersion).toBeGreaterThanOrEqual(2);
      expect(doc.gh).toBeTruthy();
      expect(doc.policy?.source).toBe(".jarvis.json");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
