import { z } from "zod";
import { IdSchema } from "./ids.js";

export const KnowledgeStateSchema = z.enum(["KNOWN", "INFERRED", "UNKNOWN", "CONTRADICTED"]);
export const ConfidenceSchema = z.enum(["NONE", "LOW", "MEDIUM", "HIGH"]);
export const RiskLevelSchema = z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
export const PermissionDecisionSchema = z.enum(["ALLOW", "APPROVAL_REQUIRED", "BLOCKED"]);

export const CycleStatusSchema = z.enum([
  "CREATED",
  "PLANNING",
  "READY",
  "EXECUTING",
  "TESTING",
  "REVIEWING",
  "SECURITY",
  "PAUSED",
  "BLOCKED",
  "WAITING_EXTERNAL",
  "FAILED",
  "ABANDONED",
  "COMPLETED",
]);

export const EvidenceSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  content: z.unknown(),
  source: z.string().min(1),
  timestamp: z.string().datetime(),
  knowledgeState: KnowledgeStateSchema,
  confidence: ConfidenceSchema,
});

export const EventSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  cycleId: z.string().optional(),
  timestamp: z.string().datetime(),
  payload: z.unknown(),
});

export const ActionSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  cycleId: z.string().min(1),
  input: z.unknown(),
});

export const ResultSchema = z.object({
  actionId: z.string().min(1),
  status: z.enum(["SUCCEEDED", "FAILED", "UNKNOWN", "BLOCKED", "WAITING"]),
  evidence: z.array(EvidenceSchema).default([]),
  output: z.unknown().optional(),
});

export const AcceptanceCriterionSchema = z.object({
  id: z.string().regex(/^AC-\d+$/),
  statement: z.string().min(1),
  evidenceRequired: z.string().min(1),
  validationStrategy: z.string().min(1),
  status: z.enum(["PASS", "FAIL", "SKIP", "UNKNOWN"]),
});

export const ContractSchema = z.object({
  id: IdSchema,
  objective: z.string().min(1),
  scope: z.array(z.string()),
  outOfScope: z.array(z.string()),
  constraints: z.array(z.string()),
  acceptanceCriteria: z.array(AcceptanceCriterionSchema),
});

export const ContextPackageSchema = z.object({
  targetProject: z.string().min(1),
  levels: z.object({
    L0: z.object({
      status: z.enum(["COMPLETE", "UNKNOWN", "DEFERRED"]),
      ecosystems: z.array(z.string()),
    }),
    L1: z.object({
      status: z.enum(["COMPLETE", "UNKNOWN", "DEFERRED"]),
      topLevel: z.array(z.string()),
    }),
    L2: z.object({
      status: z.enum(["COMPLETE", "UNKNOWN", "DEFERRED"]),
      reason: z.string().optional(),
    }),
  }),
  knowledgeState: KnowledgeStateSchema,
  confidence: ConfidenceSchema,
});

export const ImpactLayerSchema = z.enum([
  "DIRECT",
  "INDIRECT",
  "CONTRACT",
  "DATA",
  "TEST",
  "CONFIG",
  "EXTERNAL",
  "HUMAN",
]);

export const ImpactEvidenceSchema = z.object({
  path: z.string().min(1),
  layer: ImpactLayerSchema,
  reason: z.string().min(1),
  knowledgeState: KnowledgeStateSchema,
});

export const ImpactReportSchema = z.object({
  layers: z.record(ImpactLayerSchema, z.array(ImpactEvidenceSchema)),
  unknownExternalConsumers: z.array(z.string()),
  confidence: ConfidenceSchema,
});

export const RiskReportSchema = z.object({
  level: RiskLevelSchema,
  reasons: z.array(z.string()),
  accumulated: RiskLevelSchema,
  uncertaintyRaisesRisk: z.boolean(),
});

export const PermissionDecisionReportSchema = z.object({
  decision: PermissionDecisionSchema,
  riskLevel: RiskLevelSchema,
  reason: z.string().min(1),
});

export const ToolRequestSchema = z.object({
  tool: z.string().min(1),
  input: z.unknown(),
  cycleId: z.string().min(1),
});

export const ToolResultSchema = z.object({
  tool: z.string().min(1),
  status: z.enum(["SUCCEEDED", "FAILED", "BLOCKED", "APPROVAL_REQUIRED", "UNKNOWN"]),
  output: z.unknown().optional(),
  evidence: z.array(EvidenceSchema).default([]),
});

export const CapabilityInputSchema = z.object({
  name: z.string().min(1),
  cycleId: z.string().min(1),
  contract: ContractSchema.optional(),
  context: ContextPackageSchema.optional(),
  evidence: z.array(EvidenceSchema).default([]),
  constraints: z.array(z.string()).default([]),
});

export const CapabilityOutputSchema = z.object({
  name: z.string().min(1),
  status: z.enum(["SUCCEEDED", "FAILED", "PAUSED", "UNKNOWN", "PHASE_NOT_REACHED"]),
  evidence: z.array(EvidenceSchema).default([]),
  output: z.unknown().optional(),
});

export const CycleLockSchema = z.object({
  cycleId: z.string().min(1),
  sessionId: z.string().min(1),
  heartbeatAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
});

export type CycleStatus = z.infer<typeof CycleStatusSchema>;
export type Evidence = z.infer<typeof EvidenceSchema>;
export type Contract = z.infer<typeof ContractSchema>;
export type ContextPackage = z.infer<typeof ContextPackageSchema>;
export type ImpactEvidence = z.infer<typeof ImpactEvidenceSchema>;
export type ImpactReport = z.infer<typeof ImpactReportSchema>;
export type RiskReport = z.infer<typeof RiskReportSchema>;
export type PermissionDecisionReport = z.infer<typeof PermissionDecisionReportSchema>;
export type RiskLevel = z.infer<typeof RiskLevelSchema>;
export type PermissionDecision = z.infer<typeof PermissionDecisionSchema>;
