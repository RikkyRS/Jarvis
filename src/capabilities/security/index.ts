import type { Cycle } from "../../core/cycle/index.js";

export function runSecurityCapability(cycle: Cycle) {
  return { name: "security", status: "SUCCEEDED" as const, output: cycle.payload.security };
}
