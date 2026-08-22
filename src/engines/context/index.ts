import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { detectManifests as pythonManifests } from "../../adapters/languages/python/index.js";
import { detectManifests as rubyManifests } from "../../adapters/languages/ruby/index.js";
import { detectManifests as tsManifests } from "../../adapters/languages/typescript/index.js";
import type { ContextPackage } from "../../shared/contracts.js";
import { discoverL2, type L2Surface } from "./l2.js";

const SKIP = new Set([".git", ".harness", ".venv", "node_modules", "dist", "build", "__pycache__", "coverage"]);

export function discoverContext(root: string, deep = false): ContextPackage & { l2Surface?: L2Surface } {
  const ecosystems: string[] = [];
  const evidence: string[] = [];
  const check = (name: string, eco: string) => {
    if (existsSync(join(root, name))) {
      evidence.push(name);
      if (!ecosystems.includes(eco)) ecosystems.push(eco);
    }
  };
  for (const name of tsManifests()) check(name, "typescript");
  for (const name of ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"]) check(name, "typescript");
  for (const name of pythonManifests()) check(name, "python");
  for (const name of rubyManifests()) check(name, "ruby");
  for (const name of ["go.mod", "pom.xml", "Cargo.toml"]) {
    if (existsSync(join(root, name))) evidence.push(name);
  }

  const topLevel = existsSync(root)
    ? readdirSync(root).filter((name) => !SKIP.has(name)).sort()
    : [];

  let l2Surface: L2Surface | undefined;
  const l2 = deep
    ? (() => {
        l2Surface = discoverL2(root);
        return {
          status: "COMPLETE" as const,
          reason: `Structural scan (${l2Surface.filesScanned} files, ${l2Surface.parser}).`,
        };
      })()
    : {
        status: "DEFERRED" as const,
        reason: "Deep inspection is demand-driven; use --deep or plan auto-enables L2.",
      };

  return {
    targetProject: root,
    levels: {
      L0: { status: ecosystems.length ? "COMPLETE" : "UNKNOWN", ecosystems },
      L1: { status: "COMPLETE", topLevel },
      L2: l2,
    },
    knowledgeState: ecosystems.length ? "KNOWN" : "UNKNOWN",
    confidence: deep && l2Surface ? "MEDIUM" : ecosystems.length ? "MEDIUM" : "LOW",
    ...(l2Surface ? { l2Surface } : {}),
  };
}
