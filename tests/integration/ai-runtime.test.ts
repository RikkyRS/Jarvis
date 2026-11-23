import { beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import {
  AiRuntime,
  BudgetBlockedError,
  ContextTooLargeError,
  LoopDetectedError,
  ModelRouter,
  buildContext,
  type ProviderAdapter,
  type ProviderRequest,
  type ProviderResponse,
} from "../../src/ai/index.js";
import { ClaudeCodeProvider, OllamaProvider } from "../../src/ai/providers.js";
import { MissionBudget } from "../../src/budget/index.js";
import {
  buildDockerArgs,
  ContainerConfigError,
  DockerRunner,
} from "../../src/gateway/container.js";
import type { ProcessRunner, ProcessSpec } from "../../src/gateway/runner.js";
import { AuditLog } from "../../src/persistence/audit.js";
import { openDatabase } from "../../src/persistence/db.js";
import { DomainStore } from "../../src/persistence/repositories.js";
import { Scheduler } from "../../src/runtime/scheduler.js";

const owner = { kind: "human", id: "owner" } as const;

class FakeProvider implements ProviderAdapter {
  readonly id: string;
  readonly models: ProviderAdapter["models"];
  calls = 0;
  inFlight = 0;
  maxInFlight = 0;
  constructor(
    id = "fake",
    models: ProviderAdapter["models"] = [
      { id: "small", tier: 1 },
      { id: "mid", tier: 2 },
      { id: "big", tier: 3 },
    ],
    private readonly respond: (
      r: ProviderRequest,
    ) => Promise<ProviderResponse> | ProviderResponse = () => ({
      text: "ok",
      usage: { inputTokens: 10, outputTokens: 5 },
    }),
  ) {
    this.id = id;
    this.models = models;
  }
  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    this.calls += 1;
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      await new Promise((r) => setTimeout(r, 5));
      return await this.respond(request);
    } finally {
      this.inFlight -= 1;
    }
  }
}

let db: DatabaseSync;
let budget: MissionBudget;
let missionId: string;

beforeEach(() => {
  db = openDatabase(":memory:");
  const audit = new AuditLog(db);
  const store = new DomainStore(db, audit);
  budget = new MissionBudget(db, audit, store);
  const projectId = store.createProject({ name: "p", root: "/p", createdBy: owner }).id;
  missionId = budget.createMission({ projectId, owner });
});

const call = (ai: AiRuntime, text = "hello", extra: Record<string, unknown> = {}) =>
  ai.complete({
    missionId,
    phase: "EXECUTION",
    agent: "a",
    complexity: "low",
    system: "s",
    messages: [{ role: "user", content: text }],
    maxOutputTokens: 100,
    ...extra,
  });

describe("AI runtime and token governance", () => {
  it("[R-BUDGET-01] never calls the provider when the authorized budget would be exceeded", async () => {
    budget.grant({ missionId, phase: "EXECUTION", amount: 150, actor: owner, reason: "r" });
    const provider = new FakeProvider();
    const ai = new AiRuntime([provider], budget, new Scheduler());
    await call(ai, "one"); // reserves ~100+, uses 15
    await expect(call(ai, "x".repeat(2000))).rejects.toBeInstanceOf(BudgetBlockedError);
    expect(provider.calls).toBe(1);
  });

  it("[R-BUDGET-01] blocks everything with no grant", async () => {
    const provider = new FakeProvider();
    const ai = new AiRuntime([provider], budget, new Scheduler());
    await expect(call(ai)).rejects.toMatchObject({ reason: "NO_ALLOWANCE" });
    expect(provider.calls).toBe(0);
  });

  it("[R-BUDGET-02] parallel calls cannot consume the same reserved balance", async () => {
    budget.grant({ missionId, phase: "EXECUTION", amount: 400, actor: owner, reason: "r" });
    const provider = new FakeProvider();
    const ai = new AiRuntime(
      [provider],
      budget,
      new Scheduler({ global: 10, perMission: 10, perProviderModel: 10 }),
    );
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) => call(ai, `msg-${i}`)),
    );
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const blocked = results.filter((r) => r.status === "rejected").length;
    expect(ok + blocked).toBe(8);
    expect(blocked).toBeGreaterThan(0);
    const s = budget.status(missionId, "EXECUTION");
    expect(s.used + s.reserved).toBeLessThanOrEqual(400);
    expect(s.reserved).toBe(0);
  });

  it("records provider-reported usage as ACTUAL and missing usage as UNAVAILABLE", async () => {
    budget.grant({ missionId, phase: "EXECUTION", amount: 10_000, actor: owner, reason: "r" });
    const noUsage = new FakeProvider("nousage", [{ id: "m", tier: 1 }], () => ({ text: "hi" }));
    const ai = new AiRuntime([noUsage], budget, new Scheduler());
    const r = await call(ai);
    expect(r.usageState).toBe("UNAVAILABLE");
    expect(budget.report(missionId, "EXECUTION")[0]?.state).toBe("UNAVAILABLE");
  });

  it("keeps a conservative charge and surfaces the error when a provider fails", async () => {
    budget.grant({ missionId, phase: "EXECUTION", amount: 10_000, actor: owner, reason: "r" });
    const bad = new FakeProvider("bad", [{ id: "m", tier: 1 }], () => {
      throw new Error("provider down");
    });
    const ai = new AiRuntime([bad], budget, new Scheduler());
    await expect(call(ai)).rejects.toThrow("provider down");
    const s = budget.status(missionId, "EXECUTION");
    expect(s.reserved).toBe(0);
    expect(s.used).toBeGreaterThan(0);
  });

  it("detects unproductive loops and caps output", async () => {
    budget.grant({ missionId, phase: "EXECUTION", amount: 100_000, actor: owner, reason: "r" });
    let seen: ProviderRequest | undefined;
    const provider = new FakeProvider("p", [{ id: "m", tier: 1 }], (r) => {
      seen = r;
      return { text: "ok", usage: { inputTokens: 1, outputTokens: 1 } };
    });
    const ai = new AiRuntime([provider], budget, new Scheduler(), {
      maxOutputTokens: 50,
      maxIdenticalRequests: 2,
      maxCallsPerRun: 5,
    });
    await call(ai, "same", { maxOutputTokens: 99999 });
    expect(seen?.maxOutputTokens).toBe(50);
    await call(ai, "same");
    await expect(call(ai, "same")).rejects.toBeInstanceOf(LoopDetectedError);
    for (let i = 0; i < 3; i++) await call(ai, `other-${i}`, { workflowRunId: "run" });
    await call(ai, "o1", { workflowRunId: "run" });
    await call(ai, "o2", { workflowRunId: "run" });
    await expect(call(ai, "o3", { workflowRunId: "run" })).rejects.toBeInstanceOf(
      LoopDetectedError,
    );
  });

  it("downgrades model tier when the budget is restricted", async () => {
    budget.grant({ missionId, phase: "EXECUTION", amount: 1000, actor: owner, reason: "r" });
    const router = new ModelRouter([new FakeProvider()]);
    expect(router.route({ complexity: "high" }).model).toBe("big");
    expect(router.route({ complexity: "high", restricted: true }).model).toBe("mid");
    expect(router.route({ complexity: "low", restricted: true }).model).toBe("small");
    expect(
      new ModelRouter([
        new FakeProvider(),
        new FakeProvider("other", [{ id: "x", tier: 1 }]),
      ]).route({ complexity: "low", preferProvider: "other" }).provider,
    ).toBe("other");
  });
});

describe("scheduler", () => {
  it("[R-CONC-01] enforces global, per-mission and per-model limits together", async () => {
    const s = new Scheduler({ global: 3, perMission: 2, perProviderModel: 1 });
    let active = 0;
    let peak = 0;
    const task = (scope: { missionId: string; providerModel?: string }) =>
      s.run(scope, async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 10));
        active -= 1;
      });
    await Promise.all([
      task({ missionId: "a", providerModel: "p/x" }),
      task({ missionId: "a", providerModel: "p/x" }),
      task({ missionId: "b", providerModel: "p/y" }),
      task({ missionId: "b", providerModel: "p/y" }),
    ]);
    expect(peak).toBeLessThanOrEqual(2); // two models, one slot each
    expect(s.stats).toEqual({ active: 0, queued: 0 });
  });

  it("serves higher priority first and releases slots on failure", async () => {
    const s = new Scheduler({ global: 1, perMission: 1, perProviderModel: 1 });
    const order: string[] = [];
    const blocker = s.run({ missionId: "m" }, () => new Promise((r) => setTimeout(r, 20)));
    const low = s.run({ missionId: "m" }, async () => void order.push("low"), 0);
    const high = s.run({ missionId: "m" }, async () => void order.push("high"), 10);
    await Promise.all([blocker, low, high]);
    expect(order).toEqual(["high", "low"]);
    await expect(
      s.run({ missionId: "m" }, async () => Promise.reject(new Error("x"))),
    ).rejects.toThrow("x");
    await s.run({ missionId: "m" }, async () => undefined);
  });

  it("rejects invalid limits", () => {
    expect(() => new Scheduler({ global: 0, perMission: 1, perProviderModel: 1 })).toThrow();
  });
});

describe("context builder", () => {
  it("dedupes, trims optional context and never drops mandatory rules", () => {
    const built = buildContext(
      [
        { id: "rules", text: "NEVER force push.", mandatory: true },
        { id: "dup", text: "NEVER force push.", mandatory: true },
        { id: "big", text: "x".repeat(4000), priority: 1 },
        { id: "small", text: "tiny note", priority: 5 },
      ],
      50,
    );
    expect(built.text).toContain("NEVER force push.");
    expect(built.text).toContain("tiny note");
    expect(built.dropped).toEqual(["big"]);
    expect(built.text.match(/NEVER force push/g)).toHaveLength(1);
    expect(() => buildContext([{ id: "m", text: "y".repeat(1000), mandatory: true }], 10)).toThrow(
      ContextTooLargeError,
    );
  });
});

describe("providers", () => {
  it("Ollama sends a JSON schema, reports usage and is loopback-only", async () => {
    let body: Record<string, unknown> = {};
    const p = new OllamaProvider({
      models: [{ id: "llama", tier: 1 }],
      fetch: async (_url, init) => {
        body = JSON.parse(init.body) as Record<string, unknown>;
        return {
          ok: true,
          status: 200,
          json: async () => ({ message: { content: "{}" }, prompt_eval_count: 7, eval_count: 3 }),
        };
      },
    });
    const r = await p.complete({
      model: "llama",
      system: "s",
      messages: [{ role: "user", content: "u" }],
      maxOutputTokens: 10,
      jsonSchema: { type: "object" },
    });
    expect(r.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
    expect(body["format"]).toEqual({ type: "object" });
    expect(() => new OllamaProvider({ baseUrl: "http://evil.example:11434", models: [] })).toThrow(
      /loopback/,
    );
  });

  it("Claude Code runs text-only: no tools, no MCP, no session, prompt on stdin", async () => {
    let seen: ProcessSpec | undefined;
    const runner: ProcessRunner = {
      kind: "host",
      run: async (spec) => {
        seen = spec;
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            result: "answer",
            usage: { input_tokens: 4, output_tokens: 2, cache_read_input_tokens: 1 },
          }),
          stderr: "",
          timedOut: false,
          truncated: false,
        };
      },
    };
    const p = new ClaudeCodeProvider(runner, { cwd: "/tmp" });
    const r = await p.complete({
      model: "haiku",
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      maxOutputTokens: 10,
    });
    expect(r).toEqual({
      text: "answer",
      usage: { inputTokens: 4, outputTokens: 2, cachedInputTokens: 1 },
    });
    expect(seen?.args).toEqual(
      expect.arrayContaining([
        "-p",
        "--tools",
        "",
        "--strict-mcp-config",
        "--no-session-persistence",
      ]),
    );
    expect(seen?.input).toContain("hi");
    expect(seen?.args.join(" ")).not.toContain("hi");
  });
});

describe("container isolation profile", () => {
  const digest = `node:22@sha256:${"a".repeat(64)}`;
  const spec = (cwd: string): ProcessSpec => ({
    command: "npm",
    args: ["test"],
    cwd,
    timeoutMs: 1000,
    maxOutputBytes: 1000,
  });

  it("[R-ISO-02] builds a locked-down docker profile", () => {
    const dir = process.cwd();
    const args = buildDockerArgs({ image: digest, workspace: dir }, spec(dir), "jarvis-x");
    expect(args).toEqual(
      expect.arrayContaining([
        "--network",
        "none",
        "--read-only",
        "--cap-drop",
        "ALL",
        "no-new-privileges",
      ]),
    );
    expect(args.join(" ")).not.toMatch(/docker\.sock|--privileged|--env|-e /);
    expect(args.slice(-2)).toEqual(["npm", "test"]);
  });

  it("[R-ISO-02] rejects unpinned images, env vars and cwd outside the workspace", () => {
    const dir = process.cwd();
    expect(() => new DockerRunner({ image: "node:22", workspace: dir })).toThrow(
      ContainerConfigError,
    );
    expect(() =>
      buildDockerArgs(
        { image: digest, workspace: dir },
        { ...spec(dir), env: { GIT_X: "1" } },
        "n",
      ),
    ).toThrow(ContainerConfigError);
    expect(() =>
      buildDockerArgs({ image: digest, workspace: dir }, spec(`${dir}/..`), "n"),
    ).toThrow(ContainerConfigError);
  });
});
