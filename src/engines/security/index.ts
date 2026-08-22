import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { RiskLevel } from "../../shared/contracts.js";
import type { GitEngine } from "../git/index.js";
import { executeProcess } from "../execution/index.js";

const SENSITIVE = new Set([".env", ".env.local", ".env.production", ".env.staging", "credentials.json", "id_rsa", "id_ed25519"]);
const CRITICAL = [/force\s*push/i, /git\s+push\s+--force/i, /reset\s+--hard/i, /drop\s+database/i];

export type SecurityFinding = {
  severity: RiskLevel;
  kind: string;
  path?: string;
  detail: string;
};

export type SecurityReport = {
  status: "SCANNED";
  findings: SecurityFinding[];
  highest: RiskLevel;
  dependencies?: { status: string; vulnerabilities?: number; detail?: string };
};

function auditDependencies(root: string): SecurityReport["dependencies"] {
  const pkg = join(root, "package.json");
  if (!existsSync(pkg)) return undefined;
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = executeProcess([npm, "audit", "--json"], root, 60_000);
  if (result.notFound) return { status: "UNKNOWN", detail: "npm not available" };
  try {
    const data = JSON.parse(result.stdout || "{}") as {
      metadata?: { vulnerabilities?: { total?: number } };
    };
    const total = data.metadata?.vulnerabilities?.total ?? 0;
    return {
      status: total > 0 ? "VULNERABILITIES_FOUND" : "CLEAN",
      vulnerabilities: total,
      detail: total > 0 ? `${total} vulnerabilities reported by npm audit` : "npm audit reported no vulnerabilities",
    };
  } catch {
    return { status: "UNKNOWN", detail: "npm audit output could not be parsed" };
  }
}

export function scanSecurity(root: string, objective: string, git: GitEngine): SecurityReport {
  const findings: SecurityFinding[] = [];
  if (CRITICAL.some((pattern) => pattern.test(objective))) {
    findings.push({
      severity: "CRITICAL",
      kind: "DESTRUCTIVE_OBJECTIVE",
      detail: "objective describes a destructive or force-git operation",
    });
  }
  const tracked = git.run(["ls-files"]);
  const files = tracked.returncode === 0 ? tracked.stdout.split("\n").filter(Boolean) : [];
  for (const rel of files) {
    const name = rel.split("/").pop() ?? rel;
    if (SENSITIVE.has(name)) {
      findings.push({
        severity: "HIGH",
        kind: "SENSITIVE_FILE_TRACKED",
        path: rel,
        detail: "sensitive filename is tracked by git; contents were not read",
      });
    }
  }
  if (existsSync(root)) {
    for (const name of readdirSync(root)) {
      if (SENSITIVE.has(name) && !findings.some((item) => item.path === name)) {
        findings.push({
          severity: "MEDIUM",
          kind: "SENSITIVE_FILE_PRESENT",
          path: name,
          detail: "sensitive filename exists locally; contents were not read",
        });
      }
    }
  }
  const deps = auditDependencies(root);
  if (deps?.status === "VULNERABILITIES_FOUND") {
    findings.push({
      severity: "HIGH",
      kind: "DEPENDENCY_VULNERABILITIES",
      detail: deps.detail ?? "npm audit reported vulnerabilities",
    });
  }
  const rank: Record<RiskLevel, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
  let highest: RiskLevel = "LOW";
  for (const item of findings) {
    if (rank[item.severity] > rank[highest]) highest = item.severity;
  }
  return { status: "SCANNED", findings, highest, ...(deps ? { dependencies: deps } : {}) };
}
