import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { ApprovalService } from "../../src/approval/service.js";
import type { OperationRequestInput } from "../../src/domain/contracts.js";
import { ExecutionGateway, HostRunner } from "../../src/gateway/index.js";
import { defaultHandlers } from "../../src/git/handlers.js";
import { AuditLog } from "../../src/persistence/audit.js";
import { openDatabase } from "../../src/persistence/db.js";
import { sha256Hex } from "../../src/shared/canonical.js";

const human = { kind: "human", id: "rikky" } as const;
const agent = { kind: "agent", id: "claude" } as const;

let root: string;
let remote: string;
let db: DatabaseSync;
let gateway: ExecutionGateway;
let approvals: ApprovalService;
let n = 0;

const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function op(over: Partial<OperationRequestInput>): OperationRequestInput {
  n += 1;
  return {
    operationId: `g-${n}`,
    projectId: "proj",
    workItemId: "wi",
    workflowRunId: "run",
    requestedBy: agent,
    type: "GIT_INSPECT",
    target: ".",
    trust: "TRUSTED",
    ...over,
  };
}

async function approved(request: OperationRequestInput) {
  approvals.approve(gateway.requestApproval(request, 60_000).id, human);
  return gateway.execute(request);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "jarvis-git-"));
  remote = mkdtempSync(join(tmpdir(), "jarvis-remote-"));
  sh(remote, "init", "--bare", "-b", "main");
  sh(root, "init", "-b", "main");
  sh(root, "config", "user.email", "t@example.com");
  sh(root, "config", "user.name", "Test");
  sh(root, "config", "commit.gpgsign", "false");
  writeFileSync(join(root, "a.txt"), "one\n");
  sh(root, "add", ".");
  sh(root, "commit", "-m", "init");
  sh(root, "remote", "add", "origin", remote);
  db = openDatabase(":memory:");
  const audit = new AuditLog(db);
  approvals = new ApprovalService(db, audit);
  gateway = new ExecutionGateway({
    projectId: "proj",
    projectRoot: root,
    db,
    audit,
    approvals,
    handlers: defaultHandlers(),
    hostRunner: new HostRunner(["git", "node"], { inheritHome: true }),
  });
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(remote, { recursive: true, force: true });
});

describe("git handlers through the gateway", () => {
  it("inspects state with evidence", async () => {
    const r = await gateway.execute(op({}));
    expect(r.outcome).toBe("SUCCEEDED");
    expect(r.evidence["head"]).toBe(sh(root, "rev-parse", "HEAD"));
  });

  it("[R-GIT-03] stages, then commits only the exact approved diff", async () => {
    writeFileSync(join(root, "a.txt"), "two\n");
    const stage = await gateway.execute(op({ type: "GIT_STAGE", target: "a.txt" }));
    const diffHash = stage.evidence["stagedDiffHash"] as string;
    expect(diffHash).toMatch(/^[a-f0-9]{64}$/);

    // Approval for a different diff hash is useless: staged diff does not match.
    const wrong = op({
      type: "GIT_COMMIT",
      target: "main",
      parameters: { message: "x", diffHash: "0".repeat(64) },
    });
    expect((await approved(wrong)).reason).toBe("STAGED_DIFF_CHANGED");

    const ok = await approved(
      op({ type: "GIT_COMMIT", target: "main", parameters: { message: "change", diffHash } }),
    );
    expect(ok.outcome).toBe("SUCCEEDED");
    expect(ok.evidence["commitSha"]).toBe(sh(root, "rev-parse", "HEAD"));
    expect(sh(root, "log", "-1", "--format=%s")).toBe("change");
  });

  it("[R-GIT-01] never runs repository hooks", async () => {
    const marker = join(root, "hook-ran");
    writeFileSync(
      join(root, ".git", "hooks", "pre-commit"),
      `#!/bin/sh\ntouch "${marker.replace(/\\/g, "/")}"\n`,
      { mode: 0o755 },
    );
    writeFileSync(join(root, "a.txt"), "three\n");
    const stage = await gateway.execute(op({ type: "GIT_STAGE", target: "a.txt" }));
    await approved(
      op({
        type: "GIT_COMMIT",
        target: "main",
        parameters: { message: "h", diffHash: stage.evidence["stagedDiffHash"] },
      }),
    );
    expect(existsSync(marker)).toBe(false);
  });

  it("[R-GIT-02] pushes only when remote, branch and HEAD match, and verifies the remote", async () => {
    const head = sh(root, "rev-parse", "HEAD");
    const base = { remote: "origin", branch: "main", expectedHead: head, remoteUrl: remote };

    const badRemote = await approved(
      op({
        type: "GIT_PUSH",
        target: "origin/main",
        parameters: { ...base, remoteUrl: "https://evil" },
      }),
    );
    expect(badRemote.reason).toBe("REMOTE_MISMATCH");

    const badHead = await approved(
      op({
        type: "GIT_PUSH",
        target: "origin/main",
        parameters: { ...base, expectedHead: "a".repeat(40) },
      }),
    );
    expect(badHead.reason).toBe("HEAD_MISMATCH");

    const injected = await approved(
      op({ type: "GIT_PUSH", target: "origin/main", parameters: { ...base, remote: "--force" } }),
    );
    expect(injected.reason).toBe("INVALID_PARAMETERS");

    const ok = await approved(op({ type: "GIT_PUSH", target: "origin/main", parameters: base }));
    expect(ok.outcome).toBe("SUCCEEDED");
    expect(sh(remote, "rev-parse", "main")).toBe(head);
  });

  it("[R-GATE-01] refuses to force push by policy", async () => {
    const r = await gateway.execute(op({ type: "GIT_FORCE_PUSH", target: "origin/main" }));
    expect(r.outcome).toBe("BLOCKED");
  });

  it("[R-WORKTREE-01] creates and safely removes an isolated worktree", async () => {
    const add = await gateway.execute(
      op({
        type: "GIT_WORKTREE_ADD",
        target: ".jarvis/wt/run1",
        parameters: { branch: "jarvis/wi/run-1", base: "main" },
      }),
    );
    expect(add.outcome).toBe("SUCCEEDED");
    const wt = join(root, ".jarvis", "wt", "run1");
    expect(existsSync(join(wt, "a.txt"))).toBe(true);
    expect(readFileSync(join(root, ".git", "info", "exclude"), "utf8")).toContain(".jarvis/");

    // Unintegrated work: removal is refused instead of silently losing it.
    writeFileSync(join(wt, "new.txt"), "wip");
    const params = { branch: "jarvis/wi/run-1", base: "main" };
    const refused = await approved(
      op({ type: "GIT_WORKTREE_REMOVE", target: ".jarvis/wt/run1", parameters: params }),
    );
    expect(refused.reason).toBe("UNINTEGRATED_CHANGES");
    expect(existsSync(wt)).toBe(true);

    // Explicit, approved DISCARD is the only way to drop it.
    const discard = await approved(
      op({
        type: "GIT_WORKTREE_REMOVE",
        target: ".jarvis/wt/run1",
        parameters: { ...params, disposition: "DISCARD" },
      }),
    );
    expect(discard.outcome).toBe("SUCCEEDED");
    expect(existsSync(wt)).toBe(false);
  });

  it("merges an exact, verified source commit with approval", async () => {
    sh(root, "checkout", "-q", "-b", "feature");
    writeFileSync(join(root, "b.txt"), "b");
    sh(root, "add", ".");
    sh(root, "commit", "-m", "feat");
    const sourceSha = sh(root, "rev-parse", "feature");
    sh(root, "checkout", "-q", "main");

    const stale = await approved(
      op({
        type: "GIT_MERGE",
        target: "main",
        parameters: { source: "feature", expectedSource: "b".repeat(40) },
      }),
    );
    expect(stale.reason).toBe("SOURCE_CHANGED");

    const ok = await approved(
      op({
        type: "GIT_MERGE",
        target: "main",
        parameters: { source: "feature", expectedSource: sourceSha },
      }),
    );
    expect(ok.outcome).toBe("SUCCEEDED");
    expect(existsSync(join(root, "b.txt"))).toBe(true);
  });
});

describe("file handlers", () => {
  it("edits atomically with optimistic concurrency and reads back", async () => {
    const before = sha256Hex("one\n");
    const edit = await gateway.execute(
      op({
        type: "FILE_EDIT",
        target: "a.txt",
        parameters: { content: "edited\n", expectedSha256: before },
      }),
    );
    expect(edit.outcome).toBe("SUCCEEDED");
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("edited\n");

    const stale = await gateway.execute(
      op({
        type: "FILE_EDIT",
        target: "a.txt",
        parameters: { content: "x", expectedSha256: before },
      }),
    );
    expect(stale.reason).toBe("FILE_CHANGED_SINCE_READ");

    const read = await gateway.execute(op({ type: "FILE_READ", target: "a.txt" }));
    expect(read.output).toBe("edited\n");
    expect(read.evidence["sha256"]).toBe(sha256Hex("edited\n"));
  });

  it("runs trusted tests on the host and reports the real exit code", async () => {
    const pass = await gateway.execute(
      op({
        type: "TEST_RUN",
        target: ".",
        parameters: { command: "node", args: ["-e", "console.log('ok')"] },
      }),
    );
    expect(pass.outcome).toBe("SUCCEEDED");
    expect(pass.evidence["exitCode"]).toBe(0);
    const failing = await gateway.execute(
      op({
        type: "TEST_RUN",
        target: ".",
        parameters: { command: "node", args: ["-e", "process.exit(3)"] },
      }),
    );
    expect(failing.outcome).toBe("FAILED");
    expect(failing.evidence["exitCode"]).toBe(3);
    const notAllowed = await gateway.execute(
      op({ type: "TEST_RUN", target: ".", parameters: { command: "curl", args: [] } }),
    );
    expect(notAllowed.outcome).toBe("FAILED");
    expect(String(notAllowed.evidence["error"])).toContain("not allowlisted");
  });

  it("[R-ENV-01] does not leak the parent environment to child processes", async () => {
    process.env["JARVIS_TEST_SECRET"] = "s3cret";
    const r = await gateway.execute(
      op({
        type: "TEST_RUN",
        target: ".",
        parameters: {
          command: "node",
          args: ["-e", "console.log(process.env.JARVIS_TEST_SECRET ?? 'none')"],
        },
      }),
    );
    delete process.env["JARVIS_TEST_SECRET"];
    expect(String(r.evidence["stdoutTail"]).trim()).toBe("none");
  });
});
