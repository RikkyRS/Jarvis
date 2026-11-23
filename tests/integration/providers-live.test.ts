import { userInfo } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ClaudeCodeProvider, OllamaProvider } from "../../src/ai/providers.js";
import { HostRunner } from "../../src/gateway/index.js";

/**
 * Opt-in checks against real model backends. They are skipped, never faked, when not enabled.
 *   Ollama:      JARVIS_OLLAMA_MODEL=qwen2.5:3b npm test
 *   Claude Code: JARVIS_CLAUDE_LIVE=1 [JARVIS_CLAUDE_BIN=/path/to/claude.exe] npm test
 *                (spends a few tokens of your own plan; on Windows point BIN at the native claude.exe)
 */
const ollamaModel = process.env["JARVIS_OLLAMA_MODEL"];

describe.skipIf(!ollamaModel)("Ollama (live)", () => {
  it("returns schema-shaped JSON and reports real token usage", async () => {
    const p = new OllamaProvider({ models: [{ id: ollamaModel!, tier: 1 }] });
    const r = await p.complete({
      model: ollamaModel!,
      system: 'Answer only with JSON {"ok":true}.',
      messages: [{ role: "user", content: "ping" }],
      maxOutputTokens: 32,
      jsonSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
    });
    expect(JSON.parse(r.text)).toHaveProperty("ok");
    expect(r.usage?.inputTokens).toBeGreaterThan(0);
  }, 120_000);
});

describe.skipIf(process.env["JARVIS_CLAUDE_LIVE"] !== "1")("Claude Code (live)", () => {
  // tests/setup.ts sandboxes HOME so nothing touches the real profile; the CLI needs its real login here.
  const saved = { HOME: process.env["HOME"], USERPROFILE: process.env["USERPROFILE"] };
  beforeAll(() => {
    process.env["HOME"] = userInfo().homedir;
    process.env["USERPROFILE"] = userInfo().homedir;
  });
  afterAll(() => {
    process.env["HOME"] = saved.HOME;
    process.env["USERPROFILE"] = saved.USERPROFILE;
  });

  it("answers in text-only mode and reports usage", async () => {
    const p = new ClaudeCodeProvider(new HostRunner(["claude"], { inheritHome: true }), {
      cwd: process.cwd(),
      ...(process.env["JARVIS_CLAUDE_BIN"] ? { binary: process.env["JARVIS_CLAUDE_BIN"] } : {}),
      timeoutMs: 120_000,
    });
    const r = await p.complete({
      model: "haiku",
      system: "Answer with the single word: pong",
      messages: [{ role: "user", content: "ping" }],
      maxOutputTokens: 16,
    });
    expect(r.text.toLowerCase()).toContain("pong");
    expect(r.usage?.inputTokens).toBeGreaterThan(0);
  }, 150_000);
});
