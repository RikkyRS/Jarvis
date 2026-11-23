import type { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkItem } from "../domain/contracts.js";
import { containsSecret, type KnowledgeStore } from "../knowledge/index.js";
import type { Planning } from "../planning/index.js";
import type { DomainStore } from "../persistence/repositories.js";

/**
 * Learning journal. After every meaningful event JARVIS regenerates a Markdown note per Work Item
 * from durable facts only (database, ledger, approved plan): what was asked, why each decision was
 * made, what ran, what the tests proved, what it cost, and a script to explain it later.
 * Regeneration is idempotent and never contains anything an agent merely claimed.
 */

type Row = Record<string, unknown>;

const slug = (s: string): string =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50) || "tarefa";

const REDACTED = "[removido: possível segredo]";

/** Notes are for humans to read and share: any line that looks like a secret is dropped. */
export function redact(text: string): string {
  return text
    .split("\n")
    .map((line) => (containsSecret(line) ? REDACTED : line))
    .join("\n");
}

const cell = (v: unknown): string =>
  String(v ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\n/g, " ");
const list = (items: readonly string[], empty = "- (nenhum registrado)"): string[] =>
  items.length ? items.map((i) => `- ${i}`) : [empty];

export class Notes {
  constructor(
    private readonly db: DatabaseSync,
    private readonly store: DomainStore,
    private readonly planning: Planning,
    private readonly knowledge: KnowledgeStore,
    readonly dir: string,
    private readonly project: { id: string; name: string },
  ) {}

  private get projectName(): string {
    return this.project.name;
  }

  fileFor(item: Pick<WorkItem, "id" | "title">): string {
    return join(this.dir, `${slug(item.title)}-${item.id.slice(3, 11)}.md`);
  }

  private write(file: string, text: string): void {
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, redact(text), "utf8");
    renameSync(tmp, file);
  }

  /** Rebuilds the note for one Work Item and refreshes the index. Returns the file path. */
  refresh(workItemId: string): string {
    const item = this.store.getWorkItem(workItemId);
    if (!item) throw new Error(`Unknown work item ${workItemId}.`);
    const file = this.fileFor(item);
    this.write(file, this.render(item));
    this.writeIndex();
    return file;
  }

  /** Project overview from source-backed claims (what the stack is, how it is built and tested). */
  writeProjectOverview(): string {
    const claims = this.knowledge.load();
    const lines = [
      `# ${this.projectName} — visão geral`,
      "",
      "> Gerado a partir de arquivos reais do projeto. Cada afirmação cita a fonte; se o arquivo mudar, rode `jarvis scan`.",
      "",
      ...(claims.length
        ? claims.map(
            (c) =>
              `- ${c.statement} _(fonte: ${c.evidence.map((e) => `\`${e.path}\``).join(", ")}; confiança ${c.confidence})_`,
          )
        : ["- Ainda não analisado. Rode `jarvis scan`."]),
    ];
    const file = join(this.dir, "PROJETO.md");
    this.write(file, lines.join("\n"));
    return file;
  }

  writeIndex(): string {
    const rows = this.store
      .listWorkItems(this.project.id)
      .filter((i) => existsSync(this.fileFor(i)))
      .map(
        (i) =>
          `| [${cell(i.title)}](${this.fileFor(i).split(/[\\/]/).pop()}) | ${i.status} | ${i.updatedAt.slice(0, 10)} |`,
      );
    const lines = [
      `# Diário de aprendizado — ${this.projectName}`,
      "",
      "Uma nota por tarefa, gerada pelo Jarvis a partir de fatos registrados (nunca de relato de agente). Leia a seção 8 de cada nota para explicar o que foi feito.",
      "",
      "- [Visão geral do projeto](PROJETO.md)",
      "",
      "| Tarefa | Status | Atualizada |",
      "| --- | --- | --- |",
      ...(rows.length ? rows : ["| (nenhuma nota ainda) | | |"]),
      "",
    ];
    const file = join(this.dir, "INDEX.md");
    this.write(file, lines.join("\n"));
    return file;
  }

  private missionsOf(workItemId: string): string[] {
    return (
      this.db.prepare("SELECT id FROM missions WHERE work_item_id = ?").all(workItemId) as Row[]
    ).map((r) => String(r["id"]));
  }

  private render(item: WorkItem): string {
    const out: string[] = [];
    const now = new Date().toISOString().slice(0, 10);
    out.push(
      `# ${item.title}`,
      "",
      `> Work Item \`${item.id}\` · status **${item.status}** · atualizado em ${now} · projeto ${this.projectName}`,
      "",
    );

    out.push(
      "## 1. O que foi pedido",
      "",
      `**Objetivo:** ${item.objective}`,
      "",
      "**Requisitos**",
      ...list(item.requirements),
      "",
      "**Critérios de aceitação**",
      ...list(item.acceptanceCriteria),
      "",
    );

    const questions = this.planning.questions(item.id);
    out.push("## 2. Decisões e por quê", "");
    if (questions.length === 0 && item.decisions.length === 0)
      out.push("- Nenhuma decisão registrada.", "");
    else {
      for (const q of questions.filter((x) => x.status !== "OPEN")) {
        out.push(
          `- **${q.category}** — _${q.text}_`,
          `  - Resposta${q.status === "ASSUMED" ? " (assumida por convenção)" : ""}: ${q.answer}`,
        );
      }
      const answeredCats = new Set(questions.map((q) => `${q.category}:`));
      for (const d of item.decisions.filter(
        (d) => ![...answeredCats].some((c) => d.toLowerCase().startsWith(c)),
      ))
        out.push(`- ${d}`);
      const open = questions.filter((q) => q.status === "OPEN");
      if (open.length)
        out.push(
          "",
          "**Ainda em aberto:**",
          ...open.map((q) => `- (${q.impact}) ${q.category}: ${q.text}`),
        );
      out.push("");
    }

    const plan = this.planning.currentPlan(item.id);
    out.push("## 3. Plano", "");
    if (!plan) out.push("- Ainda sem plano.", "");
    else {
      out.push(
        `Versão ${plan.version} · **${plan.status}**${plan.approvedBy ? ` por ${plan.approvedBy}` : ""} · estimativa **${plan.estimate.toLocaleString("pt-BR")} tokens**`,
        "",
        plan.plan.summary,
        "",
      );
      out.push(
        "| Passo | Feito? | O que | Operações | Complexidade | Como se prova |",
        "| --- | --- | --- | --- | --- | --- |",
      );
      const progress = this.planning.progress(item.id);
      for (const s of plan.plan.steps) {
        const done = progress.steps.find((p) => p.id === s.id)?.done ? "✅" : "⬜";
        out.push(
          `| ${cell(s.id)} | ${done} | ${cell(s.title)} | ${cell(s.operations.join(", "))} | ${s.complexity} | ${cell(s.verification)} |`,
        );
      }
      for (const o of progress.outOfPlan) {
        out.push(
          `| — | ⚠️ | Mudança fora do plano: ${cell(o.type)} \`${cell(o.target)}\` | | | replanejar |`,
        );
      }
      out.push(
        "",
        "**Riscos e mitigação**",
        ...(plan.plan.risks.length
          ? plan.plan.risks.map((r) => `- ${r.description} → ${r.mitigation}`)
          : ["- (nenhum registrado)"]),
      );
      out.push(
        "",
        `**Estratégia de testes:** ${plan.plan.testStrategy || "(não informada)"}`,
        "",
        `**Rollback:** ${plan.plan.rollback || "(não informado)"}`,
        "",
        "**Premissas**",
        ...list(plan.plan.assumptions),
        "",
      );
    }

    out.push("## 4. O que foi feito", "");
    const runs = this.store.listRuns(item.id);
    if (runs.length === 0) out.push("- Nenhuma execução ainda.", "");
    for (const run of runs) {
      out.push(`### Tentativa ${run.sequence} — ${run.status}`, "");
      const ops = this.db
        .prepare(
          "SELECT operation_id, type, target, outcome, evidence FROM executions WHERE workflow_run_id = ? ORDER BY rowid",
        )
        .all(run.id) as Row[];
      if (ops.length === 0) out.push("- Nenhuma operação executada.", "");
      else {
        out.push("| Operação | Alvo | Resultado | Evidência |", "| --- | --- | --- | --- |");
        for (const o of ops) {
          const ev = JSON.parse(String(o["evidence"])) as Record<string, unknown>;
          const proof = ev["commitSha"]
            ? `commit \`${String(ev["commitSha"]).slice(0, 12)}\``
            : ev["exitCode"] !== undefined
              ? `exit ${String(ev["exitCode"])}`
              : ev["sha256"]
                ? `sha256 \`${String(ev["sha256"]).slice(0, 12)}\``
                : ev["reason"]
                  ? String(ev["reason"])
                  : "—";
          out.push(
            `| ${cell(o["type"])} | \`${cell(o["target"])}\` | ${cell(o["outcome"])} | ${cell(proof)} |`,
          );
        }
        out.push("");
      }
    }

    const tests = this.db
      .prepare(
        `SELECT e.operation_id, e.outcome, e.evidence FROM executions e
         JOIN workflow_runs r ON r.id = e.workflow_run_id WHERE r.work_item_id = ? AND e.type = 'TEST_RUN' ORDER BY e.rowid`,
      )
      .all(item.id) as Row[];
    out.push("## 5. Testes executados (evidência real)", "");
    if (tests.length === 0)
      out.push(
        "- Nenhum teste foi executado pelo Jarvis para esta tarefa. **Não afirme que foi testado.**",
        "",
      );
    else {
      for (const t of tests) {
        const ev = JSON.parse(String(t["evidence"])) as {
          command?: string;
          args?: string[];
          exitCode?: number | null;
        };
        out.push(
          `- ${t["outcome"] === "SUCCEEDED" && ev.exitCode === 0 ? "✅ passou" : "❌ falhou"} — \`${[ev.command, ...(ev.args ?? [])].join(" ")}\` (exit ${ev.exitCode})`,
        );
      }
      out.push("");
    }

    out.push("## 6. Custo em tokens", "");
    const missions = this.missionsOf(item.id);
    if (missions.length === 0) out.push("- Sem Mission associada.", "");
    else {
      for (const m of missions) {
        for (const phase of ["PREPARATION", "EXECUTION"] as const) {
          const g = this.db
            .prepare(
              "SELECT COALESCE(SUM(amount),0) AS n FROM token_grants WHERE mission_id = ? AND phase = ?",
            )
            .get(m, phase) as { n: number };
          const u = this.db
            .prepare(
              "SELECT COALESCE(SUM(charged_tokens),0) AS n FROM token_usage u WHERE mission_id = ? AND phase = ? AND NOT EXISTS (SELECT 1 FROM token_usage r WHERE r.reconciles = u.id)",
            )
            .get(m, phase) as { n: number };
          if (g.n > 0 || u.n > 0)
            out.push(
              `- ${phase === "PREPARATION" ? "Preparação" : "Execução"}: autorizado ${g.n.toLocaleString("pt-BR")} · gasto ${u.n.toLocaleString("pt-BR")}`,
            );
        }
      }
      if (plan)
        out.push(
          `- Estimativa do plano: ${plan.estimate.toLocaleString("pt-BR")} (compare com o gasto de execução acima para calibrar a próxima).`,
        );
      out.push("");
    }

    out.push("## 7. Revisão e feedback", "", ...list(item.reviewFeedback), "");

    out.push("## 8. Como explicar isso (roteiro de ~1 minuto)", "");
    out.push(
      `1. **Problema:** ${item.objective}`,
      `2. **Solução:** ${plan ? plan.plan.summary : "(plano ainda não escrito)"}`,
      `3. **Decisões-chave:** ${
        questions
          .filter((q) => q.status === "ANSWERED")
          .map((q) => `${q.category} → ${q.answer}`)
          .slice(0, 4)
          .join("; ") || "(nenhuma registrada)"
      }`,
      `4. **Prova de que funciona:** ${tests.length ? `${tests.filter((t) => t["outcome"] === "SUCCEEDED").length}/${tests.length} execuções de teste passaram` : "sem testes registrados"}; critérios: ${item.acceptanceCriteria.join("; ") || "(nenhum)"}`,
      `5. **Riscos e trade-offs:** ${plan?.plan.risks.map((r) => r.description).join("; ") || "(nenhum registrado)"}`,
      "",
    );

    out.push("## 9. Perguntas que podem te fazer", "");
    const qa: string[] = [];
    for (const q of questions.filter((x) => x.status === "ANSWERED"))
      qa.push(
        `- **Por que ${q.category}: "${q.answer}"?** Porque a pergunta era _${q.text}_ e a resposta confirmada foi essa.`,
      );
    for (const r of plan?.plan.risks ?? [])
      qa.push(`- **E se "${r.description}" acontecer?** ${r.mitigation}`);
    for (const s of (plan?.plan.steps ?? []).filter((x) => x.complexity === "HIGH"))
      qa.push(
        `- **Por que "${s.title}" foi o passo mais complexo?** Ele é HIGH porque envolve ${s.operations.join(", ")}; verificado por: ${s.verification}.`,
      );
    out.push(...(qa.length ? qa : ["- (preencha depois das decisões e do plano)"]), "");
    return out.join("\n");
  }
}
