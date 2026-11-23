import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import type { ProcessResult, ProcessRunner, ProcessSpec } from "./runner.js";

/** Images must be pinned by digest: tags are mutable, so provenance would be unverifiable. */
const PINNED_IMAGE = /^[a-z0-9][a-z0-9._/-]*(:[A-Za-z0-9._-]+)?@sha256:[a-f0-9]{64}$/;

export type ContainerOptions = {
  image: string;
  /** Only this directory is mounted. */
  workspace: string;
  memory?: string;
  cpus?: string;
  pidsLimit?: number;
  dockerBinary?: string;
};

export class ContainerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContainerConfigError";
  }
}

/**
 * Builds the `docker run` argument list. Pure and exported so the security profile is testable
 * without a daemon: no network, read-only root, dropped capabilities, no env, no docker socket.
 */
export function buildDockerArgs(
  options: ContainerOptions,
  spec: ProcessSpec,
  name: string,
): string[] {
  if (!PINNED_IMAGE.test(options.image)) {
    throw new ContainerConfigError("Container image must be pinned by sha256 digest.");
  }
  if (spec.env && Object.keys(spec.env).length > 0) {
    throw new ContainerConfigError("Containers receive no environment variables.");
  }
  const workspace = realpathSync.native(options.workspace);
  if (/docker\.sock|\\\\\.\\pipe\\docker/i.test(workspace)) {
    throw new ContainerConfigError("The Docker socket can never be mounted.");
  }
  const cwd = realpathSync.native(resolve(spec.cwd));
  const rel = relative(workspace, cwd);
  if (rel === ".." || rel.startsWith(`..${sep}`) || resolve(workspace, rel) !== cwd) {
    throw new ContainerConfigError("Working directory is outside the mounted workspace.");
  }
  const containerCwd = rel === "" ? "/work" : `/work/${rel.split(sep).join("/")}`;
  return [
    "run",
    "--rm",
    "--name",
    name,
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    String(options.pidsLimit ?? 256),
    "--memory",
    options.memory ?? "1g",
    "--cpus",
    options.cpus ?? "2",
    "--user",
    "1000:1000",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=256m",
    "--mount",
    `type=bind,source=${workspace},target=/work`,
    "--workdir",
    containerCwd,
    options.image,
    spec.command,
    ...spec.args,
  ];
}

/** Isolation boundary for untrusted project code. A container reduces risk; it is not proof of safety. */
export class DockerRunner implements ProcessRunner {
  readonly kind = "container" as const;

  constructor(private readonly options: ContainerOptions) {
    // Fail fast on a bad profile instead of at first use.
    if (!PINNED_IMAGE.test(options.image))
      throw new ContainerConfigError("Container image must be pinned by sha256 digest.");
  }

  static async isAvailable(dockerBinary = "docker"): Promise<boolean> {
    return new Promise((done) => {
      execFile(
        dockerBinary,
        ["version", "--format", "{{.Server.Version}}"],
        { timeout: 10_000, windowsHide: true },
        (error) => done(!error),
      );
    });
  }

  run(spec: ProcessSpec): Promise<ProcessResult> {
    const docker = this.options.dockerBinary ?? "docker";
    const name = `jarvis-${randomUUID()}`;
    const args = buildDockerArgs(this.options, spec, name);
    return new Promise((resolveResult) => {
      let truncated = false;
      execFile(
        docker,
        args,
        {
          timeout: spec.timeoutMs,
          maxBuffer: spec.maxOutputBytes,
          encoding: "utf8",
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          const err = error as
            (NodeJS.ErrnoException & { killed?: boolean; code?: string | number }) | null;
          if (err?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") truncated = true;
          const timedOut = Boolean(err?.killed) && !truncated;
          const finish = () =>
            resolveResult({
              exitCode: err ? (typeof err.code === "number" ? err.code : null) : 0,
              stdout: String(stdout ?? ""),
              stderr: String(stderr ?? ""),
              timedOut,
              truncated,
            });
          if (timedOut || truncated) {
            // The client was killed; make sure the container is too.
            execFile(docker, ["rm", "-f", name], { timeout: 15_000, windowsHide: true }, () =>
              finish(),
            );
          } else finish();
        },
      );
    });
  }
}
