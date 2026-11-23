import { z } from "zod";
import type { Principal, WorkItem } from "../domain/contracts.js";
import type { DomainStore } from "../persistence/repositories.js";
import { DomainError } from "../persistence/repositories.js";

/**
 * Requirement & Context Analyzer. It does not guess: material unknowns become concise questions,
 * grouped into as few rounds as practical, never repeating what is already known and valid.
 * Low-impact, reversible details follow project conventions and are recorded as such.
 */

export const QuestionSchema = z
  .object({
    id: z.string().min(1),
    /** What the answer decides. Used to avoid asking about something already known. */
    topic: z.string().min(1),
    text: z.string().min(1).max(500),
    impact: z.enum(["MATERIAL", "LOW"]),
    /** Default applied when impact is LOW and the human does not answer. */
    conventionDefault: z.string().optional(),
  })
  .strict();
export type Question = z.infer<typeof QuestionSchema>;

export type Round = {
  questions: Question[];
  deferred: Question[];
  assumedByConvention: { topic: string; assumption: string }[];
};

/**
 * Selects the questions for ONE clarification round.
 * @param known topics already answered and still valid (e.g. from decisions or fresh knowledge claims)
 */
export function planRound(
  questions: readonly Question[],
  known: ReadonlySet<string>,
  maxPerRound = 5,
): Round {
  const seen = new Set<string>();
  const open: Question[] = [];
  for (const q of questions.map((x) => QuestionSchema.parse(x))) {
    if (known.has(q.topic) || seen.has(q.topic)) continue;
    seen.add(q.topic);
    open.push(q);
  }
  const material = open.filter((q) => q.impact === "MATERIAL");
  const low = open.filter((q) => q.impact === "LOW");
  return {
    questions: material.slice(0, maxPerRound),
    deferred: material.slice(maxPerRound),
    assumedByConvention: low.map((q) => ({
      topic: q.topic,
      assumption: q.conventionDefault ?? "follow existing project conventions",
    })),
  };
}

export type Alternative = { name: string; tradeoffs: string[]; recommended?: boolean };

/** A material architectural, security, data, cost or product decision always carries a recommendation. */
export function presentDecision(
  topic: string,
  alternatives: readonly Alternative[],
): { topic: string; alternatives: Alternative[]; recommendation: string } {
  if (alternatives.length < 2) throw new DomainError("A decision needs at least two alternatives.");
  const recommended = alternatives.filter((a) => a.recommended);
  if (recommended.length !== 1)
    throw new DomainError("Exactly one alternative must be recommended.");
  return { topic, alternatives: [...alternatives], recommendation: recommended[0]!.name };
}

export type Answer = {
  questionId: string;
  topic: string;
  answer: string;
  kind: "REQUIREMENT" | "ACCEPTANCE" | "DECISION";
};

/** Converts confirmed answers into explicit requirements, acceptance criteria and decisions on the Work Item. */
export function applyAnswers(
  store: DomainStore,
  workItemId: string,
  actor: Principal,
  answers: readonly Answer[],
): WorkItem {
  if (actor.kind !== "human") throw new DomainError("Only a human can confirm requirements.");
  const item = store.getWorkItem(workItemId);
  if (!item) throw new DomainError("Unknown work item.");
  const requirements = [...item.requirements];
  const acceptance = [...item.acceptanceCriteria];
  for (const a of answers) {
    if (a.kind === "REQUIREMENT" && !requirements.includes(a.answer)) requirements.push(a.answer);
    if (a.kind === "ACCEPTANCE" && !acceptance.includes(a.answer)) acceptance.push(a.answer);
    if (a.kind === "DECISION") store.addDecision(workItemId, actor, `${a.topic}: ${a.answer}`);
  }
  store.updateScope(workItemId, actor, { requirements, acceptanceCriteria: acceptance });
  return store.getWorkItem(workItemId)!;
}
