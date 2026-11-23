import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HostRunner } from "../../src/gateway/index.js";
import {
  IntegrationResolver,
  PromotionRefusedError,
  assertPromotable,
  promotionOperation,
} from "../../src/integration/resolver.js";
import {
  KnowledgeStore,
  SecretInKnowledgeError,
  containsSecret,
} from "../../src/knowledge/index.js";
import { cleanup, makeRepo, sh } from "../helpers.js";

const WI1 = "wi_11111111-1111-1111-1111-111111111111";
const WI2 = "wi_22222222-2222-2222-2222-222222222222";

let root: string;
let resolver: IntegrationResolver;

beforeEach(() => {
  root = makeRepo();
  resolver = new IntegrationResolver(new HostRunner(["git", "node"], { inheritHome: true }), root);
});
afterEach(() => cleanup(root));

function commit(file: string, content: string, message: string): string {
  writeFileSync(join(root, file), content);
  sh(root, "add", ".");
  sh(root, "commit", "-m", message);
  return sh(root, "rev-parse", "HEAD");
}

const passing = [{ name: "tests", command: "node", args: ["-e", "process.exit(0)"] }];

describe("Integration Resolver", () => {
  it("[R-INTEGRATION-01] promotion is bound to the exact validated SHA", async () => {
    sh(root, "checkout", "-q", "-b", "candidate");
    const sha = commit("feature.txt", "x", `feat: one\n\nWork-Item: ${WI1}`);
    const report = await resolver.assess({
      base: "main",
      candidate: "candidate",
      checkoutPath: root,
      checks: passing,
    });
    expect(report.candidateSha).toBe(sha);
    expect(report.recommendation).toBe("ACCEPT");
    expect(report.associations[0]).toMatchObject({ workItemId: WI1, state: "DISCOVERED" });
    expect(() => assertPromotable(report, sha, null)).toThrow(PromotionRefusedError); // no human acceptance
    expect(() => assertPromotable(report, sha, "rikky")).not.toThrow();
    expect(promotionOperation(report)).toEqual({ source: "candidate", expectedSource: sha });

    // The branch moves after validation: the old report no longer authorizes anything.
    const moved = commit("late.txt", "y", `feat: late\n\nWork-Item: ${WI1}`);
    expect(() => assertPromotable(report, moved, "rikky")).toThrow(/Candidate changed/);
  });

  it("flags overlapping files from different contributions", async () => {
    sh(root, "checkout", "-q", "-b", "candidate");
    commit("shared.txt", "a", `feat: a\n\nWork-Item: ${WI1}`);
    commit("shared.txt", "b", `feat: b\n\nWork-Item: ${WI2}`);
    const report = await resolver.assess({
      base: "main",
      candidate: "candidate",
      checkoutPath: root,
      checks: passing,
    });
    const overlap = report.findings.find((f) => f.kind === "FILE_OVERLAP");
    expect(overlap?.workItemIds.sort()).toEqual([WI1, WI2]);
    expect(report.recommendation).toBe("REQUEST_CHANGES");
  });

  it("does not guess associations from weak signals", async () => {
    sh(root, "checkout", "-q", "-b", "candidate");
    const weak = commit("x.txt", "x", "fix: something vague");
    const ambiguous = commit("y.txt", "y", `fix: both ${WI1} and ${WI2}`);
    const report = await resolver.assess({
      base: "main",
      candidate: "candidate",
      checkoutPath: root,
      checks: passing,
    });
    expect(report.needsConfirmation).toEqual(expect.arrayContaining([weak, ambiguous]));
    expect(report.associations.every((a) => a.workItemId === null)).toBe(true);
    expect(() => assertPromotable(report, report.candidateSha, "rikky")).toThrow(
      PromotionRefusedError,
    );

    const confirmed = await resolver.assess({
      base: "main",
      candidate: "candidate",
      checkoutPath: root,
      checks: passing,
      confirmed: { [weak]: WI1, [ambiguous]: WI2 },
    });
    expect(confirmed.associations.map((a) => a.state)).toEqual(["CONFIRMED", "CONFIRMED"]);
    expect(confirmed.needsConfirmation).toEqual([]);
  });

  it("blocks when a deterministic check fails at the candidate SHA", async () => {
    sh(root, "checkout", "-q", "-b", "candidate");
    commit("f.txt", "f", `feat\n\nWork-Item: ${WI1}`);
    const report = await resolver.assess({
      base: "main",
      candidate: "candidate",
      checkoutPath: root,
      checks: [{ name: "unit", command: "node", args: ["-e", "process.exit(1)"] }],
    });
    expect(report.recommendation).toBe("BLOCK");
    expect(report.checks[0]).toMatchObject({ passed: false, exitCode: 1 });
    expect(report.findings.some((f) => f.kind === "CHECK_FAILED")).toBe(true);
  });

  it("refuses to run checks on a dirty or different checkout", async () => {
    sh(root, "checkout", "-q", "-b", "candidate");
    commit("f.txt", "f", `feat\n\nWork-Item: ${WI1}`);
    writeFileSync(join(root, "dirty.txt"), "uncommitted");
    const dirty = await resolver.assess({
      base: "main",
      candidate: "candidate",
      checkoutPath: root,
      checks: passing,
    });
    expect(dirty.findings.some((f) => f.kind === "CHECKOUT_MISMATCH")).toBe(true);
    expect(dirty.checks).toEqual([]);
    expect(dirty.recommendation).toBe("BLOCK");
  });

  it("flags dependency and contract changes", async () => {
    sh(root, "checkout", "-q", "-b", "candidate");
    commit("package.json", "{}", `chore: deps\n\nWork-Item: ${WI1}`);
    mkdirSync(join(root, "schemas"), { recursive: true });
    commit("schemas/api.schema.json", "{}", `feat: contract\n\nWork-Item: ${WI2}`);
    const report = await resolver.assess({
      base: "main",
      candidate: "candidate",
      checkoutPath: root,
      checks: passing,
    });
    expect(report.findings.map((f) => f.kind)).toEqual(
      expect.arrayContaining(["DEPENDENCY_CHANGE", "CONTRACT_CHANGE"]),
    );
  });

  it("is reproducible: the same inputs give the same report hash", async () => {
    sh(root, "checkout", "-q", "-b", "candidate");
    commit("f.txt", "f", `feat\n\nWork-Item: ${WI1}`);
    const a = await resolver.assess({
      base: "main",
      candidate: "candidate",
      checkoutPath: root,
      checks: passing,
    });
    const b = await resolver.assess({
      base: "main",
      candidate: "candidate",
      checkoutPath: root,
      checks: passing,
    });
    expect(a.reportHash).toBe(b.reportHash);
  });

  it("rejects unresolvable refs and option-looking refs", async () => {
    await expect(
      resolver.assess({ base: "main", candidate: "nope", checkoutPath: root }),
    ).rejects.toThrow();
    await expect(
      resolver.assess({ base: "main", candidate: "--output=/tmp/x", checkoutPath: root }),
    ).rejects.toThrow();
  });
});

describe("Project Intelligence", () => {
  it("scans the stack with source-backed claims and revalidates them", () => {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        name: "demo",
        type: "module",
        scripts: { test: "vitest", build: "tsc" },
        dependencies: { zod: "1" },
      }),
    );
    writeFileSync(join(root, "tsconfig.json"), "{}");
    const kb = new KnowledgeStore(root);
    const { claims, refreshed } = kb.scan();
    expect(refreshed.sort()).toEqual(["package.json", "tsconfig.json"]);
    expect(claims.some((c) => c.statement.includes("ES modules"))).toBe(true);
    expect(claims.every((c) => c.evidence.length > 0)).toBe(true);
    expect(claims.map((c) => kb.validity(c))).not.toContain("STALE");

    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "demo2" }));
    const stale = kb.load().find((c) => c.evidence[0]?.path === "package.json")!;
    expect(kb.validity(stale)).toBe("STALE");
  });

  it("re-analyzes only impacted files on the next scan", () => {
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "demo" }));
    writeFileSync(join(root, "tsconfig.json"), "{}");
    const kb = new KnowledgeStore(root);
    kb.scan();
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "demo", type: "module" }));
    const second = kb.scan();
    expect(second.refreshed).toEqual(["package.json"]);
    expect(kb.load().some((c) => c.statement.includes("ES modules"))).toBe(true);
    cleanup(join(root, "tsconfig.json"));
    expect(kb.scan().removed).toEqual(["tsconfig.json"]);
  });

  it("retrieves selectively and marks claims whose source changed", () => {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "demo", scripts: { lint: "eslint ." } }),
    );
    writeFileSync(join(root, "Dockerfile"), "FROM node");
    const kb = new KnowledgeStore(root);
    kb.scan();
    const hits = kb.retrieve("docker", 5);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.validity).toBe("VALID");
    writeFileSync(join(root, "Dockerfile"), "FROM node:22");
    expect(kb.retrieve("docker")[0]?.validity).toBe("STALE");
  });

  it("[R-SECRET-01] never persists secrets and writes atomically", () => {
    const kb = new KnowledgeStore(root);
    writeFileSync(join(root, "a.txt"), "x");
    const evidence = [{ path: "a.txt", sha256: "0".repeat(64) }];
    expect(() =>
      kb.add({
        statement: "key is AKIAABCDEFGHIJKLMNOP",
        evidence,
        confidence: "LOW",
        source: "AGENT",
      }),
    ).toThrow(SecretInKnowledgeError);
    expect(() =>
      kb.add({
        statement: "password = hunter2hunter2",
        evidence,
        confidence: "LOW",
        source: "AGENT",
      }),
    ).toThrow(SecretInKnowledgeError);
    expect(containsSecret("-----BEGIN RSA PRIVATE KEY-----")).toBe(true);
    kb.add({ statement: "the build uses tsc", evidence, confidence: "HIGH", source: "HUMAN" });
    expect(
      JSON.parse(readFileSync(join(root, ".jarvis", "knowledge", "claims.json"), "utf8")),
    ).toHaveLength(1);
    expect(kb.load()[0]?.statement).toBe("the build uses tsc");
  });
});
