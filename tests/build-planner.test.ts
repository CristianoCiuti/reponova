/**
 * Unit tests for build-planner.ts — the unified decision logic.
 *
 * Tests the 16 cases from the verification matrix in the design doc,
 * plus additional edge cases.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Config } from "../src/shared/types.js";
import { DEFAULT_CONFIG } from "../src/shared/types.js";
import type { BuildManifest, StepName } from "../src/build/manifest.js";
import type { ConfigDiff } from "../src/build/incremental/config-diff.js";
import type { PlannerInput } from "../src/build/build-planner.js";

// Mock openDatabase for artifact integrity checks
const openDatabaseMock = vi.fn();
vi.mock("../src/core/db.js", () => ({ openDatabase: openDatabaseMock }));

const { computeBuildPlan, checkExpectedArtifacts } = await import("../src/build/build-planner.js");

// ─── Test Helpers ────────────────────────────────────────────────────────────

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = join(tmpdir(), `rn-test-planner-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

function defaultConfig(): Config {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as Config;
}

function noConfigDiff(): ConfigDiff {
  return {
    hasChanges: false,
    isFirstBuild: false,
    embeddingsChanged: false,
    outlinesChanged: false,
    communitySummariesChanged: false,
    nodeDescriptionsChanged: false,
    previous: null,
  };
}

function completeManifest(): BuildManifest {
  const steps: Record<StepName, { status: string; started_at?: string; completed_at?: string }> = {} as any;
  const allSteps: StepName[] = [
    "extraction", "graph_build", "indexer", "outlines",
    "embeddings", "community_summaries", "node_descriptions", "html", "report",
  ];
  for (const step of allSteps) {
    steps[step] = { status: "completed", started_at: "2025-01-01T00:00:00.000Z", completed_at: "2025-01-01T00:00:10.000Z" };
  }
  return {
    version: 1,
    started_at: "2025-01-01T00:00:00.000Z",
    completed_at: "2025-01-01T00:01:00.000Z",
    graph_hash: "abc123",
    steps: steps as any,
  };
}

function incompleteManifest(incompleteSteps: Partial<Record<StepName, "running" | "pending" | "failed">>): BuildManifest {
  const manifest = completeManifest();
  manifest.completed_at = null; // Mark as incomplete
  for (const [step, status] of Object.entries(incompleteSteps)) {
    (manifest.steps as any)[step] = { status };
  }
  return manifest;
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

function setupValidDbMock(): void {
  openDatabaseMock.mockResolvedValue({
    exec: () => [{ values: [[5]] }],
    close: () => {},
  });
}

function setupInvalidDbMock(): void {
  openDatabaseMock.mockRejectedValue(new Error("not a valid database"));
}

function buildInput(overrides: Partial<PlannerInput>): PlannerInput {
  return {
    previousManifest: null,
    configDiff: noConfigDiff(),
    fileChanges: { reextractedFiles: 0, removedFiles: 0 },
    previousGraphHash: "hash123",
    currentGraphHash: "hash123",
    config: defaultConfig(),
    outputDir: createTempDir(),
    force: false,
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("computeBuildPlan", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── Case 1: Manifest completo, tutti artifacts OK, nessun cambio → ∅ ──
  it("case 1: complete manifest + all artifacts + no changes → early return", async () => {
    const outputDir = createTempDir();
    createAllArtifacts(outputDir);
    setupValidDbMock();

    const plan = await computeBuildPlan(buildInput({
      previousManifest: completeManifest(),
      outputDir,
      previousGraphHash: "same",
      currentGraphHash: "same",
    }));

    expect(plan.isUpToDate).toBe(true);
    expect(plan.stepsToRun.size).toBe(0);
  });

  // ── Case 2: Manifest completo, tutti artifacts OK, config embeddings cambiata → {embeddings} ──
  it("case 2: complete manifest + config embeddings changed → runs only embeddings", async () => {
    const outputDir = createTempDir();
    createAllArtifacts(outputDir);
    setupValidDbMock();

    const plan = await computeBuildPlan(buildInput({
      previousManifest: completeManifest(),
      outputDir,
      previousGraphHash: "same",
      currentGraphHash: "same",
      configDiff: {
        ...noConfigDiff(),
        hasChanges: true,
        embeddingsChanged: true,
      },
    }));

    expect(plan.isUpToDate).toBe(false);
    expect(plan.stepsToRun).toEqual(new Set(["embeddings"]));
    expect(plan.reasons.get("embeddings")).toBe("embeddings config changed");
  });

  // ── Case 3: Manifest completo, tutti artifacts OK, file sorgente cambiati → {ALL downstream} ──
  it("case 3: complete manifest + source files changed → all downstream steps", async () => {
    const outputDir = createTempDir();
    createAllArtifacts(outputDir);
    setupValidDbMock();

    const plan = await computeBuildPlan(buildInput({
      previousManifest: completeManifest(),
      outputDir,
      previousGraphHash: "same",
      currentGraphHash: "same",
      fileChanges: { reextractedFiles: 3, removedFiles: 0 },
    }));

    expect(plan.isUpToDate).toBe(false);
    expect(plan.stepsToRun).toContain("indexer");
    expect(plan.stepsToRun).toContain("outlines");
    expect(plan.stepsToRun).toContain("embeddings");
    expect(plan.stepsToRun).toContain("community_summaries");
    expect(plan.stepsToRun).toContain("node_descriptions");
    expect(plan.stepsToRun).toContain("html");
    expect(plan.stepsToRun).toContain("report");
  });

  // ── Case 4: Manifest incompleto (summaries=running), nessun cambio → {community_summaries, html, report} ──
  it("case 4: incomplete manifest (summaries=running) + no changes → runs summaries + dependents", async () => {
    const outputDir = createTempDir();
    createAllArtifacts(outputDir);
    // Remove the community_summaries artifact since it was never completed
    rmSync(join(outputDir, "community_summaries.json"), { force: true });
    setupValidDbMock();

    const plan = await computeBuildPlan(buildInput({
      previousManifest: incompleteManifest({ community_summaries: "running" }),
      outputDir,
      previousGraphHash: "same",
      currentGraphHash: "same",
    }));

    expect(plan.isUpToDate).toBe(false);
    expect(plan.stepsToRun).toContain("community_summaries");
    expect(plan.stepsToRun).toContain("html");
    expect(plan.stepsToRun).toContain("report");
    expect(plan.stepsToRun).not.toContain("indexer");
    expect(plan.stepsToRun).not.toContain("embeddings");
  });

  // ── Case 5: Manifest incompleto (summaries=running) + config embeddings cambiata ──
  it("case 5: incomplete manifest (summaries=running) + config embeddings changed → {community_summaries, embeddings, html, report}", async () => {
    const outputDir = createTempDir();
    createAllArtifacts(outputDir);
    rmSync(join(outputDir, "community_summaries.json"), { force: true });
    setupValidDbMock();

    const plan = await computeBuildPlan(buildInput({
      previousManifest: incompleteManifest({ community_summaries: "running" }),
      outputDir,
      previousGraphHash: "same",
      currentGraphHash: "same",
      configDiff: {
        ...noConfigDiff(),
        hasChanges: true,
        embeddingsChanged: true,
      },
    }));

    expect(plan.isUpToDate).toBe(false);
    expect(plan.stepsToRun).toContain("community_summaries");
    expect(plan.stepsToRun).toContain("embeddings");
    expect(plan.stepsToRun).toContain("html");
    expect(plan.stepsToRun).toContain("report");
    expect(plan.stepsToRun).not.toContain("indexer");
    expect(plan.stepsToRun).not.toContain("outlines");
  });

  // ── Case 6: Manifest incompleto (indexer=running) + config summaries cambiata ──
  it("case 6: incomplete manifest (indexer=running) + config summaries changed → {indexer, community_summaries, html, report}", async () => {
    const outputDir = createTempDir();
    createAllArtifacts(outputDir);
    // Remove indexer artifact
    rmSync(join(outputDir, "graph_search.db"), { force: true });
    setupInvalidDbMock();

    const plan = await computeBuildPlan(buildInput({
      previousManifest: incompleteManifest({ indexer: "running" }),
      outputDir,
      previousGraphHash: "same",
      currentGraphHash: "same",
      configDiff: {
        ...noConfigDiff(),
        hasChanges: true,
        communitySummariesChanged: true,
      },
    }));

    expect(plan.isUpToDate).toBe(false);
    expect(plan.stepsToRun).toContain("indexer");
    expect(plan.stepsToRun).toContain("community_summaries");
    expect(plan.stepsToRun).toContain("html");
    expect(plan.stepsToRun).toContain("report");
  });

  // ── Case 7: Manifest assente + tutti artifacts OK → ∅ (early return) ──
  it("case 7: no manifest + all artifacts present → early return", async () => {
    const outputDir = createTempDir();
    createAllArtifacts(outputDir);
    setupValidDbMock();

    const plan = await computeBuildPlan(buildInput({
      previousManifest: null,
      outputDir,
      previousGraphHash: "same",
      currentGraphHash: "same",
    }));

    expect(plan.isUpToDate).toBe(true);
    expect(plan.stepsToRun.size).toBe(0);
  });

  // ── Case 8: Manifest assente + indexer artifact mancante → {indexer} ──
  it("case 8: no manifest + indexer artifact missing → runs indexer", async () => {
    const outputDir = createTempDir();
    createAllArtifacts(outputDir);
    // Remove indexer
    rmSync(join(outputDir, "graph_search.db"), { force: true });
    setupInvalidDbMock();

    const plan = await computeBuildPlan(buildInput({
      previousManifest: null,
      outputDir,
      previousGraphHash: "same",
      currentGraphHash: "same",
    }));

    expect(plan.isUpToDate).toBe(false);
    expect(plan.stepsToRun).toContain("indexer");
    expect(plan.stepsToRun).not.toContain("embeddings");
  });

  // ── Case 9: Manifest completo + indexer artifact CORROTTO → {indexer} ──
  it("case 9: complete manifest + corrupted indexer artifact → runs indexer", async () => {
    const outputDir = createTempDir();
    createAllArtifacts(outputDir);
    // Write invalid DB
    writeFileSync(join(outputDir, "graph_search.db"), "corrupted data");
    openDatabaseMock.mockRejectedValue(new Error("malformed database schema"));

    const plan = await computeBuildPlan(buildInput({
      previousManifest: completeManifest(),
      outputDir,
      previousGraphHash: "same",
      currentGraphHash: "same",
    }));

    expect(plan.isUpToDate).toBe(false);
    expect(plan.stepsToRun).toContain("indexer");
    expect(plan.stepsToRun).not.toContain("embeddings");
  });

  // ── Case 10: Manifest completo + community_summaries.json mancante → {community_summaries, html, report} ──
  it("case 10: complete manifest + community_summaries.json missing → runs summaries + dependents", async () => {
    const outputDir = createTempDir();
    createAllArtifacts(outputDir);
    rmSync(join(outputDir, "community_summaries.json"), { force: true });
    setupValidDbMock();

    const plan = await computeBuildPlan(buildInput({
      previousManifest: completeManifest(),
      outputDir,
      previousGraphHash: "same",
      currentGraphHash: "same",
    }));

    expect(plan.isUpToDate).toBe(false);
    expect(plan.stepsToRun).toContain("community_summaries");
    expect(plan.stepsToRun).toContain("html");
    expect(plan.stepsToRun).toContain("report");
    expect(plan.stepsToRun).not.toContain("indexer");
    expect(plan.stepsToRun).not.toContain("embeddings");
  });

  // ── Case 11: Force flag → {ALL downstream} ──
  it("case 11: force flag → all downstream steps", async () => {
    const outputDir = createTempDir();
    createAllArtifacts(outputDir);
    setupValidDbMock();

    const plan = await computeBuildPlan(buildInput({
      previousManifest: completeManifest(),
      outputDir,
      previousGraphHash: "same",
      currentGraphHash: "same",
      force: true,
    }));

    expect(plan.isUpToDate).toBe(false);
    expect(plan.stepsToRun).toContain("indexer");
    expect(plan.stepsToRun).toContain("outlines");
    expect(plan.stepsToRun).toContain("embeddings");
    expect(plan.stepsToRun).toContain("community_summaries");
    expect(plan.stepsToRun).toContain("node_descriptions");
    expect(plan.stepsToRun).toContain("html");
    expect(plan.stepsToRun).toContain("report");
  });

  // ── Case 12: Manifest con embeddings=failed + artifacts embeddings presenti → {embeddings} ──
  it("case 12: manifest with embeddings=failed + artifact present → retries embeddings", async () => {
    const outputDir = createTempDir();
    createAllArtifacts(outputDir);
    setupValidDbMock();

    // Manifest complete but embeddings marked failed
    const manifest = completeManifest();
    (manifest.steps as any).embeddings = { status: "failed", skip_reason: "Model OOM" };

    const plan = await computeBuildPlan(buildInput({
      previousManifest: manifest,
      outputDir,
      previousGraphHash: "same",
      currentGraphHash: "same",
    }));

    expect(plan.isUpToDate).toBe(false);
    expect(plan.stepsToRun).toContain("embeddings");
    expect(plan.stepsToRun).not.toContain("indexer");
  });

  // ── Case 13: Manifest incompleto (tutto pending tranne extraction/graph_build), nessun cambio ──
  it("case 13: incomplete manifest (all downstream pending) → all downstream steps", async () => {
    const outputDir = createTempDir();
    // No artifacts at all
    setupInvalidDbMock();

    const plan = await computeBuildPlan(buildInput({
      previousManifest: incompleteManifest({
        indexer: "pending",
        outlines: "pending",
        embeddings: "pending",
        community_summaries: "pending",
        node_descriptions: "pending",
        html: "pending",
        report: "pending",
      }),
      outputDir,
      previousGraphHash: "same",
      currentGraphHash: "same",
    }));

    expect(plan.isUpToDate).toBe(false);
    expect(plan.stepsToRun).toContain("indexer");
    expect(plan.stepsToRun).toContain("outlines");
    expect(plan.stepsToRun).toContain("embeddings");
    expect(plan.stepsToRun).toContain("community_summaries");
    expect(plan.stepsToRun).toContain("node_descriptions");
    expect(plan.stepsToRun).toContain("html");
    expect(plan.stepsToRun).toContain("report");
  });

  // ── Case 14: Manifest completo, artifacts OK, graph hash cambiato → {ALL downstream} ──
  it("case 14: complete manifest + graph hash changed → all downstream steps", async () => {
    const outputDir = createTempDir();
    createAllArtifacts(outputDir);
    setupValidDbMock();

    const plan = await computeBuildPlan(buildInput({
      previousManifest: completeManifest(),
      outputDir,
      previousGraphHash: "old_hash",
      currentGraphHash: "new_hash",
    }));

    expect(plan.isUpToDate).toBe(false);
    expect(plan.stepsToRun).toContain("indexer");
    expect(plan.stepsToRun).toContain("outlines");
    expect(plan.stepsToRun).toContain("embeddings");
    expect(plan.stepsToRun).toContain("community_summaries");
    expect(plan.stepsToRun).toContain("node_descriptions");
    expect(plan.stepsToRun).toContain("html");
    expect(plan.stepsToRun).toContain("report");
  });

  // ── Case 15: Manifest incompleto (outlines=pending) + config outlines changed → {outlines} ──
  it("case 15: incomplete manifest (outlines=pending) + config outlines changed → runs outlines", async () => {
    const outputDir = createTempDir();
    createAllArtifacts(outputDir);
    // Remove outlines dir
    rmSync(join(outputDir, "outlines"), { recursive: true, force: true });
    setupValidDbMock();

    const plan = await computeBuildPlan(buildInput({
      previousManifest: incompleteManifest({ outlines: "pending" }),
      outputDir,
      previousGraphHash: "same",
      currentGraphHash: "same",
      configDiff: {
        ...noConfigDiff(),
        hasChanges: true,
        outlinesChanged: true,
      },
    }));

    expect(plan.isUpToDate).toBe(false);
    expect(plan.stepsToRun).toContain("outlines");
  });

  // ── Case 16: Manifest completo + outlines disabled → ∅ for outlines (filtrato) ──
  it("case 16: outlines disabled in config → outlines filtered out even if missing", async () => {
    const outputDir = createTempDir();
    createAllArtifacts(outputDir);
    // Remove outlines dir (would normally trigger)
    rmSync(join(outputDir, "outlines"), { recursive: true, force: true });
    setupValidDbMock();

    const config = defaultConfig();
    config.outlines.enabled = false;

    const plan = await computeBuildPlan(buildInput({
      previousManifest: completeManifest(),
      outputDir,
      previousGraphHash: "same",
      currentGraphHash: "same",
      config,
    }));

    expect(plan.stepsToRun).not.toContain("outlines");
  });

  // ── Additional: previousGraphHash null (first build with graph hash) ──
  it("runs all when previousGraphHash is null (first graph hash)", async () => {
    const outputDir = createTempDir();
    setupInvalidDbMock();

    const plan = await computeBuildPlan(buildInput({
      previousManifest: null,
      outputDir,
      previousGraphHash: null,
      currentGraphHash: "new_hash",
    }));

    expect(plan.isUpToDate).toBe(false);
    // Since hash changed (null !== "new_hash") → all downstream
    expect(plan.stepsToRun.size).toBe(7);
  });

  // ── Additional: dependency propagation (html/report from community_summaries) ──
  it("propagates html and report when community_summaries needs to run", async () => {
    const outputDir = createTempDir();
    createAllArtifacts(outputDir);
    rmSync(join(outputDir, "community_summaries.json"), { force: true });
    setupValidDbMock();

    const plan = await computeBuildPlan(buildInput({
      previousManifest: completeManifest(),
      outputDir,
      previousGraphHash: "same",
      currentGraphHash: "same",
    }));

    expect(plan.stepsToRun).toContain("community_summaries");
    expect(plan.stepsToRun).toContain("html");
    expect(plan.stepsToRun).toContain("report");
  });

  // ── Additional: filter disabled html ──
  it("filters html when html disabled in config", async () => {
    const outputDir = createTempDir();
    createAllArtifacts(outputDir);
    rmSync(join(outputDir, "community_summaries.json"), { force: true });
    setupValidDbMock();

    const config = defaultConfig();
    config.build.html = false;

    const plan = await computeBuildPlan(buildInput({
      previousManifest: completeManifest(),
      outputDir,
      previousGraphHash: "same",
      currentGraphHash: "same",
      config,
    }));

    expect(plan.stepsToRun).toContain("community_summaries");
    expect(plan.stepsToRun).not.toContain("html"); // disabled
    expect(plan.stepsToRun).toContain("report");
  });
});

describe("checkExpectedArtifacts", () => {
  afterEach(() => {
    vi.clearAllMocks();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns empty array when all artifacts exist and are valid", async () => {
    const outputDir = createTempDir();
    createAllArtifacts(outputDir);
    setupValidDbMock();

    const missing = await checkExpectedArtifacts(outputDir, defaultConfig());
    expect(missing).toEqual([]);
  });

  it("detects missing indexer (no file)", async () => {
    const outputDir = createTempDir();
    createAllArtifacts(outputDir);
    rmSync(join(outputDir, "graph_search.db"), { force: true });
    setupInvalidDbMock();

    const missing = await checkExpectedArtifacts(outputDir, defaultConfig());
    expect(missing).toContain("indexer");
  });

  it("detects corrupt indexer (empty DB)", async () => {
    const outputDir = createTempDir();
    createAllArtifacts(outputDir);
    openDatabaseMock.mockResolvedValue({
      exec: () => [{ values: [[0]] }],
      close: () => {},
    });

    const missing = await checkExpectedArtifacts(outputDir, defaultConfig());
    expect(missing).toContain("indexer");
  });

  it("detects missing community_summaries", async () => {
    const outputDir = createTempDir();
    createAllArtifacts(outputDir);
    rmSync(join(outputDir, "community_summaries.json"), { force: true });
    setupValidDbMock();

    const missing = await checkExpectedArtifacts(outputDir, defaultConfig());
    expect(missing).toContain("community_summaries");
  });

  it("detects invalid community_summaries (bad JSON)", async () => {
    const outputDir = createTempDir();
    createAllArtifacts(outputDir);
    writeFileSync(join(outputDir, "community_summaries.json"), "not json{{{");
    setupValidDbMock();

    const missing = await checkExpectedArtifacts(outputDir, defaultConfig());
    expect(missing).toContain("community_summaries");
  });

  it("skips embeddings check when disabled", async () => {
    const outputDir = createTempDir();
    createAllArtifacts(outputDir);
    // Remove embeddings artifact
    rmSync(join(outputDir, "tfidf_idf.json"), { force: true });
    setupValidDbMock();

    const config = defaultConfig();
    config.build.embeddings.enabled = false;

    const missing = await checkExpectedArtifacts(outputDir, config);
    expect(missing).not.toContain("embeddings");
  });

  it("detects missing report", async () => {
    const outputDir = createTempDir();
    createAllArtifacts(outputDir);
    rmSync(join(outputDir, "report.md"), { force: true });
    setupValidDbMock();

    const missing = await checkExpectedArtifacts(outputDir, defaultConfig());
    expect(missing).toContain("report");
  });

  it("detects missing html (graph_communities.html)", async () => {
    const outputDir = createTempDir();
    createAllArtifacts(outputDir);
    rmSync(join(outputDir, "graph_communities.html"), { force: true });
    setupValidDbMock();

    const missing = await checkExpectedArtifacts(outputDir, defaultConfig());
    expect(missing).toContain("html");
  });
});
