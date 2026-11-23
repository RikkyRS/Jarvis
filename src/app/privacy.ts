import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Jarvis } from "./jarvis.js";

/**
 * Protects the local state directory: it can hold client messages and contract text, so it must
 * never end up in a Git commit and, on POSIX systems, only its owner may enter it.
 * The directory carries its own `.gitignore` ("*"), so it stays ignored even if the project's
 * own .gitignore forgets it.
 */
export function hardenDataDir(dir: string): void {
  const ignore = join(dir, ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
  if (process.platform !== "win32") {
    try {
      chmodSync(dir, 0o700);
    } catch {
      // Best effort: a read-only or foreign filesystem is reported by `jarvis privacy`.
    }
  }
}

export type PrivacyFinding = { level: "OK" | "WARN" | "INFO"; message: string };

function git(root: string, args: string[]): { ok: boolean; out: string } {
  try {
    const out = execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    return { ok: true, out };
  } catch {
    return { ok: false, out: "" };
  }
}

/** A read-only self-check of where client data can go. It changes nothing. */
export function privacyReport(
  jarvis: Jarvis,
  env: NodeJS.ProcessEnv,
  opts: { retentionDays?: number } = {},
): PrivacyFinding[] {
  const out: PrivacyFinding[] = [];
  const root = jarvis.root;
  const dataDir = join(root, ".jarvis");

  const inRepo = git(root, ["rev-parse", "--is-inside-work-tree"]).ok;
  if (inRepo) {
    const ignored = git(root, ["check-ignore", "-q", join(".jarvis", "state.sqlite")]).ok;
    out.push(
      ignored
        ? {
            level: "OK",
            message:
              "The state directory (.jarvis/) is ignored by Git: messages and contract text cannot be committed by accident.",
          }
        : {
            level: "WARN",
            message:
              "The state directory (.jarvis/) is NOT ignored by Git. Add '.jarvis/' to .gitignore before committing.",
          },
    );
  } else {
    out.push({
      level: "OK",
      message: "The project is not a Git repository, so nothing here can be pushed by accident.",
    });
  }

  if (process.platform === "win32") {
    out.push({
      level: "INFO",
      message:
        "Windows: access is limited by your account's folder permissions. Turn on BitLocker (or another disk encryption) to protect the data if the computer is lost.",
    });
  } else {
    const mode = statSync(dataDir).mode & 0o077;
    out.push(
      mode === 0
        ? { level: "OK", message: "Only your user can open the state directory." }
        : {
            level: "WARN",
            message:
              "Other users on this machine can open the state directory. Run: chmod 700 .jarvis",
          },
    );
  }

  if (env["JARVIS_ALLOW_CLAUDE"] === "1") {
    out.push({
      level: "WARN",
      message:
        "Claude Code is enabled: the text of the messages and contract clauses it is given is sent to Anthropic. Remove JARVIS_ALLOW_CLAUDE for local-only processing.",
    });
  } else if (env["JARVIS_OLLAMA_MODEL"]) {
    out.push({
      level: "OK",
      message:
        "Messages are processed by a local model (Ollama, loopback only). They do not leave this machine.",
    });
  } else {
    out.push({ level: "INFO", message: "No model configured." });
  }

  const notes = jarvis.notesDir;
  const rel = relative(resolve(root), resolve(notes));
  const insideProject = !rel.startsWith("..") && !isAbsolute(rel) && rel !== "";
  if (!insideProject) {
    out.push({ level: "OK", message: `The learning journal is outside the project: ${notes}` });
  } else if (!inRepo || git(root, ["check-ignore", "-q", rel]).ok) {
    out.push({
      level: "OK",
      message: `The learning journal is inside the project but ignored by Git: ${notes}`,
    });
  } else {
    out.push({
      level: "WARN",
      message: `The learning journal is inside the project (${notes}) and not ignored by Git; it may be committed. Move it with JARVIS_NOTES_DIR.`,
    });
  }

  const days = opts.retentionDays ?? 30;
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const old = jarvis.db
    .prepare(
      "SELECT COUNT(*) AS n FROM inbox_messages WHERE project_id = ? AND status != 'NEW' AND received_at < ? AND text NOT LIKE '[arquivado sha256:%'",
    )
    .get(jarvis.project.id, cutoff) as { n: number };
  out.push(
    old.n > 0
      ? {
          level: "WARN",
          message: `${old.n} processed message(s) older than ${days} days are still stored as text. Run: jarvis retention apply --days ${days}`,
        }
      : { level: "OK", message: `No processed message older than ${days} days is kept as text.` },
  );

  if (jarvis.contract.list().length > 0) {
    out.push({
      level: "INFO",
      message:
        "An AI client connected over MCP can read contract clauses through jarvis_project_contract. If the contract is confidential, connect only a local client.",
    });
  }
  out.push({
    level: "INFO",
    message:
      "WhatsApp itself is not under JARVIS's control: with the official API the messages also pass through Meta's servers.",
  });
  return out;
}
