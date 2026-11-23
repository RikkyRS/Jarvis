import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Jarvis } from "../../src/app/jarvis.js";
import { run, type Io } from "../../src/cli/index.js";
import { exportSchemas, UnsupportedSchemaError } from "../../src/contracts/export.js";
import { MCP_TOOL_NAMES, createMcpServer } from "../../src/mcp/server.js";
import { cleanup, human, makeRepo, nextId, openJarvis, writeConfig } from "../helpers.js";

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

async function connect(clientId = "claude") {
  const server = createMcpServer(jarvis, clientId);
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
  const res = (await client.callTool({ name, arguments: args })) as {
    content: { text: string }[];
    isError?: boolean;
  };
  return {
    data: JSON.parse(res.content[0]!.text) as Record<string, unknown>,
    isError: Boolean(res.isError),
  };
};

function memoryIo(answer = true): Io & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    out: (l) => void lines.push(l),
    err: (l) => void lines.push(`ERR ${l}`),
    confirm: async () => answer,
  };
}

describe("MCP adapter", () => {
  it("[R-MCP-01] exposes request/read tools only: no approve, grant, confirm or policy tool", async () => {
    const client = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([...MCP_TOOL_NAMES].sort());
    expect(names.join(" ")).not.toMatch(/approve|reject|grant|confirm|policy|trust/);
  });

  it("[R-MCP-02] an agent request needing approval stays pending until a human approves on the CLI", async () => {
    const item = jarvis.store.createWorkItem({
      projectId: jarvis.project.id,
      actor: human,
      title: "t",
      objective: "o",
    });
    const runRow = jarvis.store.createRun(item.id, human);
    const client = await connect("claude");
    const id = nextId();
    const req = {
      operationId: id,
      workItemId: item.id,
      workflowRunId: runRow.id,
      type: "GIT_PUSH",
      target: "origin/main",
      parameters: {
        remote: "origin",
        branch: "main",
        expectedHead: "a".repeat(40),
        remoteUrl: "none",
      },
    };
    const first = await call(client, "jarvis_request_operation", req);
    expect(first.data["status"]).toBe("APPROVAL_REQUIRED");

    // Resuming without approval does not execute anything.
    const early = await call(client, "jarvis_resume_operation", { operationId: id });
    expect(early.data["outcome"]).toBe("DENIED");
    expect(early.data["reason"]).toBe("APPROVAL_NOT_APPROVED");

    // Another client cannot resume this client's operation.
    const other = await connect("someone-else");
    expect((await call(other, "jarvis_resume_operation", { operationId: id })).isError).toBe(true);

    const io = memoryIo(true);
    expect(
      await run(["approve", first.data["approvalId"] as string], io, root, {
        JARVIS_USER: "rikky",
      }),
    ).toBe(0);
    expect(io.lines.join("\n")).toContain("GIT_PUSH");
    const resumed = await call(client, "jarvis_resume_operation", { operationId: id });
    expect(resumed.data["reason"]).toBe("REMOTE_MISMATCH"); // it really ran the approved request, which failed verification
  });

  it("returns errors as data and validates input", async () => {
    const client = await connect();
    expect((await call(client, "jarvis_get_work_item", { id: "nope" })).isError).toBe(true);
    await expect(
      client.callTool({
        name: "jarvis_request_operation",
        arguments: { operationId: "x", type: "NOT_A_TYPE" },
      }),
    ).resolves.toMatchObject({ isError: true });
    const status = await call(client, "jarvis_status");
    expect(status.data["auditChain"]).toBe("VERIFIED");
  });

  it("serves knowledge with validity", async () => {
    jarvis.knowledge.scan();
    const client = await connect();
    const res = await call(client, "jarvis_project_knowledge", { query: "gitignore package" });
    expect(Array.isArray(res.data)).toBe(true);
  });
});

describe("CLI (human channel)", () => {
  it("creates work, shows pending approvals with full detail and honours a declined prompt", async () => {
    const io = memoryIo(false);
    expect(
      await run(
        [
          "work",
          "create",
          "Fix",
          "totals",
          "--objective",
          "Totals are wrong",
          "--accept",
          "matches source",
        ],
        io,
        root,
        { JARVIS_USER: "rikky" },
      ),
    ).toBe(0);
    const itemId = io.lines[0]!;
    const runRow = jarvis.store.createRun(itemId, human);
    const out = await jarvis.request(
      { kind: "agent", id: "claude" },
      {
        operationId: nextId(),
        workItemId: itemId,
        workflowRunId: runRow.id,
        type: "GIT_COMMIT",
        target: "main",
        parameters: { message: "m", diffHash: "b".repeat(64) },
      },
    );
    if (out.status !== "APPROVAL_REQUIRED") throw new Error("expected gate");

    const list = memoryIo();
    await run(["approvals"], list, root, { JARVIS_USER: "rikky" });
    expect(list.lines.join("\n")).toContain("diffHash");

    const declined = memoryIo(false);
    expect(await run(["approve", out.approvalId], declined, root, { JARVIS_USER: "rikky" })).toBe(
      1,
    );
    expect(jarvis.approvals.get(out.approvalId)?.status).toBe("PENDING");
    expect(await run(["reject", out.approvalId], memoryIo(), root, { JARVIS_USER: "rikky" })).toBe(
      0,
    );
    expect(jarvis.approvals.get(out.approvalId)?.status).toBe("REJECTED");
  });

  it("manages budget, audit and unknown commands", async () => {
    const io = memoryIo();
    const env = { JARVIS_USER: "rikky" };
    await run(["mission", "create"], io, root, env);
    const missionId = io.lines[0]!;
    expect(
      await run(
        ["budget", "grant", missionId, "EXECUTION", "1000", "--reason", "go"],
        memoryIo(),
        root,
        env,
      ),
    ).toBe(0);
    const st = memoryIo();
    await run(["budget", "status", missionId, "EXECUTION"], st, root, env);
    expect(JSON.parse(st.lines.join("\n"))).toMatchObject({ allowance: 1000, level: "NORMAL" });
    const audit = memoryIo();
    expect(await run(["audit", "verify"], audit, root, env)).toBe(0);
    expect(await run(["bogus"], memoryIo(), root, env)).toBe(2);
    expect(
      await run(
        ["budget", "grant", missionId, "EXECUTION", "-5", "--reason", "x"],
        memoryIo(),
        root,
        env,
      ),
    ).toBe(1);
  });
});

describe("contract export", () => {
  it("[R-CONTRACT-01] exports JSON Schema from Zod and matches the committed, versioned snapshot", () => {
    const current = exportSchemas();
    const committed = JSON.parse(readFileSync("schemas/contracts.json", "utf8")) as unknown;
    expect(current).toEqual(committed);
    expect(current.version).toBe("1.0.0");
    expect(Object.keys(current.contracts)).toEqual(
      expect.arrayContaining(["OperationRequest", "Approval", "IntegrationReport"]),
    );
    const op = current.contracts["OperationRequest"] as {
      additionalProperties: boolean;
      required: string[];
    };
    expect(op.additionalProperties).toBe(false);
    expect(op.required).toEqual(expect.arrayContaining(["operationId", "type", "target"]));
  });

  it("detects unsupported constructs instead of publishing a partial contract", () => {
    expect(UnsupportedSchemaError.name).toBe("UnsupportedSchemaError");
  });
});
