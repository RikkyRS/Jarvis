import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Jarvis } from "../../src/app/jarvis.js";
import { HostRunner } from "../../src/gateway/index.js";
import { buildChangeReport, renderChangeReport } from "../../src/report/index.js";
import { UnresolvedFailureError } from "../../src/runtime/workflow.js";
import {
  agent,
  cleanup,
  human,
  makeRepo,
  nextId,
  openJarvis,
  sh,
  writeConfig,
} from "../helpers.js";

let root: string;
let jarvis: Jarvis;

beforeEach(() => {
  root = makeRepo();
  writeConfig(root, { trustedProject: true });
  jarvis = openJarvis(root);
});

afterEach(() => {
  jarvis.close();
  cleanup(root);
});

async function startRun(acceptance: string[] = ["a.txt is updated"]) {
  const item = jarvis.store.createWorkItem({
    projectId: jarvis.project.id,
    actor: human,
    title: "Update a",
    objective: "Change a.txt",
    acceptanceCriteria: acceptance,
  });
  const run = jarvis.store.createRun(item.id, agent);
  for (const s of ["PREPARING", "AWAITING_EXECUTION_APPROVAL", "RUNNING"] as const)
    jarvis.store.transitionRun(run.id, s, human);
  return { item, run };
}

const op = (itemId: string, runId: string, over: Record<string, unknown>) =>
  ({ operationId: nextId(), workItemId: itemId, workflowRunId: runId, ...over }) as never;

describe("end to end: mission -> edit -> test -> approved commit -> review -> delivery", () => {
  it("[R-E2E-01] completes a full flow with evidence, and reopens with preserved context", async () => {
    const { item, run } = await startRun();
    const missionId = jarvis.budget.createMission({
      projectId: jarvis.project.id,
      owner: human,
      workItemId: item.id,
    });
    jarvis.budget.grant({
      missionId,
      phase: "PREPARATION",
      amount: 5000,
      actor: human,
      reason: "discovery",
    });
    jarvis.budget.grant({
      missionId,
      phase: "EXECUTION",
      amount: 50_000,
      actor: human,
      reason: "implementation",
    });
    expect(jarvis.budget.status(missionId, "EXECUTION").allowance).toBe(50_000);

    // 1. Allowed edit executes immediately.
    const edit = await jarvis.request(
      agent,
      op(item.id, run.id, {
        type: "FILE_EDIT",
        target: "a.txt",
        parameters: { content: "updated\n" },
      }),
    );
    expect(edit.status).toBe("EXECUTED");

    // 2. Trusted tests are executed and recorded.
    const test = await jarvis.runtime.run(run.id, {
      operationId: nextId(),
      requestedBy: agent,
      type: "TEST_RUN",
      target: ".",
      parameters: { command: "node", args: ["-e", "process.exit(0)"] },
    });
    expect(test.outcome).toBe("SUCCEEDED");

    // 3. Stage, then commit needs a human.
    const staged = await jarvis.request(
      agent,
      op(item.id, run.id, { type: "GIT_STAGE", target: "a.txt" }),
    );
    if (staged.status !== "EXECUTED") throw new Error("stage failed");
    const diffHash = staged.result.evidence["stagedDiffHash"];
    const commitOp = op(item.id, run.id, {
      type: "GIT_COMMIT",
      target: "main",
      parameters: { message: "update a", diffHash },
    });
    const pending = await jarvis.request(agent, commitOp);
    expect(pending.status).toBe("APPROVAL_REQUIRED");
    if (pending.status !== "APPROVAL_REQUIRED") return;
    expect(sh(root, "log", "-1", "--format=%s")).toBe("init"); // nothing committed yet

    const shown = jarvis
      .pendingApprovals()
      .find((p) => p.approval.id === pending.approvalId)?.request;
    expect(shown?.parameters["diffHash"]).toBe(diffHash); // the human sees exactly what they approve
    jarvis.approve(pending.approvalId);
    const committed = await jarvis.resume(pending.operationId);
    expect(committed.outcome).toBe("SUCCEEDED");
    expect(sh(root, "log", "-1", "--format=%s")).toBe("update a");

    // 4. Review and completion are driven by evidence and a human.
    jarvis.runtime.submitForReview(run.id, agent);
    const report = await buildChangeReport({
      runner: new HostRunner(["git"], { inheritHome: true }),
      repoRoot: root,
      db: jarvis.db,
      workItem: item,
      run: jarvis.store.getRun(run.id)!,
      base: "HEAD~1",
      head: "HEAD",
      summary: "Updated a.txt",
      claims: { "a.txt is updated": [edit.status === "EXECUTED" ? edit.result.operationId : ""] },
    });
    expect(report.files.map((f) => f.path)).toEqual(["a.txt"]);
    expect(report.tests[0]).toMatchObject({ passed: true, exitCode: 0 });
    expect(report.acceptance[0]?.status).toBe("MET");
    expect(renderChangeReport(report)).toContain("PASS `node -e process.exit(0)`");

    expect(() => jarvis.runtime.complete(run.id, agent)).toThrow(); // an agent cannot complete
    jarvis.runtime.complete(run.id, human);
    jarvis.store.transitionWorkItem(item.id, "IN_PROGRESS", human);
    jarvis.store.transitionWorkItem(item.id, "DELIVERED", human);

    // 5. External review asks for changes: same Work Item, new run, full context.
    jarvis.store.addReviewFeedback(item.id, human, "also handle empty file");
    jarvis.store.transitionWorkItem(item.id, "REOPENED", human);
    const run2 = jarvis.store.createRun(item.id, agent);
    expect(run2.sequence).toBe(2);
    expect(jarvis.store.getWorkItem(item.id)?.reviewFeedback).toEqual(["also handle empty file"]);
    expect(jarvis.audit.verify()).toBeNull();
  });

  it("[R-RUN-01] a failed operation can never be reported as completed", async () => {
    const { run } = await startRun();
    const failing = await jarvis.runtime.run(run.id, {
      operationId: nextId(),
      requestedBy: agent,
      type: "TEST_RUN",
      target: ".",
      parameters: { command: "node", args: ["-e", "process.exit(2)"] },
    });
    expect(failing.outcome).toBe("FAILED");
    expect(() => jarvis.runtime.submitForReview(run.id, agent)).toThrow(UnresolvedFailureError);
    expect(() => jarvis.runtime.complete(run.id, human)).toThrow(UnresolvedFailureError);
    expect(jarvis.store.getRun(run.id)?.status).toBe("RUNNING");
    expect(jarvis.store.getRun(run.id)?.checkpoint["lastFailure"]).toBeDefined();

    // A later passing run of the same test resolves it; a tool error is also a failure.
    await jarvis.runtime.run(run.id, {
      operationId: nextId(),
      requestedBy: agent,
      type: "TEST_RUN",
      target: ".",
      parameters: { command: "node", args: ["-e", "process.exit(2)"] },
    });
    expect(jarvis.runtime.unresolvedFailures(run.id)).toHaveLength(2);
  });

  it("refuses to submit a run that has no evidence at all", async () => {
    const { run } = await startRun();
    expect(() => jarvis.runtime.submitForReview(run.id, agent)).toThrow(/no evidence/);
  });

  it("only RUNNING runs accept operations", async () => {
    const item = jarvis.store.createWorkItem({
      projectId: jarvis.project.id,
      actor: human,
      title: "t",
      objective: "o",
    });
    const run = jarvis.store.createRun(item.id, agent);
    await expect(
      jarvis.runtime.run(run.id, {
        operationId: nextId(),
        requestedBy: agent,
        type: "FILE_READ",
        target: "a.txt",
      }),
    ).rejects.toThrow(/RUNNING/);
  });
});

describe("adversarial: bypass attempts through the application API", () => {
  it("[R-APPROVAL-01] an agent cannot approve its own operation", async () => {
    const { item, run } = await startRun();
    const pending = await jarvis.request(
      agent,
      op(item.id, run.id, {
        type: "GIT_PUSH",
        target: "origin/main",
        parameters: {
          remote: "origin",
          branch: "main",
          expectedHead: "a".repeat(40),
          remoteUrl: "x",
        },
      }),
    );
    if (pending.status !== "APPROVAL_REQUIRED") throw new Error("expected approval gate");
    expect(() => jarvis.approvals.approve(pending.approvalId, agent)).toThrow();
    expect(jarvis.approvals.get(pending.approvalId)?.status).toBe("PENDING");
  });

  it("[R-APPROVAL-02] an approval cannot authorize modified content", async () => {
    const { item, run } = await startRun();
    await jarvis.request(
      agent,
      op(item.id, run.id, { type: "FILE_EDIT", target: "a.txt", parameters: { content: "x\n" } }),
    );
    const staged = await jarvis.request(
      agent,
      op(item.id, run.id, { type: "GIT_STAGE", target: "a.txt" }),
    );
    if (staged.status !== "EXECUTED") throw new Error("stage failed");
    const id = nextId();
    const params = { message: "m", diffHash: staged.result.evidence["stagedDiffHash"] };
    const pending = await jarvis.request(agent, {
      operationId: id,
      workItemId: item.id,
      workflowRunId: run.id,
      type: "GIT_COMMIT",
      target: "main",
      parameters: params,
    } as never);
    if (pending.status !== "APPROVAL_REQUIRED") throw new Error("expected gate");
    jarvis.approve(pending.approvalId);
    // Same operation id, tampered message after approval.
    const tampered = await jarvis.request(agent, {
      operationId: id,
      workItemId: item.id,
      workflowRunId: run.id,
      type: "GIT_COMMIT",
      target: "main",
      parameters: { ...params, message: "malicious" },
    } as never);
    expect(tampered.status).toBe("EXECUTED");
    expect(tampered.status === "EXECUTED" && tampered.result.reason).toBe("APPROVAL_MISMATCH");
    expect(sh(root, "log", "-1", "--format=%s")).toBe("init");
  });

  it("[R-ISO-01] an agent claiming trust gets none: untrusted project code is blocked without a container", async () => {
    jarvis.close();
    writeConfig(root, { trustedProject: false });
    jarvis = openJarvis(root);
    const { item, run } = await startRun();
    const r = await jarvis.request(agent, {
      operationId: nextId(),
      workItemId: item.id,
      workflowRunId: run.id,
      type: "TEST_RUN",
      target: ".",
      trust: "TRUSTED",
      parameters: { command: "node", args: ["-e", "1"] },
    } as never);
    expect(r.status).toBe("BLOCKED");
    expect(r.status === "BLOCKED" && r.result.reason).toBe("ISOLATION_UNAVAILABLE");
  });

  it("[R-GATE-01] critical operations are blocked and audited, never executed", async () => {
    const { item, run } = await startRun();
    const r = await jarvis.request(
      agent,
      op(item.id, run.id, { type: "GIT_RESET_HARD", target: "HEAD" }),
    );
    expect(r.status).toBe("BLOCKED");
    expect(jarvis.audit.list().some((e) => e.kind === "execution.blocked")).toBe(true);
  });

  it("[R-PATH-01] path traversal through file operations is denied", async () => {
    const { item, run } = await startRun();
    const r = await jarvis.request(
      agent,
      op(item.id, run.id, {
        type: "FILE_EDIT",
        target: "../escape.txt",
        parameters: { content: "x" },
      }),
    );
    expect(r.status === "EXECUTED" && r.result.reason).toBe("PATH_ESCAPE");
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("one\n");
  });

  it("an approved operation id cannot be replayed after it ran", async () => {
    const { item, run } = await startRun();
    const staged = await jarvis.request(
      agent,
      op(item.id, run.id, { type: "GIT_STAGE", target: "a.txt" }),
    );
    expect(staged.status).toBe("EXECUTED");
    const id = nextId();
    const mk = () =>
      ({
        operationId: id,
        workItemId: item.id,
        workflowRunId: run.id,
        type: "GIT_INSPECT",
        target: ".",
      }) as never;
    expect((await jarvis.request(agent, mk())).status).toBe("EXECUTED");
    const again = await jarvis.request(agent, mk());
    expect(again.status === "EXECUTED" && again.result.reason).toBe("OPERATION_ALREADY_EXECUTED");
  });
});
