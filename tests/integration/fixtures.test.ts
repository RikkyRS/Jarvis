import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

describe("fixtures", () => {
  it("keeps typescript, python and ruby fixture manifests", () => {
    expect(existsSync(resolve("tests/fixtures/typescript/package.json"))).toBe(true);
    expect(existsSync(resolve("tests/fixtures/python/pyproject.toml"))).toBe(true);
    expect(existsSync(resolve("tests/fixtures/ruby/Gemfile"))).toBe(true);
  });
});
