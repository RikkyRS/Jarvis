import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export class PathEscapeError extends Error {
  constructor(target: string) {
    super(`Target escapes the project root: ${target}`);
    this.name = "PathEscapeError";
  }
}

const fold = (p: string): string => (process.platform === "win32" ? p.toLowerCase() : p);

/** Resolves symlinks for the deepest existing ancestor so a link cannot smuggle a path out. */
function realpathOfNearest(absolute: string): string {
  let probe = absolute;
  const tail: string[] = [];
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) break;
    tail.unshift(probe.slice(parent.length + 1));
    probe = parent;
  }
  const real = existsSync(probe) ? realpathSync.native(probe) : probe;
  return tail.length ? resolve(real, ...tail) : real;
}

export type CanonicalTarget = { relative: string; absolute: string };

/**
 * Canonicalizes a project-relative path against the real project root.
 * Rejects NUL bytes, absolute paths outside the root, `..` traversal and symlink escapes.
 */
export function canonicalizeTarget(projectRoot: string, target: string): CanonicalTarget {
  if (target.includes("\0")) throw new PathEscapeError(target);
  const root = realpathSync.native(projectRoot);
  const absolute = isAbsolute(target) ? resolve(target) : resolve(root, target);
  const real = realpathOfNearest(absolute);
  const rel = relative(fold(root), fold(real));
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new PathEscapeError(target);
  return { relative: rel === "" ? "." : rel.split(sep).join("/"), absolute: real };
}
