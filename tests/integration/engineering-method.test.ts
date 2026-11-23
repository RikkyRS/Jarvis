import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AiRuntime, type ProviderAdapter, type ProviderRequest } from "../../src/ai/index.js";
import { MissionBudget } from "../../src/budget/index.js";
import { commitMessage, prDescription, scopeOf } from "../../src/cycle/artifacts.js";
import { checkDocumentDrift } from "../../src/knowledge/drift.js";
import { PlanSchema, checkPlan, type Plan, type StoredQuestion } from "../../src/planning/index.js";
import { blindReview, deterministicFindings, verdictOf } from "../../src/review/blind.js";
import { AuditLog } from "../../src/persistence/audit.js";
import { openDatabase } from "../../src/persistence/db.js";
import { DomainStore } from "../../src/persistence/repositories.js";
import { Scheduler } from "../../src/runtime/scheduler.js";
import { cleanup } from "../helpers.js";

const owner = { kind: "human", id: "owner" } as const;

const criteria = ["Dois clientes não ocupam o mesmo horário", "Cliente recebe aviso"];
const item = {
  objective: "Agendamentos não podem duplicar",
  requirements: ["Bloquear conflito"],
  acceptanceCriteria: criteria,
} as unknown as Parameters<typeof checkPlan>[1];

const base = {
  summary: "Bloquear agendamento no mesmo horário",
  steps: [
    {
      id: "s1",
      title: "Validar conflito ao criar",
      operations: ["FILE_EDIT"],
      paths: ["src/agenda/criar.ts"],
      complexity: "LOW",
      verification: "teste de conflito passa",
    },
    {
      id: "s2",
      title: "Avisar o cliente",
      operations: ["FILE_EDIT"],
      paths: ["src/agenda/aviso.ts"],
      complexity: "LOW",
      verification: "aviso exibido",
    },
  ],
  testStrategy: "Teste de conflito e teste do aviso",
  assumptions: ["horário único por barbeiro"],
};
const parse = (extra: Record<string, unknown> = {}): Plan =>
  PlanSchema.parse({ ...base, ...extra });
const noQuestions: StoredQuestion[] = [];
const codes = (p: Plan) => checkPlan(p, item, noQuestions).blockers.map((b) => b.code);

describe("plan: certainties, doubts, impact matrix and diagnosis", () => {
  it("[R-METHOD-01] a bug-fix plan cannot be approved without showing the cause", () => {
    expect(codes(parse({ kind: "BUGFIX" }))).toContain("NO_DIAGNOSIS");
    const ok = parse({
      kind: "BUGFIX",
      diagnosis: {
        cause: "criarAgendamento não verifica conflito de horário",
        location: "src/agenda/criar.ts:42",
        evidence: "reproduzido com dois POST seguidos",
      },
    });
    expect(codes(ok)).not.toContain("NO_DIAGNOSIS");
    // A feature does not need one.
    expect(codes(parse({ kind: "FEATURE" }))).not.toContain("NO_DIAGNOSIS");
  });

  it("[R-METHOD-02] an open doubt blocks the plan; resolving it unblocks", () => {
    const open = parse({
      doubts: [{ id: "horario-unico", text: "O horário é por barbeiro ou por unidade?" }],
    });
    expect(codes(open)).toContain("OPEN_DOUBTS");
    const resolved = parse({
      doubts: [
        {
          id: "horario-unico",
          text: "Por barbeiro ou unidade?",
          resolution: "Por barbeiro, confirmado pelo cliente",
        },
      ],
    });
    expect(codes(resolved)).not.toContain("OPEN_DOUBTS");
  });

  it("[R-METHOD-02] a certainty needs evidence, otherwise it is not a certainty", () => {
    expect(() =>
      PlanSchema.parse({ ...base, certainties: [{ statement: "O contrato inclui relatórios" }] }),
    ).toThrow();
    expect(() =>
      PlanSchema.parse({
        ...base,
        certainties: [
          { statement: "Cláusula 3 exclui relatórios", evidence: "contrato v1, cláusula 3" },
        ],
      }),
    ).not.toThrow();
  });

  it("[R-METHOD-03] an impact-matrix row without a decision blocks the plan", () => {
    const rows = parse({
      impactMatrix: [
        { touchpoint: "Tela de agenda" },
        { touchpoint: "Fila de espera", decision: "SAME" },
      ],
    });
    const result = checkPlan(rows, item, noQuestions);
    expect(result.blockers.find((b) => b.code === "MATRIX_ROW_WITHOUT_DECISION")?.detail).toBe(
      "Tela de agenda",
    );
    // An empty matrix is valid.
    expect(codes(parse())).not.toContain("MATRIX_ROW_WITHOUT_DECISION");
  });
});

class Canned implements ProviderAdapter {
  readonly id = "canned";
  readonly models = [{ id: "m", tier: 2 as const }];
  seen: ProviderRequest[] = [];
  constructor(private readonly reply: string) {}
  async complete(request: ProviderRequest) {
    this.seen.push(request);
    return { text: this.reply, usage: { inputTokens: 20, outputTokens: 10 } };
  }
}

function runtimeFor(reply: string) {
  const db = openDatabase(":memory:");
  const audit = new AuditLog(db);
  const store = new DomainStore(db, audit);
  const budget = new MissionBudget(db, audit, store);
  const projectId = store.createProject({ name: "p", root: "/p", createdBy: owner }).id;
  const missionId = budget.createMission({ projectId, owner });
  budget.grant({ missionId, phase: "EXECUTION", amount: 100_000, actor: owner, reason: "r" });
  const provider = new Canned(reply);
  return {
    provider,
    ctx: {
      runtime: new AiRuntime([provider], budget, new Scheduler()),
      missionId,
      phase: "EXECUTION" as const,
      agent: "blind-reviewer",
    },
  };
}

const input = (changed: string[]) => ({
  plan: parse(),
  acceptanceCriteria: criteria,
  changedPaths: changed,
  diff: "diff --git a/src/agenda/criar.ts b/src/agenda/criar.ts\n+ if (conflito) throw new Error('horario ocupado')",
});

describe("blind review", () => {
  it("[R-METHOD-04] finds, without any model, a planned step whose paths were never touched", () => {
    const findings = deterministicFindings(parse(), ["src/agenda/criar.ts"]);
    expect(findings.find((f) => f.planRef === "s1")?.status).toBe("CONFORME");
    expect(findings.find((f) => f.planRef === "s2")).toMatchObject({
      status: "AUSENTE",
      source: "DETERMINISTIC",
    });
  });

  it("[R-METHOD-04] the verdict is computed from the findings, never taken from the model", async () => {
    const { ctx } = runtimeFor(
      JSON.stringify({
        verdict: "APROVADO",
        items: [{ planRef: "s1", status: "CONFORME", detail: "ok" }],
      }),
    );
    const r = await blindReview(input(["src/agenda/criar.ts"]), ctx);
    // s2 was never touched: the deterministic finding makes it REPROVADO whatever the model said.
    expect(r.verdict).toBe("REPROVADO");
    expect(r.advisory).toBe(true);
  });

  it("[R-METHOD-04] the reviewer is blind: it never receives decisions, conversation or history", async () => {
    const { provider, ctx } = runtimeFor(JSON.stringify({ items: [] }));
    await blindReview(input(["src/agenda/criar.ts", "src/agenda/aviso.ts"]), ctx);
    const sent = provider.seen[0]!;
    const body = JSON.parse(sent.messages[0]!.content) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      "acceptanceCriteria",
      "changedFiles",
      "diff",
      "plan",
    ]);
    expect(Object.keys(body["plan"] as object).sort()).toEqual([
      "impactMatrix",
      "kind",
      "steps",
      "summary",
      "testStrategy",
    ]);
    expect(sent.system).toMatch(/blind/);
    expect(sent.system).toMatch(/DATA/);
  });

  it("[R-METHOD-04] findings that cite an unknown plan item or an unchanged file are dropped", async () => {
    const { ctx } = runtimeFor(
      JSON.stringify({
        items: [
          {
            planRef: "criterion:2",
            status: "AUSENTE",
            detail: "sem aviso ao cliente",
            location: "src/agenda/criar.ts",
          },
          { planRef: "s99", status: "BLOQUEIA", detail: "inventado" },
          {
            planRef: "s1",
            status: "BLOQUEIA",
            detail: "arquivo inexistente",
            location: "src/outro.ts",
          },
          { planRef: "s1", status: "ALGO", detail: "status inválido" },
        ],
      }),
    );
    const r = await blindReview(input(["src/agenda/criar.ts", "src/agenda/aviso.ts"]), ctx);
    expect(r.dropped).toBe(3);
    expect(r.items.filter((i) => i.source === "MODEL").map((i) => i.planRef)).toEqual([
      "criterion:2",
    ]);
    expect(r.verdict).toBe("REPROVADO");
  });

  it("[R-METHOD-04] with the model unavailable only the deterministic checks run", async () => {
    const { ctx } = runtimeFor("not json");
    const r = await blindReview(input(["src/agenda/criar.ts", "src/agenda/aviso.ts"]), ctx);
    expect(r).toMatchObject({
      status: "MODEL_UNAVAILABLE",
      reason: "InvalidModelOutput",
      verdict: "APROVADO",
    });
    expect(verdictOf([{ planRef: "s1", status: "RESSALVA", detail: "x", source: "MODEL" }])).toBe(
      "APROVADO_COM_RESSALVAS",
    );
  });
});

describe("cycle artifacts", () => {
  const cycle = {
    plan: parse({
      kind: "BUGFIX",
      summary: "Bloquear agendamento no mesmo horário.",
      diagnosis: {
        cause: "criarAgendamento não verifica conflito",
        location: "src/agenda/criar.ts:42",
        evidence: "repro",
      },
      rollback: "Reverter o commit",
    }),
    workItemTitle: "Horário duplicado",
    acceptanceCriteria: ["Dois clientes não ocupam o mesmo horário"],
    changedPaths: ["src/agenda/criar.ts", "src/agenda/aviso.ts"],
  };

  it("[R-METHOD-05] the commit message is type(scope): description, short and derived from the plan", () => {
    const msg = commitMessage(cycle);
    const lines = msg.split("\n");
    expect(lines[0]).toBe("fix(agenda): bloquear agendamento no mesmo horário");
    expect(lines[1]).toMatch(/^Cause: /);
    expect(lines.length).toBeLessThanOrEqual(3);
    expect(lines[0]!.length).toBeLessThanOrEqual(72);
    expect(
      commitMessage({ ...cycle, plan: parse({ summary: "x".repeat(200) }) }).split("\n")[0]!.length,
    ).toBeLessThanOrEqual(72);
    expect(scopeOf(["a.ts"])).toBe("");
  });

  it("[R-METHOD-05] the PR description lists what the plan states and nothing invented", () => {
    const pr = prDescription(cycle, "pt");
    expect(pr).toContain("## O que muda / Por quê?");
    expect(pr).toContain("**Causa:** criarAgendamento não verifica conflito");
    expect(pr).toContain("- [x] fix");
    expect(pr).toContain("- [ ] Dois clientes não ocupam o mesmo horário");
    expect(pr).toContain("`src/agenda/criar.ts`");
    expect(pr).toContain("## Como desfazer");
    expect(prDescription(cycle, "en")).toContain("## How to test");
  });
});

describe("documentation drift", () => {
  it("[R-METHOD-06] separates what still holds from what aged, and says what it could not check", () => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-drift-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src", "main.ts"), "export {}");
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ scripts: { build: "tsc", lint: "eslint ." } }),
      );
      writeFileSync(
        join(root, "CLAUDE.md"),
        [
          "# Projeto",
          "O ponto de entrada fica em `src/main.ts`.",
          "A configuração fica em `src/config/old.ts`.",
          "Para compilar use `npm run build`; para publicar docs use `npm run docs`.",
          "A arquitetura é em camadas.",
        ].join("\n"),
      );
      const r = checkDocumentDrift(root, "CLAUDE.md");
      expect(r.holds.map((h) => h.claim).sort()).toEqual(["npm run build", "src/main.ts"]);
      expect(r.aged.map((a) => a.claim).sort()).toEqual(["npm run docs", "src/config/old.ts"]);
      expect(r.unchecked).toBeGreaterThan(0);
    } finally {
      cleanup(root);
    }
  });
});
