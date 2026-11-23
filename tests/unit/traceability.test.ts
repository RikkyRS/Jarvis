import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function testFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? testFiles(full) : full.endsWith(".test.ts") ? [full] : [];
  });
}

describe("requirement traceability", () => {
  const matrix = readFileSync("docs/TESTING.md", "utf8");
  const required = [...matrix.matchAll(/^\|\s*(R-[A-Z0-9-]+)\s*\|/gm)].map((m) => m[1]!);
  const cited = new Set<string>();
  for (const file of testFiles("tests")) {
    for (const m of readFileSync(file, "utf8").matchAll(
      /\b(?:it|test)\(\s*["'`]\[(R-[A-Z0-9-]+)\]/g,
    ))
      cited.add(m[1]!);
  }

  it("lists requirements", () => {
    expect(required.length).toBeGreaterThan(30);
    expect(new Set(required).size).toBe(required.length);
  });

  it("every documented requirement has at least one automated test", () => {
    expect(required.filter((id) => !cited.has(id))).toEqual([]);
  });

  it("every cited requirement is documented", () => {
    expect([...cited].filter((id) => !required.includes(id))).toEqual([]);
  });
});
