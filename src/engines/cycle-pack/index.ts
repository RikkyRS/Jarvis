import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Cycle } from "../../core/cycle/index.js";
import { harnessRoot } from "../../infrastructure/harness.js";
import { nowIso } from "../../shared/util.js";

export const CYCLE_PACK_VERSION = 1;

export type CyclePack = {
  packVersion: number;
  kind: "jarvis.cycle.export";
  exportedAt: string;
  projectHint?: string;
  cycle: {
    id: string;
    uuid: string;
    number: number;
    slug: string;
    objective: string;
    status: string;
    createdAt: string;
    updatedAt: string;
  };
  risk?: unknown;
  contract?: unknown;
  impactSummary?: {
    layers: Record<string, number>;
    confidence?: string;
    unknownExternalConsumers?: string[];
  };
  evidence: Array<{
    id: string;
    type: string;
    source: string;
    knowledgeState: string;
    confidence: string;
    timestamp: string;
    contentDigest: string;
    contentPreview: string;
  }>;
  riskHistory?: Array<{ at: string; level: string; command: string }>;
  approvals: Array<{ at: string; command: string }>;
  git?: {
    baselineHead?: string | null;
    baselineBranch?: string | null;
    reconciliationStatus?: string;
  };
  checksum: string;
};

const SENSITIVE = /(password|secret|token|api[_-]?key|authorization|credential|\.env)/i;

function preview(content: unknown): string {
  const raw = typeof content === "string" ? content : JSON.stringify(content);
  const scrubbed = SENSITIVE.test(raw) ? "[REDACTED_SENSITIVE]" : raw;
  return scrubbed.length > 280 ? `${scrubbed.slice(0, 277)}...` : scrubbed;
}

function digest(content: unknown): string {
  return createHash("sha256").update(typeof content === "string" ? content : JSON.stringify(content)).digest("hex").slice(0, 16);
}

function packChecksum(pack: Omit<CyclePack, "checksum">): string {
  return createHash("sha256").update(JSON.stringify(pack)).digest("hex").slice(0, 24);
}

export function buildCyclePack(cycle: Cycle, projectRoot?: string): CyclePack {
  const layers: Record<string, number> = {};
  if (cycle.payload.impact?.layers) {
    for (const [key, items] of Object.entries(cycle.payload.impact.layers)) {
      layers[key] = Array.isArray(items) ? items.length : 0;
    }
  }
  const withoutChecksum: Omit<CyclePack, "checksum"> = {
    packVersion: CYCLE_PACK_VERSION,
    kind: "jarvis.cycle.export",
    exportedAt: nowIso(),
    ...(projectRoot ? { projectHint: projectRoot } : {}),
    cycle: {
      id: cycle.id,
      uuid: cycle.uuid,
      number: cycle.number,
      slug: cycle.slug,
      objective: cycle.objective,
      status: cycle.status,
      createdAt: cycle.createdAt,
      updatedAt: cycle.updatedAt,
    },
    ...(cycle.payload.risk ? { risk: cycle.payload.risk } : {}),
    ...(cycle.payload.contract ? { contract: cycle.payload.contract } : {}),
    ...(cycle.payload.impact
      ? {
          impactSummary: {
            layers,
            confidence: cycle.payload.impact.confidence,
            unknownExternalConsumers: cycle.payload.impact.unknownExternalConsumers,
          },
        }
      : {}),
    evidence: cycle.payload.evidence.map((item) => ({
      id: item.id,
      type: item.type,
      source: item.source,
      knowledgeState: item.knowledgeState,
      confidence: item.confidence,
      timestamp: item.timestamp,
      contentDigest: digest(item.content),
      contentPreview: preview(item.content),
    })),
    ...(cycle.payload.riskHistory ? { riskHistory: cycle.payload.riskHistory } : {}),
    approvals: cycle.payload.approvals,
    git: {
      baselineHead: cycle.payload.gitBaseline?.head ?? null,
      baselineBranch: cycle.payload.gitBaseline?.branch ?? null,
      ...(cycle.payload.gitReconciliation?.status
        ? { reconciliationStatus: cycle.payload.gitReconciliation.status }
        : {}),
    },
  };
  return { ...withoutChecksum, checksum: packChecksum(withoutChecksum) };
}

export function exportCyclePack(projectRoot: string, cycle: Cycle, outPath?: string): { path: string; pack: CyclePack } {
  const pack = buildCyclePack(cycle, projectRoot);
  const dir = join(harnessRoot(projectRoot), "exports");
  mkdirSync(dir, { recursive: true });
  const path = outPath ?? join(dir, `${cycle.id}.json`);
  writeFileSync(path, `${JSON.stringify(pack, null, 2)}\n`, "utf8");
  return { path, pack };
}

export function importCyclePack(
  projectRoot: string,
  packPath: string,
): { status: string; pack: CyclePack; importPath: string } {
  if (!existsSync(packPath)) {
    throw new Error(`pack_not_found:${packPath}`);
  }
  const pack = JSON.parse(readFileSync(packPath, "utf8")) as CyclePack;
  if (pack.kind !== "jarvis.cycle.export" || pack.packVersion !== CYCLE_PACK_VERSION) {
    throw new Error("invalid_pack_format");
  }
  const { checksum, ...rest } = pack;
  const expected = packChecksum(rest);
  if (checksum !== expected) {
    throw new Error("checksum_mismatch");
  }
  const dir = join(harnessRoot(projectRoot), "imports");
  mkdirSync(dir, { recursive: true });
  const importPath = join(dir, `${pack.cycle.id}-${Date.now()}.json`);
  writeFileSync(importPath, `${JSON.stringify(pack, null, 2)}\n`, "utf8");
  return { status: "IMPORTED", pack, importPath };
}

export function writeActiveCycleMeta(
  projectRoot: string,
  meta: {
    cycleId: string;
    status: string;
    objective: string;
    sessionId: string;
    lockExpiresAt: string;
  },
): void {
  const path = join(harnessRoot(projectRoot), "active-cycle.meta.json");
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        ...meta,
        updatedAt: nowIso(),
        note: "Advisory only — not a shared lock. Safe to commit if desired.",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}
