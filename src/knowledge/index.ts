import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/**
 * Project Intelligence: source-backed claims with timestamps and confidence. A claim is only
 * as good as the files it cites, so every claim carries content hashes and is revalidated
 * before it is trusted. Ordinary changes invalidate only the claims whose evidence changed.
 */

export const ClaimSchema = z
  .object({
    id: z.string(),
    statement: z.string().min(1).max(500),
    evidence: z.array(z.object({ path: z.string(), sha256: z.string() }).strict()).min(1),
    confidence: z.enum(["LOW", "MEDIUM", "HIGH"]),
    source: z.enum(["SCAN", "AGENT", "HUMAN"]),
    createdAt: z.string().datetime(),
  })
  .strict();
export type Claim = z.infer<typeof ClaimSchema>;

export class SecretInKnowledgeError extends Error {
  constructor() {
    super("Knowledge documents must not contain secrets.");
    this.name = "SecretInKnowledgeError";
  }
}

const SECRET_PATTERNS = [
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\b(password|passwd|secret|api[_-]?key|token)\s*[:=]\s*["']?[^\s"']{8,}/i,
];

export const containsSecret = (text: string): boolean => SECRET_PATTERNS.some((p) => p.test(text));

const sha256File = (file: string): string =>
  createHash("sha256").update(readFileSync(file)).digest("hex");

export type Validity = "VALID" | "STALE" | "MISSING";

type Extractor = (
  path: string,
  content: string,
) => { statement: string; confidence: Claim["confidence"] }[];

const EXTRACTORS: { match: RegExp; extract: Extractor }[] = [
  {
    match: /^package\.json$/,
    extract: (_p, content) => {
      try {
        const pkg = JSON.parse(content) as {
          name?: string;
          type?: string;
          scripts?: Record<string, string>;
          dependencies?: object;
          devDependencies?: object;
          engines?: { node?: string };
        };
        const out: ReturnType<Extractor> = [
          {
            statement: `Node.js project${pkg.name ? ` "${pkg.name}"` : ""}${pkg.type === "module" ? " using ES modules" : ""}.`,
            confidence: "HIGH",
          },
        ];
        const scripts = Object.keys(pkg.scripts ?? {});
        if (scripts.length)
          out.push({
            statement: `npm scripts available: ${scripts.slice(0, 15).join(", ")}.`,
            confidence: "HIGH",
          });
        out.push({
          statement: `Declares ${Object.keys(pkg.dependencies ?? {}).length} runtime and ${Object.keys(pkg.devDependencies ?? {}).length} dev dependencies.`,
          confidence: "HIGH",
        });
        if (pkg.engines?.node)
          out.push({ statement: `Requires Node ${pkg.engines.node}.`, confidence: "HIGH" });
        return out;
      } catch {
        return [{ statement: "package.json exists but is not valid JSON.", confidence: "HIGH" }];
      }
    },
  },
  {
    match: /^tsconfig(\.[a-z]+)?\.json$/,
    extract: (p) => [{ statement: `TypeScript is configured (${p}).`, confidence: "HIGH" }],
  },
  {
    match: /^(pyproject\.toml|requirements[^/]*\.txt|setup\.py)$/,
    extract: (p) => [{ statement: `Python project metadata found (${p}).`, confidence: "HIGH" }],
  },
  {
    match: /^go\.mod$/,
    extract: (_p, c) => [
      {
        statement: `Go module ${c.split("\n")[0]?.replace("module ", "").trim() ?? ""}.`,
        confidence: "HIGH",
      },
    ],
  },
  {
    match: /^Cargo\.toml$/,
    extract: () => [{ statement: "Rust crate (Cargo.toml present).", confidence: "HIGH" }],
  },
  {
    match: /^Dockerfile$/,
    extract: () => [{ statement: "Project ships a Dockerfile.", confidence: "HIGH" }],
  },
  {
    match: /^\.github\/workflows\/[^/]+\.ya?ml$/,
    extract: (p) => [{ statement: `CI workflow defined in ${p}.`, confidence: "HIGH" }],
  },
  {
    match: /^(eslint\.config\.[cm]?js|\.eslintrc(\.[a-z]+)?)$/,
    extract: (p) => [{ statement: `Linting configured with ESLint (${p}).`, confidence: "HIGH" }],
  },
  {
    match: /^(\.prettierrc(\.[a-z]+)?|prettier\.config\.[cm]?js)$/,
    extract: (p) => [
      { statement: `Formatting configured with Prettier (${p}).`, confidence: "HIGH" },
    ],
  },
  {
    match: /^(vitest|jest)\.config\.[cm]?[jt]s$/,
    extract: (p) => [{ statement: `Test runner configured (${p}).`, confidence: "HIGH" }],
  },
];

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".jarvis",
  "coverage",
  ".venv",
  "__pycache__",
]);

function listCandidateFiles(root: string): string[] {
  const out: string[] = [];
  const top = readdirSync(root, { withFileTypes: true });
  for (const e of top) {
    if (e.isFile()) out.push(e.name);
    else if (e.name === ".github" && existsSync(join(root, ".github", "workflows"))) {
      for (const w of readdirSync(join(root, ".github", "workflows")))
        out.push(`.github/workflows/${w}`);
    }
  }
  return out;
}

export class KnowledgeStore {
  private readonly file: string;

  constructor(private readonly root: string) {
    const dir = join(root, ".jarvis", "knowledge");
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "claims.json");
  }

  load(): Claim[] {
    if (!existsSync(this.file)) return [];
    return z.array(ClaimSchema).parse(JSON.parse(readFileSync(this.file, "utf8")));
  }

  /** Atomic replace: readers never observe a half-written document. */
  save(claims: Claim[]): void {
    const parsed = z.array(ClaimSchema).parse(claims);
    const text = JSON.stringify(parsed, null, 2);
    if (containsSecret(text)) throw new SecretInKnowledgeError();
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, this.file);
  }

  add(claim: Omit<Claim, "id" | "createdAt"> & { createdAt?: string }): Claim {
    const full = ClaimSchema.parse({
      id: `clm_${createHash("sha256")
        .update(claim.statement + JSON.stringify(claim.evidence))
        .digest("hex")
        .slice(0, 16)}`,
      createdAt: claim.createdAt ?? new Date().toISOString(),
      ...claim,
    });
    this.save([...this.load().filter((c) => c.id !== full.id), full]);
    return full;
  }

  validity(claim: Claim): Validity {
    let stale = false;
    for (const e of claim.evidence) {
      const file = join(this.root, e.path);
      if (!existsSync(file) || !statSync(file).isFile()) return "MISSING";
      if (sha256File(file) !== e.sha256) stale = true;
    }
    return stale ? "STALE" : "VALID";
  }

  /**
   * Initial or incremental analysis from deterministic extractors. Only files that are new or
   * whose hash changed are re-read; claims citing removed files are dropped.
   */
  scan(now = new Date()): { claims: Claim[]; refreshed: string[]; removed: string[] } {
    const previous = this.load();
    const files = listCandidateFiles(this.root).filter((f) =>
      EXTRACTORS.some((e) => e.match.test(f)),
    );
    const known = new Map<string, string>();
    for (const c of previous)
      if (c.source === "SCAN") for (const e of c.evidence) known.set(e.path, e.sha256);

    const refreshed: string[] = [];
    const kept: Claim[] = previous.filter((c) => c.source !== "SCAN");
    for (const f of files) {
      const hash = sha256File(join(this.root, f));
      if (known.get(f) === hash) {
        kept.push(
          ...previous.filter((c) => c.source === "SCAN" && c.evidence.some((e) => e.path === f)),
        );
        continue;
      }
      refreshed.push(f);
      const content = readFileSync(join(this.root, f), "utf8");
      for (const ex of EXTRACTORS.filter((e) => e.match.test(f))) {
        for (const claim of ex.extract(f, content)) {
          kept.push(
            ClaimSchema.parse({
              id: `clm_${createHash("sha256")
                .update(claim.statement + f)
                .digest("hex")
                .slice(0, 16)}`,
              statement: claim.statement,
              evidence: [{ path: f, sha256: hash }],
              confidence: claim.confidence,
              source: "SCAN",
              createdAt: now.toISOString(),
            }),
          );
        }
      }
    }
    const removed = [...known.keys()].filter((p) => !files.includes(p));
    const modules = readdirSync(this.root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith("."))
      .map((e) => e.name);
    const withoutModules = kept.filter((c) => !c.id.startsWith("clm_mod"));
    if (modules.length > 0 && files.length > 0) {
      const anchor = files[0]!;
      withoutModules.push(
        ClaimSchema.parse({
          id: "clm_modules",
          statement: `Top-level directories: ${modules.join(", ")}.`,
          evidence: [{ path: anchor, sha256: sha256File(join(this.root, anchor)) }],
          confidence: "MEDIUM",
          source: "SCAN",
          createdAt: now.toISOString(),
        }),
      );
    }
    const unique = [...new Map(withoutModules.map((c) => [c.id, c])).values()].filter((c) =>
      c.evidence.every((e) => !removed.includes(e.path)),
    );
    this.save(unique);
    return { claims: unique, refreshed, removed };
  }

  /** Selective retrieval: the few claims relevant to a query, each revalidated against the source first. */
  retrieve(query: string, limit = 8): { claim: Claim; validity: Validity }[] {
    const terms = query
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2);
    return this.load()
      .map((claim) => ({
        claim,
        score: terms.filter(
          (t) =>
            claim.statement.toLowerCase().includes(t) ||
            claim.evidence.some((e) => e.path.toLowerCase().includes(t)),
        ).length,
      }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => ({ claim: x.claim, validity: this.validity(x.claim) }));
  }
}
