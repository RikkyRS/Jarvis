import { existsSync, readFileSync } from "node:fs";
import { join, isAbsolute } from "node:path";

/**
 * Documentation drift: compares what a project document claims with what the repository has.
 * Deterministic and read-only. It checks only what can be proven (a path mentioned in backticks
 * exists, an `npm run X` script is defined) and says how much it could NOT check, so silence is
 * never mistaken for "up to date". It proposes; it never edits the document.
 */

export type DriftClaim = { line: number; claim: string; reason?: string };
export type DriftReport = {
  file: string;
  holds: DriftClaim[];
  aged: DriftClaim[];
  unchecked: number;
};

const BACKTICK = /`([^`\n]+)`/g;
const NPM_RUN = /^(?:npm|pnpm|yarn)\s+(?:run\s+)?([A-Za-z0-9:_-]+)/;
const PATHLIKE =
  /^(?:\.{0,2}\/)?[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@*-]+)+\/?$|^[A-Za-z0-9_-]+\.(?:ts|tsx|js|mjs|cjs|json|md|py|sh|yml|yaml|toml|sql)$/;
const BUILTIN_SCRIPTS = new Set([
  "install",
  "i",
  "ci",
  "test",
  "start",
  "init",
  "publish",
  "pack",
  "audit",
]);

/** Only relative paths that should live in this repository: not examples, globs, URLs or runtime state. */
function isCheckablePath(token: string): boolean {
  if (!PATHLIKE.test(token)) return false;
  if (token.includes("*") || token.includes("://") || token.includes("...")) return false;
  if (token.startsWith("/") || token.startsWith("~") || /^[A-Za-z]:/.test(token)) return false;
  if (token.startsWith(".jarvis/")) return false;
  return true;
}

export function checkDocumentDrift(root: string, file: string): DriftReport {
  const full = isAbsolute(file) ? file : join(root, file);
  const report: DriftReport = { file, holds: [], aged: [], unchecked: 0 };
  if (!existsSync(full)) {
    report.aged.push({ line: 0, claim: file, reason: "The document does not exist." });
    return report;
  }
  let scripts: Record<string, unknown> = {};
  const pkg = join(root, "package.json");
  if (existsSync(pkg)) {
    try {
      scripts =
        (JSON.parse(readFileSync(pkg, "utf8")) as { scripts?: Record<string, unknown> }).scripts ??
        {};
    } catch {
      // An unreadable package.json simply leaves script claims unchecked.
    }
  }
  const hasPkg = existsSync(pkg);
  const lines = readFileSync(full, "utf8").split(/\r?\n/);
  const seen = new Set<string>();
  const checkedLines = new Set<number>();
  lines.forEach((text, i) => {
    for (const m of text.matchAll(BACKTICK)) {
      const token = m[1]!.trim();
      const key = `${i}:${token}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const npm = NPM_RUN.exec(token);
      if (npm) {
        checkedLines.add(i);
        const name = npm[1]!;
        if (!hasPkg || (BUILTIN_SCRIPTS.has(name) && !/\brun\b/.test(token))) {
          report.unchecked += 1;
        } else if (name in scripts) {
          report.holds.push({ line: i + 1, claim: token });
        } else {
          report.aged.push({
            line: i + 1,
            claim: token,
            reason: `package.json has no script "${name}".`,
          });
        }
        continue;
      }
      if (isCheckablePath(token)) {
        checkedLines.add(i);
        const target = join(root, token.replace(/^\.\//, ""));
        if (existsSync(target)) report.holds.push({ line: i + 1, claim: token });
        else
          report.aged.push({
            line: i + 1,
            claim: token,
            reason:
              "Not found in the repository (it may be an example or a file created at run time).",
          });
      }
    }
  });
  // Prose, versions and architecture are not provable here: count the lines nothing was checked on.
  let fenced = false;
  lines.forEach((text, i) => {
    if (text.startsWith("```")) {
      fenced = !fenced;
      return;
    }
    if (fenced || !text.trim() || text.startsWith("#") || checkedLines.has(i)) return;
    report.unchecked += 1;
  });
  return report;
}

export function renderDrift(r: DriftReport): string {
  const out = [`${r.file}`];
  out.push(`  still true: ${r.holds.length}`);
  out.push(`  aged: ${r.aged.length}`);
  for (const a of r.aged) out.push(`    line ${a.line}: \`${a.claim}\` — ${a.reason}`);
  out.push(`  not checkable here (prose, architecture, versions): ${r.unchecked} line(s)`);
  return out.join("\n");
}
