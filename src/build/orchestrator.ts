import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join, basename } from "node:path";
import { tmpdir } from "node:os";
import type { Config, GraphData } from "../shared/types.js";
import { loadConfig } from "../core/config.js";
import { runIndexer } from "./indexer.js";
import { runOutlineGeneration } from "./outlines.js";
import { runIntelligenceLayer } from "./intelligence.js";
import { generateGraphReport } from "./report.js";
import { exportHtml, exportCommunityHtml, type CommunitySummaryInfo } from "../extract/export-html.js";
import { log } from "../shared/utils.js";
import { runPipeline } from "../extract/index.js";
import { buildSkipDirs } from "../core/path-resolver.js";
import { loadPreviousBuildConfig } from "./config-diff.js";
import { cleanStaleArtifacts } from "./artifact-cleanup.js";
import { computeSemanticGraphHash, loadPreviousGraphHash, saveGraphHash } from "./graph-hash.js";
import { createPathContext, prepareWorkspace, extractRepoName } from "../core/path-resolver.js";
import {
  createManifest, loadManifest, updateStep, completeManifest,
} from "./manifest.js";
import type { StepName } from "./manifest.js";
import { computeBuildPlan } from "./build-planner.js";

export interface BuildOptions {
  force: boolean;
}

/**
 * Build result returned by both `runBuild()` and the public `build()` API.
 */
export interface BuildResult {
  /** Absolute path to the output directory */
  outputDir: string;
  /** Number of source files processed */
  fileCount: number;
  /** Number of nodes in the graph */
  nodeCount: number;
  /** Number of edges in the graph */
  edgeCount: number;
  /** Number of detected communities */
  communityCount: number;
}

/**
 * Run the full build pipeline.
 *
 * Phase 0 rewrite: Uses in-process extraction engine (web-tree-sitter WASM +
 * graphology) instead of Python subprocess. Zero external runtime dependencies.
 */
export async function runBuild(config: Config, configDir: string, options: BuildOptions): Promise<BuildResult> {
  log.info("reponova build (in-process extraction engine)");

  if (config.repos.length === 0) {
    throw new Error("No repos configured. Add repos to reponova.yml");
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

  const tmpDir = join(tmpdir(), `rn-build-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });

  try {
    const mergedPath = join(outputDir, "graph.json");
    const incremental = config.build.incremental && !options.force;
    const skipDirs = buildSkipDirs(config.build.exclude_common);

    // Prevent the build from walking into its own output directory.
    skipDirs.add(basename(outputDir));
    const ctx = createPathContext(config, configDir, outputDir);
    log.info(`Build${incremental ? " (incremental)" : ""} [${ctx.mode}-repo mode]...`);

    // ── Manifest: track pipeline completion state ────────────────────────
    // Load previous manifest BEFORE creating new one (to check if last build completed)
    const previousManifest = loadManifest(outputDir);
    const manifest = createManifest(outputDir);

    // ── Config change detection ──────────────────────────────────────────
    const configDiff = loadPreviousBuildConfig(mergedPath, config);

    if (configDiff.hasChanges) {
      log.info("Config changes detected since last build:");
      if (configDiff.embeddingsChanged) log.info("  → Embeddings config changed — will regenerate vectors");
      if (configDiff.outlinesChanged) log.info("  → Outlines config changed — will regenerate outlines");
      if (configDiff.communitySummariesChanged) log.info("  → Community summaries config changed — will regenerate summaries");
      if (configDiff.nodeDescriptionsChanged) log.info("  → Node descriptions config changed — will regenerate descriptions");
    }

    cleanStaleArtifacts(outputDir, configDiff, config);

    const workspace = prepareWorkspace(ctx, tmpDir, skipDirs);
    const repoNames = ctx.repos.map((r) => r.name);

    if (repoNames.length === 0) {
      throw new Error("No repos linked. Check repo paths in reponova.yml");
    }

    log.info(`Building unified graph (${repoNames.length} repo${repoNames.length > 1 ? "s" : ""})...`);

    // ── Step: Extraction + Graph Build ───────────────────────────────────
    updateStep(outputDir, manifest, "extraction", "running");
    const result = await runPipeline({
      workspace,
      patterns: config.build.patterns,
      excludeGlobs: config.build.exclude,
      skipDirs,
      graphJsonPath: mergedPath,
      htmlMinDegree: config.build.html_min_degree,
      outputDir,
      incremental,
      docsConfig: config.build.docs,
      imagesConfig: config.build.images,
      config,
      configDir,
      // Single-repo: pass repo name so nodes are tagged directly
      repoName: ctx.mode === "single" ? repoNames[0] : undefined,
      // Multi-repo: pass repo names for pattern matching fix
      repoNames: ctx.mode === "multi" ? new Set(repoNames) : undefined,
    });
    updateStep(outputDir, manifest, "extraction", "completed");

    // Tag nodes with repo name
    updateStep(outputDir, manifest, "graph_build", "running");
    tagNodesWithRepo(mergedPath, repoNames, ctx.mode);
    updateStep(outputDir, manifest, "graph_build", "completed");

    log.info(`Graph: ${result.builtGraph.stats.nodeCount} nodes, ${result.builtGraph.stats.edgeCount} edges, ${result.communities.count} communities`);
    if (result.incrementalStats) {
      const removed = result.incrementalStats.removedFiles ?? 0;
      log.info(`  Incremental: ${result.incrementalStats.cachedFiles} cached, ${result.incrementalStats.reextractedFiles} re-extracted${removed > 0 ? `, ${removed} removed` : ""}`);
    }

    // ── Compute build plan (single unified decision) ─────────────────────
    const currentGraphHash = computeSemanticGraphHash(result.builtGraph.graph);
    const plan = await computeBuildPlan({
      previousManifest,
      configDiff,
      fileChanges: {
        reextractedFiles: result.incrementalStats?.reextractedFiles ?? 0,
        removedFiles: result.incrementalStats?.removedFiles ?? 0,
      },
      previousGraphHash: loadPreviousGraphHash(outputDir),
      currentGraphHash,
      config,
      outputDir,
      force: options.force,
    });

    // ── Early return if nothing to do ────────────────────────────────────
    if (plan.isUpToDate) {
      log.info("No changes detected — graph is up to date");
      completeManifest(outputDir, manifest, currentGraphHash);
      const existingCounts = readExistingGraphCounts(mergedPath);
      return {
        outputDir,
        fileCount: result.fileCount,
        nodeCount: existingCounts.nodeCount,
        edgeCount: existingCounts.edgeCount,
        communityCount: existingCounts.communityCount,
      };
    }

    // ── Log build plan ───────────────────────────────────────────────────
    logBuildPlan(plan.stepsToRun, plan.reasons);

    // ── Step: Search index ───────────────────────────────────────────────
    if (plan.stepsToRun.has("indexer")) {
      updateStep(outputDir, manifest, "indexer", "running");
      await runIndexer(mergedPath, outputDir);
      updateStep(outputDir, manifest, "indexer", "completed");
    } else {
      updateStep(outputDir, manifest, "indexer", "skipped", "up to date");
    }

    // ── Step: Outlines ───────────────────────────────────────────────────
    if (plan.stepsToRun.has("outlines")) {
      updateStep(outputDir, manifest, "outlines", "running");
      const outlineForce = options.force || configDiff.outlinesChanged;
      const outlineSkipDirs = buildSkipDirs(config.outlines.exclude_common);
      outlineSkipDirs.add(basename(outputDir));
      log.info("Generating outlines...");
      const outlineCount = await runOutlineGeneration(config, configDir, outputDir, { force: outlineForce, skipDirs: outlineSkipDirs });
      log.info(`  ✓ ${outlineCount} outlines generated`);
      updateStep(outputDir, manifest, "outlines", "completed");
    } else if (!config.outlines.enabled) {
      updateStep(outputDir, manifest, "outlines", "skipped", "disabled in config");
    } else {
      updateStep(outputDir, manifest, "outlines", "skipped", "up to date");
    }

    // ── Step: Intelligence layer (embeddings + summaries + descriptions) ─
    const runEmbeddings = plan.stepsToRun.has("embeddings");
    const runSummaries = plan.stepsToRun.has("community_summaries");
    const runDescriptions = plan.stepsToRun.has("node_descriptions");

    if (runEmbeddings || runSummaries || runDescriptions) {
      if (runEmbeddings) updateStep(outputDir, manifest, "embeddings", "running");
      if (runSummaries) updateStep(outputDir, manifest, "community_summaries", "running");
      if (runDescriptions) updateStep(outputDir, manifest, "node_descriptions", "running");

      try {
        const intelligenceResult = await runIntelligenceLayer(config, outputDir, mergedPath, {
          skipEmbeddings: !runEmbeddings,
          skipSummaries: !runSummaries,
          skipDescriptions: !runDescriptions,
        });
        log.info(`Intelligence: ${intelligenceResult.embeddingsGenerated} embeddings, ${intelligenceResult.communitySummaries} community summaries, ${intelligenceResult.nodeDescriptions} node descriptions`);

        if (runEmbeddings) updateStep(outputDir, manifest, "embeddings", "completed");
        if (runSummaries) updateStep(outputDir, manifest, "community_summaries", "completed");
        if (runDescriptions) updateStep(outputDir, manifest, "node_descriptions", "completed");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`Intelligence layer failed (non-blocking): ${msg}`);
        if (runEmbeddings) updateStep(outputDir, manifest, "embeddings", "failed", msg);
        if (runSummaries) updateStep(outputDir, manifest, "community_summaries", "failed", msg);
        if (runDescriptions) updateStep(outputDir, manifest, "node_descriptions", "failed", msg);
      }
    } else {
      if (!config.build.embeddings.enabled) {
        updateStep(outputDir, manifest, "embeddings", "skipped", "disabled in config");
      } else {
        updateStep(outputDir, manifest, "embeddings", "skipped", "up to date");
      }
      if (!config.build.community_summaries.enabled) {
        updateStep(outputDir, manifest, "community_summaries", "skipped", "disabled in config");
      } else {
        updateStep(outputDir, manifest, "community_summaries", "skipped", "up to date");
      }
      if (!config.build.node_descriptions.enabled) {
        updateStep(outputDir, manifest, "node_descriptions", "skipped", "disabled in config");
      } else {
        updateStep(outputDir, manifest, "node_descriptions", "skipped", "up to date");
      }
    }

    // ── Step: HTML visualizations ────────────────────────────────────────
    if (plan.stepsToRun.has("html")) {
      updateStep(outputDir, manifest, "html", "running");

      // Load community summaries (if generated by intelligence layer)
      const communitySummaries = loadCommunitySummaries(outputDir);

      const htmlPath = join(outputDir, "graph.html");
      log.info("Generating graph.html...");
      exportHtml({
        graph: result.builtGraph.graph,
        communities: result.communities,
        outputPath: htmlPath,
        minDegree: config.build.html_min_degree,
      });

      const htmlCommunityPath = join(outputDir, "graph_communities.html");
      log.info("Generating graph_communities.html...");
      exportCommunityHtml({
        graph: result.builtGraph.graph,
        communities: result.communities,
        outputPath: htmlCommunityPath,
        communitySummaries,
      });

      updateStep(outputDir, manifest, "html", "completed");
    } else if (!config.build.html) {
      updateStep(outputDir, manifest, "html", "skipped", "disabled in config");
    } else {
      updateStep(outputDir, manifest, "html", "skipped", "up to date");
    }

    // ── Step: Report ─────────────────────────────────────────────────────
    if (plan.stepsToRun.has("report")) {
      updateStep(outputDir, manifest, "report", "running");
      log.info("Generating report.md...");
      generateGraphReport({
        graph: result.builtGraph.graph,
        communities: result.communities,
        outputDir,
        outputPath: join(outputDir, "report.md"),
      });
      updateStep(outputDir, manifest, "report", "completed");
    } else {
      updateStep(outputDir, manifest, "report", "skipped", "up to date");
    }

    // ── Save graph hash ONLY after all steps complete ────────────────────
    saveGraphHash(outputDir, currentGraphHash);
    completeManifest(outputDir, manifest, currentGraphHash);

    log.info("");
    log.info("Build complete!");
    log.info(`  Output: ${outputDir}`);
    log.info(`  Repos: ${config.repos.length}`);
    log.info(`  Files: ${result.fileCount}`);
    log.info(`  Nodes: ${result.builtGraph.stats.nodeCount}`);
    log.info(`  Edges: ${result.builtGraph.stats.edgeCount}`);
    log.info(`  Communities: ${result.communities.count}`);

    return {
      outputDir,
      fileCount: result.fileCount,
      nodeCount: result.builtGraph.stats.nodeCount,
      edgeCount: result.builtGraph.stats.edgeCount,
      communityCount: result.communities.count,
    };
  } finally {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}

function loadCommunitySummaries(outputDir: string): CommunitySummaryInfo[] | undefined {
  const summariesPath = join(outputDir, "community_summaries.json");
  if (!existsSync(summariesPath)) return undefined;

  try {
    return JSON.parse(readFileSync(summariesPath, "utf-8")) as CommunitySummaryInfo[];
  } catch {
    return undefined;
  }
}

function readExistingGraphCounts(graphJsonPath: string): { nodeCount: number; edgeCount: number; communityCount: number } {
  const raw = JSON.parse(readFileSync(graphJsonPath, "utf-8")) as GraphData;
  return {
    nodeCount: raw.metadata?.node_count ?? raw.nodes.length,
    edgeCount: raw.metadata?.edge_count ?? raw.edges.length,
    communityCount: raw.communities?.length ?? 0,
  };
}

/**
 * Log the build plan: which steps will run and why.
 */
function logBuildPlan(stepsToRun: Set<StepName>, reasons: Map<StepName, string>): void {
  log.info("Build plan:");
  for (const step of stepsToRun) {
    log.info(`  → ${step}: ${reasons.get(step) ?? "unknown"}`);
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Build the knowledge graph programmatically.
 *
 * This is the public entry point for running a build from code.
 * Register custom extractors, outline languages, or NL rulesets
 * BEFORE calling this function — they will be picked up automatically.
 *
 * @param configPath - Path to `reponova.yml`. If omitted, auto-detected
 *                     from standard locations (see Config Resolution docs).
 * @param options - Build options. `force` deletes existing output and rebuilds.
 * @returns Build result with output path and graph statistics.
 *
 * @example
 * ```typescript
 * import { build, registerExtractor } from "reponova";
 *
 * registerExtractor(myCustomExtractor);
 * const result = await build("./reponova.yml");
 * console.log(`Built: ${result.nodeCount} nodes, ${result.edgeCount} edges`);
 * ```
 */
export async function build(
  configPath?: string,
  options?: { force?: boolean },
): Promise<BuildResult> {
  const { config, configDir } = loadConfig(configPath);
  return runBuild(config, configDir, { force: options?.force ?? false });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Tag each node's `repo` field using extractRepoName from path-resolver.
 */
function tagNodesWithRepo(graphJsonPath: string, repoNames: string[], mode: "single" | "multi"): void {
  const raw = readFileSync(graphJsonPath, "utf-8");
  const data = JSON.parse(raw) as GraphData;

  // Build a minimal PathContext for extractRepoName
  const ctx = {
    mode,
    repos: repoNames.map((name) => ({ name, absPath: "" })),
    workspace: "",
    outputDir: "",
  };

  for (const node of data.nodes) {
    if (!node.source_file) continue;
    const repo = extractRepoName(ctx, node.source_file);
    if (repo) node.repo = repo;
  }

  writeFileSync(graphJsonPath, JSON.stringify(data, null, 2));
}
