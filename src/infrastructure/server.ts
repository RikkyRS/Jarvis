import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { resolve } from "node:path";
import { recallMemory } from "../engines/memory/index.js";
import { buildAgentBrief } from "../engines/memory/brief.js";
import { isInitialized } from "./harness.js";
import { Store } from "./db.js";
import { readBriefCache } from "./brief-cache.js";
import { fromRow } from "../core/runtime-helpers.js";

export const DEFAULT_PORT = 39217;
export const DEFAULT_HOST = "127.0.0.1";

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

function projectFromQuery(url: URL, req: IncomingMessage): string | null {
  const fromQuery = url.searchParams.get("project");
  if (fromQuery) return resolve(fromQuery);
  const header = req.headers["x-jarvis-project"];
  if (typeof header === "string" && header.trim()) return resolve(header.trim());
  return null;
}

export function createJarvisServer(): ReturnType<typeof createServer> {
  return createServer(async (req, res) => {
    if (!req.url || !req.method) {
      json(res, 400, { status: "BAD_REQUEST" });
      return;
    }

    const url = new URL(req.url, `http://${DEFAULT_HOST}`);
    const pathname = url.pathname;

    if (req.method === "GET" && pathname === "/health") {
      json(res, 200, { status: "OK", service: "jarvis-local", host: DEFAULT_HOST });
      return;
    }

    const projectRoot = projectFromQuery(url, req);
    if (!projectRoot) {
      json(res, 400, {
        status: "PROJECT_REQUIRED",
        hint: "Use ?project=/abs/path or header X-Jarvis-Project",
      });
      return;
    }

    if (req.method === "GET" && pathname === "/brief") {
      if (!isInitialized(projectRoot)) {
        json(res, 200, {
          status: "NOT_INITIALIZED",
          projectRoot,
          hint: "Run jarvis init or jarvis planeje",
        });
        return;
      }
      const cached = readBriefCache(projectRoot);
      if (cached) {
        json(res, 200, { status: "CACHED", cachedAt: cached.cachedAt, brief: cached.brief });
        return;
      }
      const store = Store.open(projectRoot);
      try {
        const row = store.activeCycle();
        const cycle = row ? fromRow(row) : null;
        const brief = buildAgentBrief(projectRoot, store, cycle, cycle?.payload.context ?? null);
        json(res, 200, brief);
      } finally {
        store.close();
      }
      return;
    }

    if (req.method === "GET" && pathname === "/memory") {
      if (!isInitialized(projectRoot)) {
        json(res, 200, { status: "NOT_INITIALIZED", projectRoot });
        return;
      }
      const store = Store.open(projectRoot);
      try {
        const row = store.activeCycle();
        const cycle = row ? fromRow(row) : null;
        const recalled = recallMemory(store, projectRoot);
        json(res, 200, { status: "MEMORY", recalled, brief: buildAgentBrief(projectRoot, store, cycle, cycle?.payload.context ?? null) });
      } finally {
        store.close();
      }
      return;
    }

    if (req.method === "POST" && pathname === "/memory") {
      if (!isInitialized(projectRoot)) {
        json(res, 400, { status: "NOT_INITIALIZED", hint: "Run jarvis init first" });
        return;
      }
      let body: { note?: string; text?: string } = {};
      try {
        const raw = await readBody(req);
        body = raw ? (JSON.parse(raw) as { note?: string; text?: string }) : {};
      } catch {
        json(res, 400, { status: "INVALID_JSON" });
        return;
      }
      const note = body.note ?? body.text ?? "";
      if (!note.trim()) {
        json(res, 400, { status: "NOTE_REQUIRED" });
        return;
      }
      const store = Store.open(projectRoot);
      try {
        const { recordMemory } = await import("../engines/memory/index.js");
        const { writeBriefCache } = await import("./brief-cache.js");
        const active = store.activeCycle();
        recordMemory(store, "PROJECT", "HOST_NOTE", { text: note.trim() }, "MEDIUM", active?.id, projectRoot);
        const cycle = active ? fromRow(active) : null;
        writeBriefCache(projectRoot, buildAgentBrief(projectRoot, store, cycle, cycle?.payload.context ?? null));
        json(res, 200, { status: "RECORDED", kind: "HOST_NOTE" });
      } finally {
        store.close();
      }
      return;
    }

    if (req.method === "POST" && pathname === "/command") {
      let body: { command?: string; objective?: string; approve?: boolean } = {};
      try {
        const raw = await readBody(req);
        body = raw ? (JSON.parse(raw) as typeof body) : {};
      } catch {
        json(res, 400, { status: "INVALID_JSON" });
        return;
      }
      const command = body.command;
      if (!command) {
        json(res, 400, { status: "COMMAND_REQUIRED" });
        return;
      }
      const allowed = [
        "plan",
        "dev",
        "test",
        "review",
        "security",
        "close",
        "brief",
        "memorize",
        "status",
        "pause",
        "resume",
        "wait",
      ] as const;
      if (!allowed.includes(command as (typeof allowed)[number])) {
        json(res, 400, { status: "COMMAND_NOT_ALLOWED", command });
        return;
      }
      const { handle } = await import("../core/runtime.js");
      const result = handle(command as (typeof allowed)[number], projectRoot, {
        ...(body.objective ? { objective: body.objective } : {}),
        ...(body.approve ? { approve: true } : {}),
      });
      json(res, 200, result);
      return;
    }

    json(res, 404, { status: "NOT_FOUND", path: pathname });
  });
}

export function startJarvisServer(port = DEFAULT_PORT, host = DEFAULT_HOST): Promise<{ port: number; close: () => void }> {
  const server = createJarvisServer();
  return new Promise((resolveStart, reject) => {
    server.on("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      const bound = typeof address === "object" && address ? address.port : port;
      resolveStart({
        port: bound,
        close: () => server.close(),
      });
    });
  });
}
