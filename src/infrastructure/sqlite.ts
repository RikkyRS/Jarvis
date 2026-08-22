import { phaseNotReached } from "../shared/phase.js";

export const PHASE = 2;
export const NAME = "SqliteStore";

export function connect() {
  return phaseNotReached(PHASE, NAME);
}
