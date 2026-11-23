import { createInterface } from "node:readline/promises";
import { userInfo } from "node:os";
import { parseArgs } from "node:util";
import { Jarvis } from "../app/jarvis.js";
import { BudgetPhaseSchema, type Principal } from "../domain/contracts.js";
import { exportSchemas } from "../contracts/export.js";

/**
 * Human CLI. This is the only channel that can approve operations, grant tokens or confirm
 * proposals, because it acts as a human principal in an interactive terminal.
 */
export type Io = {
  out(line: string): void;
  err(line: string): void;
  confirm(question: string): Promise<boolean>;
};

export const defaultIo: Io = {
  out: (l) => console.log(l),
  err: (l) => console.error(l),
  confirm: async (question) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
    } finally {
      rl.close();
    }
  },
};

export const HELP = `jarvis — deterministic engineering runtime

  status                          project, work items, approvals, audit integrity
  work create <title> --objective <text> [--accept <criterion>]...
  work list
  approvals                       operations waiting for a human decision, with full detail
  approve <approvalId> [--yes]    review the exact operation, then approve it
  reject <approvalId>
  mission create [--work-item <id>]
  budget status <missionId> <PREPARATION|EXECUTION>
  budget grant <missionId> <PREPARATION|EXECUTION> <tokens> --reason <text>
  audit verify
  scan                            analyze the project stack into source-backed knowledge
  know <query>                    retrieve relevant, revalidated claims
  schemas                         print the exported JSON Schema contracts
  mcp [--client <name>]           serve the MCP adapter for AI clients on stdio
`;

export function humanPrincipal(env: NodeJS.ProcessEnv = process.env): Principal {
  const id = env["JARVIS_USER"] ?? userInfo().username;
  return { kind: "human", id };
}

export async function run(
  argv: string[],
  io: Io = defaultIo,
  root = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const [command, sub, ...rest] = argv;
  if (!command || command === "help" || command === "--help") {
    io.out(HELP);
    return 0;
  }
  if (command === "schemas") {
    io.out(JSON.stringify(exportSchemas(), null, 2));
    return 0;
  }

  const human = humanPrincipal(env);
  const jarvis = Jarvis.open({ root, human });
  try {
    switch (command) {
      case "status":
        io.out(JSON.stringify(jarvis.status(), null, 2));
        return 0;

      case "work": {
        if (sub === "list") {
          for (const i of jarvis.store.listWorkItems(jarvis.project.id))
            io.out(`${i.id}  ${i.status.padEnd(11)} ${i.title}`);
          return 0;
        }
        if (sub === "create") {
          const { values, positionals } = parseArgs({
            args: rest,
            allowPositionals: true,
            options: { objective: { type: "string" }, accept: { type: "string", multiple: true } },
          });
          const title = positionals.join(" ").trim();
          if (!title || !values.objective) {
            io.err("usage: work create <title> --objective <text> [--accept <criterion>]...");
            return 2;
          }
          const item = jarvis.store.createWorkItem({
            projectId: jarvis.project.id,
            actor: human,
            title,
            objective: values.objective,
            acceptanceCriteria: values.accept ?? [],
          });
          io.out(item.id);
          return 0;
        }
        break;
      }

      case "approvals": {
        const pending = jarvis.pendingApprovals();
        if (pending.length === 0) io.out("No approvals waiting.");
        for (const { approval, request } of pending) {
          io.out(`${approval.id}  ${approval.status}  expires ${approval.expiresAt}`);
          io.out(
            `  ${approval.type} ${approval.target}  (requested by ${approval.requestedBy.kind}:${approval.requestedBy.id})`,
          );
          if (request) io.out(`  parameters: ${JSON.stringify(request.parameters)}`);
        }
        return 0;
      }

      case "approve": {
        if (!sub) return usage(io, "approve <approvalId> [--yes]");
        const request = jarvis.approvals.requestOf(sub);
        const approval = jarvis.approvals.get(sub);
        if (!approval || !request) {
          io.err("Unknown approval.");
          return 1;
        }
        io.out(`Operation : ${request.type}`);
        io.out(`Target    : ${approval.target}`);
        io.out(`Requested : ${approval.requestedBy.kind}:${approval.requestedBy.id}`);
        io.out(`Parameters: ${JSON.stringify(request.parameters, null, 2)}`);
        io.out(`Expires   : ${approval.expiresAt}`);
        const yes = rest.includes("--yes") || sub === "--yes";
        if (!yes && !(await io.confirm("Approve exactly this operation?"))) {
          io.out("Not approved.");
          return 1;
        }
        jarvis.approve(sub);
        io.out("Approved. The requesting client can now resume the operation.");
        return 0;
      }

      case "reject":
        if (!sub) return usage(io, "reject <approvalId>");
        jarvis.reject(sub);
        io.out("Rejected.");
        return 0;

      case "mission": {
        if (sub !== "create") break;
        const { values } = parseArgs({ args: rest, options: { "work-item": { type: "string" } } });
        io.out(
          jarvis.budget.createMission({
            projectId: jarvis.project.id,
            owner: human,
            ...(values["work-item"] ? { workItemId: values["work-item"] } : {}),
          }),
        );
        return 0;
      }

      case "budget": {
        if (sub === "status") {
          const [m, p] = rest;
          const phase = BudgetPhaseSchema.safeParse(p);
          if (!m || !phase.success)
            return usage(io, "budget status <missionId> <PREPARATION|EXECUTION>");
          io.out(JSON.stringify(jarvis.budget.status(m, phase.data), null, 2));
          return 0;
        }
        if (sub === "grant") {
          const [m, p, amount, ...flags] = rest;
          const phase = BudgetPhaseSchema.safeParse(p);
          const { values } = parseArgs({ args: flags, options: { reason: { type: "string" } } });
          if (!m || !phase.success || !amount || !values.reason)
            return usage(
              io,
              "budget grant <missionId> <PREPARATION|EXECUTION> <tokens> --reason <text>",
            );
          io.out(
            jarvis.budget.grant({
              missionId: m,
              phase: phase.data,
              amount: Number(amount),
              actor: human,
              reason: values.reason,
            }),
          );
          return 0;
        }
        break;
      }

      case "audit":
        if (sub !== "verify") break;
        {
          const broken = jarvis.audit.verify();
          io.out(
            broken === null ? "Audit chain verified." : `Audit chain BROKEN at event ${broken}.`,
          );
          return broken === null ? 0 : 1;
        }

      case "scan": {
        const { claims, refreshed, removed } = jarvis.knowledge.scan();
        io.out(
          `${claims.length} claims. Re-analyzed: ${refreshed.join(", ") || "nothing"}. Dropped: ${removed.join(", ") || "nothing"}.`,
        );
        return 0;
      }

      case "know": {
        const query = [sub, ...rest].filter(Boolean).join(" ");
        if (!query) return usage(io, "know <query>");
        for (const { claim, validity } of jarvis.knowledge.retrieve(query))
          io.out(
            `[${validity}] ${claim.statement}  (${claim.evidence.map((e) => e.path).join(", ")})`,
          );
        return 0;
      }

      case "mcp": {
        const { values } = parseArgs({
          args: [sub, ...rest].filter((x): x is string => Boolean(x)),
          options: { client: { type: "string" } },
          strict: false,
        });
        const [{ StdioServerTransport }, { createMcpServer }] = await Promise.all([
          import("@modelcontextprotocol/sdk/server/stdio.js"),
          import("../mcp/server.js"),
        ]);
        await createMcpServer(
          jarvis,
          typeof values.client === "string" ? values.client : "client",
        ).connect(new StdioServerTransport());
        return new Promise<number>(() => undefined); // serve until the client disconnects
      }
    }
    io.err(`Unknown command: ${command}${sub ? ` ${sub}` : ""}\n`);
    io.err(HELP);
    return 2;
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    if (command !== "mcp") jarvis.close();
  }
}

function usage(io: Io, text: string): number {
  io.err(`usage: ${text}`);
  return 2;
}
