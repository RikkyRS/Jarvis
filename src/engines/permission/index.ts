import type { PermissionDecisionReport, RiskLevel } from "../../shared/contracts.js";
import type { ProjectPolicy } from "../../infrastructure/project-policy.js";

const RANK: Record<RiskLevel, number> = { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };

export function decidePermission(
  riskLevel: RiskLevel,
  approved: boolean,
  policy?: Pick<ProjectPolicy["risk"], "requireApprovalFrom" | "blockCritical">,
): PermissionDecisionReport {
  const blockCritical = policy?.blockCritical ?? true;
  const threshold = policy?.requireApprovalFrom ?? "HIGH";
  if (blockCritical && riskLevel === "CRITICAL") {
    return { decision: "BLOCKED", riskLevel, reason: "CRITICAL operations are blocked." };
  }
  if (RANK[riskLevel] >= RANK[threshold] && !approved) {
    return {
      decision: "APPROVAL_REQUIRED",
      riskLevel,
      reason: `${threshold}-or-higher operations require explicit approval (--approve).`,
    };
  }
  return { decision: "ALLOW", riskLevel, reason: "Operation permitted under current risk policy." };
}
