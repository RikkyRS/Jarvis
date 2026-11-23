import { z } from "zod";
import type { ProcessRunner } from "../gateway/runner.js";
import { fingerprint } from "../shared/canonical.js";

/**
 * Integration Resolver: an independent, deterministic-first assessment of a whole candidate
 * branch. It reads Git state itself, runs configured checks at the exact candidate SHA and
 * produces evidence-backed findings. It recommends; it cannot approve, promote or rewrite.
 */

export const SeveritySchema = z.enum(["INFO", "MEDIUM", "HIGH"]);
export type Severity = z.infer<typeof SeveritySchema>;

export const FindingSchema = z
  .object({
    id: z.string(),
    severity: SeveritySchema,
    kind: z.enum([
      "BASE_MISMATCH",
      "FILE_OVERLAP",
      "DEPENDENCY_CHANGE",
      "CONTRACT_CHANGE",
      "CHECK_FAILED",
      "CHECKOUT_MISMATCH",
      "UNASSOCIATED",
    ]),
    message: z.string(),
    commits: z.array(z.string()),
    workItemIds: z.array(z.string()),
    paths: z.array(z.string()),
    recommendation: z.string(),
  })
  .strict();
export type Finding = z.infer<typeof FindingSchema>;

export const AssociationSchema = z
  .object({
    commit: z.string(),
    workItemId: z.string().nullable(),
    state: z.enum(["DISCOVERED", "CONFIRMED", "AMBIGUOUS", "UNASSOCIATED"]),
    signals: z.array(z.string()),
  })
  .strict();
export type Association = z.infer<typeof AssociationSchema>;

export const CheckResultSchema = z
  .object({
    name: z.string(),
    command: z.string(),
    args: z.array(z.string()),
    exitCode: z.number().nullable(),
    passed: z.boolean(),
    outputTail: z.string(),
  })
  .strict();
export type CheckResult = z.infer<typeof CheckResultSchema>;

export const IntegrationReportSchema = z
  .object({
    baseSha: z.string(),
    candidateSha: z.string(),
    candidateRef: z.string(),
    commits: z.array(
      z.object({ sha: z.string(), subject: z.string(), paths: z.array(z.string()) }).strict(),
    ),
    associations: z.array(AssociationSchema),
    needsConfirmation: z.array(z.string()),
    checks: z.array(CheckResultSchema),
    findings: z.array(FindingSchema),
    recommendation: z.enum(["ACCEPT", "REQUEST_CHANGES", "BLOCK"]),
    reportHash: z.string(),
  })
  .strict();
export type IntegrationReport = z.infer<typeof IntegrationReportSchema>;

export type CheckSpec = { name: string; command: string; args: string[] };

export type AssessInput = {
  base: string;
  candidate: string;
  /** Worktree checked out at the candidate; checks run there and its HEAD must equal the candidate SHA. */
  checkoutPath: string;
  checks?: CheckSpec[];
  /** Associations a human already confirmed, keyed by commit SHA. They override discovery. */
  confirmed?: Record<string, string>;
};

const WI_ID = /\bwi_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g;
const DEPENDENCY_FILES =
  /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|requirements[^/]*\.txt|poetry\.lock|go\.(mod|sum)|Cargo\.(toml|lock))$/;
const CONTRACT_FILES =
  /(^|\/)(schemas?\/|openapi[^/]*\.(ya?ml|json)$|.*\.schema\.json$|.*\.proto$)/;

const SHA = /^[a-f0-9]{40,64}$/;

export class IntegrationResolver {
  constructor(
    private readonly runner: ProcessRunner,
    private readonly repoRoot: string,
  ) {}

  private async git(cwd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
    const r = await this.runner.run({
      command: "git",
      args: ["-c", "core.fsmonitor=false", "-c", "core.pager=cat", ...args],
      cwd,
      timeoutMs: 120_000,
      maxOutputBytes: 16 * 1024 * 1024,
      env: { GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
    });
    return { ok: r.exitCode === 0, out: r.stdout };
  }

  async assess(input: AssessInput): Promise<IntegrationReport> {
    const base = await this.git(this.repoRoot, ["rev-parse", "--verify", `${input.base}^{commit}`]);
    const cand = await this.git(this.repoRoot, [
      "rev-parse",
      "--verify",
      `${input.candidate}^{commit}`,
    ]);
    if (!base.ok || !cand.ok) throw new Error("Cannot resolve base or candidate to a commit.");
    const baseSha = base.out.trim();
    const candidateSha = cand.out.trim();

    const findings: Finding[] = [];
    const add = (f: Omit<Finding, "id">) => findings.push({ id: `F${findings.length + 1}`, ...f });

    const ancestor = await this.git(this.repoRoot, [
      "merge-base",
      "--is-ancestor",
      baseSha,
      candidateSha,
    ]);
    if (!ancestor.ok) {
      add({
        severity: "HIGH",
        kind: "BASE_MISMATCH",
        message: "The candidate branch does not contain the base commit; it was not built on it.",
        commits: [],
        workItemIds: [],
        paths: [],
        recommendation:
          "Rebase or merge the base into the candidate through an approved operation, then re-validate.",
      });
    }

    const log = await this.git(this.repoRoot, [
      "log",
      "--format=%H%x1f%s%x1f%B%x1e",
      `${baseSha}..${candidateSha}`,
    ]);
    const commits: IntegrationReport["commits"] = [];
    const bodies = new Map<string, string>();
    for (const record of log.out.split("\x1e")) {
      const [sha, subject, body] = record.trim().split("\x1f");
      if (!sha || !SHA.test(sha)) continue;
      const files = await this.git(this.repoRoot, [
        "diff-tree",
        "--no-commit-id",
        "--name-only",
        "-r",
        "-m",
        "--first-parent",
        sha,
      ]);
      commits.push({ sha, subject: subject ?? "", paths: files.out.split("\n").filter(Boolean) });
      bodies.set(sha, `${subject ?? ""}\n${body ?? ""}`);
    }
    commits.reverse();

    const associations = commits.map((c) =>
      this.associate(c.sha, bodies.get(c.sha) ?? "", input.confirmed),
    );
    const itemOf = new Map(associations.map((a) => [a.commit, a.workItemId]));
    const needsConfirmation = associations
      .filter((a) => a.state === "AMBIGUOUS" || a.state === "UNASSOCIATED")
      .map((a) => a.commit);
    if (needsConfirmation.length > 0) {
      add({
        severity: "MEDIUM",
        kind: "UNASSOCIATED",
        message: `${needsConfirmation.length} commit(s) cannot be linked to a Work Item with confidence.`,
        commits: needsConfirmation,
        workItemIds: [],
        paths: [],
        recommendation:
          "Confirm the association explicitly; the runtime will not guess from weak signals.",
      });
    }

    // Shared files touched by different contributions: a textual or semantic conflict signal.
    const byPath = new Map<string, { commits: Set<string>; items: Set<string> }>();
    for (const c of commits) {
      for (const p of c.paths) {
        const entry = byPath.get(p) ?? { commits: new Set<string>(), items: new Set<string>() };
        entry.commits.add(c.sha);
        entry.items.add(itemOf.get(c.sha) ?? `unlinked:${c.sha.slice(0, 8)}`);
        byPath.set(p, entry);
      }
    }
    for (const [path, entry] of byPath) {
      const crossing = entry.items.size > 1;
      if (DEPENDENCY_FILES.test(path) && (crossing || entry.commits.size > 0)) {
        add({
          severity: crossing ? "MEDIUM" : "INFO",
          kind: "DEPENDENCY_CHANGE",
          message: `Dependency manifest ${path} changed${crossing ? " by multiple contributions" : ""}.`,
          commits: [...entry.commits],
          workItemIds: [...entry.items].filter((i) => !i.startsWith("unlinked:")),
          paths: [path],
          recommendation: "Verify lockfile consistency and run the full install and test suite.",
        });
      } else if (CONTRACT_FILES.test(path)) {
        add({
          severity: crossing ? "HIGH" : "MEDIUM",
          kind: "CONTRACT_CHANGE",
          message: `Public contract ${path} changed${crossing ? " by multiple contributions" : ""}.`,
          commits: [...entry.commits],
          workItemIds: [...entry.items].filter((i) => !i.startsWith("unlinked:")),
          paths: [path],
          recommendation: "Check every consumer of this contract against the combined result.",
        });
      } else if (crossing) {
        add({
          severity: "MEDIUM",
          kind: "FILE_OVERLAP",
          message: `${path} was changed by ${entry.items.size} different contributions; a later one may alter behavior an earlier one relies on.`,
          commits: [...entry.commits],
          workItemIds: [...entry.items].filter((i) => !i.startsWith("unlinked:")),
          paths: [path],
          recommendation:
            "Review the combined file and test the interaction, not each change alone.",
        });
      }
    }

    // Deterministic checks run only against the exact candidate SHA.
    const checks: CheckResult[] = [];
    const head = await this.git(input.checkoutPath, ["rev-parse", "HEAD"]);
    const dirty = await this.git(input.checkoutPath, ["status", "--porcelain"]);
    if (!head.ok || head.out.trim() !== candidateSha || dirty.out.trim() !== "") {
      add({
        severity: "HIGH",
        kind: "CHECKOUT_MISMATCH",
        message:
          "The validation checkout is not a clean checkout of the candidate SHA; checks were not run.",
        commits: [],
        workItemIds: [],
        paths: [],
        recommendation:
          "Create a clean integration worktree at the candidate SHA and re-run the assessment.",
      });
    } else {
      for (const spec of input.checks ?? []) {
        const r = await this.runner.run({
          command: spec.command,
          args: spec.args,
          cwd: input.checkoutPath,
          timeoutMs: 900_000,
          maxOutputBytes: 8 * 1024 * 1024,
        });
        const passed = r.exitCode === 0 && !r.timedOut && !r.truncated;
        const tail = (r.stdout + r.stderr).slice(-2000);
        checks.push({
          name: spec.name,
          command: spec.command,
          args: spec.args,
          exitCode: r.exitCode,
          passed,
          outputTail: tail,
        });
        if (!passed) {
          add({
            severity: "HIGH",
            kind: "CHECK_FAILED",
            message: `Check "${spec.name}" failed at candidate ${candidateSha.slice(0, 12)}.`,
            commits: [],
            workItemIds: [],
            paths: [],
            recommendation:
              "Trace the failure to the responsible contribution and reopen only that Work Item.",
          });
        }
      }
    }

    const recommendation = findings.some((f) => f.severity === "HIGH")
      ? "BLOCK"
      : findings.some((f) => f.severity === "MEDIUM")
        ? "REQUEST_CHANGES"
        : "ACCEPT";
    const body = {
      baseSha,
      candidateSha,
      candidateRef: input.candidate,
      commits,
      associations,
      needsConfirmation,
      checks,
      findings,
      recommendation,
    };
    return IntegrationReportSchema.parse({ ...body, reportHash: fingerprint(body) });
  }

  /** Discovery from explicit signals only: a single unambiguous Work Item id, or a human confirmation. */
  private associate(sha: string, text: string, confirmed?: Record<string, string>): Association {
    const human = confirmed?.[sha];
    if (human)
      return { commit: sha, workItemId: human, state: "CONFIRMED", signals: ["human-confirmed"] };
    const ids = [...new Set(text.match(WI_ID) ?? [])];
    if (ids.length === 1)
      return {
        commit: sha,
        workItemId: ids[0]!,
        state: "DISCOVERED",
        signals: ["explicit work item id in commit/branch metadata"],
      };
    if (ids.length > 1)
      return {
        commit: sha,
        workItemId: null,
        state: "AMBIGUOUS",
        signals: ids.map((i) => `mentions ${i}`),
      };
    return { commit: sha, workItemId: null, state: "UNASSOCIATED", signals: [] };
  }
}

export class PromotionRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromotionRefusedError";
  }
}

/**
 * A promotion is only eligible for the exact SHA that was validated, with a technical ACCEPT
 * and a recorded human acceptance. Technical acceptance is not permission to merge.
 */
export function assertPromotable(
  report: IntegrationReport,
  currentCandidateSha: string,
  humanAcceptedBy: string | null,
): void {
  if (currentCandidateSha !== report.candidateSha) {
    throw new PromotionRefusedError(
      `Candidate changed since validation (${report.candidateSha.slice(0, 12)} -> ${currentCandidateSha.slice(0, 12)}); re-validate.`,
    );
  }
  if (report.recommendation !== "ACCEPT")
    throw new PromotionRefusedError(`Technical recommendation is ${report.recommendation}.`);
  if (report.needsConfirmation.length > 0)
    throw new PromotionRefusedError("Contribution associations still need confirmation.");
  if (!humanAcceptedBy) throw new PromotionRefusedError("Human acceptance is required.");
}

/** Parameters for the approval-gated GIT_MERGE that performs the promotion. */
export function promotionOperation(report: IntegrationReport): {
  source: string;
  expectedSource: string;
} {
  return { source: report.candidateRef, expectedSource: report.candidateSha };
}
