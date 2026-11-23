import type { Plan } from "../planning/index.js";

/**
 * Artifacts that close the development cycle: commit message and pull request description.
 * They are derived from the approved plan and the changed files, never invented, and they are
 * DRAFTS for a human to review: JARVIS has no way to commit, push or open a PR from here.
 */

export type Lang = "pt" | "en";

export type CycleInput = {
  plan: Plan;
  workItemTitle: string;
  acceptanceCriteria: readonly string[];
  changedPaths: readonly string[];
};

const TYPE_OF_KIND = { FEATURE: "feat", BUGFIX: "fix", REFACTOR: "refactor" } as const;
const MAX_FIRST_LINE = 72;

const norm = (p: string): string => p.split("\\").join("/");

/** The folder shared by every changed file, or the most common top-level folder. */
export function scopeOf(paths: readonly string[]): string {
  const tops = paths.map((p) => norm(p).split("/")).filter((parts) => parts.length > 1);
  if (tops.length === 0) return "";
  const count = new Map<string, number>();
  for (const parts of tops) {
    // Skip generic roots to reach the meaningful folder.
    const meaningful = parts.find(
      (x) => !["src", "app", "lib", "packages", "tests", "test"].includes(x),
    );
    const key = meaningful && meaningful !== parts[parts.length - 1] ? meaningful : parts[0]!;
    count.set(key, (count.get(key) ?? 0) + 1);
  }
  return [...count].sort((a, b) => b[1] - a[1])[0]![0].replace(/[^A-Za-z0-9._-]/g, "");
}

const lowerFirst = (s: string): string => (s ? s[0]!.toLowerCase() + s.slice(1) : s);

/** `type(scope): description`, at most three short lines, no filler words. */
export function commitMessage(input: CycleInput): string {
  const type = TYPE_OF_KIND[input.plan.kind];
  const scope = scopeOf(input.changedPaths);
  const head = `${type}${scope ? `(${scope})` : ""}: `;
  const summary = input.plan.summary.replace(/\s+/g, " ").trim().replace(/[.]+$/, "");
  let first = head + lowerFirst(summary);
  if (first.length > MAX_FIRST_LINE) first = `${first.slice(0, MAX_FIRST_LINE - 1).trimEnd()}…`;
  const lines = [first];
  if (input.plan.kind === "BUGFIX" && input.plan.diagnosis)
    lines.push(`Cause: ${input.plan.diagnosis.cause.replace(/\s+/g, " ").slice(0, 120)}`);
  return lines.slice(0, 3).join("\n");
}

const TEXT = {
  pt: {
    what: "O que muda / Por quê?",
    how: "Como testar",
    kind: "Tipo de mudança",
    checklist: "Checklist",
    acceptance: "Critérios de aceite",
    files: "Arquivos alterados",
    rollback: "Como desfazer",
    cause: "Causa",
    notTested: "Defina como testar antes de abrir o PR.",
    types: { FEATURE: "feat", BUGFIX: "fix", REFACTOR: "refactor" },
  },
  en: {
    what: "What changes / Why?",
    how: "How to test",
    kind: "Type of change",
    checklist: "Checklist",
    acceptance: "Acceptance criteria",
    files: "Files changed",
    rollback: "Rollback",
    cause: "Cause",
    notTested: "Say how to test before opening the PR.",
    types: { FEATURE: "feat", BUGFIX: "fix", REFACTOR: "refactor" },
  },
} as const;

export function prDescription(input: CycleInput, lang: Lang = "pt"): string {
  const t = TEXT[lang];
  const out: string[] = [];
  out.push(`## ${t.what}`, input.plan.summary.trim());
  if (input.plan.kind === "BUGFIX" && input.plan.diagnosis) {
    out.push(
      "",
      `**${t.cause}:** ${input.plan.diagnosis.cause} (${input.plan.diagnosis.location})`,
    );
  }
  out.push("", `## ${t.how}`, input.plan.testStrategy.trim() || t.notTested);
  out.push("", `## ${t.kind}`);
  for (const k of ["FEATURE", "BUGFIX", "REFACTOR"] as const)
    out.push(`- [${input.plan.kind === k ? "x" : " "}] ${t.types[k]}`);
  if (input.acceptanceCriteria.length) {
    out.push("", `## ${t.acceptance}`);
    for (const c of input.acceptanceCriteria) out.push(`- [ ] ${c}`);
  }
  if (input.changedPaths.length) {
    out.push("", `## ${t.files}`);
    for (const p of input.changedPaths.slice(0, 40)) out.push(`- \`${norm(p)}\``);
    if (input.changedPaths.length > 40) out.push(`- … +${input.changedPaths.length - 40}`);
  }
  if (input.plan.rollback.trim()) out.push("", `## ${t.rollback}`, input.plan.rollback.trim());
  out.push(
    "",
    `## ${t.checklist}`,
    "- [ ] tests passing",
    "- [ ] no secrets in the diff",
    "- [ ] reviewed by a human",
  );
  return out.join("\n");
}
