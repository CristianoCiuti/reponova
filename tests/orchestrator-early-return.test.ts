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
const runIntelligenceLayerMock = vi.fn();
const generateGraphReportMock = vi.fn();
const exportHtmlMock = vi.fn();
const exportCommunityHtmlMock = vi.fn();
const loadPreviousBuildConfigMock = vi.fn();
const cleanStaleArtifactsMock = vi.fn();

vi.mock("../src/build/indexer.js", () => ({ runIndexer: runIndexerMock }));
vi.mock("../src/build/outlines.js", () => ({ runOutlineGeneration: runOutlineGenerationMock }));
vi.mock("../src/build/intelligence.js", () => ({ runIntelligenceLayer: runIntelligenceLayerMock }));
vi.mock("../src/build/report.ts", () => ({ generateGraphReport: generateGraphReportMock }));
vi.mock("../src/extract/export-html.js", () => ({ exportHtml: exportHtmlMock, exportCommunityHtml: exportCommunityHtmlMock }));
vi.mock("../src/build/config-diff.js", () => ({ loadPreviousBuildConfig: loadPreviousBuildConfigMock }));
vi.mock("../src/build/artifact-cleanup.js", () => ({ cleanStaleArtifacts: cleanStaleArtifactsMock }));
vi.mock("../src/core/config.js", async () => {
  const actual = await vi.importActual<typeof import("../src/core/config.js")>("../src/core/config.js");
  return actual;
});
vi.mock("../src/extract/index.js", () => ({ runPipeline: buildMonorepoMock }));

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

    loadPreviousBuildConfigMock.mockReturnValue({
      hasChanges: false,
      isFirstBuild: false,
      embeddingsChanged: false,
      outlinesChanged: false,
      communitySummariesChanged: false,
      nodeDescriptionsChanged: false,
      previous: null,
    });

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
    expect(runIntelligenceLayerMock).not.toHaveBeenCalled();
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
