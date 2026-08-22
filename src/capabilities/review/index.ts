import type { Cycle } from "../../core/cycle/index.js";

export function runReview(cycle: Cycle) {
  const gaps: Array<{ code: string; detail: string }> = [];
  const test = cycle.payload.test as { ran?: boolean; status?: string } | undefined;
  if (!test?.ran) gaps.push({ code: "TESTS_NOT_RUN", detail: "No evidenced test execution exists for this Cycle." });
  else if (test.status === "FAILED") gaps.push({ code: "TESTS_FAILED", detail: "Last evidenced test run failed." });
  const exec = cycle.payload.execution as { status?: string } | undefined;
  if (exec?.status !== "EXECUTION_AUTHORIZED") {
    gaps.push({ code: "DEV_NOT_AUTHORIZED", detail: "No authorized execution envelope was recorded." });
  }
  if (cycle.payload.risk?.level === "HIGH" && !cycle.payload.approvals.length) {
    gaps.push({ code: "HIGH_RISK_UNAPPROVED", detail: "HIGH risk remains without recorded approval." });
  }
  return {
    name: "review",
    status: "SUCCEEDED" as const,
    output: {
      status: "REVIEWED",
      verdict: gaps.length ? "INCOMPLETE" : "READY_FOR_CLOSE",
      gaps,
      note: "Review reports evidenced gaps only. It does not certify code quality.",
    },
  };
}
