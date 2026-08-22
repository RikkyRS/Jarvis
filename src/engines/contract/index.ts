import { randomUUID } from "node:crypto";
import type { Contract } from "../../shared/contracts.js";
import { slugify } from "../../shared/util.js";

export function buildContract(objective: string, number: number): Contract {
  return {
    id: { uuid: randomUUID(), number, slug: slugify(objective) },
    objective,
    scope: ["changes required to satisfy the stated objective"],
    outOfScope: ["unrelated refactors", "push/merge/PR automation"],
    constraints: [
      "Evidence-First",
      "Do not discard pre-existing human changes",
      "HIGH requires --approve",
      "CRITICAL is blocked",
    ],
    acceptanceCriteria: [
      {
        id: "AC-1",
        statement: `The objective is satisfied: ${objective}`,
        evidenceRequired: "test run or explicit review evidence",
        validationStrategy: "test_or_review",
        status: "UNKNOWN",
      },
      {
        id: "AC-2",
        statement: "Pre-existing human changes remain intact",
        evidenceRequired: "git status / HUMAN layer on impact",
        validationStrategy: "git",
        status: "UNKNOWN",
      },
    ],
  };
}

export function cannotComplete(contract: Contract): boolean {
  return contract.acceptanceCriteria.some((item) => item.status === "FAIL" || item.status === "UNKNOWN");
}
