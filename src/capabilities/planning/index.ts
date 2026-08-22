import type { Cycle } from "../../core/cycle/index.js";

export function runPlanning(cycle: Cycle) {
  return {
    name: "planning",
    status: "SUCCEEDED" as const,
    output: { cycleId: cycle.id, contract: cycle.payload.contract },
  };
}
