import type { Cycle } from "../../core/cycle/index.js";

export function runDiagnostic(cycle: Cycle) {
  return { name: "diagnostic", status: "SUCCEEDED" as const, output: cycle.payload.gitReconciliation };
}
