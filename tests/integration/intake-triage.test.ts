import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Jarvis } from "../../src/app/jarvis.js";
import type { ProviderAdapter, ProviderRequest } from "../../src/ai/index.js";
import type { InboundMessage, Intake } from "../../src/intake/index.js";
import { cleanup, human, makeRepo, openJarvis } from "../helpers.js";

const CONTRACT = `# Contrato

## Cláusula 2 - Suporte
Correção de defeitos do sistema de agendamento em até 5 dias úteis, sem custo adicional.

## Cláusula 3 - Fora do escopo
Integração com sistemas de pagamento e aplicativo móvel nativo dependem de proposta à parte.
`;
const HISTORY = `## 2026-10-02 - Reclamação: horário duplicado
Dois clientes foram agendados no mesmo horário. Corrigido com bloqueio de conflito na agenda.
`;

let root: string;
let jarvis: Jarvis;
let missionId: string;
let intake: Intake;
let calls: ProviderRequest[] = [];
let n = 0;

/** Answers by what the system prompt asks for: classification, triage or reply. */
let triageReply: (req: ProviderRequest) => string;
const provider: ProviderAdapter = {
  id: "fake",
  models: [{ id: "m", tier: 1 }],
  async complete(req) {
    calls.push(req);
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
              title: "Agendamento duplicado no mesmo horário",
              objective: "Dois clientes foram agendados no mesmo horário de novo",
              requirements: [],
              acceptanceCriteria: [],
            },
          ],
        }),
        usage: { inputTokens: 10, outputTokens: 10 },
      };
    }
    if (req.system.includes("triage a client request")) {
      return { text: triageReply(req), usage: { inputTokens: 10, outputTokens: 10 } };
    }
    return {
      text: "Olá! Isso já foi tratado em 02/10.",
      usage: { inputTokens: 10, outputTokens: 10 },
    };
  },
};

const msg = (text: string): InboundMessage => ({
  channel: "whatsapp",
  externalId: `m${++n}`,
  sender: "5511999990000",
  conversationId: "5511999990000",
  receivedAt: "2026-11-23T12:00:00.000Z",
  text,
});

const setup = (withContract: boolean) => {
  root = makeRepo();
  jarvis = openJarvis(root, { providers: [provider] });
  missionId = jarvis.budget.createMission({ projectId: jarvis.project.id, owner: human });
  jarvis.budget.grant({
    missionId,
    phase: "PREPARATION",
    amount: 100_000,
    actor: human,
    reason: "t",
  });
  if (withContract) {
    jarvis.contract.add({ kind: "CONTRACT", text: CONTRACT, sourceName: "c.md", actor: human });
    jarvis.contract.add({ kind: "HISTORY", text: HISTORY, sourceName: "h.md", actor: human });
  }
  intake = jarvis.intake({
    missionId,
    phase: "PREPARATION",
    allowedSenders: new Set(["5511999990000"]),
  });
  calls = [];
};

afterEach(() => {
  jarvis.close();
  cleanup(root);
});

describe("intake with contract triage", () => {
  beforeEach(() => setup(true));

  it("[R-INTAKE-03] a repeated complaint arrives as a proposal tagged REPEATED with the history as evidence", async () => {
    const hist = jarvis.contract.retrieve("horário duplicado agendados mesmo horário", {
      kinds: ["HISTORY"],
    })[0]!;
    triageReply = () =>
      JSON.stringify({
        verdict: "REPEATED",
        citations: [hist.chunkId],
        rationale: "Já corrigido.",
      });
    intake.ingest(msg("Dois clientes agendados no mesmo horário de novo!"));
    const { proposals } = await intake.classifyPending();
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.triage).toMatchObject({ verdict: "REPEATED", status: "OK" });
    expect(proposals[0]?.triage?.citations[0]).toMatchObject({ kind: "HISTORY" });
    // Still only a proposal: nothing was created or executed.
    expect(jarvis.store.listWorkItems(jarvis.project.id)).toHaveLength(0);
    expect(proposals[0]?.status).toBe("PENDING");
  });

  it("[R-INTAKE-03] a triage failure never blocks the proposal", async () => {
    triageReply = () => "not json";
    intake.ingest(msg("Dois clientes agendados no mesmo horário de novo!"));
    const { proposals, failed } = await intake.classifyPending();
    expect(failed).toBe(0);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.triage).toMatchObject({ status: "UNAVAILABLE", verdict: "UNCLEAR" });
  });

  it("[R-INTAKE-04] a reply is only a draft stored for the human; there is no way to send it", async () => {
    triageReply = () => JSON.stringify({ verdict: "UNCLEAR", citations: [], rationale: "" });
    intake.ingest(msg("Dois clientes agendados no mesmo horário de novo!"));
    const { proposals } = await intake.classifyPending();
    const draft = await intake.draftReply(proposals[0]!.id);
    expect(draft).toMatch(/02\/10/);
    expect(intake.getProposal(proposals[0]!.id)?.replyDraft).toBe(draft);
    const sent = calls.at(-1)!;
    expect(sent.system).toMatch(/DATA/);
    expect(Object.keys(intake)).not.toContain("send");
    expect((intake as unknown as Record<string, unknown>)["send"]).toBeUndefined();
  });

  it("[R-INTAKE-04] the digest counts what waits for the human", async () => {
    triageReply = () => JSON.stringify({ verdict: "UNCLEAR", citations: [], rationale: "" });
    intake.ingest(msg("primeira mensagem"));
    expect(intake.inboxCounts()).toEqual({ newMessages: 1, pendingProposals: 0 });
    await intake.classifyPending();
    expect(intake.inboxCounts()).toEqual({ newMessages: 0, pendingProposals: 1 });
  });
});

describe("intake in a project without a contract", () => {
  beforeEach(() => setup(false));

  it("[R-CONTRACT-05] works as before: proposal created, triage skipped, no extra model call", async () => {
    triageReply = () => {
      throw new Error("triage must not run without a contract");
    };
    intake.ingest(msg("Dois clientes agendados no mesmo horário de novo!"));
    const { proposals, failed } = await intake.classifyPending();
    expect(failed).toBe(0);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.triage).toMatchObject({ verdict: "UNCLEAR", reason: "NoContractOnFile" });
    expect(calls.filter((c) => c.system.includes("triage a client request"))).toHaveLength(0);
  });
});
