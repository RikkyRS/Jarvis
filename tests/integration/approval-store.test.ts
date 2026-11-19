import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../../src/infrastructure/db.js";
import type { NewOperationApproval } from "../../src/shared/contracts.js";

const directories: string[] = [];

function createStore() {
  const root = mkdtempSync(join(tmpdir(), "jarvis-approval-"));
  directories.push(root);
  const store = Store.open(root);
  const now = new Date().toISOString();
  store.insertCycle({
    id: "cycle-approval-test",
    uuid: "uuid-approval-test",
    number: 1,
    slug: "approval-test",
    project_id: store.projectId,
    objective: "test approval persistence",
    status: "READY",
    payload: "{}",
    created_at: now,
    updated_at: now,
  });
  return { root, store };
}

function approval(store: Store, overrides: Partial<NewOperationApproval> = {}): NewOperationApproval {
  const createdAt = new Date(Date.now() - 1_000).toISOString();
  return {
    id: "approval-1",
    operationId: "operation-1",
    cycleId: "cycle-approval-test",
    projectId: store.projectId,
    requestedBy: "agent:local",
    operation: "COMMIT" as const,
    target: "repo:main",
    parametersHash: "a".repeat(64),
    createdAt,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("operation approval persistence", () => {
  it("creates a pending approval scoped to the current project", () => {
    const { store } = createStore();
    try {
      store.createOperationApproval(approval(store));
      expect(store.getOperationApproval("approval-1")).toMatchObject({
        id: "approval-1",
        projectId: store.projectId,
        status: "PENDING",
        approvedBy: null,
        consumedAt: null,
      });
    } finally {
      store.close();
    }
  });

  it("approves and consumes an approval exactly once", () => {
    const { store } = createStore();
    try {
      store.createOperationApproval(approval(store));
      const approvedAt = new Date().toISOString();
      expect(store.approveOperationApproval("approval-1", "human:local", approvedAt)).toBe(true);
      expect(store.getOperationApproval("approval-1")?.approvedBy).toBe("human:local");

      const consumeInput = {
        id: "approval-1",
        cycleId: "cycle-approval-test",
        operation: "COMMIT" as const,
        target: "repo:main",
        parametersHash: "a".repeat(64),
        consumedAt: new Date(Date.now() + 1).toISOString(),
      };
      expect(store.consumeOperationApproval(consumeInput)).toBe(true);
      expect(store.consumeOperationApproval(consumeInput)).toBe(false);
      expect(store.getOperationApproval("approval-1")?.status).toBe("CONSUMED");
    } finally {
      store.close();
    }
  });

  it("does not consume when the target or parameter hash differs", () => {
    const { store } = createStore();
    try {
      store.createOperationApproval(approval(store));
      store.approveOperationApproval("approval-1", "human:local");
      const base = {
        id: "approval-1",
        cycleId: "cycle-approval-test",
        operation: "COMMIT" as const,
        target: "repo:main",
        parametersHash: "a".repeat(64),
      };
      expect(store.consumeOperationApproval({ ...base, target: "repo:other" })).toBe(false);
      expect(store.consumeOperationApproval({ ...base, parametersHash: "b".repeat(64) })).toBe(false);
      expect(store.getOperationApproval("approval-1")?.status).toBe("APPROVED");
    } finally {
      store.close();
    }
  });

  it("does not approve an expired request", () => {
    const { store } = createStore();
    try {
      const createdAt = new Date(Date.now() - 120_000).toISOString();
      store.createOperationApproval(approval(store, {
        createdAt,
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      }));
      expect(store.approveOperationApproval("approval-1", "human:local")).toBe(false);
    } finally {
      store.close();
    }
  });

  it("does not expose an approval through another project's Store", () => {
    const first = createStore();
    const second = createStore();
    try {
      first.store.createOperationApproval(approval(first.store));
      expect(second.store.getOperationApproval("approval-1")).toBeUndefined();
    } finally {
      first.store.close();
      second.store.close();
    }
  });

  it("rejects an approval whose Cycle does not belong to the project", () => {
    const { store } = createStore();
    try {
      expect(() => store.createOperationApproval(approval(store, { cycleId: "cycle-from-another-project" }))).toThrow(
        /does not belong/i,
      );
    } finally {
      store.close();
    }
  });
});
