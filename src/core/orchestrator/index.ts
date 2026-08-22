import {
  IDENTICAL_FINGERPRINT_LOOP_THRESHOLD,
  MAX_RETRIES_PER_LOGICAL_OPERATION,
} from "../../shared/invariants.js";
import { fingerprint } from "../../shared/util.js";

export type OrchestratorState = {
  iterations: number;
  tokensUsed: number;
  retryCountByAction: Record<string, number>;
  fingerprints: string[];
  maxIterations: number;
  maxRetriesPerAction: number;
};

export function emptyOrchestrator(): OrchestratorState {
  return {
    iterations: 0,
    tokensUsed: 0,
    retryCountByAction: {},
    fingerprints: [],
    maxIterations: 50,
    maxRetriesPerAction: MAX_RETRIES_PER_LOGICAL_OPERATION,
  };
}

export function guard(state: OrchestratorState, action: { command: string; cycleId: string; extra: unknown }) {
  if (state.iterations >= state.maxIterations) {
    return { ok: false as const, reason: "iteration_budget_exceeded", state };
  }
  const next = {
    ...state,
    iterations: state.iterations + 1,
    fingerprints: [...state.fingerprints, fingerprint(action)].slice(-20),
  };
  const recent = next.fingerprints.slice(-IDENTICAL_FINGERPRINT_LOOP_THRESHOLD);
  if (
    recent.length === IDENTICAL_FINGERPRINT_LOOP_THRESHOLD &&
    recent.every((item) => item === recent[0])
  ) {
    return { ok: false as const, reason: "loop_detected", state: next };
  }
  return { ok: true as const, state: next };
}

export function registerRetry(state: OrchestratorState, actionId: string) {
  const count = (state.retryCountByAction[actionId] ?? 0) + 1;
  const next = {
    ...state,
    retryCountByAction: { ...state.retryCountByAction, [actionId]: count },
  };
  if (count > state.maxRetriesPerAction) {
    return { ok: false as const, reason: "max_retries_exceeded", state: next };
  }
  return { ok: true as const, state: next };
}
