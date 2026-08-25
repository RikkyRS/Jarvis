import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { harnessRoot } from "../../infrastructure/harness.js";
import type { GitEngine } from "../git/index.js";
import type { Cycle } from "../../core/cycle/index.js";
import { nowIso, shortId } from "../../shared/util.js";

export const SHARE_CHANNEL_LINKEDIN = "linkedin" as const;

export type ShareChannel = typeof SHARE_CHANNEL_LINKEDIN;

export type LinkedInDraft = {
  channel: ShareChannel;
  text: string;
  path: string;
  projectName: string;
  repoUrl: string | null;
  cycleId: string;
  generatedAt: string;
};

function readPackageName(projectRoot: string): string | null {
  const pkgPath = join(projectRoot, "package.json");
  if (!existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string };
    return pkg.name?.trim() || null;
  } catch {
    return null;
  }
}

function normalizeRepoUrl(raw: string | null): string | null {
  if (!raw) return null;
  let url = raw.trim();
  if (url.startsWith("git@")) {
    const match = url.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
    if (match) url = `https://${match[1]}/${match[2]}`;
  }
  url = url.replace(/\.git$/, "");
  if (url.startsWith("https://") || url.startsWith("http://")) return url;
  return raw;
}

function bulletFromEvidence(cycle: Cycle): string[] {
  const bullets: string[] = [];
  const risk = cycle.payload.risk?.level;
  if (risk) bullets.push(`Risco do ciclo: ${risk}`);
  const test = cycle.payload.test as { status?: string; ran?: boolean } | undefined;
  if (test?.ran && test.status) bullets.push(`Testes: ${test.status}`);
  const security = cycle.payload.security as { highest?: string } | undefined;
  if (security?.highest) bullets.push(`Security scan: ${security.highest}`);
  const branch = (cycle.payload.branch as { branch?: string } | undefined)?.branch;
  if (branch) bullets.push(`Branch: ${branch}`);
  return bullets.slice(0, 5);
}

export function buildLinkedInDraftText(input: {
  projectName: string;
  objective: string;
  cycleNumber: number;
  cycleId: string;
  status: string;
  repoUrl: string | null;
  bullets: string[];
}): string {
  const lines = [
    `Acabei de fechar um ciclo de trabalho no projeto ${input.projectName}.`,
    "",
    `Objetivo: ${input.objective}`,
    "",
  ];
  if (input.bullets.length) {
    lines.push("O que saiu deste ciclo:");
    for (const bullet of input.bullets) lines.push(`• ${bullet}`);
    lines.push("");
  }
  lines.push(`Cycle #${input.cycleNumber} → ${input.status}`);
  if (input.repoUrl) {
    lines.push("");
    lines.push(`Repo: ${input.repoUrl}`);
  }
  lines.push("");
  lines.push("(Rascunho gerado pelo JARVIS — revise antes de publicar no LinkedIn.)");
  return lines.join("\n");
}

export function createLinkedInDraft(
  projectRoot: string,
  cycle: Cycle,
  git: GitEngine,
  options?: { path?: string },
): LinkedInDraft {
  const projectName = readPackageName(projectRoot) ?? projectRoot.split(/[/\\]/).filter(Boolean).at(-1) ?? "projeto";
  const repoUrl = normalizeRepoUrl(git.value(["remote", "get-url", "origin"]));
  const bullets = bulletFromEvidence(cycle);
  const text = buildLinkedInDraftText({
    projectName,
    objective: cycle.objective,
    cycleNumber: cycle.number,
    cycleId: cycle.id,
    status: cycle.status,
    repoUrl,
    bullets,
  });
  const sharesDir = join(harnessRoot(projectRoot), "shares");
  mkdirSync(sharesDir, { recursive: true });
  const path = options?.path ?? join(sharesDir, `${cycle.id}-linkedin.md`);
  const body = [
    "---",
    `channel: linkedin`,
    `cycleId: ${cycle.id}`,
    `generatedAt: ${nowIso()}`,
    "---",
    "",
    text,
    "",
  ].join("\n");
  writeFileSync(path, body, "utf8");
  return {
    channel: SHARE_CHANNEL_LINKEDIN,
    text,
    path,
    projectName,
    repoUrl,
    cycleId: cycle.id,
    generatedAt: nowIso(),
  };
}

export function tryCopyToClipboard(text: string): { ok: boolean; detail?: string } {
  try {
    if (process.platform === "win32") {
      const encoded = Buffer.from(text, "utf16le").toString("base64");
      const script = `$t = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encoded}')); Set-Clipboard -Value $t`;
      const result = spawnSync("powershell", ["-NoProfile", "-Command", script], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 10_000,
      });
      if ((result.status ?? 1) === 0) return { ok: true };
      return { ok: false, detail: result.stderr || result.stdout || "clipboard failed" };
    }
    if (process.platform === "darwin") {
      const result = spawnSync("pbcopy", [], { input: text, encoding: "utf8", timeout: 5_000 });
      if ((result.status ?? 1) === 0) return { ok: true };
      return { ok: false, detail: result.stderr || "pbcopy failed" };
    }
    const xclip = spawnSync("xclip", ["-selection", "clipboard"], {
      input: text,
      encoding: "utf8",
      timeout: 5_000,
    });
    if ((xclip.status ?? 1) === 0) return { ok: true };
    const xsel = spawnSync("xsel", ["--clipboard", "--input"], {
      input: text,
      encoding: "utf8",
      timeout: 5_000,
    });
    if ((xsel.status ?? 1) === 0) return { ok: true };
    return { ok: false, detail: "no clipboard tool (xclip/xsel)" };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

export function newShareId(): string {
  return shortId("share");
}

export function parseShareAction(raw?: string): {
  action: "draft" | "status" | "done" | "github";
  cycleId?: string;
  repoKey?: string;
} {
  const tokens = (raw ?? "").trim().split(/\s+/).filter(Boolean);
  const firstRaw = tokens[0] ?? "draft";
  const first = firstRaw.toLowerCase();
  const second = tokens[1];
  const third = tokens[2];

  const asRepo = (value?: string) => {
    if (!value) return undefined;
    if (value.toLowerCase().startsWith("cycle-")) return undefined;
    if (/^[^/\s]+\/[^/\s]+$/.test(value) || /github\.com/i.test(value)) return value;
    return undefined;
  };

  if (["github", "repos", "repositorios", "repositórios", "gh"].includes(first)) {
    const repo = asRepo(second);
    return repo ? { action: "github", repoKey: repo } : { action: "github" };
  }
  if (["status", "estado", "list", "lista"].includes(first)) {
    if (second && ["github", "repos", "gh"].includes(second.toLowerCase())) {
      return { action: "github" };
    }
    return { action: "status" };
  }
  if (["done", "mark", "marquei", "posted", "poste", "postei"].includes(first)) {
    const target = second;
    if (!target) return { action: "done" };
    if (target.toLowerCase().startsWith("cycle-")) return { action: "done", cycleId: target };
    const repo =
      asRepo(target) ?? (["github", "repo"].includes(target.toLowerCase()) ? asRepo(third) : undefined);
    if (repo) return { action: "done", repoKey: repo };
    return { action: "done", cycleId: target };
  }
  if (["draft", "rascunho", "linkedin"].includes(first)) {
    const target = second;
    if (!target) return { action: "draft" };
    if (target.toLowerCase().startsWith("cycle-")) return { action: "draft", cycleId: target };
    if (["github", "repo", "gh"].includes(target.toLowerCase())) {
      const repo = asRepo(third);
      return repo ? { action: "draft", repoKey: repo } : { action: "github" };
    }
    const repo = asRepo(target);
    if (repo) return { action: "draft", repoKey: repo };
    return { action: "draft" };
  }
  if (first.startsWith("cycle-")) {
    return { action: "draft", cycleId: firstRaw };
  }
  const repo = asRepo(firstRaw);
  if (repo) return { action: "draft", repoKey: repo };
  return { action: "draft" };
}
