import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import type { Config, GraphData } from "../shared/types.js";
import { loadConfig } from "../core/config.js";
import { runIndexer } from "./indexer.js";
import { runOutlineGeneration } from "./outlines.js";
import { runIntelligenceLayer, type IntelligenceResult } from "./intelligence.js";
import { generateGraphReport } from "./report.js";
import { exportHtml, exportCommunityHtml, type CommunitySummaryInfo } from "../extract/export-html.js";
import { log } from "../shared/utils.js";
import { runPipeline } from "../extract/index.js";
import { buildSkipDirs } from "../core/path-resolver.js";
import { loadPreviousBuildConfig } from "./config-diff.js";
import { cleanStaleArtifacts } from "./artifact-cleanup.js";
import { computeSemanticGraphHash, loadPreviousGraphHash, saveGraphHash } from "./graph-hash.js";
import { createPathContext, prepareWorkspace, extractRepoName } from "../core/path-resolver.js";

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
    const ctx = createPathContext(config, configDir, outputDir);
    log.info(`Build${incremental ? " (incremental)" : ""} [${ctx.mode}-repo mode]...`);

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

    // Tag nodes with repo name
    tagNodesWithRepo(mergedPath, repoNames, ctx.mode);

    log.info(`Graph: ${result.builtGraph.stats.nodeCount} nodes, ${result.builtGraph.stats.edgeCount} edges, ${result.communities.count} communities`);
    if (result.incrementalStats) {
      const removed = result.incrementalStats.removedFiles ?? 0;
      log.info(`  Incremental: ${result.incrementalStats.cachedFiles} cached, ${result.incrementalStats.reextractedFiles} re-extracted${removed > 0 ? `, ${removed} removed` : ""}`);
    }

    const noFileChanges = result.incrementalStats?.reextractedFiles === 0
      && (result.incrementalStats?.removedFiles ?? 0) === 0;

    if (noFileChanges && !configDiff.hasChanges && !options.force) {
      log.info("No changes detected — graph is up to date");
      const existingCounts = readExistingGraphCounts(mergedPath);
      return {
        outputDir,
        fileCount: result.fileCount,
        nodeCount: existingCounts.nodeCount,
        edgeCount: existingCounts.edgeCount,
        communityCount: existingCounts.communityCount,
      };
    }

    if (noFileChanges && configDiff.hasChanges && !options.force) {
      log.info("No source changes detected — selectively regenerating changed subsystems");

      if (config.outlines.enabled && configDiff.outlinesChanged) {
        log.info("Generating outlines...");
        const outlineCount = await runOutlineGeneration(config, configDir, outputDir, { force: true, skipDirs });
        log.info(`  ✓ ${outlineCount} outlines generated`);
      }

      const shouldRunIntelligence =
        configDiff.embeddingsChanged ||
        configDiff.communitySummariesChanged ||
        configDiff.nodeDescriptionsChanged;

      const intelligenceResult: IntelligenceResult = shouldRunIntelligence
        ? await runIntelligenceLayer(config, outputDir, mergedPath, {
            skipEmbeddings: !configDiff.embeddingsChanged,
            skipSummaries: !configDiff.communitySummariesChanged,
            skipDescriptions: !configDiff.nodeDescriptionsChanged,
          })
        : { embeddingsGenerated: 0, communitySummaries: 0, nodeDescriptions: 0 };

      if (shouldRunIntelligence) {
        log.info(`Intelligence: ${intelligenceResult.embeddingsGenerated} embeddings, ${intelligenceResult.communitySummaries} community summaries, ${intelligenceResult.nodeDescriptions} node descriptions`);
      }

      if (configDiff.communitySummariesChanged) {
        const communitySummaries = loadCommunitySummaries(outputDir);

        if (config.build.html) {
          const htmlCommunityPath = join(outputDir, "graph_communities.html");
          log.info("Generating graph_communities.html...");
          exportCommunityHtml({
            graph: result.builtGraph.graph,
            communities: result.communities,
            outputPath: htmlCommunityPath,
            communitySummaries,
          });
        }

        log.info("Generating report.md...");
        generateGraphReport({
          graph: result.builtGraph.graph,
          communities: result.communities,
          outputDir,
          outputPath: join(outputDir, "report.md"),
        });
      }

      return {
        outputDir,
        fileCount: result.fileCount,
        nodeCount: result.builtGraph.stats.nodeCount,
        edgeCount: result.builtGraph.stats.edgeCount,
        communityCount: result.communities.count,
      };
    }

    const previousGraphHash = loadPreviousGraphHash(outputDir);
    const currentGraphHash = computeSemanticGraphHash(result.builtGraph.graph);
    saveGraphHash(outputDir, currentGraphHash);

    if (previousGraphHash === currentGraphHash && !configDiff.hasChanges && !options.force) {
      log.info("Semantic graph unchanged — skipping downstream regeneration");
      return {
        outputDir,
        fileCount: result.fileCount,
        nodeCount: result.builtGraph.stats.nodeCount,
        edgeCount: result.builtGraph.stats.edgeCount,
        communityCount: result.communities.count,
      };
    }

    // Generate search index
    await runIndexer(mergedPath, outputDir);

    // Generate outlines (if enabled)
    if (config.outlines.enabled) {
      const outlineForce = options.force || configDiff.outlinesChanged;
      const outlineSkipDirs = buildSkipDirs(config.outlines.exclude_common);
      log.info("Generating outlines...");
      const outlineCount = await runOutlineGeneration(config, configDir, outputDir, { force: outlineForce, skipDirs: outlineSkipDirs });
      log.info(`  ✓ ${outlineCount} outlines generated`);
    }

    // Intelligence layer: embeddings + summaries (best-effort)
    const intelligenceResult = await runIntelligenceLayer(config, outputDir, mergedPath);
    log.info(`Intelligence: ${intelligenceResult.embeddingsGenerated} embeddings, ${intelligenceResult.communitySummaries} community summaries, ${intelligenceResult.nodeDescriptions} node descriptions`);

    // Load community summaries (if generated by intelligence layer)
    const summariesPath = join(outputDir, "community_summaries.json");
    let communitySummaries: CommunitySummaryInfo[] | undefined;
    if (existsSync(summariesPath)) {
      try {
        communitySummaries = JSON.parse(readFileSync(summariesPath, "utf-8")) as CommunitySummaryInfo[];
      } catch {
        // Ignore parse errors
      }
    }

    // HTML visualizations AFTER intelligence so community names are available
    if (config.build.html) {
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
    }

    // Report AFTER intelligence layer so community summaries can be used as names
    log.info("Generating report.md...");
    generateGraphReport({
      graph: result.builtGraph.graph,
      communities: result.communities,
      outputDir,
      outputPath: join(outputDir, "report.md"),
    });

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


