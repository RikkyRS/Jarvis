import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Jarvis } from "../app/jarvis.js";
import { BudgetPhaseSchema, OperationTypeSchema, type Principal } from "../domain/contracts.js";

/**
 * MCP adapter for AI clients (Claude Code, Cursor, VS Code...). It is deliberately narrow:
 * clients can read state and REQUEST operations. There is no tool to approve, reject, grant
 * tokens, confirm proposals or change policy: those stay on the human CLI channel.
 */
export const MCP_TOOL_NAMES = [
  "jarvis_status",
  "jarvis_list_work_items",
  "jarvis_get_work_item",
  "jarvis_request_operation",
  "jarvis_resume_operation",
  "jarvis_pending_approvals",
  "jarvis_budget_status",
  "jarvis_project_knowledge",
] as const;

const text = (value: unknown, isError = false) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  ...(isError ? { isError: true } : {}),
});

export function createMcpServer(jarvis: Jarvis, clientId = "client"): McpServer {
  const principal: Principal = { kind: "agent", id: `mcp:${clientId}`.slice(0, 120) };
  const server = new McpServer({ name: "jarvis", version: "1.0.0-alpha.0" });

  server.registerTool(
    "jarvis_status",
    { description: "Project status: work items, pending approvals, audit chain integrity." },
    async () => text(jarvis.status()),
  );

  server.registerTool(
    "jarvis_list_work_items",
    { description: "List the project's Work Items." },
    async () =>
      text(
        jarvis.store
          .listWorkItems(jarvis.project.id)
          .map((i) => ({ id: i.id, title: i.title, status: i.status })),
      ),
  );

  server.registerTool(
    "jarvis_get_work_item",
    {
      description:
        "Requirements, acceptance criteria, decisions and review feedback of a Work Item.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const item = jarvis.store.getWorkItem(id);
      return item && item.projectId === jarvis.project.id
        ? text({ ...item, runs: jarvis.store.listRuns(id) })
        : text({ error: "NOT_FOUND" }, true);
    },
  );

  server.registerTool(
    "jarvis_request_operation",
    {
      description:
        "Request an operation through the Execution Gateway. Low-risk operations run immediately. High-risk ones return APPROVAL_REQUIRED: a human must approve in the JARVIS CLI, then call jarvis_resume_operation. Critical operations are blocked.",
      inputSchema: {
        operationId: z
          .string()
          .min(1)
          .max(128)
          .describe("Unique id you choose for this operation."),
        workItemId: z.string(),
        workflowRunId: z.string(),
        type: OperationTypeSchema,
        target: z.string().min(1).max(4096),
        parameters: z.record(z.unknown()).optional(),
      },
    },
    async (args) => {
      try {
        const out = await jarvis.request(principal, {
          ...args,
          parameters: (args.parameters ?? {}) as Record<string, never>,
        });
        return text(out);
      } catch (error) {
        return text({ error: error instanceof Error ? error.message : String(error) }, true);
      }
    },
  );

  server.registerTool(
    "jarvis_resume_operation",
    {
      description: "Execute an operation a human has approved. Runs exactly the approved request.",
      inputSchema: { operationId: z.string() },
    },
    async ({ operationId }) => {
      const approval = jarvis.approvals.findByOperation(operationId);
      if (!approval || approval.requestedBy.id !== principal.id)
        return text({ error: "NOT_FOUND" }, true);
      try {
        return text(await jarvis.resume(operationId));
      } catch (error) {
        return text({ error: error instanceof Error ? error.message : String(error) }, true);
      }
    },
  );

  server.registerTool(
    "jarvis_pending_approvals",
    { description: "Approvals waiting for a human decision (read-only)." },
    async () =>
      text(
        jarvis.approvals.listPending(jarvis.project.id).map((a) => ({
          id: a.id,
          operationId: a.operationId,
          type: a.type,
          target: a.target,
          status: a.status,
          expiresAt: a.expiresAt,
        })),
      ),
  );

  server.registerTool(
    "jarvis_budget_status",
    {
      description: "Token allowance, usage and level for a Mission phase.",
      inputSchema: { missionId: z.string(), phase: BudgetPhaseSchema },
    },
    async ({ missionId, phase }) => {
      try {
        return text(jarvis.budget.status(missionId, phase));
      } catch (error) {
        return text({ error: error instanceof Error ? error.message : String(error) }, true);
      }
    },
  );

  server.registerTool(
    "jarvis_project_knowledge",
    {
      description:
        "Source-backed project claims relevant to a query, each revalidated against current files.",
      inputSchema: { query: z.string().min(1).max(200) },
    },
    async ({ query }) =>
      text(
        jarvis.knowledge.retrieve(query).map(({ claim, validity }) => ({
          statement: claim.statement,
          confidence: claim.confidence,
          evidence: claim.evidence.map((e) => e.path),
          validity,
        })),
      ),
  );

  return server;
}
