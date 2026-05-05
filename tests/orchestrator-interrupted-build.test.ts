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

vi.mock("../src/build/indexer.js", () => ({ runIndexer: runIndexerMock }));
vi.mock("../src/build/outlines.js", () => ({ runOutlineGeneration: runOutlineGenerationMock }));
vi.mock("../src/build/embeddings-step.js", () => ({ runEmbeddingsStep: runEmbeddingsStepMock }));
vi.mock("../src/build/community-summaries-step.js", () => ({ runCommunitySummariesStep: runCommunitySummariesStepMock }));
vi.mock("../src/build/node-descriptions-step.js", () => ({ runNodeDescriptionsStep: runNodeDescriptionsStepMock }));
vi.mock("../src/build/llm-engine-pool.js", () => ({
  LlmEnginePool: vi.fn().mockImplementation(() => ({ disposeAll: vi.fn() })),
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
vi.mock("../src/core/config.js", async () => {
  const actual = await vi.importActual<typeof import("../src/core/config.js")>("../src/core/config.js");
  return actual;
});
vi.mock("../src/extract/index.js", () => ({ runPipeline: buildMonorepoMock }));

// Mock openDatabase for artifact integrity checks
const openDatabaseMock = vi.fn();
vi.mock("../src/core/db.js", () => ({ openDatabase: openDatabaseMock }));

describe("interrupted-build recovery (PROP-I3)", () => {
  afterEach(() => {
    vi.clearAllMocks();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Default: openDatabase throws (simulates missing/corrupt DB).
  // Tests that create a valid indexer artifact override via createArtifacts().
  function setupDefaultDbMock(): void {
    openDatabaseMock.mockRejectedValue(new Error("not a valid database"));
  }

  /** Mock openDatabase to return a valid DB (call AFTER createArtifacts if indexer included) */
  function setupValidDbMock(): void {
    openDatabaseMock.mockResolvedValue({
      exec: () => [{ values: [[5]] }],
      close: () => {},
    });
  }

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
          writeFileSync(join(outputDir, "graph_communities.html"), "<html></html>");
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
    // Graph hash unchanged so Signal 2 (graph change) doesn't fire
    computeSemanticGraphHashMock.mockReturnValue("same_hash");
    loadPreviousGraphHashMock.mockReturnValue("same_hash");
  }

  function setupIntelligenceMock(): void {
    runEmbeddingsStepMock.mockResolvedValue(10);
    runCommunitySummariesStepMock.mockResolvedValue(1);
    runNodeDescriptionsStepMock.mockResolvedValue(2);
  }

  it("does NOT early-return when previous build manifest is incomplete (interrupted after extraction)", async () => {
    const { config, configDir, outputDir, graphPath } = setupConfig();
    writeGraphJson(graphPath);
    setupNoConfigChange();
    setupNoFileChanges();
    setupIntelligenceMock();
    setupDefaultDbMock();
    runOutlineGenerationMock.mockResolvedValue(3);

    // Simulate: previous build interrupted after extraction + graph_build, before indexer ran
    writeInterruptedManifest(outputDir, ["extraction", "graph_build"]);
    // No downstream artifacts exist

    const { runBuild } = await import("../src/build/orchestrator.js");
    await runBuild(config, configDir, { force: false });

    // The build MUST NOT early-return — it should run the indexer and other missing steps
    expect(runIndexerMock).toHaveBeenCalled();
    expect(runOutlineGenerationMock).toHaveBeenCalled();
    expect(runEmbeddingsStepMock).toHaveBeenCalled();
    expect(runCommunitySummariesStepMock).toHaveBeenCalled();
    expect(runNodeDescriptionsStepMock).toHaveBeenCalled();
    expect(exportHtmlMock).toHaveBeenCalled();
    expect(generateGraphReportMock).toHaveBeenCalled();
  });

  it("does NOT early-return when indexer artifact is missing (build killed during indexing)", async () => {
    const { config, configDir, outputDir, graphPath } = setupConfig();
    writeGraphJson(graphPath);
    setupNoConfigChange();
    setupNoFileChanges();
    setupIntelligenceMock();
    setupDefaultDbMock();
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
    setupValidDbMock();
    runOutlineGenerationMock.mockResolvedValue(3);

    // Build interrupted: extraction, graph_build, indexer all completed — outlines and beyond not started
    writeInterruptedManifest(outputDir, ["extraction", "graph_build", "indexer"]);
    // indexer artifact exists
    createArtifacts(outputDir, ["indexer"]);

    const { runBuild } = await import("../src/build/orchestrator.js");
    await runBuild(config, configDir, { force: false });

    // Indexer should be SKIPPED (artifact exists + manifest says pending for it is fine since we
    // test from the artifact check angle — artifact exists + valid DB), but downstream steps should run
    expect(runIndexerMock).not.toHaveBeenCalled();
    expect(runOutlineGenerationMock).toHaveBeenCalled();
    expect(runEmbeddingsStepMock).toHaveBeenCalled();
    expect(runCommunitySummariesStepMock).toHaveBeenCalled();
    expect(runNodeDescriptionsStepMock).toHaveBeenCalled();
    expect(exportHtmlMock).toHaveBeenCalled();
    expect(generateGraphReportMock).toHaveBeenCalled();
  });

  it("re-runs indexer when graph_search.db has invalid SQLite header (corruption)", async () => {
    const { config, configDir, outputDir, graphPath } = setupConfig();
    writeGraphJson(graphPath);
    setupNoConfigChange();
    setupNoFileChanges();
    setupIntelligenceMock();
    setupDefaultDbMock(); // openDatabase throws on corrupt file
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
    setupValidDbMock(); // indexer DB is valid
    runOutlineGenerationMock.mockResolvedValue(3);

    writeInterruptedManifest(outputDir, [
      "extraction", "graph_build", "indexer", "outlines",
      "embeddings", "community_summaries", "node_descriptions", "html", "report",
    ]);
    // All artifacts exist EXCEPT community_summaries
    createArtifacts(outputDir, ["indexer", "embeddings", "node_descriptions", "html", "outlines", "report"]);

    const { runBuild } = await import("../src/build/orchestrator.js");
    await runBuild(config, configDir, { force: false });

    // community_summaries missing → re-run community summaries step + dependents (html, report)
    expect(runCommunitySummariesStepMock).toHaveBeenCalled();
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
    setupDefaultDbMock();
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
    setupDefaultDbMock();
    runOutlineGenerationMock.mockResolvedValue(3);

    // No manifest, no artifacts — virgin output directory
    const { runBuild } = await import("../src/build/orchestrator.js");
    await runBuild(config, configDir, { force: false });

    // Everything should run on first build
    expect(runIndexerMock).toHaveBeenCalled();
    expect(runOutlineGenerationMock).toHaveBeenCalled();
    expect(runEmbeddingsStepMock).toHaveBeenCalled();
    expect(runCommunitySummariesStepMock).toHaveBeenCalled();
    expect(runNodeDescriptionsStepMock).toHaveBeenCalled();
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
    setupDefaultDbMock();
    runOutlineGenerationMock.mockResolvedValue(3);

    // Intelligence steps throw
    runEmbeddingsStepMock.mockRejectedValue(new Error("Model OOM"));
    runCommunitySummariesStepMock.mockRejectedValue(new Error("Model OOM"));
    runNodeDescriptionsStepMock.mockRejectedValue(new Error("Model OOM"));

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

  // ── Improvement #1: Step "running" + artifact exists → re-run ──────────

  it("re-runs step when manifest says 'running' even if artifact exists on disk (partial artifact)", async () => {
    const { config, configDir, outputDir, graphPath } = setupConfig();
    writeGraphJson(graphPath);
    setupNoConfigChange();
    setupNoFileChanges();
    setupIntelligenceMock();
    setupValidDbMock(); // DB appears valid but...
    runOutlineGenerationMock.mockResolvedValue(3);

    // Manifest: indexer was "running" when build was killed (artifact may be partial)
    const cacheDir = join(outputDir, ".cache");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, "build-manifest.json"), JSON.stringify({
      version: 1,
      started_at: "2025-01-01T00:00:00.000Z",
      completed_at: null,
      graph_hash: null,
      steps: {
        extraction: { status: "completed" },
        graph_build: { status: "completed" },
        indexer: { status: "running" }, // WAS INTERRUPTED
        outlines: { status: "pending" },
        embeddings: { status: "pending" },
        community_summaries: { status: "pending" },
        node_descriptions: { status: "pending" },
        html: { status: "pending" },
        report: { status: "pending" },
      },
    }, null, 2));
    // Indexer artifact exists (but might be partial since step was interrupted)
    createArtifacts(outputDir, ["indexer"]);

    const { runBuild } = await import("../src/build/orchestrator.js");
    await runBuild(config, configDir, { force: false });

    // Even though artifact exists, manifest says "running" → MUST re-run
    expect(runIndexerMock).toHaveBeenCalled();
  });

  // ── Improvement #2: Step "failed" + artifact exists → retry ────────────

  it("retries step when manifest says 'failed' even if artifact exists (model now available)", async () => {
    const { config, configDir, outputDir, graphPath } = setupConfig();
    writeGraphJson(graphPath);
    setupNoConfigChange();
    setupNoFileChanges();
    setupIntelligenceMock();
    setupValidDbMock();
    runOutlineGenerationMock.mockResolvedValue(3);

    // Manifest: intelligence layer failed previously but left partial artifacts
    const cacheDir = join(outputDir, ".cache");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, "build-manifest.json"), JSON.stringify({
      version: 1,
      started_at: "2025-01-01T00:00:00.000Z",
      completed_at: null,
      graph_hash: null,
      steps: {
        extraction: { status: "completed" },
        graph_build: { status: "completed" },
        indexer: { status: "completed" },
        outlines: { status: "completed" },
        embeddings: { status: "failed", skip_reason: "Model OOM" },
        community_summaries: { status: "failed", skip_reason: "Model OOM" },
        node_descriptions: { status: "failed", skip_reason: "Model OOM" },
        html: { status: "completed" },
        report: { status: "completed" },
      },
    }, null, 2));
    // All artifacts exist (including partial/stale ones from failed intelligence)
    createArtifacts(outputDir, ["indexer", "embeddings", "community_summaries", "node_descriptions", "html", "outlines", "report"]);

    const { runBuild } = await import("../src/build/orchestrator.js");
    await runBuild(config, configDir, { force: false });

    // Even though artifacts exist, manifest says "failed" → MUST retry intelligence
    expect(runEmbeddingsStepMock).toHaveBeenCalled();
    expect(runCommunitySummariesStepMock).toHaveBeenCalled();
    expect(runNodeDescriptionsStepMock).toHaveBeenCalled();
    // Indexer should be SKIPPED (status "completed" + artifact valid)
    expect(runIndexerMock).not.toHaveBeenCalled();
  });

  // ── Improvement #3: SQLite integrity check via actual query ────────────

  it("re-runs indexer when DB exists but query returns 0 rows (empty/corrupt DB)", async () => {
    const { config, configDir, outputDir, graphPath } = setupConfig();
    writeGraphJson(graphPath);
    setupNoConfigChange();
    setupNoFileChanges();
    setupIntelligenceMock();
    runOutlineGenerationMock.mockResolvedValue(3);

    // Mock openDatabase to return empty result (DB exists but has no data)
    openDatabaseMock.mockResolvedValue({
      exec: () => [{ values: [[0]] }], // 0 nodes = corrupt/empty
      close: () => {},
    });

    // Manifest says all completed, but DB has no data
    const cacheDir = join(outputDir, ".cache");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, "build-manifest.json"), JSON.stringify({
      version: 1,
      started_at: "2025-01-01T00:00:00.000Z",
      completed_at: null,
      graph_hash: null,
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
    createArtifacts(outputDir, ["embeddings", "community_summaries", "node_descriptions", "html", "outlines", "report"]);
    writeFileSync(join(outputDir, "graph_search.db"), "SQLite format 3\x00" + "\x00".repeat(100));

    const { runBuild } = await import("../src/build/orchestrator.js");
    await runBuild(config, configDir, { force: false });

    // Empty DB detected via query → indexer re-run
    expect(runIndexerMock).toHaveBeenCalled();
  });

  it("re-runs indexer when openDatabase throws (corrupted binary)", async () => {
    const { config, configDir, outputDir, graphPath } = setupConfig();
    writeGraphJson(graphPath);
    setupNoConfigChange();
    setupNoFileChanges();
    setupIntelligenceMock();
    runOutlineGenerationMock.mockResolvedValue(3);

    // Mock openDatabase to throw (corrupt DB can't be opened)
    openDatabaseMock.mockRejectedValue(new Error("malformed database schema"));

    const cacheDir = join(outputDir, ".cache");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, "build-manifest.json"), JSON.stringify({
      version: 1,
      started_at: "2025-01-01T00:00:00.000Z",
      completed_at: null,
      graph_hash: null,
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
    createArtifacts(outputDir, ["embeddings", "community_summaries", "node_descriptions", "html", "outlines", "report"]);
    writeFileSync(join(outputDir, "graph_search.db"), "corrupted binary data here");

    const { runBuild } = await import("../src/build/orchestrator.js");
    await runBuild(config, configDir, { force: false });

    // openDatabase threw → indexer must be re-run
    expect(runIndexerMock).toHaveBeenCalled();
  });

  // ── THE CRITICAL BUG FIX: interrupted build + config change ────────────

  it("re-runs interrupted step AND config-changed step when both signals present", async () => {
    const { config, configDir, outputDir, graphPath } = setupConfig();
    writeGraphJson(graphPath);
    setupNoFileChanges();
    setupIntelligenceMock();
    setupValidDbMock();
    runOutlineGenerationMock.mockResolvedValue(3);

    // Config change: embeddings changed
    loadPreviousBuildConfigMock.mockReturnValue({
      hasChanges: true,
      isFirstBuild: false,
      embeddingsChanged: true,
      outlinesChanged: false,
      communitySummariesChanged: false,
      nodeDescriptionsChanged: false,
      previous: null,
    });

    // Previous build interrupted during community_summaries
    const cacheDir = join(outputDir, ".cache");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, "build-manifest.json"), JSON.stringify({
      version: 1,
      started_at: "2025-01-01T00:00:00.000Z",
      completed_at: null,
      graph_hash: null,
      steps: {
        extraction: { status: "completed" },
        graph_build: { status: "completed" },
        indexer: { status: "completed" },
        outlines: { status: "completed" },
        embeddings: { status: "completed" },
        community_summaries: { status: "running" }, // INTERRUPTED HERE
        node_descriptions: { status: "pending" },
        html: { status: "pending" },
        report: { status: "pending" },
      },
    }, null, 2));
    // Artifacts that were completed exist
    createArtifacts(outputDir, ["indexer", "outlines", "embeddings"]);

    const { runBuild } = await import("../src/build/orchestrator.js");
    await runBuild(config, configDir, { force: false });

    // BOTH signals must be honored:
    // 1. Embeddings re-run (config changed)
    // 2. Community summaries re-run (was interrupted)
    // 3. node_descriptions re-run (was pending)
    // 4. HTML + report (dependency on community_summaries)
    expect(runEmbeddingsStepMock).toHaveBeenCalled();
    expect(runCommunitySummariesStepMock).toHaveBeenCalled();
    expect(runNodeDescriptionsStepMock).toHaveBeenCalled();
    expect(exportHtmlMock).toHaveBeenCalled();
    expect(generateGraphReportMock).toHaveBeenCalled();
    // Indexer should be SKIPPED (completed + artifact valid)
    expect(runIndexerMock).not.toHaveBeenCalled();
  });
});
