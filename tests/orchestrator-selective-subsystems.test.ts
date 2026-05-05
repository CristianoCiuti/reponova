import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Config } from "../src/shared/types.js";
import { DEFAULT_CONFIG } from "../src/shared/types.js";

const tempDirs: string[] = [];

const runPipelineMock = vi.fn();
const runIndexerMock = vi.fn();
const runOutlineGenerationMock = vi.fn();
const runEmbeddingsStepMock = vi.fn();
const runCommunitySummariesStepMock = vi.fn();
const runNodeDescriptionsStepMock = vi.fn();
const generateGraphReportMock = vi.fn();
const exportHtmlMock = vi.fn();
const exportCommunityHtmlMock = vi.fn();
const loadPreviousBuildConfigMock = vi.fn();
const cleanStaleArtifactsMock = vi.fn();
const loadPreviousGraphHashMock = vi.fn();
const computeSemanticGraphHashMock = vi.fn();
const saveGraphHashMock = vi.fn();

vi.mock("../src/extract/index.js", () => ({ runPipeline: runPipelineMock }));
vi.mock("../src/build/indexer.js", () => ({ runIndexer: runIndexerMock }));
vi.mock("../src/build/outlines.js", () => ({ runOutlineGeneration: runOutlineGenerationMock }));
vi.mock("../src/build/intelligence.js", () => ({
  runEmbeddingsStep: runEmbeddingsStepMock,
  runCommunitySummariesStep: runCommunitySummariesStepMock,
  runNodeDescriptionsStep: runNodeDescriptionsStepMock,
}));
vi.mock("../src/build/report.ts", () => ({ generateGraphReport: generateGraphReportMock }));
vi.mock("../src/extract/export-html.js", () => ({ exportHtml: exportHtmlMock, exportCommunityHtml: exportCommunityHtmlMock }));
vi.mock("../src/build/config-diff.js", () => ({ loadPreviousBuildConfig: loadPreviousBuildConfigMock }));
vi.mock("../src/build/artifact-cleanup.js", () => ({ cleanStaleArtifacts: cleanStaleArtifactsMock }));
vi.mock("../src/build/graph-hash.js", () => ({
  loadPreviousGraphHash: loadPreviousGraphHashMock,
  computeSemanticGraphHash: computeSemanticGraphHashMock,
  saveGraphHash: saveGraphHashMock,
}));

// Mock openDatabase for artifact integrity checks
const openDatabaseMock = vi.fn();
vi.mock("../src/core/db.js", () => ({ openDatabase: openDatabaseMock }));

describe("PROP-I2: selective subsystem execution", () => {
  afterEach(() => {
    vi.clearAllMocks();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function setupConfig(): { config: Config; configDir: string; outputDir: string; graphPath: string } {
    const root = join(tmpdir(), `rn-test-prop-i2-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    tempDirs.push(root);

    const configDir = join(root, "config");
    const repoDir = join(root, "repo");
    const outputDir = join(root, "out");

    mkdirSync(configDir, { recursive: true });
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(outputDir, { recursive: true });

    const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as Config;
    config.output = "../out";
    config.repos = [{ name: "repo", path: "../repo" }];
    config.build.html = true;

    return {
      config,
      configDir,
      outputDir,
      graphPath: join(outputDir, "graph.json"),
    };
  }

  function createAllArtifacts(outputDir: string): void {
    writeFileSync(join(outputDir, "graph_search.db"), "SQLite format 3\x00" + "\x00".repeat(100));
    writeFileSync(join(outputDir, "tfidf_idf.json"), "{}");
    writeFileSync(join(outputDir, "community_summaries.json"), "[]");
    writeFileSync(join(outputDir, "node_descriptions.json"), "[]");
    writeFileSync(join(outputDir, "graph.html"), "<html></html>");
    writeFileSync(join(outputDir, "graph_communities.html"), "<html></html>");
    mkdirSync(join(outputDir, "outlines"), { recursive: true });
    writeFileSync(join(outputDir, "report.md"), "# Report");
  }

  function writeCompletedManifest(outputDir: string): void {
    const cacheDir = join(outputDir, ".cache");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, "build-manifest.json"), JSON.stringify({
      version: 1,
      started_at: "2025-01-01T00:00:00.000Z",
      completed_at: "2025-01-01T00:01:00.000Z",
      graph_hash: "abc123",
      steps: {
        extraction: { status: "completed" },
        graph_build: { status: "completed" },
        indexer: { status: "completed" },
        outlines: { status: "completed" },
        embeddings: { status: "completed" },
        community_summaries: { status: "completed" },
        node_descriptions: { status: "completed" },
        html: { status: "completed" },
        report: { status: "completed" },
      },
    }, null, 2));
  }

  it("runs only community summary regeneration when only summaries config changed", async () => {
    const { config, configDir, outputDir, graphPath } = setupConfig();

    // Write graph.json with metadata
    writeFileSync(graphPath, JSON.stringify({
      nodes: [{ id: "n1", label: "A", type: "module" }],
      edges: [],
      communities: [{ id: "0", name: "Main", members: ["n1"], size: 1 }, { id: "1", name: "Secondary", members: [], size: 0 }],
      metadata: {
        node_count: 4,
        edge_count: 3,
        build_config: {
          embeddings: { enabled: true, method: "tfidf", model: "all-MiniLM-L6-v2", dimensions: 384 },
          outlines: { enabled: true, patterns: ["src/**/*.ts"], exclude: [], exclude_common: true },
          community_summaries: { enabled: true, max_number: 0, model: null, context_size: 512 },
          node_descriptions: { enabled: true, threshold: 0.8, model: null, context_size: 512 },
        },
      },
    }, null, 2));

    // Previous build was complete with all artifacts
    writeCompletedManifest(outputDir);
    createAllArtifacts(outputDir);

    // Mock valid DB
    openDatabaseMock.mockResolvedValue({
      exec: () => [{ values: [[5]] }],
      close: () => {},
    });

    // Config diff: only community_summaries changed
    loadPreviousBuildConfigMock.mockReturnValue({
      hasChanges: true,
      isFirstBuild: false,
      embeddingsChanged: false,
      outlinesChanged: false,
      communitySummariesChanged: true,
      nodeDescriptionsChanged: false,
      previous: {
        embeddings: { enabled: true, method: "tfidf", model: "all-MiniLM-L6-v2", dimensions: 384 },
        outlines: { enabled: true, patterns: ["src/**/*.ts"], exclude: [], exclude_common: true },
        community_summaries: { enabled: true, max_number: 0, model: null, context_size: 512 },
        node_descriptions: { enabled: true, threshold: 0.8, model: null, context_size: 512 },
      },
    });

    // No file changes, same graph hash
    runPipelineMock.mockResolvedValue({
      builtGraph: { graph: { forEachNode: vi.fn(), forEachEdge: vi.fn() }, stats: { nodeCount: 4, edgeCount: 3 } },
      communities: { count: 2 },
      fileCount: 5,
      extractionCount: 5,
      incrementalStats: { cachedFiles: 5, reextractedFiles: 0 },
    });
    computeSemanticGraphHashMock.mockReturnValue("same_hash");
    loadPreviousGraphHashMock.mockReturnValue("same_hash");

    runCommunitySummariesStepMock.mockResolvedValue(2);

    const { runBuild } = await import("../src/build/orchestrator.js");
    const result = await runBuild(config, configDir, { force: false });

    expect(result).toEqual({
      outputDir,
      fileCount: 5,
      nodeCount: 4,
      edgeCount: 3,
      communityCount: 2,
    });

    // Only community_summaries-related steps should run
    expect(runIndexerMock).not.toHaveBeenCalled();
    expect(runOutlineGenerationMock).not.toHaveBeenCalled();

    // Only community summaries step called (embeddings + descriptions skipped)
    expect(runEmbeddingsStepMock).not.toHaveBeenCalled();
    expect(runCommunitySummariesStepMock).toHaveBeenCalled();
    expect(runNodeDescriptionsStepMock).not.toHaveBeenCalled();

    // HTML + report should run (dependencies of community_summaries)
    expect(exportHtmlMock).toHaveBeenCalled();
    expect(exportCommunityHtmlMock).toHaveBeenCalled();
    expect(generateGraphReportMock).toHaveBeenCalled();
  });

  it("runs only embeddings when only embeddings config changed", async () => {
    const { config, configDir, outputDir, graphPath } = setupConfig();

    writeFileSync(graphPath, JSON.stringify({
      nodes: [{ id: "n1", label: "A", type: "module" }],
      edges: [],
      communities: [{ id: "0", name: "Main", members: ["n1"], size: 1 }],
      metadata: {
        node_count: 1,
        edge_count: 0,
        build_config: {
          embeddings: { enabled: true, method: "tfidf", model: "all-MiniLM-L6-v2", dimensions: 384 },
          outlines: { enabled: true, patterns: [], exclude: [], exclude_common: true },
          community_summaries: { enabled: true, max_number: 0, model: null, context_size: 512 },
          node_descriptions: { enabled: true, threshold: 0.8, model: null, context_size: 512 },
        },
      },
    }, null, 2));

    writeCompletedManifest(outputDir);
    createAllArtifacts(outputDir);

    openDatabaseMock.mockResolvedValue({
      exec: () => [{ values: [[5]] }],
      close: () => {},
    });

    loadPreviousBuildConfigMock.mockReturnValue({
      hasChanges: true,
      isFirstBuild: false,
      embeddingsChanged: true,
      outlinesChanged: false,
      communitySummariesChanged: false,
      nodeDescriptionsChanged: false,
      previous: null,
    });

    runPipelineMock.mockResolvedValue({
      builtGraph: { graph: { forEachNode: vi.fn(), forEachEdge: vi.fn() }, stats: { nodeCount: 1, edgeCount: 0 } },
      communities: { count: 1 },
      fileCount: 3,
      extractionCount: 3,
      incrementalStats: { cachedFiles: 3, reextractedFiles: 0 },
    });
    computeSemanticGraphHashMock.mockReturnValue("same_hash");
    loadPreviousGraphHashMock.mockReturnValue("same_hash");

    runEmbeddingsStepMock.mockResolvedValue(5);

    const { runBuild } = await import("../src/build/orchestrator.js");
    await runBuild(config, configDir, { force: false });

    // Only embeddings should be regenerated
    expect(runIndexerMock).not.toHaveBeenCalled();
    expect(runOutlineGenerationMock).not.toHaveBeenCalled();
    expect(runEmbeddingsStepMock).toHaveBeenCalled();
    expect(runCommunitySummariesStepMock).not.toHaveBeenCalled();
    expect(runNodeDescriptionsStepMock).not.toHaveBeenCalled();
    // No dependency propagation from embeddings → html/report not triggered
    expect(exportHtmlMock).not.toHaveBeenCalled();
    expect(exportCommunityHtmlMock).not.toHaveBeenCalled();
    expect(generateGraphReportMock).not.toHaveBeenCalled();
  });
});
