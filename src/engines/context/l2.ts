import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

const SKIP = new Set([".git", ".harness", ".venv", "node_modules", "dist", "build", "__pycache__", "coverage"]);
const CODE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".py", ".rb"]);

export type L2Surface = {
  exports: string[];
  routes: string[];
  symbols: string[];
  filesScanned: number;
  parser: "structural-regex";
};

function walkCode(root: string, limit = 300): string[] {
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
      else if (CODE_EXT.has(extname(name).toLowerCase())) {
        out.push(relative(root, full).replaceAll("\\", "/"));
      }
      if (out.length >= limit) return;
    }
  };
  if (existsSync(root)) visit(root);
  return out;
}

function scanFile(root: string, rel: string): { exports: string[]; routes: string[]; symbols: string[] } {
  const exports: string[] = [];
  const routes: string[] = [];
  const symbols: string[] = [];
  const full = join(root, rel);
  let text = "";
  try {
    text = readFileSync(full, "utf8").slice(0, 80_000);
  } catch {
    return { exports, routes, symbols };
  }
  for (const match of text.matchAll(/export\s+(?:async\s+)?(?:function|class|const|type|interface)\s+(\w+)/g)) {
    if (match[1]) exports.push(`${rel}#${match[1]}`);
  }
  for (const match of text.matchAll(/(?:router|app)\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/gi)) {
    routes.push(`${match[2] ?? "?"} (${match[1]?.toUpperCase()}) @ ${rel}`);
  }
  for (const match of text.matchAll(/def\s+(\w+)\s*\(/g)) {
    if (match[1] && !match[1].startsWith("_")) symbols.push(`${rel}#${match[1]}`);
  }
  for (const match of text.matchAll(/(?:class|module)\s+(\w+)/g)) {
    if (match[1]) symbols.push(`${rel}#${match[1]}`);
  }
  return { exports, routes, symbols };
}

export function discoverL2(root: string): L2Surface {
  const files = walkCode(root);
  const exports: string[] = [];
  const routes: string[] = [];
  const symbols: string[] = [];
  for (const rel of files) {
    const hit = scanFile(root, rel);
    exports.push(...hit.exports.slice(0, 20));
    routes.push(...hit.routes.slice(0, 20));
    symbols.push(...hit.symbols.slice(0, 20));
  }
  return {
    exports: exports.slice(0, 100),
    routes: routes.slice(0, 50),
    symbols: symbols.slice(0, 100),
    filesScanned: files.length,
    parser: "structural-regex",
  };
}
