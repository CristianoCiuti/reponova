import { existsSync, mkdirSync, rmSync, symlinkSync, copyFileSync, readdirSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import type { Config, GraphData } from "../shared/types.js";
import { runIndexer } from "./indexer.js";
import { runOutlineGeneration } from "./outlines.js";
import { log } from "../shared/utils.js";
import { runPipeline, type PipelineResult } from "../extract/index.js";

export interface BuildOptions {
  force: boolean;
}

/**
 * Run the full build pipeline.
 *
 * Phase 0 rewrite: Uses in-process extraction engine (web-tree-sitter WASM +
 * graphology) instead of Python subprocess. Zero external runtime dependencies.
 */
export async function runBuild(config: Config, configDir: string, options: BuildOptions): Promise<void> {
  log.info("graphify-mcp-tools build (in-process extraction engine)");

  if (config.repos.length === 0) {
    log.error("No repos configured. Add repos to graphify-mcp-tools.yml");
    process.exit(1);
  }

  // Create output directory (with --force cleanup)
  const outputDir = resolve(configDir, config.output);

  if (options.force) {
    if (existsSync(outputDir)) {
      rmSync(outputDir, { recursive: true, force: true });
      log.info(`Cleaned output: ${outputDir}`);
    }
  }

  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const tmpDir = join(tmpdir(), `graphify-build-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });

  try {
    const mergedPath = join(outputDir, "graph.json");
    const htmlPath = config.build.html ? join(outputDir, "graph.html") : undefined;
    const mode = config.build.mode;
    log.info(`Build mode: ${mode}`);

    let result: PipelineResult;

    if (mode === "monorepo") {
      result = await buildMonorepo(config, configDir, options, tmpDir, mergedPath, htmlPath);
    } else {
      result = await buildSeparate(config, configDir, options, tmpDir, mergedPath, htmlPath);
    }

    // Tag nodes with repo name (monorepo: from first path component)
    if (mode === "monorepo") {
      const repoNames = config.repos.map((r) => r.name);
      tagNodesWithRepo(mergedPath, repoNames);
    }

    log.info(`Graph: ${result.builtGraph.stats.nodeCount} nodes, ${result.builtGraph.stats.edgeCount} edges, ${result.communities.count} communities`);

    // Generate search index
    await runIndexer(mergedPath, outputDir);

    // Generate outlines (if enabled)
    if (config.outlines.enabled) {
      log.info("Generating outlines...");
      const outlineCount = await runOutlineGeneration(config, configDir, outputDir, { force: options.force });
      log.info(`  \u2713 ${outlineCount} outlines generated`);
    }

    log.info("");
    log.info("Build complete!");
    log.info(`  Output: ${outputDir}`);
    log.info(`  Repos: ${config.repos.length}`);
    log.info(`  Files: ${result.fileCount}`);
    log.info(`  Nodes: ${result.builtGraph.stats.nodeCount}`);
    log.info(`  Edges: ${result.builtGraph.stats.edgeCount}`);
    log.info(`  Communities: ${result.communities.count}`);
  } finally {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}

// ─── Monorepo mode ───────────────────────────────────────────────────────────

async function buildMonorepo(
  config: Config,
  configDir: string,
  _options: BuildOptions,
  tmpDir: string,
  mergedPath: string,
  htmlPath: string | undefined,
): Promise<PipelineResult> {
  const workspace = join(tmpDir, "workspace");
  mkdirSync(workspace, { recursive: true });

  // Symlink each repo into workspace/<repo_name>
  const repoNames: string[] = [];
  for (const repo of config.repos) {
    const repoPath = resolve(configDir, repo.path);
    if (!existsSync(repoPath)) {
      log.warn(`Repo not found, skipping: ${repoPath}`);
      continue;
    }

    const linkPath = join(workspace, repo.name);
    try {
      symlinkSync(repoPath, linkPath, "junction");
      log.info(`  Linked: ${repo.name} \u2192 ${repoPath}`);
      repoNames.push(repo.name);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`  Symlink failed for ${repo.name}: ${msg}, falling back to copy...`);
      copyDirRecursive(repoPath, linkPath, config.build.exclude);
      repoNames.push(repo.name);
    }
  }

  if (repoNames.length === 0) {
    log.error("No repos linked. Check repo paths.");
    process.exit(1);
  }

  log.info(`Building unified graph (${repoNames.length} repos)...`);

  return runPipeline({
    workspace,
    excludeDirs: config.build.exclude,
    graphJsonPath: mergedPath,
    graphHtmlPath: htmlPath,
    htmlMinDegree: config.build.html_min_degree,
  });
}

// ─── Separate mode ───────────────────────────────────────────────────────────

async function buildSeparate(
  config: Config,
  configDir: string,
  _options: BuildOptions,
  tmpDir: string,
  mergedPath: string,
  htmlPath: string | undefined,
): Promise<PipelineResult> {
  // In separate mode, we build each repo independently then merge
  // For now, use the same monorepo approach (symlink into workspace)
  // The extraction engine handles multi-repo by default via file path prefixes
  const workspace = join(tmpDir, "workspace");
  mkdirSync(workspace, { recursive: true });

  for (const repo of config.repos) {
    const repoPath = resolve(configDir, repo.path);
    if (!existsSync(repoPath)) {
      log.warn(`Repo not found, skipping: ${repoPath}`);
      continue;
    }

    const linkPath = join(workspace, repo.name);
    try {
      symlinkSync(repoPath, linkPath, "junction");
    } catch {
      copyDirRecursive(repoPath, linkPath, config.build.exclude);
    }
  }

  return runPipeline({
    workspace,
    excludeDirs: config.build.exclude,
    graphJsonPath: mergedPath,
    graphHtmlPath: htmlPath,
    htmlMinDegree: config.build.html_min_degree,
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Tag each node's `repo` field based on the first path component of source_file.
 */
function tagNodesWithRepo(graphJsonPath: string, repoNames: string[]): void {
  const raw = readFileSync(graphJsonPath, "utf-8");
  const data = JSON.parse(raw) as GraphData;
  const repoSet = new Set(repoNames);

  for (const node of data.nodes) {
    if (!node.source_file) continue;
    const normalized = node.source_file.replace(/\\/g, "/");
    const firstComponent = normalized.split("/")[0];
    if (firstComponent && repoSet.has(firstComponent)) {
      node.repo = firstComponent;
    }
  }

  writeFileSync(graphJsonPath, JSON.stringify(data, null, 2));
}

/**
 * Recursive directory copy with exclusion support.
 */
function copyDirRecursive(src: string, dest: string, excludeDirs: string[]): void {
  const excludeSet = new Set(excludeDirs);
  mkdirSync(dest, { recursive: true });

  for (const entry of readdirSync(src)) {
    if (excludeSet.has(entry)) continue;
    const srcPath = join(src, entry);
    const destPath = join(dest, entry);
    const stat = statSync(srcPath);
    if (stat.isDirectory()) {
      copyDirRecursive(srcPath, destPath, excludeDirs);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}
