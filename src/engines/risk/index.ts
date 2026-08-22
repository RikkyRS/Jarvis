import type { ImpactReport, RiskLevel, RiskReport } from "../../shared/contracts.js";

const CRITICAL = [/force\s*push/i, /git\s+push\s+--force/i, /--force-with-lease/i, /reset\s+--hard/i, /drop\s+database/i, /\brm\s+-rf\b/i];

const RANK: Record<RiskLevel, number> = { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };

function maxLevel(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RANK[a] >= RANK[b] ? a : b;
}

export function assessRisk(objective: string, impact: ImpactReport, securityHighest: RiskLevel = "LOW"): RiskReport {
  const reasons: string[] = [];
  let level: RiskLevel = "LOW";

  if (CRITICAL.some((pattern) => pattern.test(objective))) {
    level = "CRITICAL";
    reasons.push("objective matched a destructive pattern");
  }
  if (securityHighest === "CRITICAL") {
    level = "CRITICAL";
    reasons.push("security engine reported CRITICAL");
  } else if (securityHighest === "HIGH") {
    level = maxLevel(level, "HIGH");
    reasons.push("security engine reported HIGH");
  }
  if (impact.unknownExternalConsumers.length) {
    level = maxLevel(level, "HIGH");
    reasons.push("unknown external consumers cannot be disproven");
  }
  if ((impact.layers.DATA?.length ?? 0) > 0) {
    level = maxLevel(level, "MEDIUM");
    reasons.push("data layer files were evidenced");
  }
  const nonHuman = Object.entries(impact.layers).some(([key, items]) => key !== "HUMAN" && (items?.length ?? 0) > 0);
  if (nonHuman) level = maxLevel(level, "MEDIUM");
  if (impact.confidence === "LOW" && level !== "CRITICAL") {
    reasons.push("uncertainty raises risk; it never lowers it");
  }
  if (!reasons.length) reasons.push("no elevated risk evidenced");
  return {
    level,
    reasons,
    accumulated: level,
    uncertaintyRaisesRisk: impact.confidence === "LOW" || impact.unknownExternalConsumers.length > 0,
  };
}

export function accumulateRisk(previous: RiskReport | undefined, current: RiskReport): RiskReport {
  const accumulated = maxLevel(previous?.accumulated ?? "LOW", current.level);
  const reasons = [...new Set([...(previous?.reasons ?? []), ...current.reasons])];
  return {
    level: current.level,
    reasons,
    accumulated,
    uncertaintyRaisesRisk: current.uncertaintyRaisesRisk || (previous?.uncertaintyRaisesRisk ?? false),
  };
}
