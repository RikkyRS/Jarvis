import { executeProcess } from "../execution/index.js";

export type GhCheck = {
  name: string;
  state: string;
  conclusion: string | null;
  url?: string;
};

export type GhChecksReport = {
  status: "AVAILABLE" | "UNAVAILABLE" | "NO_REMOTE";
  checks: GhCheck[];
  allPassed: boolean;
  detail?: string;
};

function ghBin(): string {
  return process.platform === "win32" ? "gh.cmd" : "gh";
}

export function probeGh(): { available: boolean; detail?: string } {
  const result = executeProcess([ghBin(), "--version"], process.cwd(), 5000);
  if (result.notFound) return { available: false, detail: "gh CLI not found" };
  if (result.returncode !== 0) return { available: false, detail: result.stderr || "gh failed" };
  const line = result.stdout.split("\n")[0];
  return { available: true, ...(line ? { detail: line } : {}) };
}

export function fetchChecks(projectRoot: string): GhChecksReport {
  const probe = probeGh();
  if (!probe.available) {
    return { status: "UNAVAILABLE", checks: [], allPassed: false, ...(probe.detail ? { detail: probe.detail } : {}) };
  }
  const result = executeProcess([ghBin(), "pr", "checks", "--json", "name,state,link"], projectRoot, 30_000);
  if (result.notFound) {
    return { status: "UNAVAILABLE", checks: [], allPassed: false, detail: "gh not found" };
  }
  if (result.returncode !== 0) {
    const detail = result.stderr || result.stdout;
    if (/no pull requests|could not find|not a git/i.test(detail)) {
      return { status: "NO_REMOTE", checks: [], allPassed: false, detail };
    }
    return { status: "UNAVAILABLE", checks: [], allPassed: false, detail };
  }
  try {
    const rows = JSON.parse(result.stdout || "[]") as Array<{ name: string; state: string; link?: string }>;
    const checks: GhCheck[] = rows.map((row) => ({
      name: row.name,
      state: row.state,
      conclusion: row.state,
      ...(row.link ? { url: row.link } : {}),
    }));
    const allPassed = checks.length > 0 && checks.every((item) => /success|pass/i.test(item.state));
    return { status: "AVAILABLE", checks, allPassed };
  } catch {
    return { status: "UNAVAILABLE", checks: [], allPassed: false, detail: "could not parse gh output" };
  }
}
