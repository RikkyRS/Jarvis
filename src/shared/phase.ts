export const PHASE_NAMES = {
  0: "Bootstrap",
  1: "Contracts",
  2: "Persistence",
  3: "Cycle Engine",
  4: "Reconciliation",
  5: "Orchestrator",
  6: "Tool Registry / Permission",
  7: "Execution Engine",
  8: "Git Engine",
  9: "Contract / Acceptance",
  10: "Context Engine",
  11: "Impact Engine",
  12: "Risk Engine",
  13: "Memory Engine",
  14: "Capabilities",
  15: "Test Engine",
  16: "Security Engine",
  17: ".harness",
  18: "CLI",
  19: "Adapters / Installation",
  20: "Test Architecture",
  21: "End-to-End",
  22: "Final Architecture Review",
} as const;

export type PhaseId = keyof typeof PHASE_NAMES;

export type PhaseGate = {
  status: "PHASE_NOT_REACHED";
  phase: number;
  phaseName: string;
  component: string;
  message: string;
};

export function phaseNotReached(phase: number, component: string): PhaseGate {
  const phaseName = PHASE_NAMES[phase as PhaseId] ?? `Phase ${phase}`;
  return {
    status: "PHASE_NOT_REACHED",
    phase,
    phaseName,
    component,
    message: `${component} belongs to ${phaseName}. It is not implemented yet and will not pretend otherwise.`,
  };
}
