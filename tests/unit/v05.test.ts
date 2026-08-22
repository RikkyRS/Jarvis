import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { runCommand } from "../../src/cli/commands.js";

function git(cwd: string, args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if ((result.status ?? 1) !== 0) throw new Error(result.stderr || result.stdout);
}

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-v05-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "demo", scripts: { test: "node -e \"process.exit(0)\"" } }),
    "utf8",
  );
  writeFileSync(join(dir, "README.md"), "# demo\n", "utf8");
  git(dir, ["init"]);
  git(dir, ["add", "."]);
  git(dir, ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-m", "baseline"]);
  return dir;
}

describe("v0.5 team features", () => {
  it("returns stable status schema with session and lock", () => {
    const dir = project();
    try {
      runCommand("init", dir, {});
      runCommand("plan", dir, { objective: "status schema", session: "sess-a" });
      const status = runCommand("status", dir, { session: "sess-a" }) as {
        schemaVersion: string;
        sessionId: string;
        currentCycle: { id: string } | null;
        lock: { held: boolean; isThisSession?: boolean };
      };
      expect(status.schemaVersion).toBe("jarvis.status.v1");
      expect(status.sessionId).toBe("sess-a");
      expect(status.currentCycle?.id).toBeTruthy();
      expect(status.lock.held).toBe(true);
      expect(status.lock.isThisSession).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports who holds the lock", () => {
    const dir = project();
    try {
      runCommand("init", dir, {});
      runCommand("plan", dir, { objective: "who lock", session: "owner" });
      const who = runCommand("who", dir, { session: "other" }) as {
        status: string;
        lock: { holder: string | null; isThisSession?: boolean };
      };
      expect(who.status).toBe("WHO");
      expect(who.lock.holder).toBe("owner");
      expect(who.lock.isThisSession).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exports and imports a cycle pack without stealing the active cycle", () => {
    const dir = project();
    const other = mkdtempSync(join(tmpdir(), "jarvis-import-"));
    try {
      runCommand("init", dir, {});
      runCommand("plan", dir, { objective: "export pack" });
      const exported = runCommand("export", dir, {}) as {
        status: string;
        path: string;
        checksum: string;
        evidenceCount: number;
      };
      expect(exported.status).toBe("EXPORTED");
      expect(existsSync(exported.path)).toBe(true);
      expect(exported.evidenceCount).toBeGreaterThan(0);

      runCommand("init", other, {});
      const imported = runCommand("import", other, { path: exported.path }) as {
        status: string;
        importPath: string;
        cycle: { objective: string };
      };
      expect(imported.status).toBe("IMPORTED");
      expect(imported.cycle.objective).toContain("export");
      expect(existsSync(imported.importPath)).toBe(true);
      const status = runCommand("status", other, {}) as { currentCycle: null };
      expect(status.currentCycle).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("detects detached HEAD in snapshot", () => {
    const dir = project();
    try {
      const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8", windowsHide: true });
      git(dir, ["checkout", "--detach", head.stdout.trim()]);
      runCommand("init", dir, {});
      const status = runCommand("status", dir, {}) as { git: { detachedHead: boolean } };
      expect(status.git.detachedHead).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
