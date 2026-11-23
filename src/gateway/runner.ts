import { execFile } from "node:child_process";
import { basename } from "node:path";

export type ProcessSpec = {
  command: string;
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
};

export type ProcessResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
};

/** Where a process actually runs: a bounded host process or an isolation container. */
export interface ProcessRunner {
  readonly kind: "host" | "container";
  run(spec: ProcessSpec): Promise<ProcessResult>;
}

/** Only these variables ever reach a child process. No inherited secrets. */
function minimalEnv(): NodeJS.ProcessEnv {
  const keep =
    process.platform === "win32"
      ? ["PATH", "SystemRoot", "ComSpec", "PATHEXT", "TEMP", "TMP"]
      : ["PATH"];
  const env: NodeJS.ProcessEnv = {};
  for (const key of keep) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/**
 * Host runner for trusted, narrowly scoped operations: allowlisted executables,
 * no shell, minimal environment, bounded time and output.
 */
export class HostRunner implements ProcessRunner {
  readonly kind = "host" as const;

  constructor(private readonly allowlist: readonly string[]) {}

  run(spec: ProcessSpec): Promise<ProcessResult> {
    const name = basename(spec.command)
      .replace(/\.(exe|cmd|bat)$/i, "")
      .toLowerCase();
    if (!this.allowlist.map((c) => c.toLowerCase()).includes(name)) {
      return Promise.reject(new Error(`Executable not allowlisted: ${name}`));
    }
    return new Promise((resolve) => {
      let truncated = false;
      execFile(
        spec.command,
        [...spec.args],
        {
          cwd: spec.cwd,
          env: minimalEnv(),
          timeout: spec.timeoutMs,
          maxBuffer: spec.maxOutputBytes,
          shell: false,
          windowsHide: true,
          encoding: "utf8",
        },
        (error, stdout, stderr) => {
          const err = error as
            (NodeJS.ErrnoException & { killed?: boolean; code?: string | number }) | null;
          if (err?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") truncated = true;
          resolve({
            exitCode: err ? (typeof err.code === "number" ? err.code : null) : 0,
            stdout: String(stdout ?? ""),
            stderr: String(stderr ?? ""),
            timedOut: Boolean(err?.killed) && !truncated,
            truncated,
          });
        },
      );
    });
  }
}
