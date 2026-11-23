import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { userInfo } from "node:os";
import { parseArgs } from "node:util";
import { Jarvis } from "../app/jarvis.js";
import { BudgetPhaseSchema, type Principal } from "../domain/contracts.js";
import { exportSchemas } from "../contracts/export.js";
import { HostRunner } from "../gateway/index.js";
import { applyRetention } from "../persistence/retention.js";
import { buildChangeReport, renderChangeReport } from "../report/index.js";

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
  approvals [--watch]             operations waiting for a human decision, with full detail
  plan questions <workItem>       find every unknown that must be answered BEFORE implementing
  plan answer <workItem> <category> <text...>
  plan assume <workItem>          accept the stated convention for all low-impact questions
  plan submit <workItem> <plan.json>
  plan check <workItem>           is the plan complete? lists blockers
  plan show <workItem>
  plan approve <workItem>         approve plan + token estimate (a human decision)
  notes path|write <workItem>     learning journal: where it is, or regenerate a note
  report <runId> --base <ref> --head <ref> [--summary <text>]   evidence-backed change report (markdown)
  retention apply --days <n>      archive old operational data (audit and ledgers are never touched)
  approve <approvalId> [--yes]    review the exact operation, then approve it
  reject <approvalId>
  mission create [--work-item <id>]
  budget status <missionId> <PREPARATION|EXECUTION>
  budget grant <missionId> <PREPARATION|EXECUTION> <tokens> --reason <text>
  audit verify
  proposals                       task proposals waiting for your decision
  proposal confirm <id> [--new]   create the Work Item (or merge into the duplicate unless --new)
  proposal reject <id>
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
  const jarvis = Jarvis.open({
    root,
    human,
    ...(env["JARVIS_NOTES_DIR"] ? { notesDir: env["JARVIS_NOTES_DIR"] } : {}),
  });
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
        if (sub === "--watch") {
          const { values } = parseArgs({
            args: rest,
            options: { interval: { type: "string" }, max: { type: "string" } },
          });
          const every = Number(values.interval ?? 2000);
          const max = Number(values.max ?? Number.POSITIVE_INFINITY);
          const seen = new Set<string>();
          for (let i = 0; i < max; i += 1) {
            for (const { approval, request } of jarvis.pendingApprovals()) {
              if (approval.status !== "PENDING" || seen.has(approval.id)) continue;
              seen.add(approval.id);
              io.out(
                `NEW ${approval.id}  ${approval.type} ${approval.target}  (by ${approval.requestedBy.id})`,
              );
              if (request) io.out(`  parameters: ${JSON.stringify(request.parameters)}`);
              io.out(`  -> jarvis approve ${approval.id}`);
            }
            if (i + 1 < max) await new Promise((r) => setTimeout(r, every));
          }
          return 0;
        }
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

      case "proposals": {
        const pending = jarvis.proposals().listPending();
        if (pending.length === 0) io.out("No proposals waiting.");
        for (const p of pending) {
          io.out(
            `${p.id}  ${p.title}${p.duplicateOf ? `  (possible duplicate of ${p.duplicateOf})` : ""}`,
          );
          io.out(`  objective: ${p.objective}`);
          for (const r of p.requirements) io.out(`  - ${r}`);
        }
        return 0;
      }

      case "proposal": {
        const [id, ...flags] = rest;
        if (!id || (sub !== "confirm" && sub !== "reject"))
          return usage(io, "proposal confirm|reject <id> [--new]");
        if (sub === "reject") {
          jarvis.proposals().reject(id, human);
          io.out("Rejected.");
          return 0;
        }
        const out = jarvis.proposals().confirm(id, human, { asNew: flags.includes("--new") });
        io.out(out.merged ? `Merged into ${out.workItemId}` : `Created ${out.workItemId}`);
        return 0;
      }

      case "plan": {
        const [wi, ...more] = rest;
        const planUsage = "plan questions|answer|assume|submit|check|show|approve <workItem> ...";
        if (!wi) return usage(io, planUsage);
        const planning = jarvis.planning;
        if (sub === "questions") {
          for (const q of planning.generateQuestions(wi, human, jarvis.knowledge.load())) {
            io.out(
              `[${q.status}] (${q.impact}) ${q.category}: ${q.text}${q.status !== "OPEN" ? `\n    -> ${q.answer}` : ""}`,
            );
          }
          return 0;
        }
        if (sub === "answer") {
          const [category, ...text] = more;
          if (!category || text.length === 0)
            return usage(io, "plan answer <workItem> <category> <text...>");
          planning.answer(wi, category, text.join(" "), human);
          io.out("Recorded.");
          return 0;
        }
        if (sub === "assume") {
          io.out(
            `${planning.assumeConventions(wi, human)} low-impact question(s) settled by convention.`,
          );
          return 0;
        }
        if (sub === "submit") {
          const [file] = more;
          if (!file) return usage(io, "plan submit <workItem> <plan.json>");
          const stored = planning.submitPlan(
            wi,
            JSON.parse(readFileSync(file, "utf8")) as never,
            human,
          );
          io.out(`Plan v${stored.version} submitted. Estimate: ${stored.estimate} tokens.`);
          return 0;
        }
        if (sub === "check" || sub === "show") {
          const verdict = planning.readiness(wi);
          const current = planning.currentPlan(wi);
          if (sub === "show" && current) {
            io.out(
              JSON.stringify(
                {
                  version: current.version,
                  status: current.status,
                  estimate: current.estimate,
                  plan: current.plan,
                },
                null,
                2,
              ),
            );
          }
          io.out(verdict.ready ? "READY: nothing blocks approval." : "NOT READY:");
          for (const b of verdict.blockers) io.out(`  - ${b.code}: ${b.detail}`);
          for (const w of verdict.warnings) io.out(`  ! ${w}`);
          return verdict.ready ? 0 : 1;
        }
        if (sub === "approve") {
          const current = planning.currentPlan(wi);
          if (!current) {
            io.err("No plan submitted.");
            return 1;
          }
          io.out(`Plan v${current.version}: ${current.plan.summary}`);
          io.out(`Steps: ${current.plan.steps.length}  Estimated tokens: ${current.estimate}`);
          if (
            !more.includes("--yes") &&
            !(await io.confirm("Approve this plan and its token estimate?"))
          ) {
            io.out("Not approved.");
            return 1;
          }
          planning.approvePlan(wi, human);
          io.out(
            "Plan approved. Grant an EXECUTION budget at least as large as the estimate, then start execution.",
          );
          return 0;
        }
        return usage(io, planUsage);
      }

      case "notes": {
        if (sub === "path") {
          io.out(jarvis.notes.dir);
          return 0;
        }
        if (sub === "write" && rest[0]) {
          io.out(jarvis.refreshNotes(rest[0]) ?? "Could not write the note (see audit).");
          return 0;
        }
        return usage(io, "notes path | notes write <workItem>");
      }

      case "report": {
        const { values } = parseArgs({
          args: rest,
          options: {
            base: { type: "string" },
            head: { type: "string" },
            summary: { type: "string" },
          },
        });
        const run = sub ? jarvis.store.getRun(sub) : undefined;
        if (!run || !values.base || !values.head) {
          return usage(io, "report <runId> --base <ref> --head <ref> [--summary <text>]");
        }
        const item = jarvis.store.getWorkItem(run.workItemId)!;
        const report = await buildChangeReport({
          runner: new HostRunner(["git"], { inheritHome: true }),
          repoRoot: jarvis.root,
          db: jarvis.db,
          workItem: item,
          run,
          base: values.base,
          head: values.head,
          summary: values.summary ?? item.objective,
        });
        io.out(renderChangeReport(report));
        return 0;
      }

      case "retention": {
        const retentionUsage = "retention apply --days <n>";
        if (sub !== "apply") return usage(io, retentionUsage);
        const { values } = parseArgs({
          args: rest,
          options: { days: { type: "string" }, yes: { type: "boolean" } },
        });
        const days = Number(values.days);
        if (!Number.isFinite(days) || days < 1) return usage(io, retentionUsage);
        if (
          !values.yes &&
          !(await io.confirm(
            `Archive operational data older than ${days} day(s)? Audit and ledgers are kept.`,
          ))
        ) {
          return 1;
        }
        io.out(
          JSON.stringify(
            applyRetention(jarvis.db, jarvis.audit, {
              projectId: jarvis.project.id,
              olderThanDays: days,
            }),
            null,
            2,
          ),
        );
        return 0;
      }

      case "scan": {
        const { claims, refreshed, removed } = jarvis.scan();
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
