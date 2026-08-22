import { spawnSync } from "node:child_process";
import { nowIso } from "../../shared/util.js";

export type GitSnapshot = {
  repository: boolean;
  reason?: string;
  head?: string | null;
  treeHash?: string | null;
  branch?: string | null;
  branches?: string[];
  workingTreeClean?: boolean;
  statusShort?: string;
  detachedHead?: boolean;
  timestamp: string;
};

export type GitReconciliation = {
  status: "IN_SYNC" | "DIVERGED" | "UNKNOWN" | "NO_BASELINE";
  changes: string[];
  baseline?: GitSnapshot;
  current: GitSnapshot;
  reason?: string;
};

export class GitEngine {
  constructor(private readonly root: string) {}

  run(args: string[], timeoutMs = 15_000): { returncode: number; stdout: string; stderr: string } {
    const proc = spawnSync("git", args, {
      cwd: this.root,
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
    });
    return {
      returncode: proc.status ?? 1,
      stdout: (proc.stdout ?? "").trim(),
      stderr: (proc.stderr ?? "").trim(),
    };
  }

  value(args: string[]): string | null {
    const result = this.run(args);
    return result.returncode === 0 && result.stdout ? result.stdout : null;
  }

  snapshot(): GitSnapshot {
    const timestamp = nowIso();
    if (this.value(["rev-parse", "--is-inside-work-tree"]) !== "true") {
      return { repository: false, reason: "not_a_git_repository", timestamp };
    }
    const head = this.value(["rev-parse", "HEAD"]);
    const branch = this.value(["branch", "--show-current"]);
    const detachedHead = !branch && Boolean(head);
    const status = this.run(["status", "--short"]);
    const branches = this.run(["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
    const treeHash = head ? this.value(["rev-parse", "HEAD^{tree}"]) : null;
    return {
      repository: true,
      head,
      treeHash,
      branch,
      branches: branches.stdout ? branches.stdout.split("\n") : [],
      workingTreeClean: status.returncode === 0 && !status.stdout,
      statusShort: status.stdout,
      detachedHead,
      timestamp,
    };
  }

  reconcile(baseline: GitSnapshot | undefined): GitReconciliation {
    const current = this.snapshot();
    if (!baseline) return { status: "NO_BASELINE", changes: [], current };
    if (!baseline.repository || !current.repository) {
      return { status: "UNKNOWN", changes: [], current, baseline, reason: "git_repository_state_unavailable" };
    }
    const changes: string[] = [];
    if (baseline.head !== current.head) changes.push("HEAD_CHANGED");
    if (baseline.treeHash !== current.treeHash) changes.push("TREE_CHANGED");
    if (baseline.branch !== current.branch) changes.push("BRANCH_CHANGED");
    if (JSON.stringify(baseline.branches) !== JSON.stringify(current.branches)) changes.push("BRANCH_LIST_CHANGED");
    return { status: changes.length ? "DIVERGED" : "IN_SYNC", changes, baseline, current };
  }

  parseStatus(statusShort = ""): Array<{ code: string; path: string }> {
    return statusShort
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const code = line.slice(0, 2);
        let path = line.slice(3);
        if (path.includes(" -> ")) path = path.split(" -> ")[1] ?? path;
        return { code, path };
      });
  }

  ensureCycleBranch(slug: string, number: number, snapshot: GitSnapshot): { status: string; branch?: string; reason?: string } {
    const branch = `jarvis/${number}-${slug}`;
    if (!snapshot.repository) return { status: "SKIPPED", reason: "not_a_git_repository" };
    if (snapshot.detachedHead) return { status: "SKIPPED", reason: "detached_HEAD_requires_explicit_choice" };
    if (!snapshot.workingTreeClean) return { status: "SKIPPED", reason: "dirty_working_tree", branch };
    if (snapshot.branch === branch) return { status: "ALREADY_ON_BRANCH", branch };
    if (snapshot.branches?.includes(branch)) {
      return { status: "EXISTS", branch, reason: "branch exists; checkout requires explicit user choice" };
    }
    const created = this.run(["checkout", "-b", branch]);
    if (created.returncode !== 0) return { status: "FAILED", branch, reason: created.stderr || created.stdout };
    return { status: "CREATED", branch };
  }

  commit(message: string): { status: string; reason?: string } {
    const add = this.run(["add", "-A"]);
    if (add.returncode !== 0) return { status: "FAILED", reason: add.stderr };
    const commit = this.run(["commit", "-m", message]);
    if (commit.returncode !== 0) return { status: "FAILED", reason: commit.stderr || commit.stdout };
    return { status: "COMMITTED" };
  }
}
