import { decidePermission } from "../engines/permission/index.js";
import { isForbiddenCommand } from "../engines/execution/index.js";
import type { RiskLevel } from "../shared/contracts.js";

export type ToolName = "git.status" | "git.commit" | "git.push" | "process.run";

export function invokeTool(
  tool: ToolName,
  command: string[],
  riskLevel: RiskLevel,
  approved: boolean,
) {
  if (tool === "git.push" || isForbiddenCommand(command)) {
    return { status: "BLOCKED" as const, tool, reason: "Tool is forbidden by policy." };
  }
  const permission = decidePermission(tool === "git.commit" ? "HIGH" : riskLevel, approved);
  if (permission.decision !== "ALLOW") {
    return { status: permission.decision, tool, permission };
  }
  return { status: "ALLOW" as const, tool, permission };
}
