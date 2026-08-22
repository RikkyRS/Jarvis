import type { PermissionDecisionReport, RiskLevel } from "../../shared/contracts.js";

export function decidePermission(riskLevel: RiskLevel, approved: boolean): PermissionDecisionReport {
  if (riskLevel === "CRITICAL") {
    return { decision: "BLOCKED", riskLevel, reason: "CRITICAL operations are blocked." };
  }
  if (riskLevel === "HIGH" && !approved) {
    return {
      decision: "APPROVAL_REQUIRED",
      riskLevel,
      reason: "HIGH-risk operations require explicit approval (--approve).",
    };
  }
  return { decision: "ALLOW", riskLevel, reason: "Operation permitted under current risk policy." };
}
