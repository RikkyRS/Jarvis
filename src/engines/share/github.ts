import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { executeProcess } from "../execution/index.js";
import { probeGh } from "../git/gh.js";
import { nowIso } from "../../shared/util.js";
import { globalSharesDir } from "../../infrastructure/global-shares.js";
import { SHARE_CHANNEL_LINKEDIN, tryCopyToClipboard, type ShareChannel } from "./index.js";

function ghBin(): string {
  return process.platform === "win32" ? "gh.cmd" : "gh";
}

export type GhRepoSummary = {
  nameWithOwner: string;
  description: string | null;
  url: string;
  updatedAt: string | null;
  isPrivate: boolean;
};

export type GhRepoDetail = GhRepoSummary & {
  name: string;
  primaryLanguage: string | null;
  recentCommits: string[];
};

export function normalizeRepoKey(raw: string): string | null {
  const trimmed = raw.trim().replace(/\.git$/i, "");
  const https = trimmed.match(/github\.com[/:]([^/\s]+)\/([^/\s#?]+)/i);
  if (https) return `${https[1]}/${https[2]}`.replace(/\.git$/i, "");
  if (/^[^/\s]+\/[^/\s]+$/.test(trimmed)) return trimmed;
  return null;
}

export function listGithubRepos(limit = 30): {
  status: "AVAILABLE" | "UNAVAILABLE";
  repos: GhRepoSummary[];
  detail?: string;
} {
  const probe = probeGh();
  if (!probe.available) {
    return { status: "UNAVAILABLE", repos: [], detail: probe.detail ?? "gh CLI not found — run: gh auth login" };
  }
  const result = executeProcess(
    [
      ghBin(),
      "repo",
      "list",
      "--limit",
      String(limit),
      "--json",
      "nameWithOwner,description,url,updatedAt,isPrivate",
    ],
    process.cwd(),
    45_000,
  );
  if (result.notFound || result.returncode !== 0) {
    return {
      status: "UNAVAILABLE",
      repos: [],
      detail: result.stderr || result.stdout || "gh repo list failed (auth?)",
    };
  }
  try {
    const rows = JSON.parse(result.stdout || "[]") as Array<{
      nameWithOwner: string;
      description?: string | null;
      url: string;
      updatedAt?: string | null;
      isPrivate?: boolean;
    }>;
    return {
      status: "AVAILABLE",
      repos: rows.map((row) => ({
        nameWithOwner: row.nameWithOwner,
        description: row.description ?? null,
        url: row.url,
        updatedAt: row.updatedAt ?? null,
        isPrivate: Boolean(row.isPrivate),
      })),
    };
  } catch {
    return { status: "UNAVAILABLE", repos: [], detail: "could not parse gh repo list" };
  }
}

function fetchRecentCommits(repoKey: string): string[] {
  const result = executeProcess(
    [ghBin(), "api", `repos/${repoKey}/commits?per_page=5`],
    process.cwd(),
    30_000,
  );
  if (result.returncode !== 0) return [];
  try {
    const rows = JSON.parse(result.stdout || "[]") as Array<{ commit?: { message?: string } }>;
    return rows
      .map((row) => (row.commit?.message ?? "").split("\n")[0]?.trim() ?? "")
      .filter(Boolean)
      .slice(0, 5);
  } catch {
    return [];
  }
}

export function fetchGithubRepo(repoKey: string): {
  status: "AVAILABLE" | "UNAVAILABLE";
  repo?: GhRepoDetail;
  detail?: string;
} {
  const probe = probeGh();
  if (!probe.available) {
    return { status: "UNAVAILABLE", detail: probe.detail ?? "gh CLI not found" };
  }
  const result = executeProcess(
    [
      ghBin(),
      "repo",
      "view",
      repoKey,
      "--json",
      "name,nameWithOwner,description,url,updatedAt,isPrivate,primaryLanguage",
    ],
    process.cwd(),
    30_000,
  );
  if (result.notFound || result.returncode !== 0) {
    return {
      status: "UNAVAILABLE",
      detail: result.stderr || result.stdout || `repo not found: ${repoKey}`,
    };
  }
  try {
    const row = JSON.parse(result.stdout) as {
      name: string;
      nameWithOwner: string;
      description?: string | null;
      url: string;
      updatedAt?: string | null;
      isPrivate?: boolean;
      primaryLanguage?: { name?: string } | null;
    };
    return {
      status: "AVAILABLE",
      repo: {
        name: row.name,
        nameWithOwner: row.nameWithOwner,
        description: row.description ?? null,
        url: row.url,
        updatedAt: row.updatedAt ?? null,
        isPrivate: Boolean(row.isPrivate),
        primaryLanguage: row.primaryLanguage?.name ?? null,
        recentCommits: fetchRecentCommits(row.nameWithOwner),
      },
    };
  } catch {
    return { status: "UNAVAILABLE", detail: "could not parse gh repo view" };
  }
}

export function buildGithubLinkedInDraftText(repo: GhRepoDetail): string {
  const lines = [
    `Compartilhando um projeto que publiquei no GitHub: ${repo.name}.`,
    "",
  ];
  if (repo.description) {
    lines.push(repo.description);
    lines.push("");
  }
  const bullets: string[] = [];
  if (repo.primaryLanguage) bullets.push(`Stack principal: ${repo.primaryLanguage}`);
  if (repo.isPrivate) bullets.push("Repositório privado");
  else bullets.push("Repositório público");
  for (const commit of repo.recentCommits.slice(0, 3)) {
    bullets.push(`Commit recente: ${commit.slice(0, 80)}`);
  }
  if (bullets.length) {
    lines.push("Destaques:");
    for (const bullet of bullets) lines.push(`• ${bullet}`);
    lines.push("");
  }
  lines.push(`Repo: ${repo.url}`);
  lines.push("");
  lines.push("(Rascunho gerado pelo JARVIS a partir do GitHub — revise antes de publicar no LinkedIn.)");
  return lines.join("\n");
}

export type GithubLinkedInDraft = {
  channel: ShareChannel;
  text: string;
  path: string;
  repoKey: string;
  repoUrl: string;
  projectName: string;
  generatedAt: string;
};

export function createGithubLinkedInDraft(
  repo: GhRepoDetail,
  options?: { path?: string },
): GithubLinkedInDraft {
  const text = buildGithubLinkedInDraftText(repo);
  const dir = globalSharesDir();
  mkdirSync(dir, { recursive: true });
  const safe = repo.nameWithOwner.replaceAll("/", "-");
  const path = options?.path ?? join(dir, `${safe}-linkedin.md`);
  const body = [
    "---",
    `channel: linkedin`,
    `source: github`,
    `repo: ${repo.nameWithOwner}`,
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
    repoKey: repo.nameWithOwner,
    repoUrl: repo.url,
    projectName: repo.name,
    generatedAt: nowIso(),
  };
}

export function draftGithubWithClipboard(
  repo: GhRepoDetail,
  options?: { path?: string },
): GithubLinkedInDraft & { clipboard: { copied: boolean; detail?: string } } {
  const draft = createGithubLinkedInDraft(repo, options);
  const clipboard = tryCopyToClipboard(draft.text);
  return {
    ...draft,
    clipboard: clipboard.ok
      ? { copied: true }
      : clipboard.detail
        ? { copied: false, detail: clipboard.detail }
        : { copied: false },
  };
}
