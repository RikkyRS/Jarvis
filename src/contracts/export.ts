import { zodToJsonSchema } from "zod-to-json-schema";
import type { ZodTypeAny } from "zod";
import {
  ApprovalSchema,
  OperationRequestSchema,
  ProjectSchema,
  WorkItemSchema,
  WorkflowRunSchema,
} from "../domain/contracts.js";
import {
  AssociationSchema,
  CheckResultSchema,
  FindingSchema,
  IntegrationReportSchema,
} from "../integration/resolver.js";
import { ClaimSchema } from "../knowledge/index.js";
import { PlanSchema } from "../planning/index.js";

/** Bump when an exported contract changes incompatibly. The committed snapshot guards this. */
export const CONTRACT_VERSION = "1.0.0";

const CONTRACTS: Record<string, ZodTypeAny> = {
  OperationRequest: OperationRequestSchema,
  Approval: ApprovalSchema,
  Project: ProjectSchema,
  WorkItem: WorkItemSchema,
  WorkflowRun: WorkflowRunSchema,
  Claim: ClaimSchema,
  Plan: PlanSchema,
  Association: AssociationSchema,
  CheckResult: CheckResultSchema,
  Finding: FindingSchema,
  IntegrationReport: IntegrationReportSchema,
};

export class UnsupportedSchemaError extends Error {
  constructor(contract: string, detail: string) {
    super(`Contract ${contract} cannot be exported faithfully: ${detail}`);
    this.name = "UnsupportedSchemaError";
  }
}

/** Walks a generated schema and rejects anything that would silently publish an incomplete contract. */
const isEmptySchema = (v: unknown): boolean =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v as object).length === 0;

/**
 * Rejects anything that would silently publish an incomplete contract: an empty schema (`{}`,
 * i.e. "anything") in a position where a type is expected, or a reference leaving the document.
 */
function assertComplete(contract: string, node: unknown, path = "$"): void {
  if (Array.isArray(node)) {
    node.forEach((n, i) => {
      if (isEmptySchema(n))
        throw new UnsupportedSchemaError(contract, `unconstrained schema at ${path}[${i}]`);
      assertComplete(contract, n, `${path}[${i}]`);
    });
    return;
  }
  if (node === null || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  const ref = obj["$ref"];
  if (typeof ref === "string" && !ref.startsWith("#")) {
    throw new UnsupportedSchemaError(contract, `external reference at ${path}`);
  }
  for (const key of ["items", "additionalProperties"]) {
    if (key in obj && isEmptySchema(obj[key])) {
      throw new UnsupportedSchemaError(contract, `unconstrained "${key}" at ${path}`);
    }
  }
  for (const [key, value] of Object.entries(
    (obj["properties"] as Record<string, unknown> | undefined) ?? {},
  )) {
    if (isEmptySchema(value))
      throw new UnsupportedSchemaError(contract, `unconstrained property "${key}" at ${path}`);
  }
  for (const [k, v] of Object.entries(obj)) assertComplete(contract, v, `${path}.${k}`);
}

export function exportSchemas(): { version: string; contracts: Record<string, unknown> } {
  const contracts: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(CONTRACTS)) {
    const json = zodToJsonSchema(schema, { $refStrategy: "root", target: "jsonSchema7" });
    assertComplete(name, json);
    contracts[name] = json;
  }
  return { version: CONTRACT_VERSION, contracts };
}
