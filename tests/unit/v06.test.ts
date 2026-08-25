import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { runCommand } from "../../src/cli/commands.js";
import { buildLinkedInDraftText, parseShareAction } from "../../src/engines/share/index.js";
import { buildGithubLinkedInDraftText, normalizeRepoKey } from "../../src/engines/share/github.js";
import { resolveIntent } from "../../src/cli/intent.js";
import {
  getGlobalShare,
  markGlobalSharePosted,
  upsertGlobalShare,
} from "../../src/infrastructure/global-shares.js";

function git(cwd: string, args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if ((result.status ?? 1) !== 0) throw new Error(result.stderr || result.stdout);
}

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-v06-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "demo-share", scripts: { test: "node -e \"process.exit(0)\"" } }),
    "utf8",
  );
  writeFileSync(join(dir, "README.md"), "# demo\n", "utf8");
  git(dir, ["init"]);
  git(dir, ["add", "."]);
  git(dir, ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-m", "baseline"]);
  return dir;
}

describe("share LinkedIn draft", () => {
  it("resolves share aliases", () => {
    expect(resolveIntent(["compartilhar", "draft"])).toEqual({
      command: "share",
      rest: ["draft"],
    });
    expect(resolveIntent(["linkedin"])).toEqual({ command: "share", rest: [] });
  });

  it("parses share actions including github repos", () => {
    expect(parseShareAction("")).toEqual({ action: "draft" });
    expect(parseShareAction("status")).toEqual({ action: "status" });
    expect(parseShareAction("status github")).toEqual({ action: "github" });
    expect(parseShareAction("github")).toEqual({ action: "github" });
    expect(parseShareAction("done cycle-abc")).toEqual({ action: "done", cycleId: "cycle-abc" });
    expect(parseShareAction("done owner/repo")).toEqual({ action: "done", repoKey: "owner/repo" });
    expect(parseShareAction("draft owner/repo")).toEqual({ action: "draft", repoKey: "owner/repo" });
    expect(parseShareAction("RikkyRS/Jarvis")).toEqual({ action: "draft", repoKey: "RikkyRS/Jarvis" });
    expect(parseShareAction("cycle-xyz")).toEqual({ action: "draft", cycleId: "cycle-xyz" });
  });

  it("normalizes github repo keys", () => {
    expect(normalizeRepoKey("RikkyRS/Jarvis")).toBe("RikkyRS/Jarvis");
    expect(normalizeRepoKey("https://github.com/RikkyRS/Jarvis.git")).toBe("RikkyRS/Jarvis");
  });

  it("builds evidence-based draft text", () => {
    const text = buildLinkedInDraftText({
      projectName: "demo-share",
      objective: "ship share feature",
      cycleNumber: 2,
      cycleId: "cycle-x",
      status: "COMPLETED",
      repoUrl: "https://github.com/acme/demo",
      bullets: ["Testes: PASSED"],
    });
    expect(text).toContain("demo-share");
    expect(text).toContain("ship share feature");
    expect(text).toContain("Testes: PASSED");
    expect(text).toContain("https://github.com/acme/demo");
    expect(text).toContain("revise antes de publicar");
  });

  it("builds github-sourced draft without cycle", () => {
    const text = buildGithubLinkedInDraftText({
      name: "Jarvis",
      nameWithOwner: "RikkyRS/Jarvis",
      description: "Evidence-first harness",
      url: "https://github.com/RikkyRS/Jarvis",
      updatedAt: "2026-08-25T00:00:00Z",
      isPrivate: false,
      primaryLanguage: "TypeScript",
      recentCommits: ["feat: share github"],
    });
    expect(text).toContain("Jarvis");
    expect(text).toContain("Evidence-first harness");
    expect(text).toContain("TypeScript");
    expect(text).toContain("feat: share github");
  });

  it("tracks github shares in global registry", () => {
    const home = mkdtempSync(join(tmpdir(), "jarvis-home-"));
    const prev = process.env.JARVIS_HOME;
    process.env.JARVIS_HOME = home;
    try {
      upsertGlobalShare({
        subjectKind: "github",
        subjectKey: "Acme/Demo",
        channel: "linkedin",
        status: "DRAFT",
        draftPath: join(home, "shares", "Acme-Demo-linkedin.md"),
        draftText: "hello",
        postedAt: null,
      });
      expect(getGlobalShare("github", "acme/demo", "linkedin")?.status).toBe("DRAFT");
      const posted = markGlobalSharePosted("github", "Acme/Demo", "linkedin");
      expect(posted?.status).toBe("POSTED");
      expect(getGlobalShare("github", "Acme/Demo", "linkedin")?.status).toBe("POSTED");
    } finally {
      if (prev === undefined) delete process.env.JARVIS_HOME;
      else process.env.JARVIS_HOME = prev;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("drafts, lists unshared, and marks posted after close", () => {
    const dir = project();
    try {
      runCommand("init", dir, {});
      runCommand("plan", dir, { objective: "share draft linkedin", approve: true });
      runCommand("dev", dir, { approve: true });
      runCommand("test", dir, { approve: true });
      const closed = runCommand("close", dir, { approve: true }) as {
        status: string;
        cycleId: string;
        next?: { share: string };
      };
      expect(closed.status).toBe("COMPLETED");
      expect(closed.next?.share).toContain("share");

      const draft = runCommand("share", dir, { objective: "draft" }) as {
        status: string;
        cycleId: string;
        path: string;
        text: string;
      };
      expect(draft.status).toBe("SHARE_DRAFT");
      expect(draft.cycleId).toBe(closed.cycleId);
      expect(existsSync(draft.path)).toBe(true);
      expect(readFileSync(draft.path, "utf8")).toContain("demo-share");
      expect(draft.text).toContain("share draft linkedin");

      const status = runCommand("share", dir, { objective: "status" }) as {
        status: string;
        unsharedCompleted: number;
        items: Array<{ cycleId: string; share: { status: string } }>;
      };
      expect(status.status).toBe("SHARE_STATUS");
      expect(status.unsharedCompleted).toBe(0);
      expect(status.items[0]?.share.status).toBe("DRAFT");

      const marked = runCommand("share", dir, { objective: `done ${draft.cycleId}` }) as {
        status: string;
        postedAt: string;
      };
      expect(marked.status).toBe("SHARE_MARKED_POSTED");
      expect(marked.postedAt).toBeTruthy();

      const after = runCommand("share", dir, { objective: "status" }) as {
        items: Array<{ share: { status: string } }>;
        unsharedCompleted: number;
      };
      expect(after.items[0]?.share.status).toBe("POSTED");
      expect(after.unsharedCompleted).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lists completed cycles without draft as NOT_SHARED", () => {
    const dir = project();
    try {
      runCommand("init", dir, {});
      runCommand("plan", dir, { objective: "no share yet", approve: true });
      runCommand("dev", dir, { approve: true });
      runCommand("test", dir, { approve: true });
      runCommand("close", dir, { approve: true });
      const status = runCommand("share", dir, { objective: "status" }) as {
        unsharedCompleted: number;
        items: Array<{ share: { status: string } }>;
      };
      expect(status.unsharedCompleted).toBe(1);
      expect(status.items[0]?.share.status).toBe("NOT_SHARED");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
