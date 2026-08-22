import type { Store } from "../../infrastructure/db.js";
import { recallGlobalForProject } from "../../infrastructure/global-memory.js";
import type { Cycle } from "../../core/cycle/index.js";
import type { ContextPackage } from "../../shared/contracts.js";

export type AgentBrief = {
  status: "READY" | "NO_CYCLE" | "NOT_INITIALIZED";
  projectRoot: string;
  cycle: {
    id: string;
    number: number;
    status: string;
    objective: string;
    riskLevel: string;
    riskAccumulated: string;
    next: string;
    protectedHumanPaths: string[];
  } | null;
  memory: {
    bullets: string[];
    projectCount: number;
    globalCount: number;
  };
  context: {
    ecosystems: string[];
    topLevel: string[];
    knowledgeState: string;
  } | null;
  tokenHint: string;
  generatedAt: string;
};

function summarizePayload(kind: string, payload: unknown): string {
  if (kind === "HOST_NOTE" && payload && typeof payload === "object" && "text" in payload) {
    return String((payload as { text: string }).text).slice(0, 200);
  }
  if (kind === "STACK" && payload && typeof payload === "object" && "ecosystems" in payload) {
    return `stack: ${((payload as { ecosystems: string[] }).ecosystems ?? []).join(", ") || "unknown"}`;
  }
  if (kind === "TOP_LEVEL" && payload && typeof payload === "object" && "dirs" in payload) {
    const dirs = (payload as { dirs: string[] }).dirs ?? [];
    return `top-level: ${dirs.slice(0, 12).join(", ")}`;
  }
  if (kind === "LAST_CYCLE" || kind === "LAST_COMPLETED_CYCLE") {
    return JSON.stringify(payload).slice(0, 120);
  }
  const raw = JSON.stringify(payload);
  return raw.length > 100 ? `${raw.slice(0, 97)}...` : raw;
}

function nextStep(status: string, riskLevel: string): string {
  if (status === "PAUSED") return "resume";
  if (status === "WAITING_EXTERNAL") return "wait resolved → resume or close";
  if (status === "BLOCKED") return riskLevel === "CRITICAL" ? "blocked — change objective" : "dev --approve or diagnose";
  if (status === "PLANNING" || status === "READY") return "dev";
  if (status === "EXECUTING") return "test";
  if (status === "TESTING") return "review";
  if (status === "REVIEWING") return "security or close";
  if (status === "SECURITY") return "close";
  return "status";
}

export function buildAgentBrief(
  projectRoot: string,
  store: Store | null,
  cycle: Cycle | null,
  context?: ContextPackage | null,
): AgentBrief {
  const memoryBullets: string[] = [];
  let projectCount = 0;
  let globalCount = 0;

  if (store) {
    const project = store.listMemory(12);
    projectCount = project.length;
    for (const row of project) {
      const payload = JSON.parse(row.payload) as unknown;
      memoryBullets.push(`[PROJECT/${row.kind}] ${summarizePayload(row.kind, payload)}`);
    }
    const global = recallGlobalForProject(projectRoot, 6);
    globalCount = global.length;
    for (const row of global) {
      memoryBullets.push(`[GLOBAL/${row.kind}] ${summarizePayload(row.kind, row.payload)}`);
    }
  }

  const humanPaths =
    cycle?.payload.impact?.layers.HUMAN?.map((item) => item.path).slice(0, 15) ?? [];

  const ctx = context ?? cycle?.payload.context ?? null;

  return {
    status: cycle ? "READY" : store ? "NO_CYCLE" : "NOT_INITIALIZED",
    projectRoot,
    cycle: cycle
      ? {
          id: cycle.id,
          number: cycle.number,
          status: cycle.status,
          objective: cycle.objective,
          riskLevel: cycle.payload.risk?.level ?? "LOW",
          riskAccumulated: cycle.payload.risk?.accumulated ?? cycle.payload.risk?.level ?? "LOW",
          next: nextStep(cycle.status, cycle.payload.risk?.level ?? "LOW"),
          protectedHumanPaths: humanPaths,
        }
      : null,
    memory: {
      bullets: memoryBullets.slice(0, 16),
      projectCount,
      globalCount,
    },
    context: ctx
      ? {
          ecosystems: ctx.levels.L0.ecosystems ?? [],
          topLevel: (ctx.levels.L1.topLevel as string[] | undefined)?.slice(0, 15) ?? [],
          knowledgeState: ctx.knowledgeState ?? "UNKNOWN",
        }
      : null,
    tokenHint:
      "Read this brief before exploring the repo. Run `jarvis brief` each turn. Record learnings with `jarvis memorize \"…\"`. Full plan output only on `planeje`.",
    generatedAt: new Date().toISOString(),
  };
}
