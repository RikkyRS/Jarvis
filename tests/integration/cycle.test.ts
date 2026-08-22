import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { runCommand } from "../../src/cli/commands.js";

function git(cwd: string, args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-app-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "demo", scripts: { test: "node -e \"process.exit(0)\"" } }), "utf8");
  writeFileSync(join(dir, "usersRoutes.ts"), "export {}\n", "utf8");
  git(dir, ["init"]);
  git(dir, ["add", "."]);
  git(dir, ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-m", "baseline"]);
  return dir;
}

describe("cycle e2e", () => {
  it("runs plan -> dev -> test -> review -> security -> close", () => {
    const dir = project();
    try {
      expect(runCommand("init", dir, {})).toMatchObject({ status: "INITIALIZED" });
      const plan = runCommand("plan", dir, { objective: "atualizar readme local" }) as {
        status: string;
        cycleId: string;
        risk: { level: string };
      };
      expect(plan.status).toBe("PLANNING");
      const dev = runCommand("dev", dir, {}) as { status: string };
      expect(["EXECUTION_AUTHORIZED", "REQUIRES_APPROVAL"]).toContain(dev.status);
      if (dev.status === "REQUIRES_APPROVAL") {
        expect(runCommand("dev", dir, { approve: true })).toMatchObject({ status: "EXECUTION_AUTHORIZED" });
      }
      const test = runCommand("test", dir, {}) as { status: string; ran: boolean };
      expect(["PASSED", "FAILED", "UNKNOWN"]).toContain(test.status);
      const review = runCommand("review", dir, {}) as { status: string };
      expect(review.status).toBe("REVIEWED");
      const security = runCommand("security", dir, {}) as { status: string };
      expect(security.status).toBe("SCANNED");
      const closed = runCommand("close", dir, {}) as { status: string };
      expect(["COMPLETED", "ABANDONED"]).toContain(closed.status);
      const status = runCommand("status", dir, {}) as { currentCycle: string | null };
      expect(status.currentCycle).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("blocks a second active cycle and requires approval for HIGH API risk", () => {
    const dir = project();
    try {
      runCommand("init", dir, {});
      const first = runCommand("plan", dir, { objective: "alterar endpoint da API" }) as { status: string; risk: { level: string } };
      expect(first.status).toBe("PLANNING");
      expect(first.risk.level).toBe("HIGH");
      const second = runCommand("plan", dir, { objective: "outra" }) as { status: string };
      expect(second.status).toBe("CYCLE_ALREADY_ACTIVE");
      const denied = runCommand("dev", dir, {}) as { status: string };
      expect(denied.status).toBe("REQUIRES_APPROVAL");
      const allowed = runCommand("dev", dir, { approve: true }) as { status: string };
      expect(allowed.status).toBe("EXECUTION_AUTHORIZED");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("blocks CRITICAL force-push objectives", () => {
    const dir = project();
    try {
      runCommand("init", dir, {});
      runCommand("plan", dir, { objective: "fazer force push na main" });
      const result = runCommand("dev", dir, { approve: true }) as { status: string };
      expect(result.status).toBe("BLOCKED");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prevents a second session from controlling the same Cycle", () => {
    const dir = project();
    try {
      runCommand("init", dir, {});
      runCommand("plan", dir, { objective: "lock test", session: "session-a" });
      const blocked = runCommand("dev", dir, { session: "session-b" }) as { status: string };
      expect(blocked.status).toBe("CONFLICT");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects pre-existing human changes", () => {
    const dir = project();
    try {
      writeFileSync(join(dir, "usersRoutes.ts"), "export const changed = true\n", "utf8");
      runCommand("init", dir, {});
      const plan = runCommand("plan", dir, { objective: "paginação no modal" }) as {
        impact: { layers: { HUMAN: unknown[] } };
      };
      expect(plan.impact.layers.HUMAN.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("discovers typescript python and ruby fixtures", () => {
    runCommand("init", "tests/fixtures/typescript", {});
    runCommand("init", "tests/fixtures/python", {});
    runCommand("init", "tests/fixtures/ruby", {});
    const ts = runCommand("context", "tests/fixtures/typescript", {}) as { levels: { L0: { ecosystems: string[] } } };
    const py = runCommand("context", "tests/fixtures/python", {}) as { levels: { L0: { ecosystems: string[] } } };
    const rb = runCommand("context", "tests/fixtures/ruby", {}) as { levels: { L0: { ecosystems: string[] } } };
    expect(ts.levels.L0.ecosystems).toContain("typescript");
    expect(py.levels.L0.ecosystems).toContain("python");
    expect(rb.levels.L0.ecosystems).toContain("ruby");
  });
});
