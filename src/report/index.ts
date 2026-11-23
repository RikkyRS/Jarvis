import type { DatabaseSync } from "node:sqlite";
import type { WorkItem, WorkflowRun } from "../domain/contracts.js";
import type { ProcessRunner } from "../gateway/runner.js";

/**
 * Evidence-backed change report. Everything factual comes from the Git diff and the execution
 * ledger; an agent's narrative can only fill `summary`. A test counts as passed only when a
 * recorded execution shows exit code 0.
 */

export type SymbolChange = { name: string; kind: string };
export type FileChange = {
  path: string;
  added: number;
  removed: number;
  /** Approximate ranges in the final file: navigation aids, not stable identifiers. */
  ranges: { start: number; end: number }[];
  symbols: SymbolChange[];
};
export type TestExecution = {
  operationId: string;
  command: string;
  exitCode: number | null;
  passed: boolean;
};

export type ChangeReport = {
  workItemId: string;
  workflowRunId: string;
  summary: string;
  baseSha: string;
  headSha: string;
  commits: { sha: string; subject: string }[];
  files: FileChange[];
  acceptance: { criterion: string; status: "MET" | "UNVERIFIED"; evidence: string[] }[];
  tests: TestExecution[];
  limitations: string[];
  evidenceRefs: string[];
};

const SYMBOL =
  /^\+\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(function|class|interface|type|enum|const|def)\s+([A-Za-z_$][\w$]*)/;

type Row = Record<string, unknown>;

export type ReportInput = {
  runner: ProcessRunner;
  repoRoot: string;
  db: DatabaseSync;
  workItem: WorkItem;
  run: WorkflowRun;
  base: string;
  head: string;
  summary: string;
  /** Acceptance criteria an agent or reviewer claims are met, with the operation ids that prove it. */
  claims?: Record<string, string[]>;
  limitations?: string[];
};

export async function buildChangeReport(input: ReportInput): Promise<ChangeReport> {
  const git = async (args: string[]) => {
    const r = await input.runner.run({
      command: "git",
      args: ["-c", "core.pager=cat", ...args],
      cwd: input.repoRoot,
      timeoutMs: 120_000,
      maxOutputBytes: 32 * 1024 * 1024,
      env: { GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
    });
    if (r.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.slice(0, 200)}`);
    return r.stdout;
  };

  const baseSha = (await git(["rev-parse", "--verify", `${input.base}^{commit}`])).trim();
  const headSha = (await git(["rev-parse", "--verify", `${input.head}^{commit}`])).trim();
  const range = `${baseSha}..${headSha}`;

  const commits = (await git(["log", "--reverse", "--format=%H%x1f%s", range]))
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [sha, subject] = l.split("\x1f");
      return { sha: sha!, subject: subject ?? "" };
    });

  const files = new Map<string, FileChange>();
  for (const line of (await git(["diff", "--numstat", range])).split("\n").filter(Boolean)) {
    const [a, r, ...p] = line.split("\t");
    const path = p.join("\t");
    files.set(path, {
      path,
      added: a === "-" ? 0 : Number(a),
      removed: r === "-" ? 0 : Number(r),
      ranges: [],
      symbols: [],
    });
  }

  let current: FileChange | undefined;
  for (const line of (await git(["diff", "-U0", "--no-color", range])).split("\n")) {
    if (line.startsWith("+++ b/")) {
      current = files.get(line.slice(6));
    } else if (line.startsWith("@@") && current) {
      const m = /\+(\d+)(?:,(\d+))?/.exec(line);
      if (m) {
        const start = Number(m[1]);
        const count = m[2] === undefined ? 1 : Number(m[2]);
        if (count > 0) current.ranges.push({ start, end: start + count - 1 });
      }
    } else if (current && line.startsWith("+") && !line.startsWith("+++")) {
      const s = SYMBOL.exec(line);
      if (s && !current.symbols.some((x) => x.name === s[2]))
        current.symbols.push({ name: s[2]!, kind: s[1]! });
    }
  }

  const rows = input.db
    .prepare(
      "SELECT operation_id, outcome, evidence FROM executions WHERE workflow_run_id = ? AND type = 'TEST_RUN' ORDER BY finished_at",
    )
    .all(input.run.id) as Row[];
  const tests: TestExecution[] = rows.map((r) => {
    const ev = JSON.parse(String(r.evidence)) as {
      command?: string;
      args?: string[];
      exitCode?: number | null;
    };
    return {
      operationId: String(r.operation_id),
      command: [ev.command ?? "?", ...(ev.args ?? [])].join(" "),
      exitCode: ev.exitCode ?? null,
      passed: r.outcome === "SUCCEEDED" && ev.exitCode === 0,
    };
  });

  const known = new Set(
    (
      input.db
        .prepare(
          "SELECT operation_id FROM executions WHERE workflow_run_id = ? AND outcome = 'SUCCEEDED'",
        )
        .all(input.run.id) as Row[]
    ).map((r) => String(r.operation_id)),
  );
  const acceptance = input.workItem.acceptanceCriteria.map((criterion) => {
    const proof = (input.claims?.[criterion] ?? []).filter((id) => known.has(id));
    return {
      criterion,
      status: proof.length > 0 ? ("MET" as const) : ("UNVERIFIED" as const),
      evidence: proof,
    };
  });

  const limitations = [...(input.limitations ?? [])];
  if (tests.length === 0)
    limitations.push("No tests were executed through the gateway for this run.");
  if (acceptance.some((a) => a.status === "UNVERIFIED"))
    limitations.push("Some acceptance criteria have no recorded evidence.");

  return {
    workItemId: input.workItem.id,
    workflowRunId: input.run.id,
    summary: input.summary,
    baseSha,
    headSha,
    commits,
    files: [...files.values()],
    acceptance,
    tests,
    limitations,
    evidenceRefs: [...known],
  };
}

export function renderChangeReport(r: ChangeReport): string {
  const lines: string[] = [
    `# Change report — ${r.workItemId} / ${r.workflowRunId}`,
    "",
    r.summary,
    "",
    `Base \`${r.baseSha.slice(0, 12)}\` → head \`${r.headSha.slice(0, 12)}\``,
    "",
    "## Commits",
    ...r.commits.map((c) => `- \`${c.sha.slice(0, 12)}\` ${c.subject}`),
    "",
    "## Files and symbols",
    ...r.files.flatMap((f) => [
      `- \`${f.path}\` (+${f.added} −${f.removed})${f.ranges.length ? ` ~lines ${f.ranges.map((x) => `${x.start}-${x.end}`).join(", ")}` : ""}`,
      ...f.symbols.map((s) => `  - ${s.kind} \`${s.name}\``),
    ]),
    "",
    "## Acceptance criteria",
    ...r.acceptance.map(
      (a) =>
        `- [${a.status === "MET" ? "x" : " "}] ${a.criterion}${a.evidence.length ? ` (evidence: ${a.evidence.join(", ")})` : " — UNVERIFIED"}`,
    ),
    "",
    "## Tests executed",
    ...(r.tests.length
      ? r.tests.map(
          (t) =>
            `- ${t.passed ? "PASS" : "FAIL"} \`${t.command}\` (exit ${t.exitCode}) [${t.operationId}]`,
        )
      : ["- none recorded"]),
    "",
    "## Known limitations",
    ...(r.limitations.length ? r.limitations.map((l) => `- ${l}`) : ["- none recorded"]),
  ];
  return lines.join("\n");
}
