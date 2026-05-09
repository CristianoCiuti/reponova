/**
 * POSIX path utilities — centralized path normalization.
 *
 * Replaces 30+ inline `.replace(/\\/g, "/")` calls across the codebase.
 * All functions normalize Windows backslashes to forward slashes.
 */
import { relative } from "node:path";

/**
 * Normalize a path to POSIX forward slashes.
 */
export function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Compute a relative path with POSIX separators.
 */
export function relativePosix(from: string, to: string): string {
  return relative(from, to).replace(/\\/g, "/");
}

/**
 * Extract the last path component (basename) from a POSIX-normalized path.
 */
export function posixBasename(p: string): string {
  return toPosix(p).split("/").pop() ?? p;
}
