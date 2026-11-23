import { z } from "zod";
import type { Principal, RiskLevel } from "../domain/contracts.js";
import type { Plan, Readiness } from "../planning/index.js";
import { riskOf, type PolicyConfig } from "../policy/index.js";
import { fingerprint } from "../shared/canonical.js";

/**
 * Delegated autonomy. The human decides ONCE, in `.jarvis/config.json` (which an agent cannot
 * write), how much JARVIS may do without asking. At level INTERMEDIATE a plan whose every operation
 * is LOW or MEDIUM risk is approved and started by the delegation; anything HIGH or CRITICAL
 * (commit, push, merge, removing a worktree, force operations) still needs the human, one operation
 * at a time. Every automatic decision is attributed to the `autonomy` actor and records the
 * fingerprint of the configuration that allowed it, so it can always be traced to the human choice.
 */

export const AutonomyConfigSchema = z
  .object({
    level: z.enum(["SUPERVISED", "INTERMEDIATE"]).default("SUPERVISED"),
    /** Plans estimated above this many tokens still wait for the human. */
    maxEstimateTokens: z.number().int().positive().optional(),
    /** Confirm client requests that triage found IN_SCOPE (never OUT_OF_SCOPE, UNCLEAR or duplicates). */
    autoConfirmInScope: z.boolean().default(false),
  })
  .strict();
export type AutonomyConfig = z.infer<typeof AutonomyConfigSchema>;

export const DEFAULT_AUTONOMY: AutonomyConfig = { level: "SUPERVISED", autoConfirmInScope: false };
export const AUTONOMY_ACTOR: Principal = { kind: "system", id: "autonomy" };
export const AUTONOMY_MAX_RISK: RiskLevel = "MEDIUM";

export const autonomyFingerprint = (config: AutonomyConfig): string => fingerprint(config);

export type Eligibility = { eligible: boolean; reasons: string[] };

const touchesControlFiles = (path: string): boolean => {
  const p = path.split("\\").join("/").replace(/^\.\//, "");
  return p === ".jarvis" || p.startsWith(".jarvis/");
};

/** Pure decision: may this plan run on the delegation alone? Every reason it may not is returned. */
export function evaluateAutonomy(input: {
  plan: Plan;
  estimate: number;
  readiness: Readiness;
  config: AutonomyConfig;
  policy: PolicyConfig;
  executionAllowance: number;
}): Eligibility {
  const reasons: string[] = [];
  if (input.config.level !== "INTERMEDIATE") reasons.push("LEVEL_SUPERVISED");
  if (!input.readiness.ready)
    reasons.push(`PLAN_NOT_READY:${input.readiness.blockers.map((b) => b.code).join(",")}`);

  const ops = new Set(input.plan.steps.flatMap((s) => s.operations));
  const high = [...ops].filter(
    (o) => riskOf(o, input.policy) !== "LOW" && riskOf(o, input.policy) !== "MEDIUM",
  );
  if (high.length) reasons.push(`RISK_ABOVE_MEDIUM:${high.join(",")}`);
  const asked = [...ops].filter((o) => input.policy.requireApproval?.includes(o));
  if (asked.length) reasons.push(`PROJECT_REQUIRES_APPROVAL:${asked.join(",")}`);

  if (input.plan.steps.some((s) => s.paths.some(touchesControlFiles)))
    reasons.push("TOUCHES_CONTROL_FILES");
  if (
    input.config.maxEstimateTokens !== undefined &&
    input.estimate > input.config.maxEstimateTokens
  )
    reasons.push("ESTIMATE_ABOVE_LIMIT");
  if (input.estimate > input.executionAllowance) reasons.push("ESTIMATE_ABOVE_BUDGET");
  return { eligible: reasons.length === 0, reasons };
}
