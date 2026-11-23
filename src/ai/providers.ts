import type { ProcessRunner } from "../gateway/runner.js";
import type { ProviderAdapter, ProviderRequest, ProviderResponse } from "./index.js";

/** Local-only by default: a model endpoint is never exposed to or reached over the network implicitly. */
const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i;

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export type OllamaOptions = {
  baseUrl?: string;
  models: readonly { id: string; tier: 1 | 2 | 3 }[];
  fetch?: FetchLike;
  allowRemote?: boolean;
};

export class OllamaProvider implements ProviderAdapter {
  readonly id = "ollama";
  readonly models: OllamaOptions["models"];
  private readonly baseUrl: string;
  private readonly doFetch: FetchLike;

  constructor(options: OllamaOptions) {
    this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:11434").replace(/\/$/, "");
    if (!options.allowRemote && !LOOPBACK.test(this.baseUrl)) {
      throw new Error("Ollama base URL must be loopback unless allowRemote is set explicitly.");
    }
    this.models = options.models;
    this.doFetch = options.fetch ?? ((url, init) => fetch(url, init) as ReturnType<FetchLike>);
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    const res = await this.doFetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: request.model,
        stream: false,
        messages: [{ role: "system", content: request.system }, ...request.messages],
        ...(request.jsonSchema ? { format: request.jsonSchema } : {}),
        options: { num_predict: request.maxOutputTokens, temperature: 0 },
      }),
    });
    if (!res.ok) throw new Error(`Ollama request failed with status ${res.status}.`);
    const data = (await res.json()) as {
      message?: { content?: string };
      prompt_eval_count?: number;
      eval_count?: number;
    };
    const text = data.message?.content;
    if (typeof text !== "string") throw new Error("Ollama returned no message content.");
    return {
      text,
      ...(typeof data.prompt_eval_count === "number" && typeof data.eval_count === "number"
        ? { usage: { inputTokens: data.prompt_eval_count, outputTokens: data.eval_count } }
        : {}),
    };
  }
}

/**
 * Claude Code in headless print mode, as a *text-only* model: built-in tools are disabled, MCP
 * servers are ignored and no session is persisted, so it can interpret and propose but never act.
 */
export class ClaudeCodeProvider implements ProviderAdapter {
  readonly id = "claude-code";
  readonly models: readonly { id: string; tier: 1 | 2 | 3 }[];

  constructor(
    private readonly runner: ProcessRunner,
    private readonly options: {
      cwd: string;
      binary?: string;
      models?: readonly { id: string; tier: 1 | 2 | 3 }[];
      timeoutMs?: number;
    },
  ) {
    this.models = options.models ?? [
      { id: "haiku", tier: 1 },
      { id: "sonnet", tier: 2 },
      { id: "opus", tier: 3 },
    ];
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    const prompt = request.messages
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
      .join("\n\n");
    const args = [
      "-p",
      "--output-format",
      "json",
      "--tools",
      "",
      "--strict-mcp-config",
      "--no-session-persistence",
      "--model",
      request.model,
      "--system-prompt",
      request.system,
      ...(request.jsonSchema ? ["--json-schema", JSON.stringify(request.jsonSchema)] : []),
    ];
    const r = await this.runner.run({
      command: this.options.binary ?? "claude",
      args,
      cwd: this.options.cwd,
      timeoutMs: this.options.timeoutMs ?? 180_000,
      maxOutputBytes: 4 * 1024 * 1024,
      input: prompt,
    });
    if (r.exitCode !== 0 || r.timedOut)
      throw new Error(
        `Claude Code exited with ${r.exitCode ?? (r.timedOut ? "timeout" : "no exit code (could not start; on Windows pass the native claude.exe as binary, a .cmd shim cannot be launched without a shell)")}.`,
      );
    const data = JSON.parse(r.stdout) as {
      result?: string;
      structured_output?: unknown;
      is_error?: boolean;
      usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
    };
    if (data.is_error) throw new Error("Claude Code reported an error.");
    const text =
      data.structured_output !== undefined ? JSON.stringify(data.structured_output) : data.result;
    if (typeof text !== "string") throw new Error("Claude Code returned no result.");
    const u = data.usage;
    return {
      text,
      ...(u && typeof u.input_tokens === "number" && typeof u.output_tokens === "number"
        ? {
            usage: {
              inputTokens: u.input_tokens,
              outputTokens: u.output_tokens,
              ...(typeof u.cache_read_input_tokens === "number"
                ? { cachedInputTokens: u.cache_read_input_tokens }
                : {}),
            },
          }
        : {}),
    };
  }
}
