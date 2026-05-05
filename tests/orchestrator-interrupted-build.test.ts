import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Config, GraphData } from "../src/shared/types.js";
import { DEFAULT_CONFIG } from "../src/shared/types.js";

const tempDirs: string[] = [];

const mocks = vi.hoisted(() => ({
  runIndexerStep: vi.fn(async () => ({ processed: 0, skipped: true, skipReason: "up to date" })),
  runOutlinesStep: vi.fn(async () => ({ processed: 0, skipped: true, skipReason: "up to date" })),
  runEmbeddingsStep: vi.fn(async ({ force }: { force: boolean }) => ({ processed: force ? 2 : 0, skipped: !force, skipReason: force ? undefined : "up to date" })),
  runCommunitySummariesStep: vi.fn(async ({ force }: { force: boolean }) => ({ processed: force ? 1 : 0, skipped: !force, skipReason: force ? undefined : "up to date" })),
  runNodeDescriptionsStep: vi.fn(async () => ({ processed: 0, skipped: true, skipReason: "up to date" })),
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

describe("orchestrator interrupted-step recovery", () => {
  afterEach(() => {
    vi.clearAllMocks();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("forces a previously running step", async () => {
    const { config, configDir, outputDir } = setupConfig();
    setupStableBuild();
    writeManifest(outputDir, { embeddings: "running" });

    await runBuild(config, configDir, { force: false });

    expect(mocks.runEmbeddingsStep).toHaveBeenCalledWith(expect.objectContaining({ force: true }));
    const manifest = readManifest(outputDir);
    expect(manifest.steps.embeddings.status).toBe("completed");
  });

  it("forces a previously failed step without forcing completed steps", async () => {
    const { config, configDir, outputDir } = setupConfig();
    setupStableBuild();
    writeManifest(outputDir, {
      community_summaries: "failed",
      embeddings: "completed",
    });

    await runBuild(config, configDir, { force: false });

    expect(mocks.runCommunitySummariesStep).toHaveBeenCalledWith(expect.objectContaining({ force: true }));
    expect(mocks.runEmbeddingsStep).toHaveBeenCalledWith(expect.objectContaining({ force: false }));

    const manifest = readManifest(outputDir);
    expect(manifest.steps.community_summaries.status).toBe("completed");
    expect(manifest.completed_at).toBeTruthy();
  });
});

function setupStableBuild(): void {
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
        stats: { nodeCount: 3, edgeCount: 2 },
      },
      communities: { count: 1 },
      fileCount: 2,
    };
  });
}

function setupConfig(): { config: Config; configDir: string; outputDir: string } {
  const root = join(tmpdir(), `rn-test-orch-recover-${Date.now()}-${Math.random().toString(16).slice(2)}`);
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

function writeManifest(outputDir: string, overrides: Partial<Record<string, string>>): void {
  const cacheDir = join(outputDir, ".cache");
  mkdirSync(cacheDir, { recursive: true });
  const steps = {
    extraction: { status: "completed" },
    graph_build: { status: "completed" },
    indexer: { status: "completed" },
    outlines: { status: "completed" },
    embeddings: { status: "completed" },
    community_summaries: { status: "completed" },
    node_descriptions: { status: "completed" },
    html: { status: "completed" },
    report: { status: "completed" },
    ...Object.fromEntries(Object.entries(overrides).map(([key, value]) => [key, { status: value }])),
  };

  writeFileSync(join(cacheDir, "build-manifest.json"), JSON.stringify({
    version: 1,
    started_at: "2025-01-01T00:00:00.000Z",
    completed_at: null,
    graph_hash: "same-hash",
    steps,
  }, null, 2));
}

function readManifest(outputDir: string): {
  completed_at: string | null;
  steps: Record<string, { status: string }>;
} {
  return JSON.parse(readFileSync(join(outputDir, ".cache", "build-manifest.json"), "utf-8")) as {
    completed_at: string | null;
    steps: Record<string, { status: string }>;
  };
}

function writeGraph(graphJsonPath: string): void {
  const graph: GraphData = {
    nodes: [
      { id: "a", label: "main", type: "function", source_file: "main.py", repo: "repo", community: "1" },
      { id: "b", label: "helper", type: "function", source_file: "main.py", repo: "repo", community: "1" },
      { id: "c", label: "value", type: "module", source_file: "main.py", repo: "repo", community: "1" },
    ],
    edges: [
      { source: "a", target: "b", type: "calls" },
      { source: "a", target: "c", type: "imports" },
    ],
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
