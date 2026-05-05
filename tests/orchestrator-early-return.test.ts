import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Config, GraphData } from "../src/shared/types.js";
import { DEFAULT_CONFIG } from "../src/shared/types.js";

const tempDirs: string[] = [];

const mocks = vi.hoisted(() => ({
  runIndexerStep: vi.fn(async () => ({ processed: 0, skipped: true, skipReason: "up to date" })),
  runOutlinesStep: vi.fn(async () => ({ processed: 0, skipped: true, skipReason: "graph unchanged" })),
  runEmbeddingsStep: vi.fn(async () => ({ processed: 0, skipped: true, skipReason: "graph unchanged" })),
  runCommunitySummariesStep: vi.fn(async () => ({ processed: 0, skipped: true, skipReason: "graph unchanged" })),
  runNodeDescriptionsStep: vi.fn(async () => ({ processed: 0, skipped: true, skipReason: "graph unchanged" })),
  runHtmlStep: vi.fn(async () => ({ processed: 0, skipped: true, skipReason: "up to date" })),
  runReportStep: vi.fn(async () => ({ processed: 0, skipped: true, skipReason: "up to date" })),
  runPipeline: vi.fn(),
  loadPreviousBuildConfig: vi.fn(),
  loadPreviousGraphHash: vi.fn(),
  computeSemanticGraphHash: vi.fn(),
  saveGraphHash: vi.fn(),
}));

vi.mock("../src/build/steps/indexer.js", () => ({ runIndexerStep: mocks.runIndexerStep }));
vi.mock("../src/build/steps/outlines.js", async () => {
  const actual = await vi.importActual<typeof import("../src/build/steps/outlines.js")>("../src/build/steps/outlines.js");
  return { ...actual, runOutlinesStep: mocks.runOutlinesStep };
});
vi.mock("../src/build/steps/embeddings-step.js", () => ({ runEmbeddingsStep: mocks.runEmbeddingsStep }));
vi.mock("../src/build/steps/community-summaries-step.js", () => ({ runCommunitySummariesStep: mocks.runCommunitySummariesStep }));
vi.mock("../src/build/steps/node-descriptions-step.js", () => ({ runNodeDescriptionsStep: mocks.runNodeDescriptionsStep }));
vi.mock("../src/build/steps/html-step.js", () => ({ runHtmlStep: mocks.runHtmlStep }));
vi.mock("../src/build/steps/report.js", () => ({ runReportStep: mocks.runReportStep }));
vi.mock("../src/build/intelligence/llm-engine-pool.js", () => ({
  LlmEnginePool: class {
    async disposeAll(): Promise<void> {}
  },
}));
vi.mock("../src/extract/index.js", () => ({ runPipeline: mocks.runPipeline }));
vi.mock("../src/build/incremental/config-diff.js", () => ({ loadPreviousBuildConfig: mocks.loadPreviousBuildConfig }));
vi.mock("../src/build/incremental/graph-hash.js", () => ({
  loadPreviousGraphHash: mocks.loadPreviousGraphHash,
  computeSemanticGraphHash: mocks.computeSemanticGraphHash,
  saveGraphHash: mocks.saveGraphHash,
}));

import { runBuild } from "../src/build/orchestrator.js";

describe("orchestrator skipped-step flow", () => {
  afterEach(() => {
    vi.clearAllMocks();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("marks all autonomous steps as skipped when graphChanged=false", async () => {
    const { config, configDir, outputDir } = setupConfig();

    mocks.loadPreviousBuildConfig.mockReturnValue({
      hasChanges: false,
      isFirstBuild: false,
      embeddingsChanged: false,
      outlinesChanged: false,
      communitySummariesChanged: false,
      nodeDescriptionsChanged: false,
      previous: null,
    });
    mocks.loadPreviousGraphHash.mockReturnValue("same-hash");
    mocks.computeSemanticGraphHash.mockReturnValue("same-hash");
    mocks.runPipeline.mockImplementation(async ({ graphJsonPath }: { graphJsonPath: string }) => {
      writeGraph(graphJsonPath);
      return {
        builtGraph: {
          graph: {},
          stats: { nodeCount: 2, edgeCount: 1 },
        },
        communities: { count: 1 },
        fileCount: 2,
      };
    });

    await runBuild(config, configDir, { force: false });

    const manifest = JSON.parse(readFileSync(join(outputDir, ".cache", "build-manifest.json"), "utf-8")) as {
      steps: Record<string, { status: string }>;
    };

    expect(mocks.runEmbeddingsStep).toHaveBeenCalledWith(expect.objectContaining({ graphChanged: false, force: false }));
    expect(mocks.runCommunitySummariesStep).toHaveBeenCalledWith(expect.objectContaining({ graphChanged: false, force: false }));
    expect(mocks.runNodeDescriptionsStep).toHaveBeenCalledWith(expect.objectContaining({ graphChanged: false, force: false }));
    expect(mocks.runOutlinesStep).toHaveBeenCalledWith(expect.objectContaining({ graphChanged: false, force: false }));

    expect(manifest.steps.embeddings.status).toBe("skipped");
    expect(manifest.steps.community_summaries.status).toBe("skipped");
    expect(manifest.steps.node_descriptions.status).toBe("skipped");
    expect(manifest.steps.outlines.status).toBe("skipped");
    expect(manifest.steps.indexer.status).toBe("skipped");
    expect(manifest.steps.html.status).toBe("skipped");
    expect(manifest.steps.report.status).toBe("skipped");
  });
});

function setupConfig(): { config: Config; configDir: string; outputDir: string } {
  const root = join(tmpdir(), `rn-test-orch-skip-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  tempDirs.push(root);

  const configDir = join(root, "config");
  const repoDir = join(root, "repo");
  const outputDir = join(root, "out");

  mkdirSync(configDir, { recursive: true });
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(repoDir, "main.py"), "def main():\n    return 1\n");

  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as Config;
  config.output = "../out";
  config.repos = [{ name: "repo", path: "../repo" }];

  return { config, configDir, outputDir };
}

function writeGraph(graphJsonPath: string): void {
  const graph: GraphData = {
    nodes: [
      { id: "a", label: "main", type: "function", source_file: "main.py", repo: "repo" },
      { id: "b", label: "helper", type: "function", source_file: "main.py", repo: "repo" },
    ],
    edges: [{ source: "a", target: "b", type: "calls" }],
    metadata: {
      build_config: {
        embeddings: { enabled: true, method: "tfidf", model: "all-MiniLM-L6-v2", dimensions: 384 },
        outlines: { enabled: true, patterns: [], exclude: [], exclude_common: true },
        community_summaries: { enabled: true, max_number: 0, model: null, context_size: 512 },
        node_descriptions: { enabled: true, threshold: 0.8, model: null, context_size: 512 },
      },
    },
  };
  writeFileSync(graphJsonPath, JSON.stringify(graph, null, 2));
}
