/**
 * E2E tests for the interrupted-build recovery mechanism.
 *
 * These tests verify that when a build is interrupted (manifest incomplete, artifacts missing),
 * the next incremental build correctly detects the incomplete state and re-runs missing steps
 * instead of incorrectly reporting "up to date".
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

describe("interrupted-build recovery (PROP-I3)", () => {
  afterEach(() => {
    vi.clearAllMocks();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function setupConfig(): { config: Config; configDir: string; outputDir: string; graphPath: string } {
    const root = join(tmpdir(), `rn-test-interrupted-${Date.now()}-${Math.random().toString(16).slice(2)}`);
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

    return { config, configDir, outputDir, graphPath: join(outputDir, "graph.json") };
  }

  function writeGraphJson(graphPath: string): void {
    writeFileSync(graphPath, JSON.stringify({
      nodes: [{ id: "n1", label: "A", type: "module" }],
      edges: [{ source: "n1", target: "n1", type: "self" }],
      communities: [{ id: "0", name: "Main", members: ["n1"], size: 1 }],
      metadata: {
        node_count: 1,
        edge_count: 1,
        build_config: {
          embeddings: { enabled: true, method: "tfidf", model: "all-MiniLM-L6-v2", dimensions: 384 },
          outlines: { enabled: true, patterns: ["src/**/*.ts"], exclude: [], exclude_common: true },
          community_summaries: { enabled: true, max_number: 0, model: null, context_size: 512 },
          node_descriptions: { enabled: true, threshold: 0.8, model: null, context_size: 512 },
        },
      },
    }, null, 2));
  }

  /** Simulates an interrupted build: manifest exists but completed_at=null */
  function writeInterruptedManifest(outputDir: string, completedSteps: string[]): void {
    const cacheDir = join(outputDir, ".cache");
    mkdirSync(cacheDir, { recursive: true });

    const allSteps = [
      "extraction", "graph_build", "indexer", "outlines",
      "embeddings", "community_summaries", "node_descriptions", "html", "report",
    ];
    const steps: Record<string, { status: string; started_at?: string; completed_at?: string }> = {};
    for (const step of allSteps) {
      if (completedSteps.includes(step)) {
        steps[step] = { status: "completed", started_at: "2025-01-01T00:00:00.000Z", completed_at: "2025-01-01T00:00:10.000Z" };
      } else {
        steps[step] = { status: "pending" };
      }
    }

    writeFileSync(join(cacheDir, "build-manifest.json"), JSON.stringify({
      version: 1,
      started_at: "2025-01-01T00:00:00.000Z",
      completed_at: null, // NOT completed = interrupted
      graph_hash: null,
      steps,
    }, null, 2));
  }

  /** Create artifacts for specified steps */
  function createArtifacts(outputDir: string, steps: string[]): void {
    for (const step of steps) {
      switch (step) {
        case "indexer":
          writeFileSync(join(outputDir, "graph_search.db"), "SQLite format 3\x00" + "\x00".repeat(100));
          break;
        case "embeddings":
          writeFileSync(join(outputDir, "tfidf_idf.json"), "{}");
          break;
        case "community_summaries":
          writeFileSync(join(outputDir, "community_summaries.json"), "[]");
          break;
        case "node_descriptions":
          writeFileSync(join(outputDir, "node_descriptions.json"), "[]");
          break;
        case "html":
          writeFileSync(join(outputDir, "graph.html"), "<html></html>");
          break;
        case "outlines":
          mkdirSync(join(outputDir, "outlines"), { recursive: true });
          break;
        case "report":
          writeFileSync(join(outputDir, "report.md"), "# Report");
          break;
      }
    }
  }

  function setupNoConfigChange(): void {
    loadPreviousBuildConfigMock.mockReturnValue({
      hasChanges: false,
      isFirstBuild: false,
      embeddingsChanged: false,
      outlinesChanged: false,
      communitySummariesChanged: false,
      nodeDescriptionsChanged: false,
      previous: null,
    });
  }

  function setupNoFileChanges(): void {
    buildMonorepoMock.mockResolvedValue({
      builtGraph: {
        graph: { forEachNode: vi.fn(), forEachEdge: vi.fn() },
        stats: { nodeCount: 1, edgeCount: 1 },
      },
      communities: { count: 1 },
      fileCount: 5,
      extractionCount: 5,
      incrementalStats: { cachedFiles: 5, reextractedFiles: 0 },
    });
  }

  function setupIntelligenceMock(): void {
    runIntelligenceLayerMock.mockResolvedValue({
      embeddingsGenerated: 10,
      communitySummaries: 1,
      nodeDescriptions: 2,
    });
  }

  it("does NOT early-return when previous build manifest is incomplete (interrupted after extraction)", async () => {
    const { config, configDir, outputDir, graphPath } = setupConfig();
    writeGraphJson(graphPath);
    setupNoConfigChange();
    setupNoFileChanges();
    setupIntelligenceMock();
    runOutlineGenerationMock.mockResolvedValue(3);

    // Simulate: previous build interrupted after extraction + graph_build, before indexer ran
    writeInterruptedManifest(outputDir, ["extraction", "graph_build"]);
    // No downstream artifacts exist

    const { runBuild } = await import("../src/build/orchestrator.js");
    await runBuild(config, configDir, { force: false });

    // The build MUST NOT early-return — it should run the indexer and other missing steps
    expect(runIndexerMock).toHaveBeenCalled();
    expect(runOutlineGenerationMock).toHaveBeenCalled();
    expect(runIntelligenceLayerMock).toHaveBeenCalled();
    expect(exportHtmlMock).toHaveBeenCalled();
    expect(generateGraphReportMock).toHaveBeenCalled();
  });

  it("does NOT early-return when indexer artifact is missing (build killed during indexing)", async () => {
    const { config, configDir, outputDir, graphPath } = setupConfig();
    writeGraphJson(graphPath);
    setupNoConfigChange();
    setupNoFileChanges();
    setupIntelligenceMock();
    runOutlineGenerationMock.mockResolvedValue(3);

    // Manifest says completed (old successful build), but indexer artifact is corrupted/missing
    writeInterruptedManifest(outputDir, [
      "extraction", "graph_build", "indexer", "outlines",
      "embeddings", "community_summaries", "node_descriptions", "html", "report",
    ]);
    // Create ALL artifacts EXCEPT indexer
    createArtifacts(outputDir, ["embeddings", "community_summaries", "node_descriptions", "html", "outlines", "report"]);

    const { runBuild } = await import("../src/build/orchestrator.js");
    await runBuild(config, configDir, { force: false });

    // Missing indexer must be re-run
    expect(runIndexerMock).toHaveBeenCalled();
  });

  it("selectively re-runs only missing steps (interrupted after indexer completed)", async () => {
    const { config, configDir, outputDir, graphPath } = setupConfig();
    writeGraphJson(graphPath);
    setupNoConfigChange();
    setupNoFileChanges();
    setupIntelligenceMock();
    runOutlineGenerationMock.mockResolvedValue(3);

    // Build interrupted: extraction, graph_build, indexer all completed — outlines and beyond not started
    writeInterruptedManifest(outputDir, ["extraction", "graph_build", "indexer"]);
    // indexer artifact exists
    createArtifacts(outputDir, ["indexer"]);

    const { runBuild } = await import("../src/build/orchestrator.js");
    await runBuild(config, configDir, { force: false });

    // Indexer should be SKIPPED (artifact exists), but downstream steps should run
    expect(runIndexerMock).not.toHaveBeenCalled();
    expect(runOutlineGenerationMock).toHaveBeenCalled();
    expect(runIntelligenceLayerMock).toHaveBeenCalled();
    expect(exportHtmlMock).toHaveBeenCalled();
    expect(generateGraphReportMock).toHaveBeenCalled();
  });

  it("re-runs indexer when graph_search.db has invalid SQLite header (corruption)", async () => {
    const { config, configDir, outputDir, graphPath } = setupConfig();
    writeGraphJson(graphPath);
    setupNoConfigChange();
    setupNoFileChanges();
    setupIntelligenceMock();
    runOutlineGenerationMock.mockResolvedValue(3);

    // All steps "completed" in manifest but indexer artifact is corrupted
    writeInterruptedManifest(outputDir, [
      "extraction", "graph_build", "indexer", "outlines",
      "embeddings", "community_summaries", "node_descriptions", "html", "report",
    ]);
    // Create all artifacts but write invalid data to graph_search.db
    createArtifacts(outputDir, ["embeddings", "community_summaries", "node_descriptions", "html", "outlines", "report"]);
    writeFileSync(join(outputDir, "graph_search.db"), "not a sqlite file");

    const { runBuild } = await import("../src/build/orchestrator.js");
    await runBuild(config, configDir, { force: false });

    // Corruption detected → indexer must be re-run
    expect(runIndexerMock).toHaveBeenCalled();
  });

  it("re-runs community_summaries + dependents when community_summaries.json is missing", async () => {
    const { config, configDir, outputDir, graphPath } = setupConfig();
    writeGraphJson(graphPath);
    setupNoConfigChange();
    setupNoFileChanges();
    setupIntelligenceMock();
    runOutlineGenerationMock.mockResolvedValue(3);

    writeInterruptedManifest(outputDir, [
      "extraction", "graph_build", "indexer", "outlines",
      "embeddings", "community_summaries", "node_descriptions", "html", "report",
    ]);
    // All artifacts exist EXCEPT community_summaries
    createArtifacts(outputDir, ["indexer", "embeddings", "node_descriptions", "html", "outlines", "report"]);

    const { runBuild } = await import("../src/build/orchestrator.js");
    await runBuild(config, configDir, { force: false });

    // community_summaries missing → re-run intelligence layer + dependents (html, report)
    expect(runIntelligenceLayerMock).toHaveBeenCalled();
    expect(exportHtmlMock).toHaveBeenCalled();
    expect(generateGraphReportMock).toHaveBeenCalled();
    // indexer should be skipped (artifact exists and valid)
    expect(runIndexerMock).not.toHaveBeenCalled();
  });

  it("marks manifest complete after successful recovery build", async () => {
    const { config, configDir, outputDir, graphPath } = setupConfig();
    writeGraphJson(graphPath);
    setupNoConfigChange();
    setupNoFileChanges();
    setupIntelligenceMock();
    runOutlineGenerationMock.mockResolvedValue(3);

    // Interrupted build
    writeInterruptedManifest(outputDir, ["extraction", "graph_build"]);

    const { runBuild } = await import("../src/build/orchestrator.js");
    await runBuild(config, configDir, { force: false });

    // After recovery, manifest should be complete
    const manifestPath = join(outputDir, ".cache", "build-manifest.json");
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    expect(manifest.completed_at).not.toBeNull();
  });

  it("completes full pipeline on first build (no previous manifest)", async () => {
    const { config, configDir, outputDir, graphPath } = setupConfig();
    writeGraphJson(graphPath);
    setupNoConfigChange();
    setupNoFileChanges();
    setupIntelligenceMock();
    runOutlineGenerationMock.mockResolvedValue(3);

    // No manifest, no artifacts — virgin output directory
    const { runBuild } = await import("../src/build/orchestrator.js");
    await runBuild(config, configDir, { force: false });

    // Everything should run on first build
    expect(runIndexerMock).toHaveBeenCalled();
    expect(runOutlineGenerationMock).toHaveBeenCalled();
    expect(runIntelligenceLayerMock).toHaveBeenCalled();
    expect(exportHtmlMock).toHaveBeenCalled();
    expect(generateGraphReportMock).toHaveBeenCalled();

    // Manifest should be written and complete
    const manifestPath = join(outputDir, ".cache", "build-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    expect(manifest.completed_at).not.toBeNull();
  });

  it("intelligence layer failure is non-blocking (manifest still completes)", async () => {
    const { config, configDir, outputDir, graphPath } = setupConfig();
    writeGraphJson(graphPath);
    setupNoConfigChange();
    setupNoFileChanges();
    runOutlineGenerationMock.mockResolvedValue(3);

    // Intelligence layer throws
    runIntelligenceLayerMock.mockRejectedValue(new Error("Model OOM"));

    // No previous build
    const { runBuild } = await import("../src/build/orchestrator.js");
    await runBuild(config, configDir, { force: false });

    // Build should still complete (intelligence is best-effort)
    const manifestPath = join(outputDir, ".cache", "build-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    expect(manifest.completed_at).not.toBeNull();

    // Intelligence steps should be marked "failed"
    expect(manifest.steps.embeddings.status).toBe("failed");
    expect(manifest.steps.embeddings.skip_reason).toBe("Model OOM");
    expect(manifest.steps.community_summaries.status).toBe("failed");
    expect(manifest.steps.node_descriptions.status).toBe("failed");

    // Other steps should still have completed
    expect(manifest.steps.indexer.status).toBe("completed");
    expect(manifest.steps.html.status).toBe("completed");
    expect(manifest.steps.report.status).toBe("completed");
  });
});
