import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../../src/cli/index.js";
import { MCP_TOOL_NAMES } from "../../src/mcp/server.js";

const dir = join(process.cwd(), "plugin");
const skills = readdirSync(join(dir, "skills"));
const read = (name: string) =>
  readFileSync(join(dir, "skills", name, "SKILL.md"), "utf8")
    .split(String.fromCharCode(13, 10))
    .join(String.fromCharCode(10));

describe("Claude Code plugin", () => {
  it("[R-PLUGIN-01] declares five skills, each with a name and a description", () => {
    expect(skills.sort()).toEqual(["cycle", "dev", "plan", "review", "toc"]);
    for (const s of skills) {
      const text = read(s);
      expect(text).toMatch(new RegExp(`^---\\nname: ${s}\\ndescription: .{20,}\\n---`));
    }
    const manifest = JSON.parse(
      readFileSync(join(dir, ".claude-plugin", "plugin.json"), "utf8"),
    ) as {
      name: string;
    };
    expect(manifest.name).toBe("jarvis");
  });

  it("[R-PLUGIN-01] every MCP tool a skill mentions really exists", () => {
    const known = new Set<string>(MCP_TOOL_NAMES);
    for (const s of skills) {
      for (const m of read(s).matchAll(/\bjarvis_[a-z_]+\b/g)) {
        expect(known.has(m[0]), `${s} mentions unknown tool ${m[0]}`).toBe(true);
      }
    }
  });

  it("[R-PLUGIN-01] every CLI command a skill tells the user to run really exists", async () => {
    const lines: string[] = [];
    await run(["--help"], {
      out: (l: string) => void lines.push(l),
      err: () => undefined,
      confirm: async () => false,
    });
    const help = lines.join("\n");
    for (const s of skills) {
      for (const m of read(s).matchAll(
        /`?jarvis ((?:review blind|cycle commit|cycle pr|docs-drift|plan approve|run complete|approvals|approve|scan|know)\b)/g,
      )) {
        expect(help.includes(m[1]!.split(" ")[0]!), `${s}: ${m[1]}`).toBe(true);
      }
    }
  });

  it("[R-PLUGIN-01] no skill grants an agent the power to approve", () => {
    for (const s of skills) {
      expect(read(s)).not.toMatch(/você (pode|deve) aprovar/i);
    }
    expect(read("dev")).toMatch(/Você nunca aprova/);
  });
});
