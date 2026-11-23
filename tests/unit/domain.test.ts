import { describe, expect, it } from "vitest";
import { OperationRequestSchema } from "../../src/domain/contracts.js";
import {
  InvalidTransitionError,
  isTerminalRun,
  transitionItem,
  transitionRun,
} from "../../src/domain/workflow.js";
import { evaluatePolicy, riskOf } from "../../src/policy/index.js";
import { canonicalJson, fingerprint } from "../../src/shared/canonical.js";

const human = { kind: "human", id: "rikky" } as const;

describe("workflow state machine", () => {
  it("[R-STATE-01] allows the happy path and rejects shortcuts", () => {
    expect(transitionRun("PLANNED", "PREPARING")).toBe("PREPARING");
    expect(transitionRun("AWAITING_EXECUTION_APPROVAL", "RUNNING")).toBe("RUNNING");
    expect(() => transitionRun("PLANNED", "RUNNING")).toThrow(InvalidTransitionError);
    expect(() => transitionRun("PREPARING", "RUNNING")).toThrow(InvalidTransitionError);
  });

  it("treats completed, failed and cancelled as terminal", () => {
    for (const s of ["COMPLETED", "FAILED", "CANCELLED"] as const) {
      expect(isTerminalRun(s)).toBe(true);
      expect(() => transitionRun(s, "RUNNING")).toThrow(InvalidTransitionError);
    }
  });

  it("lets a delivered or closed work item be reopened", () => {
    expect(transitionItem("DELIVERED", "REOPENED")).toBe("REOPENED");
    expect(transitionItem("CLOSED", "REOPENED")).toBe("REOPENED");
    expect(() => transitionItem("OPEN", "DELIVERED")).toThrow(InvalidTransitionError);
  });
});

describe("policy", () => {
  it("allows low/medium, requires approval for high, blocks critical", () => {
    expect(evaluatePolicy({ type: "FILE_READ", requestedBy: human }).decision).toBe("ALLOW");
    expect(evaluatePolicy({ type: "FILE_EDIT", requestedBy: human }).decision).toBe("ALLOW");
    expect(evaluatePolicy({ type: "GIT_COMMIT", requestedBy: human }).decision).toBe(
      "APPROVAL_REQUIRED",
    );
    expect(evaluatePolicy({ type: "GIT_PUSH", requestedBy: human }).decision).toBe(
      "APPROVAL_REQUIRED",
    );
    for (const type of ["GIT_FORCE_PUSH", "GIT_RESET_HARD", "GIT_CLEAN"] as const) {
      expect(evaluatePolicy({ type, requestedBy: human }).decision).toBe("BLOCKED");
    }
  });

  it("[R-POLICY-01] lets project config tighten but never weaken", () => {
    expect(
      evaluatePolicy({ type: "FILE_EDIT", requestedBy: human }, { requireApproval: ["FILE_EDIT"] })
        .decision,
    ).toBe("APPROVAL_REQUIRED");
    expect(riskOf("GIT_FORCE_PUSH", { raiseRisk: { GIT_FORCE_PUSH: "LOW" } })).toBe("CRITICAL");
    expect(riskOf("GIT_COMMIT", { raiseRisk: { GIT_COMMIT: "LOW" } })).toBe("HIGH");
    expect(riskOf("FILE_EDIT", { raiseRisk: { FILE_EDIT: "CRITICAL" } })).toBe("CRITICAL");
  });
});

describe("contracts and canonical hashing", () => {
  it("defaults trust to UNTRUSTED and rejects unknown fields", () => {
    const base = {
      operationId: "op1",
      projectId: "p",
      workItemId: "w",
      workflowRunId: "r",
      requestedBy: human,
      type: "FILE_EDIT",
      target: "a.txt",
    };
    expect(OperationRequestSchema.parse(base).trust).toBe("UNTRUSTED");
    expect(() => OperationRequestSchema.parse({ ...base, approved: true })).toThrow();
  });

  it("is key-order independent and rejects non-JSON values", () => {
    expect(fingerprint({ a: 1, b: { c: 2, d: 3 } })).toBe(fingerprint({ b: { d: 3, c: 2 }, a: 1 }));
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }));
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalJson({ a: new Date() })).toThrow(TypeError);
    const cycle: Record<string, unknown> = {};
    cycle["self"] = cycle;
    expect(() => canonicalJson(cycle)).toThrow(TypeError);
  });
});
