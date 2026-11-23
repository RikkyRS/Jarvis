import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderAdapter, ProviderRequest } from "../../src/ai/index.js";
import type { Jarvis } from "../../src/app/jarvis.js";
import { AUTONOMY_ACTOR } from "../../src/autonomy/index.js";
import { run as cli, type Io } from "../../src/cli/index.js";
import { DomainError } from "../../src/persistence/repositories.js";
import type { PlanInput } from "../../src/planning/index.js";
import { agent, cleanup, human, makeRepo, openJarvis, writeConfig } from "../helpers.js";

let root: string;
let jarvis: Jarvis | undefined;
afterEach(() => {
  jarvis?.close();
  jarvis = undefined;
  cleanup(root);
});

const plan = (operations: string[] = ["FILE_EDIT", "TEST_RUN"], paths = ["a.txt"]): PlanInput => ({
  summary: "Ajustar a.txt e conferir",
  steps: operations.map((op, i) => ({
    id: `s${i + 1}`,
    title: `Passo ${i + 1}`,
    operations: [op as never],
    paths: op === "FILE_EDIT" || op === "GIT_STAGE" ? paths : [],
    complexity: "LOW" as const,
    verification: "conferido por teste",
  })),
  risks: [{ description: "edição errada", mitigation: "revisar o diff" }],
  testStrategy: "node check",
  rollback: "git revert",
  assumptions: ["só a.txt muda"],
});

function setup(config: Record<string, unknown>, p: PlanInput = plan(), budget = 500_000) {
  root = makeRepo();
  writeConfig(root, { trustedProject: true, ...config });
  jarvis = openJarvis(root);
  const item = jarvis.store.createWorkItem({
    projectId: jarvis.project.id,
    actor: human,
    title: "Ajustar a",
    objective: "Ajustar a.txt",
    acceptanceCriteria: ["a.txt ajustado"],
  });
  for (const q of jarvis.planning.generateQuestions(item.id, human, [])) {
    if (q.impact === "MATERIAL" && q.status === "OPEN")
      jarvis.planning.answer(item.id, q.category, "ok", human);
  }
  jarvis.planning.assumeConventions(item.id, human);
  jarvis.planning.submitPlan(item.id, p, agent);
  const missionId = jarvis.budget.createMission({
    projectId: jarvis.project.id,
    owner: human,
    workItemId: item.id,
  });
  if (budget > 0)
    jarvis.budget.grant({
      missionId,
      phase: "EXECUTION",
      amount: budget,
      actor: human,
      reason: "r",
    });
  return { item, missionId };
}

function waitingRun(itemId: string) {
  const run = jarvis!.store.createRun(itemId, agent);
  jarvis!.store.transitionRun(run.id, "PREPARING", human);
  jarvis!.store.transitionRun(run.id, "AWAITING_EXECUTION_APPROVAL", human);
  return run;
}

const autonomous = { autonomy: { level: "INTERMEDIATE" } };
const events = (kind: string) =>
  jarvis!.db.prepare("SELECT actor_kind, actor_id FROM audit_events WHERE kind = ?").all(kind) as {
    actor_kind: string;
    actor_id: string;
  }[];

describe("delegated autonomy up to MEDIUM", () => {
  it("[R-AUTONOMY-01] is off by default: nothing is approved or started without the human", () => {
    const { item, missionId } = setup({});
    const run = waitingRun(item.id);
    const t = jarvis!.autonomyTick(missionId);
    expect(t).toMatchObject({ approvedPlans: [], startedRuns: [], confirmedRequests: [] });
    expect(jarvis!.planning.currentPlan(item.id)?.status).toBe("DRAFT");
    expect(jarvis!.store.getRun(run.id)?.status).toBe("AWAITING_EXECUTION_APPROVAL");
  });

  it("[R-AUTONOMY-01] at INTERMEDIATE an all-MEDIUM plan is approved and started, attributed to the delegation", () => {
    const { item, missionId } = setup(autonomous);
    const run = waitingRun(item.id);
    const t = jarvis!.autonomyTick(missionId);
    expect(t.approvedPlans).toEqual([item.id]);
    expect(t.startedRuns).toEqual([run.id]);
    expect(jarvis!.store.getRun(run.id)?.status).toBe("RUNNING");
    const stored = jarvis!.planning.currentPlan(item.id)!;
    expect(stored.status).toBe("APPROVED");
    expect(stored.approvedBy).toBe("delegation:INTERMEDIATE");
    expect(events("planning.plan_auto_approved")).toEqual([
      { actor_kind: "system", actor_id: "autonomy" },
    ]);
    expect(events("workflow_run.auto_started")).toHaveLength(1);
    expect(jarvis!.audit.verify()).toBeNull();
  });

  it("[R-AUTONOMY-02] a plan with anything HIGH (commit) is never auto-approved", () => {
    const { item, missionId } = setup(autonomous, plan(["FILE_EDIT", "TEST_RUN", "GIT_COMMIT"]));
    const t = jarvis!.autonomyTick(missionId);
    expect(t.approvedPlans).toEqual([]);
    expect(t.waiting[0]?.reasons.join(" ")).toMatch(/RISK_ABOVE_MEDIUM:GIT_COMMIT/);
    expect(jarvis!.planning.currentPlan(item.id)?.status).toBe("DRAFT");
    // The human still can, as before.
    expect(() => jarvis!.planning.approvePlan(item.id, human)).not.toThrow();
  });

  it("[R-AUTONOMY-02] a project that requires approval for a type keeps that plan for the human", () => {
    const { missionId } = setup({ ...autonomous, requireApproval: ["TEST_RUN"] });
    const status = jarvis!.autonomyStatus(missionId);
    expect(status.items[0]).toMatchObject({ eligible: false });
    expect(status.items[0]?.reasons.join(" ")).toMatch(/PROJECT_REQUIRES_APPROVAL:TEST_RUN/);
  });

  it("[R-AUTONOMY-02] respects the estimate limit and the authorized budget", () => {
    const limited = setup({ autonomy: { level: "INTERMEDIATE", maxEstimateTokens: 1000 } });
    expect(jarvis!.autonomyStatus(limited.missionId).items[0]?.reasons.join(" ")).toMatch(
      /ESTIMATE_ABOVE_LIMIT/,
    );
    jarvis!.close();
    cleanup(root);
    const poor = setup(autonomous, plan(), 100);
    expect(jarvis!.autonomyStatus(poor.missionId).items[0]?.reasons.join(" ")).toMatch(
      /ESTIMATE_ABOVE_BUDGET/,
    );
  });

  it("[R-AUTONOMY-03] a plan touching the control files (.jarvis/) is never eligible", () => {
    const { missionId } = setup(autonomous, plan(["FILE_EDIT"], [".jarvis/config.json"]));
    expect(jarvis!.autonomyStatus(missionId).items[0]?.reasons.join(" ")).toMatch(
      /TOUCHES_CONTROL_FILES/,
    );
  });

  it("[R-AUTONOMY-03] the delegation is not a human: approve and start by delegation refuse when it is off", () => {
    const { item, missionId } = setup({});
    expect(() => jarvis!.planning.approvePlan(item.id, AUTONOMY_ACTOR)).toThrow(/human/);
    expect(() =>
      jarvis!.planning.approvePlanByDelegation(
        item.id,
        jarvis!.autonomy,
        jarvis!.policyConfig,
        500_000,
      ),
    ).toThrow(DomainError);
    const run = waitingRun(item.id);
    expect(() =>
      jarvis!.runtime.startExecutionByDelegation(
        run.id,
        missionId,
        jarvis!.autonomy,
        jarvis!.policyConfig,
      ),
    ).toThrow(/not enabled/);
  });

  it("[R-AUTONOMY-03] only the human changes the level, through the CLI, and the change is audited", async () => {
    root = makeRepo();
    const out: string[] = [];
    const io: Io = {
      out: (l) => void out.push(l),
      err: () => undefined,
      confirm: async () => false,
    };
    const code = await cli(
      ["autonomy", "set", "INTERMEDIATE", "--max-estimate", "50000"],
      io,
      root,
      {
        JARVIS_USER: "rikky",
        JARVIS_NOTES_DIR: join(root, "notes"),
      },
    );
    expect(code).toBe(0);
    const config = JSON.parse(readFileSync(join(root, ".jarvis", "config.json"), "utf8")) as {
      autonomy: { level: string; maxEstimateTokens: number };
    };
    expect(config.autonomy).toMatchObject({ level: "INTERMEDIATE", maxEstimateTokens: 50000 });
    jarvis = openJarvis(root);
    expect(jarvis.autonomy.level).toBe("INTERMEDIATE");
    expect(events("config.autonomy_changed")).toEqual([{ actor_kind: "human", actor_id: "rikky" }]);
  });
});

describe("automatic confirmation of in-scope client requests", () => {
  const CONTRACT =
    "## Cláusula 2 - Suporte\nCorreção de defeitos do sistema de agendamento em até 5 dias úteis, sem custo.\n\n## Cláusula 3 - Fora do escopo\nAplicativo móvel nativo depende de proposta à parte.\n";
  let verdict: (clauseId: string) => string;

  const provider: ProviderAdapter = {
    id: "fake",
    models: [{ id: "m", tier: 1 }],
    async complete(req: ProviderRequest) {
      if (req.system.includes("classify chat messages")) {
        const ids = (
          JSON.parse(req.messages[0]!.content) as { messages: { id: string }[] }
        ).messages.map((m) => m.id);
        return {
          text: JSON.stringify({
            groups: [
              {
                intent: "task",
                messageIds: ids,
                title: "Corrigir defeito no agendamento",
                objective: "Corrigir defeito do sistema de agendamento",
                requirements: [],
                acceptanceCriteria: [],
              },
            ],
          }),
          usage: { inputTokens: 5, outputTokens: 5 },
        };
      }
      const docs = (JSON.parse(req.messages[0]!.content) as { documents: { id: string }[] })
        .documents;
      return { text: verdict(docs[0]?.id ?? "none"), usage: { inputTokens: 5, outputTokens: 5 } };
    },
  };

  async function proposal(config: Record<string, unknown>, reply: (id: string) => string) {
    root = makeRepo();
    writeConfig(root, config);
    jarvis = openJarvis(root, { providers: [provider] });
    const missionId = jarvis.budget.createMission({ projectId: jarvis.project.id, owner: human });
    jarvis.budget.grant({
      missionId,
      phase: "PREPARATION",
      amount: 100_000,
      actor: human,
      reason: "r",
    });
    jarvis.contract.add({ kind: "CONTRACT", text: CONTRACT, sourceName: "c.md", actor: human });
    verdict = reply;
    const intake = jarvis.intake({
      missionId,
      phase: "PREPARATION",
      allowedSenders: new Set(["s"]),
    });
    intake.ingest({
      channel: "manual",
      externalId: "m1",
      sender: "s",
      conversationId: "s",
      receivedAt: "2026-11-23T12:00:00.000Z",
      text: "O agendamento está com defeito, corrijam por favor",
    });
    const { proposals } = await intake.classifyPending();
    return { intake, missionId, p: proposals[0]! };
  }

  const auto = { autonomy: { level: "INTERMEDIATE", autoConfirmInScope: true } };

  it("[R-AUTONOMY-04] a cited IN_SCOPE request becomes a Work Item by delegation", async () => {
    const { intake, missionId, p } = await proposal(auto, (id) =>
      JSON.stringify({ verdict: "IN_SCOPE", citations: [id], rationale: "Cláusula 2" }),
    );
    expect(p.triage?.verdict).toBe("IN_SCOPE");
    const t = jarvis!.autonomyTick(missionId);
    expect(t.confirmedRequests).toHaveLength(1);
    expect(intake.getProposal(p.id)?.status).toBe("CONFIRMED");
    expect(events("intake.proposal_auto_confirmed")).toEqual([
      { actor_kind: "system", actor_id: "autonomy" },
    ]);
  });

  it("[R-AUTONOMY-04] OUT_OF_SCOPE, UNCLEAR and the switch being off always wait for the human", async () => {
    const out = await proposal(auto, (id) =>
      JSON.stringify({ verdict: "OUT_OF_SCOPE", citations: [id], rationale: "x" }),
    );
    expect(jarvis!.autonomyTick(out.missionId).confirmedRequests).toEqual([]);
    expect(out.intake.getProposal(out.p.id)?.status).toBe("PENDING");
    jarvis!.close();
    cleanup(root);

    const unclear = await proposal(auto, () =>
      JSON.stringify({ verdict: "UNCLEAR", citations: [], rationale: "" }),
    );
    expect(jarvis!.autonomyTick(unclear.missionId).confirmedRequests).toEqual([]);
    jarvis!.close();
    cleanup(root);

    const off = await proposal({ autonomy: { level: "INTERMEDIATE" } }, (id) =>
      JSON.stringify({ verdict: "IN_SCOPE", citations: [id], rationale: "x" }),
    );
    expect(() => off.intake.confirmByDelegation(off.p.id, jarvis!.autonomy)).toThrow(/not enabled/);
  });
});
