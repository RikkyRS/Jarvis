import { describe, expect, it } from "vitest";
import { INVARIANTS, MAX_RETRIES_PER_LOGICAL_OPERATION } from "../../src/shared/invariants.js";
import { LANGUAGE_ADAPTERS } from "../../src/adapters/languages/index.js";
import { SUPPORTED_IDES } from "../../src/adapters/ide/index.js";

describe("invariants", () => {
  it("keeps the retry ceiling at 3", () => {
    expect(MAX_RETRIES_PER_LOGICAL_OPERATION).toBe(3);
  });

  it("records the closed architectural invariants", () => {
    expect(INVARIANTS).toHaveLength(11);
  });

  it("supports typescript, python and ruby without encoding a single toolchain in the core", () => {
    expect([...LANGUAGE_ADAPTERS].sort()).toEqual(["python", "ruby", "typescript"]);
  });

  it("keeps IDE adapters named and decoupled", () => {
    expect([...SUPPORTED_IDES]).toEqual(["cursor", "vscode", "claude-code"]);
  });
});
