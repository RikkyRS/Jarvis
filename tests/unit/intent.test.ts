import { describe, expect, it } from "vitest";
import { resolveIntent } from "../../src/cli/intent.js";

describe("natural language intent", () => {
  it("maps planeje to plan", () => {
    expect(resolveIntent(["planeje", "implementar", "paginação"])).toEqual({
      command: "plan",
      rest: ["implementar", "paginação"],
    });
  });

  it("ignores a duplicated jarvis token and filler before the verb", () => {
    expect(resolveIntent(["jarvis", "quero", "que", "planeje", "paginação"])).toEqual({
      command: "plan",
      rest: ["paginação"],
    });
  });

  it("keeps canonical commands", () => {
    expect(resolveIntent(["plan", "foo"])).toEqual({ command: "plan", rest: ["foo"] });
  });
});
