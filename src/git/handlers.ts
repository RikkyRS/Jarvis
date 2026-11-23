import {
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
  existsSync,
  appendFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { OperationType } from "../domain/contracts.js";
import type { HandlerContext, HandlerResult, OperationHandler } from "../gateway/index.js";
import type { ProcessResult } from "../gateway/runner.js";
import { sha256Hex } from "../shared/canonical.js";

/** Option-injection guard: refs, remotes and branches may never start with "-". */
const RefName = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._/][A-Za-z0-9._/@{}^~-]*$/, "invalid ref name")
  .refine((v) => !v.includes(".."), "invalid ref name");

const NO_HOOKS = join(tmpdir(), "jarvis-no-hooks");
/** Repository hooks are project-provided code: never run them on the host. */
const SAFE_GIT = [
  "-c",
  `core.hooksPath=${NO_HOOKS}`,
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.pager=cat",
];

export type GitResult = ProcessResult & { ok: boolean };

export async function git(ctx: HandlerContext, cwd: string, args: string[]): Promise<GitResult> {
  const result = await ctx.runner.run({
    command: "git",
    args: [...SAFE_GIT, ...args],
    cwd,
    timeoutMs: 120_000,
    maxOutputBytes: 8 * 1024 * 1024,
    env: { GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
  });
  return { ...result, ok: result.exitCode === 0 && !result.timedOut };
}

const fail = (reason: string, evidence: Record<string, unknown> = {}): HandlerResult => ({
  ok: false,
  evidence: { reason, ...evidence },
});

function tail(text: string, n = 2000): string {
  return text.length > n ? text.slice(-n) : text;
}

async function headSha(ctx: HandlerContext, cwd: string): Promise<string | null> {
  const r = await git(ctx, cwd, ["rev-parse", "HEAD"]);
  return r.ok ? r.stdout.trim() : null;
}

export async function stagedDiffHash(ctx: HandlerContext, cwd: string): Promise<string | null> {
  const r = await git(ctx, cwd, ["diff", "--cached", "--no-color", "--binary", "--no-ext-diff"]);
  return r.ok && r.stdout.length > 0 ? sha256Hex(r.stdout) : null;
}

const cwdOf = (ctx: HandlerContext) => ctx.projectRoot;

export const gitInspect: OperationHandler = async (ctx) => {
  const cwd = cwdOf(ctx);
  const status = await git(ctx, cwd, ["status", "--porcelain=v1", "-b"]);
  const head = await headSha(ctx, cwd);
  if (!status.ok) return fail("GIT_STATUS_FAILED", { stderr: tail(status.stderr) });
  const lines = status.stdout.split("\n").filter(Boolean);
  return {
    ok: true,
    evidence: { head, branchLine: lines[0] ?? "", dirtyEntries: Math.max(lines.length - 1, 0) },
    output: status.stdout,
  };
};

export const gitStage: OperationHandler = async (ctx) => {
  const cwd = cwdOf(ctx);
  const r = await git(ctx, cwd, ["add", "--", ctx.target]);
  if (!r.ok) return fail("GIT_ADD_FAILED", { stderr: tail(r.stderr) });
  return {
    ok: true,
    evidence: { staged: ctx.target, stagedDiffHash: await stagedDiffHash(ctx, cwd) },
  };
};

const CommitParams = z.object({
  message: z.string().min(1).max(5000),
  diffHash: z.string().regex(/^[a-f0-9]{64}$/),
});

export const gitCommit: OperationHandler = async (ctx) => {
  const p = CommitParams.safeParse(ctx.request.parameters);
  if (!p.success) return fail("INVALID_PARAMETERS");
  const cwd = cwdOf(ctx);
  const current = await stagedDiffHash(ctx, cwd);
  if (current !== p.data.diffHash) {
    return fail("STAGED_DIFF_CHANGED", { approved: p.data.diffHash, actual: current });
  }
  const before = await headSha(ctx, cwd);
  const r = await git(ctx, cwd, ["commit", "--no-verify", "-m", p.data.message]);
  if (!r.ok) return fail("GIT_COMMIT_FAILED", { stderr: tail(r.stderr), stdout: tail(r.stdout) });
  const after = await headSha(ctx, cwd);
  if (!after || after === before) return fail("COMMIT_NOT_RECORDED");
  return { ok: true, evidence: { commitSha: after, parent: before, diffHash: current } };
};

const PushParams = z.object({
  remote: RefName,
  branch: RefName,
  expectedHead: z.string().regex(/^[a-f0-9]{40,64}$/),
  remoteUrl: z.string().min(1),
});

export const gitPush: OperationHandler = async (ctx) => {
  const p = PushParams.safeParse(ctx.request.parameters);
  if (!p.success) return fail("INVALID_PARAMETERS");
  const { remote, branch, expectedHead, remoteUrl } = p.data;
  const cwd = cwdOf(ctx);
  const url = await git(ctx, cwd, ["remote", "get-url", remote]);
  if (!url.ok || url.stdout.trim() !== remoteUrl)
    return fail("REMOTE_MISMATCH", { actual: url.stdout.trim() });
  const cur = await git(ctx, cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (cur.stdout.trim() !== branch) return fail("BRANCH_MISMATCH", { actual: cur.stdout.trim() });
  const head = await headSha(ctx, cwd);
  if (head !== expectedHead) return fail("HEAD_MISMATCH", { expected: expectedHead, actual: head });
  // Explicit refspec without "+": a non-fast-forward is rejected, never forced.
  const r = await git(ctx, cwd, ["push", remote, `refs/heads/${branch}:refs/heads/${branch}`]);
  if (!r.ok) return fail("GIT_PUSH_FAILED", { stderr: tail(r.stderr) });
  const remoteRef = await git(ctx, cwd, ["ls-remote", remote, `refs/heads/${branch}`]);
  const remoteSha = remoteRef.stdout.split(/\s+/)[0];
  if (remoteSha !== expectedHead) return fail("REMOTE_HEAD_NOT_VERIFIED", { remoteSha });
  return { ok: true, evidence: { pushed: expectedHead, remote, branch, remoteSha } };
};

const MergeParams = z.object({
  source: RefName,
  expectedSource: z.string().regex(/^[a-f0-9]{40,64}$/),
});

export const gitMerge: OperationHandler = async (ctx) => {
  const p = MergeParams.safeParse(ctx.request.parameters);
  const target = RefName.safeParse(ctx.target);
  if (!p.success || !target.success) return fail("INVALID_PARAMETERS");
  const cwd = cwdOf(ctx);
  const cur = await git(ctx, cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (cur.stdout.trim() !== target.data)
    return fail("TARGET_BRANCH_NOT_CHECKED_OUT", { actual: cur.stdout.trim() });
  const src = await git(ctx, cwd, ["rev-parse", `refs/heads/${p.data.source}`]);
  if (src.stdout.trim() !== p.data.expectedSource)
    return fail("SOURCE_CHANGED", { actual: src.stdout.trim() });
  const before = await headSha(ctx, cwd);
  const r = await git(ctx, cwd, ["merge", "--no-ff", "--no-edit", "--no-verify", p.data.source]);
  if (!r.ok) {
    await git(ctx, cwd, ["merge", "--abort"]);
    return fail("MERGE_CONFLICT", { stderr: tail(r.stderr), stdout: tail(r.stdout) });
  }
  const after = await headSha(ctx, cwd);
  return { ok: true, evidence: { mergeSha: after, previousHead: before, source: p.data.source } };
};

const WorktreeAdd = z.object({ branch: RefName, base: RefName });

export const gitWorktreeAdd: OperationHandler = async (ctx) => {
  const p = WorktreeAdd.safeParse(ctx.request.parameters);
  if (!p.success || !ctx.absoluteTarget) return fail("INVALID_PARAMETERS");
  const cwd = cwdOf(ctx);
  const exclude = await git(ctx, cwd, ["rev-parse", "--git-path", "info/exclude"]);
  if (exclude.ok) {
    const file = join(cwd, exclude.stdout.trim());
    mkdirSync(dirname(file), { recursive: true });
    const body = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (!body.includes(".jarvis/"))
      appendFileSync(file, `${body.endsWith("\n") || body === "" ? "" : "\n"}.jarvis/\n`);
  }
  const r = await git(ctx, cwd, [
    "worktree",
    "add",
    "-b",
    p.data.branch,
    ctx.absoluteTarget,
    p.data.base,
  ]);
  if (!r.ok) return fail("WORKTREE_ADD_FAILED", { stderr: tail(r.stderr) });
  return {
    ok: true,
    evidence: {
      worktree: ctx.target,
      branch: p.data.branch,
      head: await headSha(ctx, ctx.absoluteTarget),
    },
  };
};

const WorktreeRemove = z.object({
  branch: RefName,
  base: RefName,
  /** DISCARD acknowledges that unintegrated work will be lost; default refuses. */
  disposition: z.enum(["NONE", "DISCARD"]).default("NONE"),
});

export const gitWorktreeRemove: OperationHandler = async (ctx) => {
  const p = WorktreeRemove.safeParse(ctx.request.parameters);
  if (!p.success || !ctx.absoluteTarget) return fail("INVALID_PARAMETERS");
  const cwd = cwdOf(ctx);
  const dirty = await git(ctx, ctx.absoluteTarget, ["status", "--porcelain"]);
  const ahead = await git(ctx, cwd, ["rev-list", "--count", `${p.data.base}..${p.data.branch}`]);
  const dirtyEntries = dirty.stdout.split("\n").filter(Boolean).length;
  const unintegrated = Number.parseInt(ahead.stdout.trim() || "0", 10);
  if ((!dirty.ok || !ahead.ok) && p.data.disposition !== "DISCARD") return fail("STATE_UNKNOWN");
  if ((dirtyEntries > 0 || unintegrated > 0) && p.data.disposition !== "DISCARD") {
    return fail("UNINTEGRATED_CHANGES", { dirtyEntries, unintegratedCommits: unintegrated });
  }
  const args = [
    "worktree",
    "remove",
    ...(p.data.disposition === "DISCARD" ? ["--force"] : []),
    ctx.absoluteTarget,
  ];
  const r = await git(ctx, cwd, args);
  if (!r.ok) return fail("WORKTREE_REMOVE_FAILED", { stderr: tail(r.stderr) });
  return {
    ok: true,
    evidence: {
      removed: ctx.target,
      dirtyEntries,
      unintegratedCommits: unintegrated,
      disposition: p.data.disposition,
    },
  };
};

const FileEdit = z.object({
  content: z.string(),
  expectedSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});

export const fileEdit: OperationHandler = async (ctx) => {
  const p = FileEdit.safeParse(ctx.request.parameters);
  if (!p.success || !ctx.absoluteTarget) return fail("INVALID_PARAMETERS");
  const file = ctx.absoluteTarget;
  if (existsSync(file)) {
    if (statSync(file).isDirectory()) return fail("TARGET_IS_DIRECTORY");
    if (p.data.expectedSha256 && sha256Hex(readFileSync(file, "utf8")) !== p.data.expectedSha256) {
      return fail("FILE_CHANGED_SINCE_READ");
    }
  } else if (p.data.expectedSha256) {
    return fail("FILE_CHANGED_SINCE_READ");
  }
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.jarvis-${process.pid}.tmp`;
  writeFileSync(tmp, p.data.content, "utf8");
  renameSync(tmp, file);
  return {
    ok: true,
    evidence: {
      path: ctx.target,
      bytes: Buffer.byteLength(p.data.content),
      sha256: sha256Hex(p.data.content),
    },
  };
};

const FileRead = z.object({
  maxBytes: z.number().int().positive().max(5_000_000).default(200_000),
});

export const fileRead: OperationHandler = async (ctx) => {
  const p = FileRead.safeParse(ctx.request.parameters);
  if (!p.success || !ctx.absoluteTarget) return fail("INVALID_PARAMETERS");
  if (!existsSync(ctx.absoluteTarget)) return fail("NOT_FOUND");
  const stat = statSync(ctx.absoluteTarget);
  if (!stat.isFile()) return fail("NOT_A_FILE");
  if (stat.size > p.data.maxBytes) return fail("FILE_TOO_LARGE", { bytes: stat.size });
  const content = readFileSync(ctx.absoluteTarget, "utf8");
  return {
    ok: true,
    evidence: { path: ctx.target, bytes: stat.size, sha256: sha256Hex(content) },
    output: content,
  };
};

const TestRun = z.object({ command: z.string().min(1), args: z.array(z.string()).default([]) });

export const testRun: OperationHandler = async (ctx) => {
  const p = TestRun.safeParse(ctx.request.parameters);
  if (!p.success || !ctx.absoluteTarget) return fail("INVALID_PARAMETERS");
  const r = await ctx.runner.run({
    command: p.data.command,
    args: p.data.args,
    cwd: ctx.absoluteTarget,
    timeoutMs: 600_000,
    maxOutputBytes: 8 * 1024 * 1024,
  });
  const evidence = {
    command: p.data.command,
    args: p.data.args,
    cwd: ctx.target,
    exitCode: r.exitCode,
    timedOut: r.timedOut,
    truncated: r.truncated,
    stdoutSha256: sha256Hex(r.stdout),
    stdoutTail: tail(r.stdout),
    stderrTail: tail(r.stderr),
  };
  return { ok: r.exitCode === 0 && !r.timedOut && !r.truncated, evidence };
};

/** Ready-made handlers for every non-critical operation type. */
export function defaultHandlers(): Partial<Record<OperationType, OperationHandler>> {
  return {
    FILE_READ: fileRead,
    FILE_EDIT: fileEdit,
    TEST_RUN: testRun,
    GIT_INSPECT: gitInspect,
    GIT_STAGE: gitStage,
    GIT_COMMIT: gitCommit,
    GIT_PUSH: gitPush,
    GIT_MERGE: gitMerge,
    GIT_WORKTREE_ADD: gitWorktreeAdd,
    GIT_WORKTREE_REMOVE: gitWorktreeRemove,
  };
}
