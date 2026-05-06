import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join, basename } from "node:path";
import { tmpdir } from "node:os";
import type { Config, GraphData } from "../shared/types.js";
import { loadConfig } from "../core/config.js";
import { runIndexerStep } from "./steps/indexer.js";
import { runOutlinesStep } from "./steps/outlines.js";
import { runEmbeddingsStep } from "./steps/embeddings-step.js";
import { runCommunitySummariesStep } from "./steps/community-summaries-step.js";
import { runNodeDescriptionsStep } from "./steps/node-descriptions-step.js";
import { runReportStep } from "./steps/report.js";
import { runHtmlStep } from "./steps/html-step.js";
import { LlmEnginePool } from "./intelligence/llm-engine-pool.js";
import { log } from "../shared/utils.js";
import { runPipeline } from "../extract/index.js";
import { buildSkipDirs, createPathContext, prepareWorkspace, extractRepoName } from "../core/path-resolver.js";
import { loadPreviousBuildConfig } from "./incremental/config-diff.js";
import { computeSemanticGraphHash, loadPreviousGraphHash, saveGraphHash } from "./incremental/graph-hash.js";
import {
  createManifest, loadManifest, updateStep, completeManifest,
} from "./manifest.js";
import type { BuildManifest, StepName } from "./manifest.js";
import type { BuildStep, StepContext } from "./types.js";

const STEP_LABELS: Record<string, string> = {
  embeddings: "Embeddings",
  community_summaries: "Community Summaries",
  node_descriptions: "Node Descriptions",
  outlines: "Outlines",
  indexer: "Search Index",
  html: "HTML Visualizations",
  report: "Report",
};

export interface BuildOptions {
  force: boolean;
}

export interface BuildResult {
  outputDir: string;
  fileCount: number;
  nodeCount: number;
  edgeCount: number;
  communityCount: number;
}

export async function runBuild(config: Config, configDir: string, options: BuildOptions): Promise<BuildResult> {
  log.info("reponova build (in-process extraction engine)");

  if (config.repos.length === 0) {
    throw new Error("No repos configured. Add repos to reponova.yml");
  }

  const outputDir = resolve(configDir, config.output);

  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const tmpDir = join(tmpdir(), `rn-build-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });

  try {
    const graphJsonPath = join(outputDir, "graph.json");
    const incremental = config.build.incremental && !options.force;
    const skipDirs = buildSkipDirs(config.build.exclude_common);
    skipDirs.add(basename(outputDir));

    const pathContext = createPathContext(config, configDir, outputDir);
    log.info(`Build${incremental ? " (incremental)" : ""} [${pathContext.mode}-repo mode]...`);

    const previousManifest = loadManifest(outputDir);
    const manifest = createManifest(outputDir);
    const previousConfig = loadPreviousBuildConfig(graphJsonPath, config).previous;
    const previousGraphHash = loadPreviousGraphHash(outputDir);

    const workspace = prepareWorkspace(pathContext, tmpDir, skipDirs);
    const repoNames = pathContext.repos.map((repo) => repo.name);
    if (repoNames.length === 0) {
      throw new Error("No repos linked. Check repo paths in reponova.yml");
    }

    log.info(`Building unified graph (${repoNames.length} repo${repoNames.length > 1 ? "s" : ""})...`);

    updateStep(outputDir, manifest, "extraction", "running");
    const result = await runPipeline({
      workspace,
      patterns: config.build.patterns,
      excludeGlobs: config.build.exclude,
      skipDirs,
      graphJsonPath,
      htmlMinDegree: config.build.html_min_degree,
      outputDir,
      incremental,
      docsConfig: config.build.docs,
      imagesConfig: config.build.images,
      config,
      configDir,
      repoName: pathContext.mode === "single" ? repoNames[0] : undefined,
      repoNames: pathContext.mode === "multi" ? new Set(repoNames) : undefined,
    });
    updateStep(outputDir, manifest, "extraction", "completed");

    updateStep(outputDir, manifest, "graph_build", "running");
    tagNodesWithRepo(graphJsonPath, repoNames, pathContext.mode);
    updateStep(outputDir, manifest, "graph_build", "completed");

    log.info(`Graph: ${result.builtGraph.stats.nodeCount} nodes, ${result.builtGraph.stats.edgeCount} edges, ${result.communities.count} communities`);
    if (result.incrementalStats) {
      const removed = result.incrementalStats.removedFiles ?? 0;
      log.info(`  Incremental: ${result.incrementalStats.cachedFiles} cached, ${result.incrementalStats.reextractedFiles} re-extracted${removed > 0 ? `, ${removed} removed` : ""}`);
    }

    const currentGraphHash = computeSemanticGraphHash(result.builtGraph.graph);
    const graphChanged = previousGraphHash !== currentGraphHash;
    const llmPool = new LlmEnginePool(config.models);

    try {
      const stepContext: StepContext = {
        config,
        configDir,
        outputDir,
        graphJsonPath,
        force: options.force,
        graphChanged,
        previousConfig,
        llmPool,
        graph: result.builtGraph.graph,
        communities: result.communities,
      };

      await executeStep(outputDir, manifest, previousManifest, "embeddings", runEmbeddingsStep, stepContext);
      await executeStep(outputDir, manifest, previousManifest, "community_summaries", runCommunitySummariesStep, stepContext);
      await executeStep(outputDir, manifest, previousManifest, "node_descriptions", runNodeDescriptionsStep, stepContext);
      await executeStep(outputDir, manifest, previousManifest, "outlines", runOutlinesStep, stepContext);
      await executeStep(outputDir, manifest, previousManifest, "indexer", runIndexerStep, stepContext);
      await executeStep(outputDir, manifest, previousManifest, "html", runHtmlStep, stepContext);
      await executeStep(outputDir, manifest, previousManifest, "report", runReportStep, stepContext);
    } finally {
      await llmPool.disposeAll();
    }

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

async function executeStep(
  outputDir: string,
  manifest: BuildManifest,
  previousManifest: BuildManifest | null,
  name: StepName,
  stepFn: BuildStep,
  ctx: StepContext,
): Promise<void> {
  const label = STEP_LABELS[name] ?? name;
  log.info("");
  log.info(`── ${label} ──`);
  updateStep(outputDir, manifest, name, "running");

  try {
    const force = ctx.force || shouldForceStep(previousManifest, name);
    const result = await stepFn({ ...ctx, force });
    if (result.skipped) {
      updateStep(outputDir, manifest, name, "skipped", result.skipReason ?? "up to date");
      log.info(`  Skipped: ${result.skipReason ?? "up to date"}`);
    } else {
      updateStep(outputDir, manifest, name, "completed");
      log.info(`  Done: ${result.processed} processed`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    updateStep(outputDir, manifest, name, "failed", message);
    log.warn(`  Failed (non-blocking): ${message}`);
  }
}

function shouldForceStep(previousManifest: BuildManifest | null, step: StepName): boolean {
  if (!previousManifest) return false;
  const status = previousManifest.steps[step]?.status;
  return status === "running" || status === "failed";
}

export async function build(
  configPath?: string,
  options?: { force?: boolean },
): Promise<BuildResult> {
  const { config, configDir } = loadConfig(configPath);
  return runBuild(config, configDir, { force: options?.force ?? false });
}

function tagNodesWithRepo(graphJsonPath: string, repoNames: string[], mode: "single" | "multi"): void {
  const raw = readFileSync(graphJsonPath, "utf-8");
  const data = JSON.parse(raw) as GraphData;

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
