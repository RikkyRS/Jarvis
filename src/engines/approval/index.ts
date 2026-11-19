import { createHash } from "node:crypto";

function canonicalize(value: unknown, ancestors = new WeakSet<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Approval parameters must contain finite numbers.");
    return value;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new TypeError("Approval parameters cannot contain circular references.");
    ancestors.add(value);
    const result = value.map((item) => canonicalize(item, ancestors));
    ancestors.delete(value);
    return result;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (ancestors.has(record)) throw new TypeError("Approval parameters cannot contain circular references.");
    const prototype = Object.getPrototypeOf(record);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Approval parameters must use plain objects.");
    }
    ancestors.add(record);
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      result[key] = canonicalize(record[key], ancestors);
    }
    ancestors.delete(record);
    return result;
  }
  throw new TypeError("Approval parameters must be JSON-compatible values.");
}

/**
 * Hashes normalized, secret-free operation parameters.
 * Callers must exclude credentials, tokens and other secrets before hashing.
 */
export function hashApprovalParameters(parameters: unknown): string {
  const canonical = JSON.stringify(canonicalize(parameters));
  return createHash("sha256").update(canonical).digest("hex");
}
