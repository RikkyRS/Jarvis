import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDockerArgs, defaultContainerUser } from "../../src/gateway/container.js";
import { cleanup } from "../helpers.js";

const image = `node@sha256:${"a".repeat(64)}`;

describe("container profile user", () => {
  it("[R-ISO-02] never runs as root and defaults to an unprivileged id", () => {
    const user = defaultContainerUser();
    expect(user).toMatch(/^[1-9]\d*:\d+$/);
  });

  it("[R-ISO-02] the user is part of the locked-down argument list and can be overridden", () => {
    const workspace = mkdtempSync(join(tmpdir(), "jarvis-prof-"));
    try {
      const spec = {
        command: "node",
        args: ["x.js"],
        cwd: workspace,
        timeoutMs: 1,
        maxOutputBytes: 1,
      };
      const args = buildDockerArgs({ image, workspace }, spec, "n");
      expect(args[args.indexOf("--user") + 1]).toBe(defaultContainerUser());
      const custom = buildDockerArgs({ image, workspace, user: "2000:2000" }, spec, "n");
      expect(custom[custom.indexOf("--user") + 1]).toBe("2000:2000");
      expect(args).toEqual(expect.arrayContaining(["--network", "none", "--read-only"]));
    } finally {
      cleanup(workspace);
    }
  });
});
