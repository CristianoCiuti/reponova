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
  isManifestComplete, invalidateManifestStep, validateManifestStep,
} from "./manifest.js";

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

    // ── Early return decision (manifest + artifact aware) ────────────────
    const noFileChanges = result.incrementalStats?.reextractedFiles === 0
      && (result.incrementalStats?.removedFiles ?? 0) === 0;

    const missingArtifacts = checkExpectedArtifacts(outputDir, config);
    const previousBuildComplete = previousManifest !== null
      && isManifestComplete(previousManifest)
      && missingArtifacts.length === 0;

    if (noFileChanges && !configDiff.hasChanges && !options.force && previousBuildComplete) {
      log.info("No changes detected — graph is up to date");
      completeManifest(outputDir, manifest);
      const existingCounts = readExistingGraphCounts(mergedPath);
      return {
        outputDir,
        fileCount: result.fileCount,
        nodeCount: existingCounts.nodeCount,
        edgeCount: existingCounts.edgeCount,
        communityCount: existingCounts.communityCount,
      };
    }

    if (noFileChanges && !options.force && missingArtifacts.length > 0) {
      log.info(`Resuming incomplete build — missing: ${missingArtifacts.join(", ")}`);
    }

    if (noFileChanges && configDiff.hasChanges && !options.force) {
      log.info("No source changes detected — selectively regenerating changed subsystems");

      if (config.outlines.enabled && configDiff.outlinesChanged) {
        updateStep(outputDir, manifest, "outlines", "running");
        log.info("Generating outlines...");
        const outlineCount = await runOutlineGeneration(config, configDir, outputDir, { force: true, skipDirs });
        log.info(`  \u2713 ${outlineCount} outlines generated`);
        updateStep(outputDir, manifest, "outlines", "completed");
      }

      const shouldRunIntelligence =
        configDiff.embeddingsChanged ||
        configDiff.communitySummariesChanged ||
        configDiff.nodeDescriptionsChanged;

      if (shouldRunIntelligence) {
        if (configDiff.embeddingsChanged) updateStep(outputDir, manifest, "embeddings", "running");
        if (configDiff.communitySummariesChanged) updateStep(outputDir, manifest, "community_summaries", "running");
        if (configDiff.nodeDescriptionsChanged) updateStep(outputDir, manifest, "node_descriptions", "running");

        const intelligenceResult = await runIntelligenceLayer(config, outputDir, mergedPath, {
          skipEmbeddings: !configDiff.embeddingsChanged,
          skipSummaries: !configDiff.communitySummariesChanged,
          skipDescriptions: !configDiff.nodeDescriptionsChanged,
        });
        log.info(`Intelligence: ${intelligenceResult.embeddingsGenerated} embeddings, ${intelligenceResult.communitySummaries} community summaries, ${intelligenceResult.nodeDescriptions} node descriptions`);

        if (configDiff.embeddingsChanged) updateStep(outputDir, manifest, "embeddings", "completed");
        if (configDiff.communitySummariesChanged) updateStep(outputDir, manifest, "community_summaries", "completed");
        if (configDiff.nodeDescriptionsChanged) updateStep(outputDir, manifest, "node_descriptions", "completed");
      }

      if (configDiff.communitySummariesChanged) {
        const communitySummaries = loadCommunitySummaries(outputDir);

        if (config.build.html) {
          updateStep(outputDir, manifest, "html", "running");
          const htmlCommunityPath = join(outputDir, "graph_communities.html");
          log.info("Generating graph_communities.html...");
          exportCommunityHtml({
            graph: result.builtGraph.graph,
            communities: result.communities,
            outputPath: htmlCommunityPath,
            communitySummaries,
          });
          updateStep(outputDir, manifest, "html", "completed");
        }

        updateStep(outputDir, manifest, "report", "running");
        log.info("Generating report.md...");
        generateGraphReport({
          graph: result.builtGraph.graph,
          communities: result.communities,
          outputDir,
          outputPath: join(outputDir, "report.md"),
        });
        updateStep(outputDir, manifest, "report", "completed");
      }

      completeManifest(outputDir, manifest);
      return {
        outputDir,
        fileCount: result.fileCount,
        nodeCount: result.builtGraph.stats.nodeCount,
        edgeCount: result.builtGraph.stats.edgeCount,
        communityCount: result.communities.count,
      };
    }

    // ── Semantic graph hash (skip downstream only if build was previously complete) ──
    const previousGraphHash = loadPreviousGraphHash(outputDir);
    const currentGraphHash = computeSemanticGraphHash(result.builtGraph.graph);

    if (previousGraphHash === currentGraphHash && !configDiff.hasChanges && !options.force && previousBuildComplete) {
      log.info("Semantic graph unchanged — skipping downstream regeneration");
      completeManifest(outputDir, manifest, currentGraphHash);
      return {
        outputDir,
        fileCount: result.fileCount,
        nodeCount: result.builtGraph.stats.nodeCount,
        edgeCount: result.builtGraph.stats.edgeCount,
        communityCount: result.communities.count,
      };
    }

    // ── Determine which steps need running ───────────────────────────────
    const stepsToRun = determineStepsToRun(missingArtifacts, config);

    // ── Step: Search index ───────────────────────────────────────────────
    if (stepsToRun.has("indexer")) {
      updateStep(outputDir, manifest, "indexer", "running");
      await runIndexer(mergedPath, outputDir);
      updateStep(outputDir, manifest, "indexer", "completed");
    } else {
      updateStep(outputDir, manifest, "indexer", "skipped", "artifact exists");
    }

    // ── Step: Outlines ───────────────────────────────────────────────────
    if (config.outlines.enabled && stepsToRun.has("outlines")) {
      updateStep(outputDir, manifest, "outlines", "running");
      const outlineForce = options.force || configDiff.outlinesChanged;
      const outlineSkipDirs = buildSkipDirs(config.outlines.exclude_common);
      outlineSkipDirs.add(basename(outputDir));
      log.info("Generating outlines...");
      const outlineCount = await runOutlineGeneration(config, configDir, outputDir, { force: outlineForce, skipDirs: outlineSkipDirs });
      log.info(`  \u2713 ${outlineCount} outlines generated`);
      updateStep(outputDir, manifest, "outlines", "completed");
    } else if (!config.outlines.enabled) {
      updateStep(outputDir, manifest, "outlines", "skipped", "disabled in config");
    } else {
      updateStep(outputDir, manifest, "outlines", "skipped", "artifact exists");
    }

    // ── Step: Intelligence layer (embeddings + summaries + descriptions) ─
    if (stepsToRun.has("embeddings") || stepsToRun.has("community_summaries") || stepsToRun.has("node_descriptions")) {
      updateStep(outputDir, manifest, "embeddings", "running");
      updateStep(outputDir, manifest, "community_summaries", "running");
      updateStep(outputDir, manifest, "node_descriptions", "running");

      try {
        const intelligenceResult = await runIntelligenceLayer(config, outputDir, mergedPath, {
          skipEmbeddings: !stepsToRun.has("embeddings") && !config.build.embeddings.enabled,
          skipSummaries: !stepsToRun.has("community_summaries") && !config.build.community_summaries.enabled,
          skipDescriptions: !stepsToRun.has("node_descriptions") && !config.build.node_descriptions.enabled,
        });
        log.info(`Intelligence: ${intelligenceResult.embeddingsGenerated} embeddings, ${intelligenceResult.communitySummaries} community summaries, ${intelligenceResult.nodeDescriptions} node descriptions`);

        updateStep(outputDir, manifest, "embeddings",
          config.build.embeddings.enabled ? "completed" : "skipped", !config.build.embeddings.enabled ? "disabled in config" : undefined);
        updateStep(outputDir, manifest, "community_summaries",
          config.build.community_summaries.enabled ? "completed" : "skipped", !config.build.community_summaries.enabled ? "disabled in config" : undefined);
        updateStep(outputDir, manifest, "node_descriptions",
          config.build.node_descriptions.enabled ? "completed" : "skipped", !config.build.node_descriptions.enabled ? "disabled in config" : undefined);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`Intelligence layer failed (non-blocking): ${msg}`);
        updateStep(outputDir, manifest, "embeddings", "failed", msg);
        updateStep(outputDir, manifest, "community_summaries", "failed", msg);
        updateStep(outputDir, manifest, "node_descriptions", "failed", msg);
      }
    } else {
      updateStep(outputDir, manifest, "embeddings", "skipped", "artifact exists");
      updateStep(outputDir, manifest, "community_summaries", "skipped", "artifact exists");
      updateStep(outputDir, manifest, "node_descriptions", "skipped", "artifact exists");
    }

    // ── Step: HTML visualizations ────────────────────────────────────────
    if (config.build.html && stepsToRun.has("html")) {
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
      updateStep(outputDir, manifest, "html", "skipped", "artifact exists");
    }

    // ── Step: Report ─────────────────────────────────────────────────────
    if (stepsToRun.has("report")) {
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
      updateStep(outputDir, manifest, "report", "skipped", "artifact exists");
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

// ─── Artifact Existence Check ────────────────────────────────────────────────

/**
 * Check which expected artifacts are missing or corrupted in the output directory.
 * Used to prevent early-return when a previous build was interrupted.
 * Performs both existence AND integrity checks.
 */
function checkExpectedArtifacts(outputDir: string, config: Config): string[] {
  const missing: string[] = [];

  // Search index: check existence + basic integrity (parseable)
  const dbPath = join(outputDir, "graph_search.db");
  if (!existsSync(dbPath)) {
    missing.push("indexer");
  } else {
    try {
      const content = readFileSync(dbPath);
      // SQLite files start with "SQLite format 3\000"
      if (content.length < 100 || !content.toString("utf-8", 0, 15).startsWith("SQLite format 3")) {
        missing.push("indexer");
      }
    } catch {
      missing.push("indexer");
    }
  }

  if (config.build.embeddings.enabled) {
    const hasVectors = existsSync(join(outputDir, "vectors"));
    const hasVectorsJson = existsSync(join(outputDir, "vectors.json"));
    const hasTfidf = existsSync(join(outputDir, "tfidf_idf.json"));
    if (!hasVectors && !hasVectorsJson && !hasTfidf) missing.push("embeddings");
  }

  if (config.build.community_summaries.enabled) {
    const summariesPath = join(outputDir, "community_summaries.json");
    if (!existsSync(summariesPath)) {
      missing.push("community_summaries");
    } else {
      try { JSON.parse(readFileSync(summariesPath, "utf-8")); }
      catch { missing.push("community_summaries"); }
    }
  }

  if (config.build.node_descriptions.enabled) {
    const descriptionsPath = join(outputDir, "node_descriptions.json");
    if (!existsSync(descriptionsPath)) {
      missing.push("node_descriptions");
    } else {
      try { JSON.parse(readFileSync(descriptionsPath, "utf-8")); }
      catch { missing.push("node_descriptions"); }
    }
  }

  if (config.build.html && !existsSync(join(outputDir, "graph.html"))) {
    missing.push("html");
  }

  if (config.outlines.enabled) {
    const outlinesDir = join(outputDir, "outlines");
    if (!existsSync(outlinesDir)) missing.push("outlines");
  }

  if (!existsSync(join(outputDir, "report.md"))) missing.push("report");

  return missing;
}

/**
 * Determine which pipeline steps need to run based on missing artifacts.
 * On a full build (no missing artifacts from early-return skip), runs everything.
 */
function determineStepsToRun(missingArtifacts: string[], config: Config): Set<string> {
  // If there are missing artifacts, only run those (plus dependencies).
  // Otherwise run everything (normal full build after graph change).
  if (missingArtifacts.length === 0) {
    // Full build — run all steps
    const all = new Set<string>(["indexer", "outlines", "embeddings", "community_summaries", "node_descriptions", "html", "report"]);
    return all;
  }

  // Selective recovery: run missing steps + their dependents
  const steps = new Set<string>(missingArtifacts);

  // HTML depends on community_summaries (for names in visualization)
  if (steps.has("community_summaries") && config.build.html) steps.add("html");
  // Report depends on community_summaries
  if (steps.has("community_summaries")) steps.add("report");

  return steps;
}


