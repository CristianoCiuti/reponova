/**
 * Recursive directory walker that counts files by extension.
 *
 * Purpose-built for `reponova lang suggest`: scans the repos configured
 * in `reponova.yml` (or a single cwd as fallback) and returns a tally
 * of file extensions, which the suggestion engine then maps to plugin
 * candidates.
 *
 * Honours the same skip rules as the rest of the pipeline
 * (`COMMON_SKIP_DIRS`) plus an optional caller-provided glob exclude list.
 * Walking is bounded: by default we stop after 200k files to avoid
 * pathological cases (huge monorepos, accidental scan of `/`).
 */
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { COMMON_SKIP_DIRS, createMatcher } from "../shared/glob.js";

export interface ScanOptions {
  /** Absolute paths to walk. Non-existent roots are silently skipped. */
  roots: string[];
  /** Names of directories to skip wholesale. Defaults to `COMMON_SKIP_DIRS`. */
  skipDirs?: Set<string>;
  /**
   * Glob patterns (relative to each root) to skip during walking.
   * Empty by default. Uses the project's central `createMatcher`.
   */
  excludeGlobs?: string[];
  /**
   * Safety cap. Walking stops cleanly once this many files have been
   * counted across all roots. Default: 200_000.
   */
  maxFiles?: number;
}

export interface ScanResult {
  /** Lowercased extension (with leading dot) → number of matching files. */
  counts: Map<string, number>;
  /** Total files visited and counted (post-exclude). */
  totalFiles: number;
  /** Roots that didn't exist or weren't directories. */
  missingRoots: string[];
  /** True if walking stopped early due to `maxFiles`. */
  truncated: boolean;
}

/**
 * Synchronously walk the given roots and tally file extensions.
 * Pure FS work — no logging, no side effects beyond directory reads.
 */
export function scanExtensions(opts: ScanOptions): ScanResult {
  const skipDirs = opts.skipDirs ?? new Set<string>(COMMON_SKIP_DIRS);
  const maxFiles = opts.maxFiles ?? 200_000;
  const isExcluded =
    opts.excludeGlobs && opts.excludeGlobs.length > 0
      ? createMatcher(opts.excludeGlobs)
      : () => false;

  const counts = new Map<string, number>();
  const missingRoots: string[] = [];
  let totalFiles = 0;
  let truncated = false;

  function walk(root: string, dir: string): void {
    if (truncated) return;

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (truncated) return;
      const fullPath = join(dir, entry.name);

      // Cheap exclude check first to skip whole subtrees.
      const rel = relative(root, fullPath).replace(/\\/g, "/");
      if (isExcluded(rel)) continue;

      let isDir = entry.isDirectory();
      // Resolve symlinks to a directory only when not skipped by name.
      if (!isDir && entry.isSymbolicLink()) {
        try {
          isDir = statSync(fullPath).isDirectory();
        } catch {
          continue;
        }
      }

      if (isDir) {
        if (skipDirs.has(entry.name)) continue;
        walk(root, fullPath);
        continue;
      }

      if (!entry.isFile()) continue;
      const lastDot = entry.name.lastIndexOf(".");
      if (lastDot <= 0) continue; // skip dotfiles ("." at index 0) and extension-less files
      const ext = entry.name.slice(lastDot).toLowerCase();

      counts.set(ext, (counts.get(ext) ?? 0) + 1);
      totalFiles++;
      if (totalFiles >= maxFiles) {
        truncated = true;
        return;
      }
    }
  }

  for (const root of opts.roots) {
    try {
      const st = statSync(root);
      if (!st.isDirectory()) {
        missingRoots.push(root);
        continue;
      }
    } catch {
      missingRoots.push(root);
      continue;
    }
    walk(root, root);
  }

  return { counts, totalFiles, missingRoots, truncated };
}
