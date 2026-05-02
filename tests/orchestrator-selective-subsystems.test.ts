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
const runIntelligenceLayerMock = vi.fn();
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
vi.mock("../src/build/intelligence.js", () => ({ runIntelligenceLayer: runIntelligenceLayerMock }));
vi.mock("../src/build/report.ts", () => ({ generateGraphReport: generateGraphReportMock }));
vi.mock("../src/extract/export-html.js", () => ({ exportHtml: exportHtmlMock, exportCommunityHtml: exportCommunityHtmlMock }));
vi.mock("../src/build/config-diff.js", () => ({ loadPreviousBuildConfig: loadPreviousBuildConfigMock }));
vi.mock("../src/build/artifact-cleanup.js", () => ({ cleanStaleArtifacts: cleanStaleArtifactsMock }));
vi.mock("../src/build/graph-hash.js", () => ({
  loadPreviousGraphHash: loadPreviousGraphHashMock,
  computeSemanticGraphHash: computeSemanticGraphHashMock,
  saveGraphHash: saveGraphHashMock,
}));

describe("PROP-I2: selective subsystem execution", () => {
  afterEach(() => {
    vi.clearAllMocks();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs only community summary regeneration when only summaries config changed", async () => {
    const { config, configDir, outputDir, graphPath } = setupConfig();
    writeFileSync(join(outputDir, "community_summaries.json"), JSON.stringify([{ id: "0", summary: "Updated" }], null, 2));
    writeFileSync(graphPath, JSON.stringify({
      nodes: [],
      edges: [],
      metadata: {
        build_config: {
          embeddings: { enabled: true, method: "tfidf", model: "all-MiniLM-L6-v2", dimensions: 384 },
          outlines: { enabled: true, paths: ["src/**/*.ts"], exclude: [] },
          community_summaries: { enabled: true, max_number: 0, model: null },
          node_descriptions: { enabled: true, threshold: 0.8, model: null },
        },
      },
    }, null, 2));

    loadPreviousBuildConfigMock.mockReturnValue({
      hasChanges: true,
      isFirstBuild: false,
      embeddingsChanged: false,
      outlinesChanged: false,
      communitySummariesChanged: true,
      nodeDescriptionsChanged: false,
      previous: {
        embeddings: { enabled: true, method: "tfidf", model: "all-MiniLM-L6-v2", dimensions: 384 },
        outlines: { enabled: true, paths: ["src/**/*.ts"], exclude: [] },
        community_summaries: { enabled: true, max_number: 0, model: null },
        node_descriptions: { enabled: true, threshold: 0.8, model: null },
      },
    });

    runPipelineMock.mockResolvedValue({
      builtGraph: { graph: { forEachNode: vi.fn(), forEachEdge: vi.fn() }, stats: { nodeCount: 4, edgeCount: 3 } },
      communities: { count: 2 },
      fileCount: 5,
      extractionCount: 5,
      incrementalStats: { cachedFiles: 5, reextractedFiles: 0 },
    });
    runIntelligenceLayerMock.mockResolvedValue({ embeddingsGenerated: 0, communitySummaries: 2, nodeDescriptions: 0 });

    const { runBuild } = await import("../src/build/orchestrator.js");
    const result = await runBuild(config, configDir, { force: false });

    expect(result).toEqual({
      outputDir,
      fileCount: 5,
      nodeCount: 4,
      edgeCount: 3,
      communityCount: 2,
    });
    expect(runIndexerMock).not.toHaveBeenCalled();
    expect(runOutlineGenerationMock).not.toHaveBeenCalled();
    expect(runIntelligenceLayerMock).toHaveBeenCalledWith(config, outputDir, graphPath, {
      skipEmbeddings: true,
      skipSummaries: false,
      skipDescriptions: true,
    });
    expect(exportCommunityHtmlMock).toHaveBeenCalledTimes(1);
    expect(generateGraphReportMock).toHaveBeenCalledTimes(1);
    expect(exportHtmlMock).not.toHaveBeenCalled();
    expect(loadPreviousGraphHashMock).not.toHaveBeenCalled();
  });
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
