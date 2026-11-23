import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { ApprovalError, ApprovalService } from "../../src/approval/service.js";
import type { OperationRequestInput } from "../../src/domain/contracts.js";
import {
  ExecutionGateway,
  HostRunner,
  type OperationHandler,
  type ProcessRunner,
} from "../../src/gateway/index.js";
import { AuditLog } from "../../src/persistence/audit.js";
import { openDatabase } from "../../src/persistence/db.js";

const human = { kind: "human", id: "rikky" } as const;
const agent = { kind: "agent", id: "claude" } as const;

let root: string;
let db: DatabaseSync;
let now = new Date("2026-11-23T12:00:00.000Z");
const clock = () => now;
let counter = 0;

function req(over: Partial<OperationRequestInput> = {}): OperationRequestInput {
  counter += 1;
  return {
    operationId: `op-${counter}`,
    projectId: "proj",
    workItemId: "wi",
    workflowRunId: "run",
    requestedBy: agent,
    type: "FILE_EDIT",
    target: "src/a.txt",
    parameters: { diff: "abc" },
    ...over,
  };
}

const okHandler: OperationHandler = async ({ target }) => ({
  ok: true,
  evidence: { touched: target },
});
const fakeContainer: ProcessRunner = {
  kind: "container",
  run: async () => ({ exitCode: 0, stdout: "ok", stderr: "", timedOut: false, truncated: false }),
};

function build(opts: { container?: boolean; handlers?: Parameters<typeof makeGateway>[0] } = {}) {
  return makeGateway(
    opts.handlers ?? { FILE_EDIT: okHandler, GIT_COMMIT: okHandler, TEST_RUN: okHandler },
    opts.container,
  );
}

function makeGateway(
  handlers: ConstructorParameters<typeof ExecutionGateway>[0]["handlers"],
  container = false,
) {
  const audit = new AuditLog(db, clock);
  const approvals = new ApprovalService(db, audit, clock);
  const gateway = new ExecutionGateway({
    projectId: "proj",
    projectRoot: root,
    db,
    audit,
    approvals,
    handlers,
    hostRunner: new HostRunner(["node"]),
    ...(container ? { containerRunner: fakeContainer } : {}),
    clock,
  });
  return { gateway, approvals, audit };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "jarvis-gw-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "a.txt"), "x");
  db = openDatabase(":memory:");
  now = new Date("2026-11-23T12:00:00.000Z");
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("execution gateway", () => {
  it("runs allowed operations and records evidence", async () => {
    const { gateway, audit } = build();
    const result = await gateway.execute(req());
    expect(result.outcome).toBe("SUCCEEDED");
    expect(result.evidence["touched"]).toBe("src/a.txt");
    expect(audit.verify()).toBeNull();
  });

  it("blocks critical operations even if an approval exists", async () => {
    const { gateway } = build({ handlers: { GIT_FORCE_PUSH: okHandler } });
    const result = await gateway.execute(req({ type: "GIT_FORCE_PUSH", target: "origin/main" }));
    expect(result.outcome).toBe("BLOCKED");
    expect(result.decision).toBe("BLOCKED");
  });

  it("denies path traversal and absolute escapes", async () => {
    const { gateway } = build();
    expect((await gateway.execute(req({ target: "../outside.txt" }))).reason).toBe("PATH_ESCAPE");
    expect((await gateway.execute(req({ target: join(root, "..", "x.txt") }))).reason).toBe(
      "PATH_ESCAPE",
    );
    expect((await gateway.execute(req({ target: "src/\0a" }))).reason).toBe("PATH_ESCAPE");
  });

  it("denies symlink escapes", async () => {
    const outside = mkdtempSync(join(tmpdir(), "jarvis-out-"));
    try {
      symlinkSync(outside, join(root, "link"), "junction");
    } catch {
      rmSync(outside, { recursive: true, force: true });
      return; // symlinks unavailable on this platform/user
    }
    const { gateway } = build();
    expect((await gateway.execute(req({ target: "link/evil.txt" }))).reason).toBe("PATH_ESCAPE");
    rmSync(outside, { recursive: true, force: true });
  });

  it("denies replay of an executed operation id", async () => {
    const { gateway } = build();
    const r = req();
    expect((await gateway.execute(r)).outcome).toBe("SUCCEEDED");
    expect((await gateway.execute(r)).reason).toBe("OPERATION_ALREADY_EXECUTED");
  });

  it("denies requests for another project", async () => {
    const { gateway } = build();
    expect((await gateway.execute(req({ projectId: "other" }))).reason).toBe("PROJECT_MISMATCH");
  });

  it("fails success claims that carry no evidence", async () => {
    const { gateway } = build({
      handlers: { FILE_EDIT: async () => ({ ok: true, evidence: {} }) },
    });
    expect((await gateway.execute(req())).reason).toBe("SUCCESS_WITHOUT_EVIDENCE");
  });

  it("reports handler exceptions as FAILED", async () => {
    const { gateway } = build({
      handlers: {
        FILE_EDIT: async () => {
          throw new Error("boom");
        },
      },
    });
    const result = await gateway.execute(req());
    expect(result.outcome).toBe("FAILED");
    expect(result.evidence["error"]).toBe("boom");
  });

  it("never runs untrusted project code without a container", async () => {
    const without = build();
    const blocked = await without.gateway.execute(req({ type: "TEST_RUN", target: "src" }));
    expect(blocked.reason).toBe("ISOLATION_UNAVAILABLE");

    const withContainer = build({ container: true });
    const ran = await withContainer.gateway.execute(req({ type: "TEST_RUN", target: "src" }));
    expect(ran.outcome).toBe("SUCCEEDED");
    expect(ran.evidence["isolation"]).toBe("container");

    const trusted = await without.gateway.execute(
      req({ type: "TEST_RUN", target: "src", trust: "TRUSTED" }),
    );
    expect(trusted.evidence["isolation"]).toBe("host");
  });
});

describe("operation-specific approvals", () => {
  const commit = (over: Partial<OperationRequestInput> = {}) =>
    req({ type: "GIT_COMMIT", target: "feature/x", parameters: { diff: "d1" }, ...over });

  it("denies a high-risk operation without approval", async () => {
    const { gateway } = build();
    expect((await gateway.execute(commit())).reason).toBe("APPROVAL_NOT_FOUND");
  });

  it("denies when the approval is still pending", async () => {
    const { gateway } = build();
    const r = commit();
    gateway.requestApproval(r, 60_000);
    expect((await gateway.execute(r)).reason).toBe("APPROVAL_NOT_APPROVED");
  });

  it("executes once with a human approval and refuses replay of the approval", async () => {
    const { gateway, approvals } = build();
    const r = commit();
    const a = gateway.requestApproval(r, 60_000);
    approvals.approve(a.id, human);
    expect((await gateway.execute(r)).outcome).toBe("SUCCEEDED");
    // New operation id cannot reuse the consumed approval either.
    expect((await gateway.execute({ ...r, operationId: "op-new" })).reason).toBe(
      "APPROVAL_NOT_FOUND",
    );
    expect(approvals.get(a.id)?.status).toBe("CONSUMED");
  });

  it("rejects approval by an agent or system principal", () => {
    const { gateway, approvals } = build();
    const a = gateway.requestApproval(commit(), 60_000);
    expect(() => approvals.approve(a.id, agent)).toThrow(ApprovalError);
    expect(() => approvals.approve(a.id, { kind: "system", id: "cron" })).toThrow(ApprovalError);
    expect(approvals.get(a.id)?.status).toBe("PENDING");
  });

  it("invalidates the approval if parameters, target or actor change", async () => {
    for (const change of [
      { parameters: { diff: "d2" } },
      { target: "feature/y" },
      { requestedBy: { kind: "agent", id: "other" } as const },
      { workflowRunId: "run-2" },
    ]) {
      const { gateway, approvals } = build();
      const r = commit();
      approvals.approve(gateway.requestApproval(r, 60_000).id, human);
      expect((await gateway.execute({ ...r, ...change })).reason).toBe("APPROVAL_MISMATCH");
    }
  });

  it("expires approvals", async () => {
    const { gateway, approvals } = build();
    const r = commit();
    approvals.approve(gateway.requestApproval(r, 1_000).id, human);
    now = new Date(now.getTime() + 2_000);
    expect((await gateway.execute(r)).reason).toBe("APPROVAL_EXPIRED");
  });

  it("does not burn the approval when execution is refused before running", async () => {
    const { gateway, approvals } = build({ handlers: {} });
    const r = commit();
    const a = gateway.requestApproval(r, 60_000);
    approvals.approve(a.id, human);
    expect((await gateway.execute(r)).reason).toBe("NO_HANDLER");
    expect(approvals.get(a.id)?.status).toBe("APPROVED");
  });

  it("rejected approvals cannot be used", async () => {
    const { gateway, approvals } = build();
    const r = commit();
    approvals.reject(gateway.requestApproval(r, 60_000).id, human);
    expect((await gateway.execute(r)).reason).toBe("APPROVAL_REJECTED");
  });
});

describe("audit log", () => {
  it("is append-only and detects tampering", async () => {
    const { gateway, audit } = build();
    await gateway.execute(req());
    await gateway.execute(req());
    expect(audit.list().length).toBeGreaterThan(2);
    expect(() => db.exec("UPDATE audit_events SET kind='x' WHERE seq=1")).toThrow(/append-only/);
    expect(() => db.exec("DELETE FROM audit_events WHERE seq=1")).toThrow(/append-only/);

    db.exec("DROP TRIGGER audit_no_update");
    db.exec("UPDATE audit_events SET subject='forged' WHERE seq=2");
    expect(audit.verify()).toBe(2);
  });
});
