import { describe, expect, it } from "vitest";
import { hashApprovalParameters } from "../../src/engines/approval/index.js";

describe("approval parameter hashing", () => {
  it("produces the same hash regardless of object key order", () => {
    expect(hashApprovalParameters({ branch: "feature", args: ["test"], cwd: "/repo" })).toBe(
      hashApprovalParameters({ cwd: "/repo", args: ["test"], branch: "feature" }),
    );
  });

  it("changes when an operation parameter changes", () => {
    expect(hashApprovalParameters({ branch: "feature-a" })).not.toBe(
      hashApprovalParameters({ branch: "feature-b" }),
    );
  });

  it("rejects values that cannot be represented canonically", () => {
    expect(() => hashApprovalParameters({ value: Number.NaN })).toThrow();
    expect(() => hashApprovalParameters({ value: undefined })).toThrow();
  });

  it("rejects circular references", () => {
    const value: { self?: unknown } = {};
    value.self = value;
    expect(() => hashApprovalParameters(value)).toThrow(/circular/i);
  });
});
