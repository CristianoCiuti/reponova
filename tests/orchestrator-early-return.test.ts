import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Config } from "../src/shared/types.js";
import { DEFAULT_CONFIG } from "../src/shared/types.js";

const tempDirs: string[] = [];

const buildMonorepoMock = vi.fn();
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

vi.mock("../src/build/steps/indexer.js", () => ({ runIndexer: runIndexerMock }));
vi.mock("../src/build/steps/outlines.js", () => ({ runOutlineGeneration: runOutlineGenerationMock }));
vi.mock("../src/build/steps/embeddings-step.js", () => ({ runEmbeddingsStep: runEmbeddingsStepMock }));
vi.mock("../src/build/steps/community-summaries-step.js", () => ({ runCommunitySummariesStep: runCommunitySummariesStepMock }));
vi.mock("../src/build/steps/node-descriptions-step.js", () => ({ runNodeDescriptionsStep: runNodeDescriptionsStepMock }));
vi.mock("../src/build/intelligence/llm-engine-pool.js", () => ({
  LlmEnginePool: vi.fn().mockImplementation(() => ({ disposeAll: vi.fn() })),
}));
vi.mock("../src/build/steps/report.ts", () => ({ generateGraphReport: generateGraphReportMock }));
vi.mock("../src/extract/export-html.js", () => ({ exportHtml: exportHtmlMock, exportCommunityHtml: exportCommunityHtmlMock }));
vi.mock("../src/build/incremental/config-diff.js", () => ({ loadPreviousBuildConfig: loadPreviousBuildConfigMock }));
vi.mock("../src/build/incremental/artifact-cleanup.js", () => ({ cleanStaleArtifacts: cleanStaleArtifactsMock }));
vi.mock("../src/build/incremental/graph-hash.js", () => ({
  loadPreviousGraphHash: loadPreviousGraphHashMock,
  computeSemanticGraphHash: computeSemanticGraphHashMock,
  saveGraphHash: saveGraphHashMock,
}));
vi.mock("../src/core/config.js", async () => {
  const actual = await vi.importActual<typeof import("../src/core/config.js")>("../src/core/config.js");
  return actual;
});
vi.mock("../src/extract/index.js", () => ({ runPipeline: buildMonorepoMock }));

// Mock openDatabase for artifact integrity checks
const openDatabaseMock = vi.fn();
vi.mock("../src/core/db.js", () => ({ openDatabase: openDatabaseMock }));

describe("PROP-I1: orchestrator early return when no files changed", () => {
  afterEach(() => {
    vi.clearAllMocks();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns existing graph counts and skips downstream work when incremental build is unchanged", async () => {
    const { config, configDir, outputDir, graphPath } = setupConfig();
    writeFileSync(graphPath, JSON.stringify({
      nodes: [{ id: "n1", label: "A", type: "module" }],
      edges: [{ source: "n1", target: "n1", type: "self" }],
      communities: [{ id: "0", name: "Main", members: ["n1"], size: 1 }],
      metadata: {
        node_count: 11,
        edge_count: 7,
        build_config: {
          embeddings: { enabled: true, method: "tfidf", model: "all-MiniLM-L6-v2", dimensions: 384 },
          outlines: { enabled: true, patterns: ["src/**/*.ts"], exclude: [], exclude_common: true },
          community_summaries: { enabled: true, max_number: 0, model: null, context_size: 512 },
          node_descriptions: { enabled: true, threshold: 0.8, model: null, context_size: 512 },
        },
      },
    }, null, 2));

    // Simulate a completed previous build: manifest + all expected artifacts
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
    // Create expected artifacts
    writeFileSync(join(outputDir, "graph_search.db"), "SQLite format 3\x00" + "\x00".repeat(100));
    writeFileSync(join(outputDir, "tfidf_idf.json"), "{}");
    writeFileSync(join(outputDir, "community_summaries.json"), "[]");
    writeFileSync(join(outputDir, "node_descriptions.json"), "[]");
    writeFileSync(join(outputDir, "graph.html"), "<html></html>");
    writeFileSync(join(outputDir, "graph_communities.html"), "<html></html>");
    writeFileSync(join(outputDir, "report.md"), "# Report");
    mkdirSync(join(outputDir, "outlines"), { recursive: true });

    // Mock openDatabase to report a valid DB with nodes
    openDatabaseMock.mockResolvedValue({
      exec: () => [{ values: [[5]] }],
      close: () => {},
    });

    loadPreviousBuildConfigMock.mockReturnValue({
      hasChanges: false,
      isFirstBuild: false,
      embeddingsChanged: false,
      outlinesChanged: false,
      communitySummariesChanged: false,
      nodeDescriptionsChanged: false,
      previous: null,
    });

    // Same graph hash = no change
    computeSemanticGraphHashMock.mockReturnValue("same_hash");
    loadPreviousGraphHashMock.mockReturnValue("same_hash");

    buildMonorepoMock.mockResolvedValue({
      builtGraph: {
        graph: { forEachNode: vi.fn(), forEachEdge: vi.fn() },
        stats: { nodeCount: 99, edgeCount: 88 },
      },
      communities: { count: 55 },
      fileCount: 13,
      extractionCount: 13,
      incrementalStats: {
        cachedFiles: 13,
        reextractedFiles: 0,
      },
    });

    const { runBuild } = await import("../src/build/orchestrator.js");
    const result = await runBuild(config, configDir, { force: false });

    expect(result).toEqual({
      outputDir,
      fileCount: 13,
      nodeCount: 11,
      edgeCount: 7,
      communityCount: 1,
    });

    expect(cleanStaleArtifactsMock).toHaveBeenCalledTimes(1);
    expect(runIndexerMock).not.toHaveBeenCalled();
    expect(runOutlineGenerationMock).not.toHaveBeenCalled();
    expect(runEmbeddingsStepMock).not.toHaveBeenCalled();
    expect(runCommunitySummariesStepMock).not.toHaveBeenCalled();
    expect(runNodeDescriptionsStepMock).not.toHaveBeenCalled();
    expect(exportHtmlMock).not.toHaveBeenCalled();
    expect(exportCommunityHtmlMock).not.toHaveBeenCalled();
    expect(generateGraphReportMock).not.toHaveBeenCalled();
  });
});

function setupConfig(): { config: Config; configDir: string; outputDir: string; graphPath: string } {
  const root = join(tmpdir(), `rn-test-prop-i1-${Date.now()}-${Math.random().toString(16).slice(2)}`);
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

  return {
    config,
    configDir,
    outputDir,
    graphPath: join(outputDir, "graph.json"),
  };
}
