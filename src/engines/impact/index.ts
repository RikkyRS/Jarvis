import { existsSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import type { ImpactEvidence, ImpactReport } from "../../shared/contracts.js";
import { tokens } from "../../shared/util.js";
import type { GitEngine, GitSnapshot } from "../git/index.js";
import type { L2Surface } from "../context/l2.js";

const SKIP = new Set([".git", ".harness", ".venv", "node_modules", "dist", "build", "__pycache__", "coverage"]);

export function classifyPath(path: string): ImpactEvidence["layer"] {
  const p = path.replaceAll("\\", "/").toLowerCase();
  const name = p.split("/").pop() ?? p;
  if (p.includes("test") || p.includes("spec") || p.includes("__tests__")) return "TEST";
  if (p.includes("prisma") || p.includes("migration") || p.includes("schema") || p.includes("models")) return "DATA";
  if (p.includes("route") || p.includes("controller") || p.includes("openapi") || p.includes("swagger")) return "CONTRACT";
  if (
    ["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "tsconfig.json", "docker-compose.yml", ".env", ".env.example"].includes(
      name,
    )
  ) {
    return "CONFIG";
  }
  return "DIRECT";
}

function walkFiles(root: string, limit = 4000): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    if (out.length >= limit) return;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (SKIP.has(name)) continue;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) visit(full);
      else if (st.isFile()) out.push(relative(root, full).split(sep).join("/"));
      if (out.length >= limit) return;
    }
  };
  if (existsSync(root)) visit(root);
  return out;
}

function matchL2(objectiveTokens: Set<string>, l2: L2Surface, layers: Record<ImpactEvidence["layer"], ImpactEvidence[]>): void {
  const check = (entries: string[], layer: ImpactEvidence["layer"], reason: string) => {
    for (const entry of entries) {
      const symbol = entry.includes("#") ? (entry.split("#")[1] ?? "") : entry;
      const pathPart = entry.split("#")[0] ?? entry;
      const hit =
        [...objectiveTokens].some((token) => symbol.toLowerCase().includes(token) || pathPart.toLowerCase().includes(token)) ||
        [...objectiveTokens].some((token) => entry.toLowerCase().includes(token));
      if (hit) {
        layers[layer].push({
          path: entry,
          layer,
          reason,
          knowledgeState: "INFERRED",
        });
      }
    }
  };
  check(l2.exports, "DIRECT", "objective term matched L2 export");
  check(l2.routes, "CONTRACT", "objective term matched L2 route");
  check(l2.symbols, "INDIRECT", "objective term matched L2 symbol");
}

export function analyzeImpact(
  root: string,
  objective: string,
  git: GitEngine,
  snapshot: GitSnapshot,
  l2?: L2Surface,
): ImpactReport {
  const objectiveTokens = tokens(objective);
  const layers: Record<ImpactEvidence["layer"], ImpactEvidence[]> = {
    DIRECT: [],
    INDIRECT: [],
    CONTRACT: [],
    DATA: [],
    TEST: [],
    CONFIG: [],
    EXTERNAL: [],
    HUMAN: [],
  };
  const human = git.parseStatus(snapshot.statusShort);
  for (const item of human) {
    layers.HUMAN.push({
      path: item.path,
      layer: "HUMAN",
      reason: "file was already modified/untracked when the Cycle baseline was captured",
      knowledgeState: "KNOWN",
    });
  }

  const matched: Array<{ score: number; path: string }> = [];
  for (const rel of walkFiles(root)) {
    if (extname(rel).length > 8) continue;
    const score = [...tokens(rel)].filter((token) => objectiveTokens.has(token)).length;
    if (score) matched.push({ score, path: rel });
  }
  matched.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  for (const item of matched.slice(0, 20)) {
    const layer = classifyPath(item.path);
    layers[layer].push({
      path: item.path,
      layer,
      reason: "objective term matched file path",
      knowledgeState: "INFERRED",
    });
  }

  if (l2) matchL2(objectiveTokens, l2, layers);

  const unknownExternalConsumers: string[] = [];
  const maybeApi = [...objectiveTokens].some((token) => ["api", "route", "endpoint", "backend"].includes(token));
  if (layers.CONTRACT.length || maybeApi || (l2?.routes.length ?? 0) > 0) {
    unknownExternalConsumers.push("UNKNOWN_EXTERNAL_CONSUMER");
    layers.EXTERNAL.push({
      path: layers.CONTRACT[0]?.path ?? l2?.routes[0] ?? "(unproven)",
      layer: "EXTERNAL",
      reason: "contract surface may have consumers outside the repository; absence cannot be proven",
      knowledgeState: "UNKNOWN",
    });
  }

  const hasL2 = Boolean(l2 && (l2.exports.length || l2.routes.length || l2.symbols.length));
  return {
    layers,
    unknownExternalConsumers,
    confidence: hasL2 || matched.length ? "MEDIUM" : "LOW",
  };
}
