import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RiskLevel } from "../shared/contracts.js";

export type ProjectPolicy = {
  version: number;
  risk: {
    requireApprovalFrom: RiskLevel;
    blockCritical: boolean;
  };
  git: {
    remote: string;
    fetchOnReconcile: boolean;
  };
  protectedPaths: string[];
  workflow: {
    requireTestBeforeClose: boolean;
  };
  source: "default" | ".jarvis.json" | ".jarvis.yml";
};

export const DEFAULT_POLICY: ProjectPolicy = {
  version: 1,
  risk: { requireApprovalFrom: "HIGH", blockCritical: true },
  git: { remote: "origin", fetchOnReconcile: true },
  protectedPaths: [".env", ".env.local", "credentials.json"],
  workflow: { requireTestBeforeClose: false },
  source: "default",
};

function mergePolicy(raw: Partial<ProjectPolicy>, source: ProjectPolicy["source"]): ProjectPolicy {
  return {
    version: raw.version ?? 1,
    risk: {
      requireApprovalFrom: raw.risk?.requireApprovalFrom ?? DEFAULT_POLICY.risk.requireApprovalFrom,
      blockCritical: raw.risk?.blockCritical ?? DEFAULT_POLICY.risk.blockCritical,
    },
    git: {
      remote: raw.git?.remote ?? DEFAULT_POLICY.git.remote,
      fetchOnReconcile: raw.git?.fetchOnReconcile ?? DEFAULT_POLICY.git.fetchOnReconcile,
    },
    protectedPaths: raw.protectedPaths ?? DEFAULT_POLICY.protectedPaths,
    workflow: {
      requireTestBeforeClose: raw.workflow?.requireTestBeforeClose ?? DEFAULT_POLICY.workflow.requireTestBeforeClose,
    },
    source,
  };
}

function parseSimpleYaml(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let currentArray: string[] | null = null;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("- ") && currentArray) {
      currentArray.push(trimmed.slice(2).trim());
      continue;
    }
    const match = trimmed.match(/^([\w.-]+):\s*(.*)$/);
    if (!match) continue;
    const key = match[1] ?? "";
    const value = match[2]?.trim() ?? "";
    if (value === "") {
      currentArray = [];
      out[key] = currentArray;
      continue;
    }
    currentArray = null;
    if (value === "true" || value === "false") out[key] = value === "true";
    else if (/^\d+$/.test(value)) out[key] = Number.parseInt(value, 10);
    else out[key] = value.replace(/^["']|["']$/g, "");
  }
  return out;
}

function normalizeRaw(raw: Record<string, unknown>): Partial<ProjectPolicy> {
  const riskRaw = raw.risk as Record<string, unknown> | undefined;
  const gitRaw = raw.git as Record<string, unknown> | undefined;
  const workflowRaw = raw.workflow as Record<string, unknown> | undefined;
  const out: Partial<ProjectPolicy> = {};
  if (typeof raw.version === "number") out.version = raw.version;
  if (riskRaw) {
    out.risk = {
      requireApprovalFrom:
        typeof riskRaw.requireApprovalFrom === "string"
          ? (riskRaw.requireApprovalFrom as ProjectPolicy["risk"]["requireApprovalFrom"])
          : DEFAULT_POLICY.risk.requireApprovalFrom,
      blockCritical: typeof riskRaw.blockCritical === "boolean" ? riskRaw.blockCritical : DEFAULT_POLICY.risk.blockCritical,
    };
  }
  if (gitRaw) {
    out.git = {
      remote: typeof gitRaw.remote === "string" ? gitRaw.remote : DEFAULT_POLICY.git.remote,
      fetchOnReconcile:
        typeof gitRaw.fetchOnReconcile === "boolean" ? gitRaw.fetchOnReconcile : DEFAULT_POLICY.git.fetchOnReconcile,
    };
  }
  if (Array.isArray(raw.protectedPaths)) {
    out.protectedPaths = raw.protectedPaths.filter((item): item is string => typeof item === "string");
  }
  if (workflowRaw) {
    out.workflow = {
      requireTestBeforeClose:
        typeof workflowRaw.requireTestBeforeClose === "boolean"
          ? workflowRaw.requireTestBeforeClose
          : DEFAULT_POLICY.workflow.requireTestBeforeClose,
    };
  }
  return out;
}

export function loadProjectPolicy(projectRoot: string): ProjectPolicy {
  const jsonPath = join(projectRoot, ".jarvis.json");
  if (existsSync(jsonPath)) {
    try {
      const raw = JSON.parse(readFileSync(jsonPath, "utf8")) as Record<string, unknown>;
      return mergePolicy(normalizeRaw(raw), ".jarvis.json");
    } catch {
      return DEFAULT_POLICY;
    }
  }
  const ymlPath = join(projectRoot, ".jarvis.yml");
  if (existsSync(ymlPath)) {
    try {
      const raw = parseSimpleYaml(readFileSync(ymlPath, "utf8"));
      return mergePolicy(normalizeRaw(raw), ".jarvis.yml");
    } catch {
      return DEFAULT_POLICY;
    }
  }
  return DEFAULT_POLICY;
}
