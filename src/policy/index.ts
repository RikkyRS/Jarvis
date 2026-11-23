import type {
  OperationRequest,
  OperationType,
  PolicyDecision,
  RiskLevel,
} from "../domain/contracts.js";

const BASE_RISK: Readonly<Record<OperationType, RiskLevel>> = {
  FILE_READ: "LOW",
  GIT_INSPECT: "LOW",
  FILE_EDIT: "MEDIUM",
  TEST_RUN: "MEDIUM",
  GIT_STAGE: "MEDIUM",
  GIT_COMMIT: "HIGH",
  GIT_PUSH: "HIGH",
  GIT_MERGE: "HIGH",
  GIT_FORCE_PUSH: "CRITICAL",
  GIT_RESET_HARD: "CRITICAL",
  GIT_CLEAN: "CRITICAL",
};

const ORDER: readonly RiskLevel[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];

/**
 * Project configuration may only make policy stricter. Mandatory safeguards
 * (CRITICAL blocked, HIGH needs approval) cannot be weakened from here.
 */
export type PolicyConfig = {
  /** Raise the risk of specific operation types (never lower). */
  raiseRisk?: Partial<Record<OperationType, RiskLevel>>;
  /** Additionally require approval for these types, regardless of risk. */
  requireApproval?: readonly OperationType[];
};

export type PolicyResult = {
  decision: PolicyDecision;
  risk: RiskLevel;
  reason: string;
};

function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return ORDER.indexOf(a) >= ORDER.indexOf(b) ? a : b;
}

export function riskOf(type: OperationType, config: PolicyConfig = {}): RiskLevel {
  const raised = config.raiseRisk?.[type];
  return raised ? maxRisk(BASE_RISK[type], raised) : BASE_RISK[type];
}

export function evaluatePolicy(
  request: Pick<OperationRequest, "type" | "requestedBy">,
  config: PolicyConfig = {},
): PolicyResult {
  const risk = riskOf(request.type, config);
  if (risk === "CRITICAL") {
    return {
      decision: "BLOCKED",
      risk,
      reason: `${request.type} is critical and blocked by default.`,
    };
  }
  if (risk === "HIGH" || config.requireApproval?.includes(request.type)) {
    return {
      decision: "APPROVAL_REQUIRED",
      risk,
      reason: `${request.type} needs operation-specific approval.`,
    };
  }
  return { decision: "ALLOW", risk, reason: `${request.type} is permitted by policy.` };
}
