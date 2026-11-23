import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { OllamaProvider } from "../../src/ai/providers.js";

let server: Server | undefined;
afterEach(
  () => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())),
);

function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  server = createServer(handler);
  return new Promise((resolve) =>
    server!.listen(0, "127.0.0.1", () =>
      resolve(`http://127.0.0.1:${(server!.address() as AddressInfo).port}`),
    ),
  );
}

const request = {
  model: "m",
  system: "sys",
  messages: [{ role: "user" as const, content: "hi" }],
  maxOutputTokens: 16,
};

describe("Ollama adapter over a real HTTP connection", () => {
  it("[R-ADAPTER-01] speaks the /api/chat wire format and reads usage back", async () => {
    let received: { url?: string; body?: Record<string, unknown> } = {};
    const baseUrl = await listen((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        received = { url: req.url ?? "", body: JSON.parse(raw) as Record<string, unknown> };
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({ message: { content: "pong" }, prompt_eval_count: 9, eval_count: 4 }),
        );
      });
    });
    const r = await new OllamaProvider({ baseUrl, models: [{ id: "m", tier: 1 }] }).complete({
      ...request,
      jsonSchema: { type: "object" },
    });
    expect(r).toEqual({ text: "pong", usage: { inputTokens: 9, outputTokens: 4 } });
    expect(received.url).toBe("/api/chat");
    expect(received.body).toMatchObject({ model: "m", stream: false, format: { type: "object" } });
    expect(received.body?.["messages"]).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ]);
  });

  it("[R-ADAPTER-01] turns HTTP errors and empty bodies into explicit failures", async () => {
    let mode: "500" | "empty" = "500";
    const baseUrl = await listen((_req, res) => {
      if (mode === "500") {
        res.statusCode = 500;
        res.end("boom");
      } else {
        res.end(JSON.stringify({}));
      }
    });
    const p = new OllamaProvider({ baseUrl, models: [{ id: "m", tier: 1 }] });
    await expect(p.complete(request)).rejects.toThrow(/status 500/);
    mode = "empty";
    await expect(p.complete(request)).rejects.toThrow(/no message content/);
  });
});
