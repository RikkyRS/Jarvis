import { FORBIDDEN_OPERATIONS } from "../../shared/policy.js";
import type { Cycle } from "../../core/cycle/index.js";
import type { PermissionDecisionReport } from "../../shared/contracts.js";

export function runDevelopment(cycle: Cycle, permission: PermissionDecisionReport, humanPaths: string[]) {
  const envelope = {
    objective: cycle.objective,
    allowed: [
      "read project files",
      "propose local changes that do not overwrite protected paths",
      "record evidence via JARVIS commands",
    ],
    forbidden: FORBIDDEN_OPERATIONS,
    protectedHumanPaths: humanPaths,
  };
  if (permission.decision === "BLOCKED") {
    return { name: "development", status: "FAILED" as const, output: { status: "BLOCKED", permission, envelope } };
  }
  if (permission.decision === "APPROVAL_REQUIRED") {
    return {
      name: "development",
      status: "PAUSED" as const,
      output: { status: "REQUIRES_APPROVAL", permission, envelope },
    };
  }
  return {
    name: "development",
    status: "SUCCEEDED" as const,
    output: {
      status: "EXECUTION_AUTHORIZED",
      permission,
      envelope,
      message: "Host may implement inside this envelope. JARVIS will not push, merge, or open PRs.",
    },
  };
}
