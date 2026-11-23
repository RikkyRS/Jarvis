import type { BudgetPhase } from "../domain/contracts.js";
import { MissionBudget, type BudgetStatus } from "../budget/index.js";
import { sha256Hex } from "../shared/canonical.js";
import type { Scheduler } from "../runtime/scheduler.js";

export type ChatMessage = { role: "user" | "assistant"; content: string };

export type ProviderRequest = {
  model: string;
  system: string;
  messages: ChatMessage[];
  maxOutputTokens: number;
  /** JSON Schema for structured output, when the provider supports it. */
  jsonSchema?: Record<string, unknown>;
};

export type ProviderResponse = {
  text: string;
  /** Absent when the provider does not report usage; the runtime then records UNAVAILABLE. */
  usage?: { inputTokens: number; outputTokens: number; cachedInputTokens?: number };
};

/**
 * Provider- and host-agnostic. Ollama, Claude Code, an HTTP API: all implement this and
 * are reachable only through AiRuntime, so no agent can call a provider directly.
 */
export interface ProviderAdapter {
  readonly id: string;
  readonly models: readonly { id: string; tier: 1 | 2 | 3 }[];
  complete(request: ProviderRequest): Promise<ProviderResponse>;
}

export type Complexity = "low" | "medium" | "high";

export type RouteDecision = { provider: string; model: string; tier: 1 | 2 | 3 };

export class ModelRouter {
  constructor(private readonly providers: readonly ProviderAdapter[]) {}

  /** Cheapest model that satisfies the task; restriction lowers the target tier by one. */
  route(input: {
    complexity: Complexity;
    restricted?: boolean;
    preferProvider?: string;
  }): RouteDecision {
    const wanted = { low: 1, medium: 2, high: 3 }[input.complexity];
    const target = Math.max(1, input.restricted ? wanted - 1 : wanted);
    const all = this.providers.flatMap((p) =>
      p.models.map((m) => ({ provider: p.id, model: m.id, tier: m.tier })),
    );
    if (all.length === 0) throw new Error("No AI providers are registered.");
    const score = (c: { provider: string; tier: number }) =>
      Math.abs(c.tier - target) * 10 +
      (c.tier > target ? 1 : 0) +
      (input.preferProvider && c.provider !== input.preferProvider ? 5 : 0);
    return all.sort((a, b) => score(a) - score(b))[0]!;
  }
}

export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

export class ContextTooLargeError extends Error {
  constructor(
    readonly needed: number,
    readonly limit: number,
  ) {
    super(`Mandatory context needs ~${needed} tokens but the limit is ${limit}.`);
    this.name = "ContextTooLargeError";
  }
}

export type ContextSection = {
  id: string;
  text: string;
  /** Business rules, security constraints, approvals and evidence must be mandatory: never dropped. */
  mandatory?: boolean;
  /** Higher survives longer when trimming optional sections. */
  priority?: number;
};

/** Minimal, deduplicated context. Optional sections yield first; mandatory ones never do. */
export function buildContext(
  sections: readonly ContextSection[],
  maxTokens: number,
): { text: string; tokens: number; dropped: string[] } {
  const seen = new Set<string>();
  const kept: ContextSection[] = [];
  for (const s of sections) {
    const key = sha256Hex(s.text.trim());
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(s);
  }
  const mandatory = kept.filter((s) => s.mandatory);
  let tokens = mandatory.reduce((n, s) => n + estimateTokens(s.text), 0);
  if (tokens > maxTokens) throw new ContextTooLargeError(tokens, maxTokens);
  const chosen = new Set(mandatory);
  const dropped: string[] = [];
  for (const s of kept
    .filter((x) => !x.mandatory)
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))) {
    const cost = estimateTokens(s.text);
    if (tokens + cost <= maxTokens) {
      chosen.add(s);
      tokens += cost;
    } else dropped.push(s.id);
  }
  const text = kept
    .filter((s) => chosen.has(s))
    .map((s) => `## ${s.id}\n${s.text}`)
    .join("\n\n");
  return { text, tokens, dropped };
}

export class BudgetBlockedError extends Error {
  constructor(
    readonly reason: string,
    readonly status: BudgetStatus,
  ) {
    super(
      `AI call blocked by token budget: ${reason}. Checkpoint and wait for an authorized grant.`,
    );
    this.name = "BudgetBlockedError";
  }
}

export class LoopDetectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoopDetectedError";
  }
}

export type CompletionRequest = {
  missionId: string;
  phase: BudgetPhase;
  agent: string;
  workItemId?: string;
  workflowRunId?: string;
  operationId?: string;
  complexity: Complexity;
  system: string;
  messages: ChatMessage[];
  maxOutputTokens?: number;
  jsonSchema?: Record<string, unknown>;
  critical?: boolean;
  essential?: boolean;
  preferProvider?: string;
};

export type CompletionResult = {
  text: string;
  provider: string;
  model: string;
  usageState: "ACTUAL" | "UNAVAILABLE";
  budget: BudgetStatus;
};

export type AiRuntimeConfig = {
  /** Hard cap for any single response. */
  maxOutputTokens: number;
  /** Identical request repeated this many times for one Mission is treated as an unproductive loop. */
  maxIdenticalRequests: number;
  /** Cap of calls per Workflow Run. */
  maxCallsPerRun: number;
};

export const DEFAULT_AI_CONFIG: AiRuntimeConfig = {
  maxOutputTokens: 4096,
  maxIdenticalRequests: 2,
  maxCallsPerRun: 200,
};

/**
 * The single mediation point for LLM calls: route, guard against loops, reserve budget
 * atomically, schedule under concurrency limits, call, settle real usage.
 */
export class AiRuntime {
  private readonly router: ModelRouter;
  private readonly providers: Map<string, ProviderAdapter>;
  private readonly seen = new Map<string, number>();
  private readonly perRun = new Map<string, number>();

  constructor(
    providers: readonly ProviderAdapter[],
    private readonly budget: MissionBudget,
    private readonly scheduler: Scheduler,
    private readonly config: AiRuntimeConfig = DEFAULT_AI_CONFIG,
  ) {
    this.router = new ModelRouter(providers);
    this.providers = new Map(providers.map((p) => [p.id, p]));
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const before = this.budget.status(req.missionId, req.phase);
    const route = this.router.route({
      complexity: req.complexity,
      restricted: before.level === "RESTRICTED",
      ...(req.preferProvider ? { preferProvider: req.preferProvider } : {}),
    });
    const provider = this.providers.get(route.provider)!;

    const key = sha256Hex(JSON.stringify([req.missionId, req.system, req.messages]));
    const repeats = (this.seen.get(key) ?? 0) + 1;
    if (repeats > this.config.maxIdenticalRequests) {
      throw new LoopDetectedError(
        "Identical AI request repeated too many times; stopping instead of looping.",
      );
    }
    if (req.workflowRunId) {
      const calls = (this.perRun.get(req.workflowRunId) ?? 0) + 1;
      if (calls > this.config.maxCallsPerRun)
        throw new LoopDetectedError("Workflow run exceeded its AI call cap.");
    }

    const maxOutput = Math.min(
      req.maxOutputTokens ?? this.config.maxOutputTokens,
      this.config.maxOutputTokens,
    );
    const estimate =
      estimateTokens(req.system) +
      req.messages.reduce((n, m) => n + estimateTokens(m.content), 0) +
      maxOutput;
    const reservation = this.budget.reserve({
      missionId: req.missionId,
      phase: req.phase,
      estimate,
      ...(req.critical !== undefined ? { critical: req.critical } : {}),
      ...(req.essential !== undefined ? { essential: req.essential } : {}),
    });
    if (!reservation.ok) throw new BudgetBlockedError(reservation.reason, reservation.status);

    this.seen.set(key, repeats);
    if (req.workflowRunId)
      this.perRun.set(req.workflowRunId, (this.perRun.get(req.workflowRunId) ?? 0) + 1);

    const who = {
      agent: req.agent,
      provider: route.provider,
      model: route.model,
      ...(req.workItemId ? { workItemId: req.workItemId } : {}),
      ...(req.workflowRunId ? { workflowRunId: req.workflowRunId } : {}),
      ...(req.operationId ? { operationId: req.operationId } : {}),
    };

    let response: ProviderResponse;
    try {
      response = await this.scheduler.run(
        { missionId: req.missionId, providerModel: `${route.provider}/${route.model}` },
        () =>
          provider.complete({
            model: route.model,
            system: req.system,
            messages: req.messages,
            maxOutputTokens: maxOutput,
            ...(req.jsonSchema ? { jsonSchema: req.jsonSchema } : {}),
          }),
      );
    } catch (error) {
      // Unknown whether tokens were consumed: keep the conservative estimate, never claim it as actual.
      this.budget.settle(reservation.reservationId, { state: "UNAVAILABLE" }, who);
      throw error;
    }

    this.budget.settle(
      reservation.reservationId,
      response.usage
        ? {
            state: "ACTUAL",
            inputTokens: response.usage.inputTokens,
            outputTokens: response.usage.outputTokens,
            ...(response.usage.cachedInputTokens !== undefined
              ? { cachedInputTokens: response.usage.cachedInputTokens }
              : {}),
          }
        : { state: "UNAVAILABLE" },
      who,
    );
    return {
      text: response.text,
      provider: route.provider,
      model: route.model,
      usageState: response.usage ? "ACTUAL" : "UNAVAILABLE",
      budget: this.budget.status(req.missionId, req.phase),
    };
  }
}
