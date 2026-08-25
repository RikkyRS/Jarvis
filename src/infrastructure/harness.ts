import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  CONTRACT_VERSION,
  IDENTITY,
  JARVIS_VERSION,
  SCHEMA_VERSION,
} from "../shared/invariants.js";

export const HARNESS_DIR = ".harness";

export const HARNESS_SUBDIRS = [
  "state",
  "cycles",
  "context",
  "memory",
  "cache",
  "locks",
  "logs",
  "shares",
] as const;

export type JarvisConfig = {
  schemaVersion: number;
  contractVersion: number;
  jarvisVersion: string;
  evidencePolicy: "EVIDENCE_FIRST";
  maxRetriesPerAction: 3;
  identity: typeof IDENTITY;
  initializedAt: string;
  projectRoot: string;
};

export function harnessRoot(projectRoot: string): string {
  return join(projectRoot, HARNESS_DIR);
}

export function configPath(projectRoot: string): string {
  return join(harnessRoot(projectRoot), "config.json");
}

export function isInitialized(projectRoot: string): boolean {
  return existsSync(configPath(projectRoot));
}

export function readConfig(projectRoot: string): JarvisConfig | null {
  if (!isInitialized(projectRoot)) return null;
  return JSON.parse(readFileSync(configPath(projectRoot), "utf8")) as JarvisConfig;
}

export function initHarness(projectRoot: string): { created: boolean; harness: string; config: JarvisConfig } {
  const root = harnessRoot(projectRoot);
  mkdirSync(root, { recursive: true });
  for (const dir of HARNESS_SUBDIRS) {
    mkdirSync(join(root, dir), { recursive: true });
  }

  const existing = readConfig(projectRoot);
  if (existing) {
    return { created: false, harness: root, config: existing };
  }

  const config: JarvisConfig = {
    schemaVersion: SCHEMA_VERSION,
    contractVersion: CONTRACT_VERSION,
    jarvisVersion: JARVIS_VERSION,
    evidencePolicy: "EVIDENCE_FIRST",
    maxRetriesPerAction: 3,
    identity: IDENTITY,
    initializedAt: new Date().toISOString(),
    projectRoot,
  };
  writeFileSync(configPath(projectRoot), `${JSON.stringify(config, null, 2)}\n`, "utf8");
  ensureGitignore(projectRoot);
  return { created: true, harness: root, config };
}

function ensureGitignore(projectRoot: string): void {
  const path = join(projectRoot, ".gitignore");
  const line = ".harness/";
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const lines = new Set(existing.split(/\r?\n/).map((item) => item.trim()).filter(Boolean));
  if (lines.has(line)) return;
  const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
  writeFileSync(path, `${existing}${prefix}${line}\n`, "utf8");
}
