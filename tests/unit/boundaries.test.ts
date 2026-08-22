import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(fileURLToPath(new URL("../../src", import.meta.url)));

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (path.endsWith(".ts")) out.push(path);
  }
  return out;
}

function localImports(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const matches = source.matchAll(/from ["'](\.\.?\/[^"']+)["']/g);
  const resolved: string[] = [];
  for (const match of matches) {
    const spec = match[1];
    if (!spec) continue;
    const target = resolve(dirname(file), spec.replace(/\.js$/, ".ts"));
    resolved.push(relative(root, target).replaceAll("\\", "/"));
  }
  return resolved;
}

function area(rel: string): string {
  const top = rel.split("/")[0];
  return top ?? rel;
}

describe("import boundaries", () => {
  const files = walk(root);

  it("keeps adapters independent from core/engines/capabilities/tools/cli", () => {
    for (const file of files.filter((item) => relative(root, item).replaceAll("\\", "/").startsWith("adapters/"))) {
      for (const imported of localImports(file)) {
        expect(["core", "engines", "capabilities", "tools", "cli"]).not.toContain(area(imported));
      }
    }
  });

  it("keeps capabilities from importing tools or cli", () => {
    for (const file of files.filter((item) => relative(root, item).replaceAll("\\", "/").startsWith("capabilities/"))) {
      for (const imported of localImports(file)) {
        expect(["tools", "cli"]).not.toContain(area(imported));
      }
    }
  });

  it("keeps engines from importing capabilities or cli", () => {
    for (const file of files.filter((item) => relative(root, item).replaceAll("\\", "/").startsWith("engines/"))) {
      for (const imported of localImports(file)) {
        expect(["capabilities", "cli"]).not.toContain(area(imported));
      }
    }
  });

  it("keeps cli from importing engines, capabilities or tools", () => {
    for (const file of files.filter((item) => relative(root, item).replaceAll("\\", "/").startsWith("cli/"))) {
      for (const imported of localImports(file)) {
        expect(["engines", "capabilities", "tools"]).not.toContain(area(imported));
      }
    }
  });
});
