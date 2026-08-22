import { randomUUID } from "node:crypto";
import type { CycleStatus, Evidence } from "../../shared/contracts.js";
import { nowIso, shortId, slugify } from "../../shared/util.js";
import { emptyOrchestrator, type OrchestratorState } from "../orchestrator/index.js";
import type { ContextPackage, Contract, ImpactReport, RiskReport } from "../../shared/contracts.js";
import type { GitReconciliation, GitSnapshot } from "../../engines/git/index.js";

export const TERMINAL: CycleStatus[] = ["COMPLETED", "FAILED", "ABANDONED"];
export const LOCK_TTL_MS = 30 * 60 * 1000;

export type CyclePayload = {
  evidence: Evidence[];
  contract?: Contract;
  context?: ContextPackage;
  impact?: ImpactReport;
  risk?: RiskReport;
  security?: unknown;
  gitBaseline?: GitSnapshot;
  gitReconciliation?: GitReconciliation;
  branch?: unknown;
  test?: unknown;
  review?: unknown;
  memory?: unknown;
  execution?: unknown;
  approvals: Array<{ at: string; command: string }>;
  orchestrator: OrchestratorState;
  lastActionUnknown?: boolean;
  pausedFrom?: CycleStatus;
  waitReason?: string;
  riskHistory?: Array<{ at: string; level: string; command: string }>;
};

export type Cycle = {
  id: string;
  uuid: string;
  number: number;
  slug: string;
  objective: string;
  status: CycleStatus;
  createdAt: string;
  updatedAt: string;
  payload: CyclePayload;
};

export function createCycleObject(objective: string, number: number): Cycle {
  const uuid = randomUUID();
  const createdAt = nowIso();
  return {
    id: shortId("cycle"),
    uuid,
    number,
    slug: slugify(objective),
    objective,
    status: "PLANNING",
    createdAt,
    updatedAt: createdAt,
    payload: {
      evidence: [
        {
          id: "E-001",
          type: "USER_OBJECTIVE",
          content: objective,
          source: "user",
          timestamp: createdAt,
          knowledgeState: "KNOWN",
          confidence: "HIGH",
        },
      ],
      approvals: [],
      orchestrator: emptyOrchestrator(),
    },
  };
}

export function addEvidence(cycle: Cycle, type: string, content: unknown, source: string, knowledgeState: Evidence["knowledgeState"] = "KNOWN", confidence: Evidence["confidence"] = "MEDIUM"): void {
  const record: Evidence = {
    id: `E-${String(cycle.payload.evidence.length + 1).padStart(3, "0")}`,
    type,
    content,
    source,
    timestamp: nowIso(),
    knowledgeState,
    confidence,
  };
  cycle.payload.evidence.push(record);
}

export function canTransition(from: CycleStatus, to: CycleStatus): boolean {
  if (from === to) return true;
  if (TERMINAL.includes(from)) return false;
  const allowed: Record<CycleStatus, CycleStatus[]> = {
    CREATED: ["PLANNING", "ABANDONED"],
    PLANNING: ["READY", "BLOCKED", "PAUSED", "ABANDONED", "FAILED", "COMPLETED", "EXECUTING"],
    READY: ["EXECUTING", "TESTING", "REVIEWING", "SECURITY", "PAUSED", "BLOCKED", "ABANDONED", "FAILED", "COMPLETED"],
    EXECUTING: ["TESTING", "REVIEWING", "SECURITY", "PAUSED", "BLOCKED", "FAILED", "ABANDONED", "READY", "COMPLETED"],
    TESTING: ["REVIEWING", "SECURITY", "EXECUTING", "PAUSED", "BLOCKED", "FAILED", "COMPLETED", "ABANDONED"],
    REVIEWING: ["SECURITY", "TESTING", "COMPLETED", "ABANDONED", "BLOCKED", "WAITING_EXTERNAL"],
    SECURITY: ["REVIEWING", "COMPLETED", "ABANDONED", "BLOCKED"],
    PAUSED: ["READY", "EXECUTING", "ABANDONED", "FAILED"],
    BLOCKED: ["READY", "PAUSED", "ABANDONED", "FAILED"],
    WAITING_EXTERNAL: ["COMPLETED", "ABANDONED", "REVIEWING"],
    FAILED: [],
    ABANDONED: [],
    COMPLETED: [],
  };
  return allowed[from]?.includes(to) ?? false;
}
