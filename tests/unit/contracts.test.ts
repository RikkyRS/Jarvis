import { describe, expect, it } from "vitest";
import {
  AcceptanceCriterionSchema,
  ContractSchema,
  ContextPackageSchema,
  EvidenceSchema,
  ImpactReportSchema,
  PermissionDecisionReportSchema,
  RiskReportSchema,
  ToolRequestSchema,
  CapabilityInputSchema,
} from "../../src/shared/contracts.js";
import { IdSchema } from "../../src/shared/ids.js";

const iso = "2026-08-18T21:00:00.000Z";

describe("contracts", () => {
  it("accepts a valid entity id", () => {
    expect(
      IdSchema.parse({
        uuid: "11111111-1111-4111-8111-111111111111",
        number: 1,
        slug: "pagination-modal",
      }),
    ).toBeTruthy();
  });

  it("accepts evidence, contract, context, impact, risk, permission, tool and capability payloads", () => {
    const evidence = EvidenceSchema.parse({
      id: "E-001",
      type: "USER_OBJECTIVE",
      content: "implementar paginação",
      source: "user",
      timestamp: iso,
      knowledgeState: "KNOWN",
      confidence: "HIGH",
    });
    const contract = ContractSchema.parse({
      id: { uuid: "11111111-1111-4111-8111-111111111111", number: 1, slug: "pagination" },
      objective: "implementar paginação",
      scope: ["modal"],
      outOfScope: ["billing"],
      constraints: ["não descartar mudanças humanas"],
      acceptanceCriteria: [
        AcceptanceCriterionSchema.parse({
          id: "AC-1",
          statement: "lista pagina de 20 em 20",
          evidenceRequired: "teste de UI ou API",
          validationStrategy: "test",
          status: "UNKNOWN",
        }),
      ],
    });
    const context = ContextPackageSchema.parse({
      targetProject: "C:/tmp/app",
      levels: {
        L0: { status: "COMPLETE", ecosystems: ["typescript"] },
        L1: { status: "COMPLETE", topLevel: ["src"] },
        L2: { status: "DEFERRED", reason: "demand-driven" },
      },
      knowledgeState: "KNOWN",
      confidence: "MEDIUM",
    });
    const impact = ImpactReportSchema.parse({
      layers: {
        DIRECT: [
          {
            path: "src/users.ts",
            layer: "DIRECT",
            reason: "matched objective",
            knowledgeState: "INFERRED",
          },
        ],
      },
      unknownExternalConsumers: [],
      confidence: "LOW",
    });
    const risk = RiskReportSchema.parse({
      level: "HIGH",
      reasons: ["UNKNOWN_EXTERNAL_CONSUMER"],
      accumulated: "HIGH",
      uncertaintyRaisesRisk: true,
    });
    const permission = PermissionDecisionReportSchema.parse({
      decision: "APPROVAL_REQUIRED",
      riskLevel: "HIGH",
      reason: "HIGH requires explicit approval",
    });
    const tool = ToolRequestSchema.parse({
      tool: "git.status",
      input: {},
      cycleId: "cycle-1",
    });
    const capability = CapabilityInputSchema.parse({
      name: "planning",
      cycleId: "cycle-1",
      evidence: [evidence],
      constraints: [],
    });
    expect(contract.acceptanceCriteria[0]?.id).toBe("AC-1");
    expect(context.levels.L2.status).toBe("DEFERRED");
    expect(impact.confidence).toBe("LOW");
    expect(risk.level).toBe("HIGH");
    expect(permission.decision).toBe("APPROVAL_REQUIRED");
    expect(tool.tool).toBe("git.status");
    expect(capability.name).toBe("planning");
  });
});
