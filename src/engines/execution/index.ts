import { spawnSync } from "node:child_process";
import { FORBIDDEN_OPERATIONS } from "../../shared/policy.js";

export function isForbiddenCommand(command: string[]): boolean {
  const joined = command.join(" ").toLowerCase();
  return FORBIDDEN_OPERATIONS.some((item) => joined.includes(item));
}

export function executeProcess(command: string[], cwd: string, timeoutMs: number) {
  try {
    const proc = spawnSync(command[0] ?? "", command.slice(1), {
      cwd,
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
      env: { ...process.env, PYTHONUTF8: "1" },
    });
    return {
      returncode: proc.status ?? 1,
      stdout: proc.stdout ?? "",
      stderr: proc.stderr ?? "",
      timedOut: Boolean(proc.error && proc.error.message.includes("TIMEDOUT")),
      notFound: Boolean(proc.error && "code" in proc.error && (proc.error as NodeJS.ErrnoException).code === "ENOENT"),
      durationHint: "completed",
    };
  } catch (error) {
    return {
      returncode: 1,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      timedOut: false,
      notFound: true,
      durationHint: "failed",
    };
  }
}

export { FORBIDDEN_OPERATIONS } from "../../shared/policy.js";
