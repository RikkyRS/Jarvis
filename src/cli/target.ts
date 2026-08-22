import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

export type TargetResolution =
  | { status: "RESOLVED"; path: string; explicit: boolean; runtimeDetected: boolean }
  | { status: "TARGET_NOT_FOUND"; path: string }
  | { status: "TARGET_NOT_DIRECTORY"; path: string }
  | { status: "TARGET_REQUIRED"; path: string; reason: string };

function isRuntimePackage(dir: string): boolean {
  const file = resolve(dir, "package.json");
  if (!existsSync(file)) return false;
  try {
    const pkg = JSON.parse(readFileSync(file, "utf8")) as { name?: string };
    return pkg.name === "jarvis";
  } catch {
    return false;
  }
}

export function resolveTarget(
  explicit: string | undefined,
  cwd: string,
  allowRuntime: boolean,
): TargetResolution {
  const candidate = resolve(explicit ?? cwd);
  if (!existsSync(candidate)) return { status: "TARGET_NOT_FOUND", path: candidate };
  if (!statSync(candidate).isDirectory()) return { status: "TARGET_NOT_DIRECTORY", path: candidate };

  const runtimeDetected = isRuntimePackage(candidate);
  if (runtimeDetected && !explicit && !allowRuntime) {
    return {
      status: "TARGET_REQUIRED",
      path: candidate,
      reason: "Current directory is the JARVIS runtime; specify --project for the target project.",
    };
  }
  return { status: "RESOLVED", path: candidate, explicit: Boolean(explicit), runtimeDetected };
}
