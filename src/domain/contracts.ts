import { z } from "zod";

/** Canonical runtime contracts. JSON Schema for external clients is generated from these. */

export const IdSchema = z.string().min(1).max(128);
export const IsoDateSchema = z.string().datetime();

export const PrincipalKindSchema = z.enum(["human", "agent", "system"]);
export const PrincipalSchema = z.object({ kind: PrincipalKindSchema, id: IdSchema }).strict();
export type Principal = z.infer<typeof PrincipalSchema>;

export const OperationTypeSchema = z.enum([
  "FILE_READ",
  "GIT_INSPECT",
  "FILE_EDIT",
  "TEST_RUN",
  "GIT_STAGE",
  "GIT_COMMIT",
  "GIT_PUSH",
  "GIT_MERGE",
  "GIT_FORCE_PUSH",
  "GIT_RESET_HARD",
  "GIT_CLEAN",
]);
export type OperationType = z.infer<typeof OperationTypeSchema>;

export const RiskLevelSchema = z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const PolicyDecisionSchema = z.enum(["ALLOW", "APPROVAL_REQUIRED", "BLOCKED"]);
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;

export const TrustSchema = z.enum(["TRUSTED", "UNTRUSTED"]);
export type Trust = z.infer<typeof TrustSchema>;

const JsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(JsonValueSchema),
  ]),
);

export const OperationRequestSchema = z
  .object({
    operationId: IdSchema,
    projectId: IdSchema,
    workItemId: IdSchema,
    workflowRunId: IdSchema,
    requestedBy: PrincipalSchema,
    type: OperationTypeSchema,
    /** Path or ref the operation acts on. Paths are canonicalized by the gateway. */
    target: z.string().min(1).max(4096),
    /** Normalized, secret-free parameters (command argv, diff digest, remote, branch...). */
    parameters: z.record(JsonValueSchema).default({}),
    /** Provenance-based classification; never taken from an agent's claim. */
    trust: TrustSchema.default("UNTRUSTED"),
  })
  .strict();
export type OperationRequest = z.infer<typeof OperationRequestSchema>;
export type OperationRequestInput = z.input<typeof OperationRequestSchema>;

export const ApprovalStatusSchema = z.enum([
  "PENDING",
  "APPROVED",
  "CONSUMED",
  "REJECTED",
  "EXPIRED",
]);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

export const ApprovalSchema = z
  .object({
    id: IdSchema,
    operationId: IdSchema,
    projectId: IdSchema,
    workItemId: IdSchema,
    workflowRunId: IdSchema,
    requestedBy: PrincipalSchema,
    type: OperationTypeSchema,
    target: z.string().min(1),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    status: ApprovalStatusSchema,
    createdAt: IsoDateSchema,
    expiresAt: IsoDateSchema,
    decidedBy: IdSchema.nullable(),
    decidedAt: IsoDateSchema.nullable(),
    consumedAt: IsoDateSchema.nullable(),
  })
  .strict();
export type Approval = z.infer<typeof ApprovalSchema>;

export const WorkItemStatusSchema = z.enum([
  "OPEN",
  "IN_PROGRESS",
  "DELIVERED",
  "REOPENED",
  "CLOSED",
]);
export type WorkItemStatus = z.infer<typeof WorkItemStatusSchema>;

export const WorkflowRunStatusSchema = z.enum([
  "PLANNED",
  "PREPARING",
  "AWAITING_EXECUTION_APPROVAL",
  "RUNNING",
  "PAUSED",
  "AWAITING_REVIEW",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
]);
export type WorkflowRunStatus = z.infer<typeof WorkflowRunStatusSchema>;
