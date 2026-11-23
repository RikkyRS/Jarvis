import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { userInfo } from "node:os";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import type { ProviderAdapter } from "../ai/index.js";
import { ClaudeCodeProvider, OllamaProvider } from "../ai/providers.js";
import { Jarvis } from "../app/jarvis.js";
import { privacyReport } from "../app/privacy.js";
import { BudgetPhaseSchema, type Principal } from "../domain/contracts.js";
import { exportSchemas } from "../contracts/export.js";
import { CONTRACT_KINDS, readContractFile, type ContractKind } from "../contract/index.js";
import type { Triage } from "../contract/triage.js";
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
  work show <workItem>            requirements, decisions, runs
  work status <workItem> <IN_PROGRESS|DELIVERED|REOPENED|CLOSED>
  run create <workItem>           new attempt (PLANNED -> PREPARING)
  run ready <runId>               preparation finished, waiting for your go (-> AWAITING_EXECUTION_APPROVAL)
  run start <runId> <missionId>   YOU start execution: needs approved plan + enough Execution Budget
  run submit <runId>              all plan steps proven -> AWAITING_REVIEW
  run complete <runId>            after your review (a human decision)
  run pause|cancel <runId>
  run list <workItem>
  approvals [--watch]             operations waiting for a human decision, with full detail
  plan questions <workItem>       find every unknown that must be answered BEFORE implementing
  plan answer <workItem> <category> <text...>
  plan assume <workItem>          accept the stated convention for all low-impact questions
  plan submit <workItem> <plan.json>
  plan check <workItem>           is the plan complete? lists blockers
  plan show <workItem>
  plan progress <workItem>        which steps are done and any change outside the plan
  plan done <workItem> <step> <operationId...>   mark a step, proven by successful operations
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
  inbox add <sender> <text...> [--conversation <id>]   put a forwarded client message in the inbox
  inbox process --mission <id> [--phase PREPARATION|EXECUTION]   classify new messages into proposals and check them against the contract
  privacy                         where client data can go, and what to fix (changes nothing)
  digest                          what is waiting for you (messages, proposals with their scope verdict, approvals)
  proposals                       task proposals waiting for your decision
  proposal reply <id> --mission <id>   draft a reply to the client for you to send (never sent by JARVIS)
  proposal confirm <id> [--new]   create the Work Item (or merge into the duplicate unless --new)
  proposal reject <id>
  contract add <CONTRACT|SCOPE|HISTORY> <file.md|.txt|.pdf> [--title <t>]   this project's contract (a new version replaces the one consulted)
  contract list [--all]           documents in force (--all includes superseded versions)
  contract find <query>           the few clauses that match, with document, version and clause
  scan                            analyze the project stack into source-backed knowledge
  know <query>                    retrieve relevant, revalidated claims
  schemas                         print the exported JSON Schema contracts
  mcp [--client <name>]           serve the MCP adapter for AI clients on stdio
`;

function scopeLine(t: Triage | null): string {
  if (!t) return "  scope: not checked (no contract or no model)";
  if (t.verdict === "UNCLEAR")
    return `  scope: UNCLEAR${t.reason ? ` (${t.reason})` : ""}. You decide.`;
  const cited = t.citations.map((c) => `${c.kind} v${c.version} ${c.ref}`).join("; ");
  return `  scope: ${t.verdict} (${cited})`;
}

export function humanPrincipal(env: NodeJS.ProcessEnv = process.env): Principal {
  const id = env["JARVIS_USER"] ?? userInfo().username;
  return { kind: "human", id };
}

/**
 * Model backends for the human CLI. Local by default: a client's messages stay on this machine
 * unless you explicitly allow Claude Code (JARVIS_ALLOW_CLAUDE=1).
 */
export function providersFromEnv(env: NodeJS.ProcessEnv, root: string): ProviderAdapter[] {
  const out: ProviderAdapter[] = [];
  const model = env["JARVIS_OLLAMA_MODEL"];
  if (model)
    out.push(
      new OllamaProvider({
        models: [{ id: model, tier: 1 }],
        ...(env["JARVIS_OLLAMA_URL"] ? { baseUrl: env["JARVIS_OLLAMA_URL"] } : {}),
      }),
    );
  if (env["JARVIS_ALLOW_CLAUDE"] === "1")
    out.push(
      new ClaudeCodeProvider(new HostRunner(["claude"], { inheritHome: true }), {
        cwd: root,
        ...(env["JARVIS_CLAUDE_BIN"] ? { binary: env["JARVIS_CLAUDE_BIN"] } : {}),
      }),
    );
  return out;
}

const NO_MODEL =
  "No model configured. For client messages use a local one: set JARVIS_OLLAMA_MODEL (for example qwen2.5:7b). Claude Code only with JARVIS_ALLOW_CLAUDE=1.";

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
    providers: providersFromEnv(env, root),
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
        if (sub === "show" && rest[0]) {
          const item = jarvis.store.getWorkItem(rest[0]);
          if (!item) {
            io.err("Unknown work item.");
            return 1;
          }
          io.out(
            JSON.stringify(
              {
                ...item,
                runs: jarvis.store
                  .listRuns(item.id)
                  .map((r) => ({ id: r.id, sequence: r.sequence, status: r.status })),
              },
              null,
              2,
            ),
          );
          return 0;
        }
        if (sub === "status") {
          const [id, to] = rest;
          if (!id || !to)
            return usage(io, "work status <workItem> <IN_PROGRESS|DELIVERED|REOPENED|CLOSED>");
          io.out(jarvis.store.transitionWorkItem(id, to as never, human).status);
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

      case "run": {
        const runUsage = "run create|ready|start|submit|complete|pause|cancel|list ...";
        const [id, missionId] = rest;
        if (!sub || !id) return usage(io, runUsage);
        const store = jarvis.store;
        if (sub === "list") {
          for (const r of store.listRuns(id)) io.out(`${r.id}  #${r.sequence}  ${r.status}`);
          return 0;
        }
        if (sub === "create") {
          const created = store.createRun(id, human);
          store.transitionRun(created.id, "PREPARING", human);
          io.out(created.id);
          return 0;
        }
        if (sub === "ready") {
          io.out(store.transitionRun(id, "AWAITING_EXECUTION_APPROVAL", human).status);
          return 0;
        }
        if (sub === "start") {
          if (!missionId) return usage(io, "run start <runId> <missionId>");
          io.out(jarvis.runtime.startExecution(id, missionId, human).status);
          return 0;
        }
        if (sub === "submit") {
          io.out(jarvis.runtime.submitForReview(id, human).status);
          return 0;
        }
        if (sub === "complete") {
          io.out(jarvis.runtime.complete(id, human).status);
          return 0;
        }
        if (sub === "pause") {
          io.out(jarvis.runtime.pause(id, human, "paused by human").status);
          return 0;
        }
        if (sub === "cancel") {
          io.out(store.transitionRun(id, "CANCELLED", human).status);
          return 0;
        }
        return usage(io, runUsage);
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
          io.out(scopeLine(p.triage));
        }
        return 0;
      }

      case "inbox": {
        if (sub === "add") {
          const { values, positionals } = parseArgs({
            args: rest,
            allowPositionals: true,
            options: { conversation: { type: "string" } },
          });
          const [sender, ...words] = positionals;
          const text = words.join(" ");
          if (!sender || !text)
            return usage(io, "inbox add <sender> <text...> [--conversation <id>]");
          const r = jarvis
            .intake({ missionId: "", phase: "PREPARATION", allowedSenders: new Set([sender]) })
            .ingest({
              channel: "manual",
              externalId: randomUUID(),
              sender,
              conversationId: values.conversation ?? sender,
              receivedAt: new Date().toISOString(),
              text,
            });
          io.out(`Message ${r.id}: ${r.status}`);
          return 0;
        }
        if (sub === "process") {
          const { values } = parseArgs({
            args: rest,
            options: { mission: { type: "string" }, phase: { type: "string" } },
          });
          const phase = BudgetPhaseSchema.safeParse(values.phase ?? "PREPARATION");
          if (!values.mission || !phase.success)
            return usage(io, "inbox process --mission <id> [--phase PREPARATION|EXECUTION]");
          if (providersFromEnv(env, root).length === 0) {
            io.err(NO_MODEL);
            return 1;
          }
          const { proposals, failed } = await jarvis
            .intake({ missionId: values.mission, phase: phase.data, allowedSenders: new Set() })
            .classifyPending();
          io.out(`${proposals.length} proposal(s), ${failed} message(s) could not be classified.`);
          for (const p of proposals) {
            io.out(`${p.id}  ${p.title}`);
            io.out(scopeLine(p.triage));
          }
          return 0;
        }
        return usage(io, "inbox add|process ...");
      }

      case "privacy": {
        const findings = privacyReport(jarvis, env);
        for (const f of findings) io.out(`[${f.level}] ${f.message}`);
        return findings.some((f) => f.level === "WARN") ? 1 : 0;
      }

      case "digest": {
        const intake = jarvis.intake({
          missionId: "",
          phase: "PREPARATION",
          allowedSenders: new Set(),
        });
        const counts = intake.inboxCounts();
        const status = jarvis.status() as { pendingApprovals?: number };
        io.out("Waiting for you:");
        io.out(`  ${counts.newMessages} new message(s) not yet processed`);
        io.out(`  ${counts.pendingProposals} proposal(s) to decide`);
        for (const p of intake.listPending()) {
          io.out(`    - ${p.title}`);
          io.out(`  ${scopeLine(p.triage)}`);
        }
        io.out(`  ${status.pendingApprovals ?? 0} operation(s) awaiting approval`);
        io.out("Nothing runs until you approve. JARVIS never sends messages.");
        return 0;
      }

      case "proposal": {
        if (sub === "reply") {
          const [replyId, ...replyFlags] = rest;
          const { values } = parseArgs({
            args: replyFlags,
            options: { mission: { type: "string" } },
          });
          if (!replyId || !values.mission) return usage(io, "proposal reply <id> --mission <id>");
          if (providersFromEnv(env, root).length === 0) {
            io.err(NO_MODEL);
            return 1;
          }
          const draft = await jarvis
            .intake({ missionId: values.mission, phase: "PREPARATION", allowedSenders: new Set() })
            .draftReply(replyId);
          io.out(draft);
          io.out("(draft for you to review and send; JARVIS does not send messages)");
          return 0;
        }
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
        if (sub === "progress") {
          const p = jarvis.planning.progress(wi);
          for (const s of p.steps)
            io.out(
              `[${s.done ? "x" : " "}] ${s.id} ${s.title}${s.evidence.length ? `  (${s.evidence.join(", ")})` : ""}`,
            );
          for (const o of p.outOfPlan)
            io.out(`  ! outside plan: ${o.type} ${o.target} (${o.operationId})`);
          io.out(p.complete ? "Plan complete." : "Plan not complete.");
          return p.complete ? 0 : 1;
        }
        if (sub === "done") {
          const [step, ...ops] = more;
          if (!step || ops.length === 0)
            return usage(io, "plan done <workItem> <step> <operationId...>");
          planning.markStep(wi, step, ops, human);
          io.out("Step marked done.");
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

      case "contract": {
        if (sub === "add") {
          const [kindArg, file, ...flags] = rest;
          const kind = String(kindArg ?? "").toUpperCase() as ContractKind;
          const { values } = parseArgs({ args: flags, options: { title: { type: "string" } } });
          if (!CONTRACT_KINDS.includes(kind) || !file)
            return usage(
              io,
              "contract add <CONTRACT|SCOPE|HISTORY> <file.md|.txt|.pdf> [--title <t>]",
            );
          const { text, sourceName } = readContractFile(file);
          const { doc, created } = jarvis.contract.add({
            kind,
            text,
            sourceName,
            ...(values.title ? { title: values.title } : {}),
            actor: jarvis.human,
          });
          io.out(
            created
              ? `${doc.kind} v${doc.version} added (${doc.chunks} clauses). It is now the version consulted.`
              : `${doc.kind} v${doc.version} is already the current text; nothing changed.`,
          );
          return 0;
        }
        if (sub === "list") {
          const all = rest.includes("--all");
          for (const d of jarvis.contract.list({ includeSuperseded: all }))
            io.out(
              `${d.kind.padEnd(8)} v${d.version}  ${d.status.padEnd(10)} ${d.title}  (${d.chunks} clauses, ${d.addedAt.slice(0, 10)})`,
            );
          return 0;
        }
        if (sub === "find") {
          const query = rest.join(" ");
          if (!query) return usage(io, "contract find <query>");
          for (const h of jarvis.contract.retrieve(query))
            io.out(`[${h.kind} v${h.version}] ${h.ref}
${h.text.slice(0, 400)}
`);
          return 0;
        }
        return usage(io, "contract add|list|find ...");
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
