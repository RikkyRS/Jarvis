import { executeProcess } from "../execution/index.js";
import type { ContextPackage, ImpactReport } from "../../shared/contracts.js";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";

const SKIP = new Set([".git", ".harness", ".venv", "node_modules", "dist", "build", "__pycache__", "coverage"]);

function pythonPrefix(): string[] {
  const probe = executeProcess(["python", "--version"], process.cwd(), 5000);
  if (!probe.notFound && probe.returncode === 0) return ["python"];
  return ["py"];
}

export type TestDetection = {
  status: "DETECTED" | "UNKNOWN";
  runner: "pytest" | "npm_test" | "rspec" | null;
};

function collectSourcePaths(impact?: ImpactReport): string[] {
  if (!impact) return [];
  const paths = new Set<string>();
  for (const items of Object.values(impact.layers)) {
    for (const item of items ?? []) {
      const path = item.path.split("#")[0] ?? item.path;
      if (!path.includes("(")) paths.add(path);
    }
  }
  return [...paths];
}

function walkTests(root: string, limit = 500): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    if (out.length >= limit) return;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (SKIP.has(name)) continue;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) visit(full);
      else if (/\.(test|spec)\.[jt]sx?$|_test\.|test_.*\.py$/.test(name) || name.endsWith("_spec.rb")) {
        out.push(relative(root, full).replaceAll("\\", "/"));
      }
      if (out.length >= limit) return;
    }
  };
  if (existsSync(root)) visit(root);
  return out;
}

export function impactedTestPaths(root: string, impact?: ImpactReport): string[] {
  const sources = collectSourcePaths(impact);
  if (!sources.length) return [];
  const tests = walkTests(root);
  const hits: string[] = [];
  for (const src of sources) {
    const base = basename(src, extname(src)).toLowerCase();
    if (!base || base.length < 3) continue;
    for (const test of tests) {
      const lower = test.toLowerCase();
      if (lower.includes(base) && !hits.includes(test)) hits.push(test);
    }
  }
  return hits.slice(0, 20);
}

export function detectTests(root: string, context?: ContextPackage): TestDetection {
  const pytest = existsSync(join(root, "pytest.ini")) || existsSync(join(root, "tests"));
  let npmTest = false;
  const pkg = join(root, "package.json");
  if (existsSync(pkg)) {
    try {
      const data = JSON.parse(readFileSync(pkg, "utf8")) as { scripts?: { test?: string } };
      npmTest = Boolean(data.scripts?.test);
    } catch {
      npmTest = false;
    }
  }
  const rspec = existsSync(join(root, "spec")) || existsSync(join(root, ".rspec"));
  const eco = context?.levels.L0.ecosystems ?? [];
  if ((eco.includes("python") || pytest) && pytest) return { status: "DETECTED", runner: "pytest" };
  if ((eco.includes("typescript") || npmTest) && npmTest) return { status: "DETECTED", runner: "npm_test" };
  if (eco.includes("ruby") && rspec) return { status: "DETECTED", runner: "rspec" };
  if (pytest) return { status: "DETECTED", runner: "pytest" };
  if (npmTest) return { status: "DETECTED", runner: "npm_test" };
  return { status: "UNKNOWN", runner: null };
}

export function runTests(root: string, context?: ContextPackage, impact?: ImpactReport) {
  const detection = detectTests(root, context);
  const impacted = impactedTestPaths(root, impact);
  if (!detection.runner) {
    return {
      status: "UNKNOWN",
      ran: false,
      reason: "No test runner was evidenced in the target project.",
      detection,
      impactedTests: impacted,
    };
  }
  let command: string[];
  if (detection.runner === "pytest") {
    command =
      impacted.length > 0
        ? [...pythonPrefix(), "-m", "pytest", "-q", "--rootdir", root, ...impacted.map((rel) => join(root, rel))]
        : [...pythonPrefix(), "-m", "pytest", "-q", "--rootdir", root, join(root, "tests")];
  } else if (detection.runner === "npm_test") {
    command = [process.platform === "win32" ? "npm.cmd" : "npm", "test"];
  } else {
    command = impacted.length > 0 ? ["bundle", "exec", "rspec", ...impacted.map((rel) => join(root, rel))] : ["bundle", "exec", "rspec"];
  }
  const result = executeProcess(command, root, 120_000);
  return {
    status: result.timedOut ? "FAILED" : result.returncode === 0 ? "PASSED" : "FAILED",
    ran: !result.notFound,
    returncode: result.returncode,
    command,
    stdoutTail: result.stdout.slice(-4000),
    stderrTail: result.stderr.slice(-2000),
    detection,
    impactedTests: impacted,
    impactedMode: impacted.length > 0 ? "TARGETED" : "FULL",
    reason: result.notFound ? `Command not found: ${command[0]}` : result.timedOut ? "timeout" : undefined,
  };
}
