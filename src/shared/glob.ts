/**
 * Centralized glob matching module.
 *
 * Single point of entry for all glob matching in the project.
 * Replaces the broken custom `globToRegex` and `matchExclude` implementations
 * with picomatch, a battle-tested, zero-dependency glob matcher.
 */
import picomatch from "picomatch";

// ─── Always-Skip Directories ─────────────────────────────────────────────────

/**
 * Directory names always skipped during filesystem walking.
 * Used by all file detection functions (source, docs, images, outlines, copy).
 * Controllable via config `build.exclude_common`.
 */
export const COMMON_SKIP_DIRS = [
  "node_modules", "__pycache__", ".git", ".svn", ".hg",
  "venv", ".venv", "env", ".env", ".tox",
  "site-packages", "dist", "build", ".eggs",
  ".mypy_cache", ".pytest_cache", ".ruff_cache",
  "target", "bin", "obj",
] as const;

export type CommonSkipDir = typeof COMMON_SKIP_DIRS[number];

/**
 * Build a Set of directories to skip, considering the `exclude_common` config flag.
 *
 * @param excludeCommon - When true, returns a Set of COMMON_SKIP_DIRS; when false, returns empty Set
 */
export function buildSkipDirs(excludeCommon: boolean): Set<string> {
  return excludeCommon ? new Set<string>(COMMON_SKIP_DIRS) : new Set<string>();
}

// ─── Glob Matching ───────────────────────────────────────────────────────────

/**
 * Create a reusable matcher function for a list of patterns.
 * More efficient when matching many paths against the same patterns.
 *
 * @param patterns - Array of glob patterns
 * @returns A function that tests a relative path against all patterns
 */
export function createMatcher(patterns: string[]): (relPath: string) => boolean {
  if (patterns.length === 0) return () => false;
  return picomatch(patterns, { dot: true });
}
