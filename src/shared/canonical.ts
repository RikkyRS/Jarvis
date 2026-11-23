import { createHash } from "node:crypto";

/**
 * Deterministic JSON-compatible normalization: sorted keys, plain objects only,
 * finite numbers, no cycles. Anything else is rejected rather than coerced.
 */
export function canonicalize(value: unknown, ancestors = new WeakSet<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("Canonical values must contain finite numbers.");
    return value;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value))
      throw new TypeError("Canonical values cannot contain circular references.");
    ancestors.add(value);
    const result = value.map((item) => canonicalize(item, ancestors));
    ancestors.delete(value);
    return result;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (ancestors.has(record))
      throw new TypeError("Canonical values cannot contain circular references.");
    const proto = Object.getPrototypeOf(record) as unknown;
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError("Canonical values must use plain objects.");
    }
    ancestors.add(record);
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const item = record[key];
      if (item === undefined) continue;
      result[key] = canonicalize(item, ancestors);
    }
    ancestors.delete(record);
    return result;
  }
  throw new TypeError("Canonical values must be JSON-compatible.");
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Fingerprint of normalized, secret-free data. Callers must strip secrets first. */
export function fingerprint(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
