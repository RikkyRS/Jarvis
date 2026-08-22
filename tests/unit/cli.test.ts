import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../../src/cli/index.js";
import { runCommand } from "../../src/cli/commands.js";
import { resolveTarget } from "../../src/cli/target.js";

async function capture(argv: string[]): Promise<{ code: number; out: string }> {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    const code = await main(argv);
    return { code, out: chunks.join("") };
  } finally {
    process.stdout.write = original;
  }
}

describe("CLI", () => {
  it("prints help", async () => {
    const result = await capture(["--help"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("JARVIS");
  });

  it("runs doctor", async () => {
    const result = await capture(["doctor"]);
    expect(result.code).toBe(0);
    const data = JSON.parse(result.out) as { status: string };
    expect(data.status).toBe("OK");
  });

  it("inits a project and reports status", () => {
    const dir = mkdtempSync(join(tmpdir(), "jarvis-"));
    try {
      const init = runCommand("init", dir, {});
      expect(init).toMatchObject({ status: "INITIALIZED" });
      const gitignore = readFileSync(join(dir, ".gitignore"), "utf8");
      expect(gitignore).toContain(".harness/");
      const status = runCommand("status", dir, {});
      expect(status).toMatchObject({ status: "READY", currentCycle: null });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("plans a cycle instead of pretending the engine is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "jarvis-"));
    try {
      runCommand("init", dir, {});
      const plan = runCommand("plan", dir, { objective: "paginação" }) as { status: string; cycleId: string };
      expect(plan.status).toBe("PLANNING");
      expect(plan.cycleId).toMatch(/^cycle-/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts planeje as plan and auto-inits", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jarvis-"));
    try {
      const result = await capture(["planeje", "paginação", "--project", dir]);
      expect(result.code).toBe(0);
      const data = JSON.parse(result.out) as { status: string };
      expect(data.status).toBe("PLANNING");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("requires --project inside the runtime package", () => {
    const result = resolveTarget(undefined, process.cwd(), false);
    expect(result.status).toBe("TARGET_REQUIRED");
  });
});
