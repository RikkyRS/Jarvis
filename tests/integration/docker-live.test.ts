import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DockerRunner } from "../../src/gateway/container.js";
import { cleanup } from "../helpers.js";

/**
 * Opt-in live check of the isolation profile against a real daemon.
 * Run with: JARVIS_DOCKER_IMAGE="node:22-alpine@sha256:<digest>" npm test
 * Without the variable (or without a reachable daemon) the suite is skipped, never faked.
 */
const image = process.env["JARVIS_DOCKER_IMAGE"];
const daemon = image ? await DockerRunner.isAvailable() : false;

describe.skipIf(!image || !daemon)("docker isolation (live daemon)", () => {
  it("runs code with no network, no host environment and a read-only root", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "jarvis-docker-"));
    process.env["JARVIS_LIVE_SECRET"] = "leak-me";
    writeFileSync(
      join(workspace, "probe.js"),
      `const out = { secret: process.env.JARVIS_LIVE_SECRET ?? null };
const net = require("node:net").connect(80, "1.1.1.1");
net.on("error", () => { out.network = "blocked"; finish(); });
net.on("connect", () => { out.network = "open"; finish(); });
setTimeout(() => { out.network ??= "blocked"; finish(); }, 3000);
let done = false;
function finish() { if (done) return; done = true; try { require("node:fs").writeFileSync("/etc/x", "1"); out.root = "writable"; } catch { out.root = "read-only"; } console.log(JSON.stringify(out)); process.exit(0); }`,
    );
    const runner = new DockerRunner({ image: image!, workspace });
    const r = await runner.run({
      command: "node",
      args: ["probe.js"],
      cwd: workspace,
      timeoutMs: 60_000,
      maxOutputBytes: 100_000,
    });
    delete process.env["JARVIS_LIVE_SECRET"];
    cleanup(workspace);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout.trim().split("\n").pop()!)).toEqual({
      secret: null,
      network: "blocked",
      root: "read-only",
    });
  });
});
