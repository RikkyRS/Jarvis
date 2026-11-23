import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckSpec } from "./gates.js";

/**
 * Suggests the mandatory checks for a project from the files it already has. Deterministic and
 * read-only: it proposes, the human decides (`jarvis checks detect --apply`). Covers Node, Python
 * and Java, the stacks this owner works with.
 */

export type Detection = { language: string; checks: CheckSpec[]; notes: string[] };

const read = (root: string, file: string): string | null => {
  const p = join(root, file);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
};

export function detectChecks(root: string): Detection[] {
  const out: Detection[] = [];

  const pkg = read(root, "package.json");
  if (pkg) {
    let scripts: Record<string, unknown> = {};
    try {
      scripts = (JSON.parse(pkg) as { scripts?: Record<string, unknown> }).scripts ?? {};
    } catch {
      // An unreadable package.json suggests nothing.
    }
    const checks: CheckSpec[] = [];
    for (const name of ["typecheck", "lint", "build", "test"])
      if (name in scripts)
        checks.push({
          name,
          command: "npm",
          args: name === "test" ? ["test"] : ["run", name],
        });
    if (checks.length) out.push({ language: "Node/TypeScript", checks, notes: [] });
  }

  const pyproject = read(root, "pyproject.toml") ?? "";
  const hasPython =
    existsSync(join(root, "pyproject.toml")) ||
    existsSync(join(root, "requirements.txt")) ||
    existsSync(join(root, "setup.py")) ||
    existsSync(join(root, "setup.cfg"));
  if (hasPython) {
    const checks: CheckSpec[] = [];
    const notes: string[] = [];
    const req = (read(root, "requirements.txt") ?? "") + (read(root, "requirements-dev.txt") ?? "");
    const mentions = (word: string) => new RegExp(word, "i").test(pyproject + req);
    if (
      existsSync(join(root, "pytest.ini")) ||
      existsSync(join(root, "tests")) ||
      /\[tool\.pytest/.test(pyproject) ||
      mentions("pytest")
    )
      checks.push({ name: "pytest", command: "pytest", args: ["-q"] });
    if (existsSync(join(root, "ruff.toml")) || /\[tool\.ruff/.test(pyproject) || mentions("ruff"))
      checks.push({ name: "ruff", command: "ruff", args: ["check", "."] });
    if (existsSync(join(root, "mypy.ini")) || /\[tool\.mypy/.test(pyproject) || mentions("mypy"))
      checks.push({ name: "mypy", command: "mypy", args: ["."] });
    if (checks.length === 0)
      notes.push("Python project found, but no pytest, ruff or mypy configuration.");
    out.push({ language: "Python", checks, notes });
  }

  if (existsSync(join(root, "pom.xml")))
    out.push({
      language: "Java (Maven)",
      checks: [{ name: "test", command: "mvn", args: ["-q", "test"] }],
      notes: [],
    });
  else if (existsSync(join(root, "build.gradle")) || existsSync(join(root, "build.gradle.kts")))
    out.push({
      language: "Java (Gradle)",
      checks: [{ name: "test", command: "gradle", args: ["test", "-q"] }],
      notes: [],
    });
  return out;
}
