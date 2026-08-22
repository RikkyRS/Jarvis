import { describe, expect, it } from "vitest";
import { emptyOrchestrator, guard, registerRetry } from "../../src/core/orchestrator/index.js";

describe("orchestrator guards", () => {
  it("stops identical fingerprints on the third repeat", () => {
    let state = emptyOrchestrator();
    const action = { command: "dev", cycleId: "c1", extra: { status: "READY" } };
    for (let i = 0; i < 2; i += 1) {
      const result = guard(state, action);
      expect(result.ok).toBe(true);
      state = result.state;
    }
    const third = guard(state, action);
    expect(third.ok).toBe(false);
    expect(third.reason).toBe("loop_detected");
  });

  it("caps retries at 3", () => {
    let state = emptyOrchestrator();
    for (let i = 0; i < 3; i += 1) {
      const result = registerRetry(state, "a");
      expect(result.ok).toBe(true);
      state = result.state;
    }
    expect(registerRetry(state, "a").ok).toBe(false);
  });
});
