#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { COMMANDS, runCommand } from "./commands.js";
import { resolveIntent } from "./intent.js";
import { resolveTarget } from "./target.js";

function print(data: unknown): void {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      project: { type: "string" },
      json: { type: "boolean", default: false },
      approve: { type: "boolean", default: false },
      session: { type: "string" },
      deep: { type: "boolean", default: false },
      commit: { type: "boolean", default: false },
      port: { type: "string" },
      host: { type: "string" },
      remote: { type: "string" },
      checks: { type: "boolean", default: false },
      limit: { type: "string" },
      path: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help || positionals.length === 0) {
    process.stdout.write(`JARVIS — evidence-first personal development harness

Commands:
  ${COMMANDS.join("\n  ")}

Natural language:
  jarvis resumo              # brief compacto (economiza tokens)
  jarvis memorizar "nota"
  jarvis quem                # quem segura o lock
  jarvis exportar            # pack de evidência do Cycle
  jarvis importar --path x   # importa pack (read-only)
  jarvis servidor            # backend local 127.0.0.1:39217

Options:
  --project <path>   target project (required inside the JARVIS runtime)
  --approve          explicit approval for HIGH-risk operations
  --path <file>      path for export/import
  --remote           fetch remote on reconcile
  --checks           read PR checks via gh on wait
  --port <n>         port for serve (default 39217)
  --host <addr>      host for serve (default 127.0.0.1)
  -h, --help         show help
`);
    return 0;
  }

  const rawCommand = positionals[0];
  const intent = resolveIntent(positionals);
  if (!rawCommand || !intent) {
    print({ status: "UNKNOWN_COMMAND", command: rawCommand });
    return 1;
  }
  const command = intent.command;
  const objective = intent.rest.join(" ");

  if (command === "serve") {
    const { startJarvisServer, DEFAULT_HOST, DEFAULT_PORT } = await import("../infrastructure/server.js");
    const port = values.port ? Number.parseInt(values.port, 10) : DEFAULT_PORT;
    const host = values.host ?? DEFAULT_HOST;
    if (Number.isNaN(port) || port < 1 || port > 65535) {
      print({ status: "INVALID_PORT", port: values.port });
      return 2;
    }
    try {
      const started = await startJarvisServer(port, host);
      print({
        status: "SERVING",
        host,
        port: started.port,
        endpoints: [
          `GET  http://${host}:${started.port}/health`,
          `GET  http://${host}:${started.port}/brief?project=<path>`,
          `POST http://${host}:${started.port}/memory?project=<path>`,
          `POST http://${host}:${started.port}/command?project=<path>`,
        ],
        note: "Local-only backend. Estado continua em .harness/ por projeto.",
      });
      await new Promise<void>((resolve) => {
        process.on("SIGINT", () => {
          started.close();
          resolve();
        });
        process.on("SIGTERM", () => {
          started.close();
          resolve();
        });
      });
      return 0;
    } catch (error) {
      print({ status: "SERVE_FAILED", error: error instanceof Error ? error.message : String(error) });
      return 1;
    }
  }

  const allowRuntime = command === "doctor";
  const target = resolveTarget(values.project, process.cwd(), allowRuntime);
  if (target.status !== "RESOLVED") {
    print(target);
    return 2;
  }

  const result = runCommand(command, target.path, {
    ...(objective ? { objective } : {}),
    ...(values.approve ? { approve: true } : {}),
    ...(values.session ? { session: values.session } : {}),
    ...(values.deep ? { deep: true } : {}),
    ...(values.commit ? { commit: true } : {}),
    ...(values.remote ? { remote: true } : {}),
    ...(values.checks ? { checks: true } : {}),
    ...(values.limit ? { limit: Number.parseInt(values.limit, 10) } : {}),
    ...(values.path ? { path: values.path } : {}),
  });
  print(result);
  return 0;
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fileURLToPath(import.meta.url).toLowerCase();
  const invoked = resolve(entry).toLowerCase();
  return self === invoked || invoked.replaceAll("\\", "/").endsWith("/cli/index.js");
}

if (isMainModule()) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
