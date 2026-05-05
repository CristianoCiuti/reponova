/**
 * Central path resolution module — single point of truth for all path decisions.
 *
 * Build-time: creates PathContext, prepares workspace, converts paths.
 * Query-time: resolves source_file → absolute path using metadata.repos.
 */
import { resolve, relative, join } from "node:path";
import { existsSync, symlinkSync, mkdirSync, readdirSync, statSync, copyFileSync } from "node:fs";
import type { Config } from "../shared/types.js";
import { createMatcher } from "../shared/glob.js";
import { log } from "../shared/utils.js";

export { buildSkipDirs } from "../shared/glob.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** Repo mapping — runtime representation with resolved absolute path. */
export interface RepoMapping {
  name: string;
  /**
   * Absolute path to the repo root (normalized forward slashes).
   * Build-time: resolve(configDir, repoConfig.path).
   * Query-time: reconstructed from metadata — resolve(graphDir, metadata.config_dir, repo.path).
   * NEVER serialized as absolute — graph.json stores only relative paths.
   */
  absPath: string;
}

/** Resolved once from config — passed to all build-time functions. */
export interface PathContext {
  mode: "single" | "multi";
  repos: RepoMapping[];
  /** Root of the workspace (single-repo = repoRoot, multi = tmpDir/workspace) */
  workspace: string;
  /** Output directory (e.g. /abs/path/reponova-out) */
  outputDir: string;
}

// ── Build-time ───────────────────────────────────────────────────────────────

/** Determine mode from config (internal). */
function resolveMode(config: Config): "single" | "multi" {
  return config.repos.length === 1 ? "single" : "multi";
}

/** Create PathContext from config (called by orchestrator). */
export function createPathContext(
  config: Config,
  configDir: string,
  outputDir: string,
): PathContext {
  const mode = resolveMode(config);
  const repos: RepoMapping[] = config.repos.map((r) => ({
    name: r.name,
    absPath: resolve(configDir, r.path).replace(/\\/g, "/"),
  }));

  return {
    mode,
    repos,
    workspace: "", // Set by prepareWorkspace
    outputDir,
  };
}

/**
 * Prepare the workspace directory.
 * Single-repo: returns repoRoot directly (no symlinks).
 * Multi-repo: creates symlink workspace in tmpDir.
 */
export function prepareWorkspace(
  ctx: PathContext,
  tmpDir: string,
  skipDirs: Set<string>,
): string {
  if (ctx.mode === "single") {
    ctx.workspace = ctx.repos[0]!.absPath;
    return ctx.workspace;
  }

  // Multi-repo: create symlink workspace
  const workspace = join(tmpDir, "workspace");
  mkdirSync(workspace, { recursive: true });

  for (const repo of ctx.repos) {
    if (!existsSync(repo.absPath)) {
      log.warn(`Repo not found, skipping: ${repo.absPath}`);
      continue;
    }

    const linkPath = join(workspace, repo.name);
    try {
      symlinkSync(repo.absPath, linkPath, "junction");
      log.info(`  Linked: ${repo.name} \u2192 ${repo.absPath}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`  Symlink failed for ${repo.name}: ${msg}, falling back to copy...`);
      copyDirRecursive(repo.absPath, linkPath, skipDirs);
    }
  }

  ctx.workspace = workspace;
  return workspace;
}

/** Convert an absolute fullPath to the canonical source_file string. */
export function toSourceFile(ctx: PathContext, fullPath: string): string {
  const normalized = fullPath.replace(/\\/g, "/");

  if (ctx.mode === "single") {
    return relative(ctx.repos[0]!.absPath, normalized).replace(/\\/g, "/");
  }

  // Multi: find which repo this belongs to and prefix
  for (const repo of ctx.repos) {
    if (normalized.startsWith(repo.absPath + "/") || normalized === repo.absPath) {
      const repoRel = relative(repo.absPath, normalized).replace(/\\/g, "/");
      return `${repo.name}/${repoRel}`;
    }
  }

  // Fallback: relative to workspace
  return relative(ctx.workspace, normalized).replace(/\\/g, "/");
}

/** Extract repo name from a source_file string. */
export function extractRepoName(
  ctx: PathContext,
  sourceFile: string,
): string | undefined {
  if (ctx.mode === "single") {
    return ctx.repos[0]?.name;
  }

  const first = sourceFile.split("/")[0];
  return ctx.repos.find((r) => r.name === first)?.name;
}

// ── Query-time (use only metadata, NOT config, NOT graphDir) ─────────────────

/**
 * Resolve source_file → absolute filesystem path using repo mappings from metadata.
 * ONLY function for absolute path resolution. Does NOT use graphDir.
 */
export function resolveAbsolutePath(
  repos: RepoMapping[],
  sourceFile: string,
  mode: "single" | "multi",
): string | null {
  if (mode === "single") {
    if (repos.length === 0) return null;
    const abs = resolve(repos[0]!.absPath, sourceFile);
    return existsSync(abs) ? abs : null;
  }

  // multi: source_file = "api/src/core.py" → repo="api", relPath="src/core.py"
  const slashIdx = sourceFile.indexOf("/");
  if (slashIdx === -1) return null;
  const repoName = sourceFile.slice(0, slashIdx);
  const repoRelPath = sourceFile.slice(slashIdx + 1);
  const repo = repos.find((r) => r.name === repoName);
  if (!repo) return null;
  const abs = resolve(repo.absPath, repoRelPath);
  return existsSync(abs) ? abs : null;
}

/** Construct the path to a pre-computed outline file. */
export function resolveOutlinePath(graphDir: string, sourceFile: string): string {
  return join(graphDir, "outlines", sourceFile + ".outline.json");
}

/**
 * Reconstruct RepoMapping[] from graph.json metadata (query-time).
 * Returns null if metadata is missing required fields.
 */
export function reconstructRepos(
  graphDir: string,
  metadataConfigDir?: string,
  metadataRepos?: Array<{ name: string; path: string }>,
): RepoMapping[] | null {
  if (!metadataConfigDir || !metadataRepos) return null;

  const configDir = resolve(graphDir, metadataConfigDir);
  return metadataRepos.map((r) => ({
    name: r.name,
    absPath: resolve(configDir, r.path).replace(/\\/g, "/"),
  }));
}

// ── File path resolution for MCP tool responses ─────────────────────────────

export interface ResolvedPaths {
  /** Path relative to the graph output directory (portable across machines if layout is preserved) */
  graph_rel_path: string | null;
  /** Absolute filesystem path (null if file not found or repos unavailable) */
  absolute_path: string | null;
}

/**
 * Path resolution callback — created once at MCP server startup as a closure
 * that captures graphDir, repos, and mode. Tools receive this single function
 * instead of needing those three params individually.
 */
export type PathResolver = (sourceFile: string) => ResolvedPaths;

/**
 * Resolve a node's source_file into both a graph-relative path and an absolute path.
 * Used by MCP tools to include actionable file locations in responses.
 *
 * - graph_rel_path: relative(graphDir, absolutePath) — portable if repo layout preserved
 * - absolute_path: resolveAbsolutePath(repos, sourceFile, mode) — direct filesystem location
 */
export function resolveFilePaths(
  graphDir: string,
  repos: RepoMapping[] | null | undefined,
  mode: "single" | "multi",
  sourceFile: string | null | undefined,
): ResolvedPaths {
  if (!sourceFile) return { graph_rel_path: null, absolute_path: null };
  if (!repos || repos.length === 0) return { graph_rel_path: null, absolute_path: null };

  const abs = resolveAbsolutePath(repos, sourceFile, mode);
  if (!abs) return { graph_rel_path: null, absolute_path: null };

  const graphRel = relative(graphDir, abs).replace(/\\/g, "/");
  return { graph_rel_path: graphRel, absolute_path: abs };
}

// ── Extension → Glob conversion ──────────────────────────────────────────────

/**
 * Convert a set of file extensions to glob patterns for picomatch.
 * Used when `patterns: []` (auto-detect mode) to replace raw `Set.has(ext)` checks
 * with picomatch, ensuring include and exclude use the same matching engine.
 *
 * Given {".py", ".pyw"}, returns glob patterns that match those extensions at any depth.
 */
export function extensionsToGlobs(extensions: Set<string>): string[] {
  return [...extensions].map(ext => `**/*${ext}`);
}

// ── Pattern matching ─────────────────────────────────────────────────────────

/**
 * Strip repo prefix from a workspace-relative path.
 * "api/src/core.py" → "src/core.py" (if "api" is a known repo name).
 * Returns null if no repo prefix matches.
 */
function stripRepoPrefix(relPath: string, repoNames: Set<string>): string | null {
  const slashIdx = relPath.indexOf("/");
  if (slashIdx === -1) return null;
  const first = relPath.slice(0, slashIdx);
  if (repoNames.has(first)) {
    return relPath.slice(slashIdx + 1);
  }
  return null;
}

/**
 * Create a bidirectional pattern matcher.
 *
 * Tests patterns against multiple forms of the same path:
 * 1. As given (covers both workspace-relative and repo-relative depending on caller)
 * 2. Stripped: removes known repo prefix (workspace-relative → repo-relative)
 * 3. Prefixed: adds repoName (repo-relative → workspace-relative)
 *
 * @param patterns - Glob patterns
 * @param repoNames - Known repo names (enables dual matching)
 * @returns A function `(relPath, repoName?) => boolean`
 */
export function createPatternMatcher(
  patterns: string[],
  repoNames?: Set<string>,
): (relPath: string, repoName?: string) => boolean {
  if (patterns.length === 0) return () => false;
  const matcher = createMatcher(patterns);
  if (!repoNames || repoNames.size === 0) return (p) => matcher(p);

  return (relPath: string, repoName?: string) => {
    // 1. Test as-is
    if (matcher(relPath)) return true;

    // 2. Strip known repo prefix (workspace-relative → repo-relative)
    const stripped = stripRepoPrefix(relPath, repoNames);
    if (stripped !== null && matcher(stripped)) return true;

    // 3. Add repo prefix (repo-relative → workspace-relative)
    if (repoName) {
      return matcher(`${repoName}/${relPath}`);
    }

    return false;
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function copyDirRecursive(src: string, dest: string, skipDirs: Set<string>): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    if (skipDirs.has(entry)) continue;
    const srcPath = join(src, entry);
    const destPath = join(dest, entry);
    const stat = statSync(srcPath);
    if (stat.isDirectory()) {
      copyDirRecursive(srcPath, destPath, skipDirs);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}
