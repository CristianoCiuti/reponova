import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  atomicWriteJson,
  completeManifest,
  createManifest,
  getIncompleteSteps,
  getManifestPath,
  invalidateManifestStep,
  isManifestComplete,
  loadManifest,
  updateStep,
  validateManifestStep,
} from "../src/build/manifest.js";
import type { BuildManifest, StepName } from "../src/build/manifest.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = join(tmpdir(), `rn-test-manifest-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("manifest: atomicWriteJson", () => {
  it("writes valid JSON that can be read back", () => {
    const dir = makeTempDir();
    const filePath = join(dir, "test.json");
    const data = { hello: "world", num: 42 };

    atomicWriteJson(filePath, data);

    const content = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(content).toEqual(data);
  });

  it("does not leave .tmp file behind", () => {
    const dir = makeTempDir();
    const filePath = join(dir, "test.json");

    atomicWriteJson(filePath, { ok: true });

    expect(existsSync(filePath + ".tmp")).toBe(false);
    expect(existsSync(filePath)).toBe(true);
  });

  it("overwrites existing file atomically", () => {
    const dir = makeTempDir();
    const filePath = join(dir, "test.json");

    atomicWriteJson(filePath, { version: 1 });
    atomicWriteJson(filePath, { version: 2 });

    const content = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(content).toEqual({ version: 2 });
  });
});

describe("manifest: createManifest", () => {
  it("creates manifest with all steps pending", () => {
    const outputDir = makeTempDir();
    const manifest = createManifest(outputDir);

    expect(manifest.version).toBe(1);
    expect(manifest.started_at).toBeTruthy();
    expect(manifest.completed_at).toBeNull();
    expect(manifest.graph_hash).toBeNull();

    const allSteps: StepName[] = [
      "extraction", "graph_build", "indexer", "outlines",
      "embeddings", "community_summaries", "node_descriptions", "html", "report",
    ];
    for (const step of allSteps) {
      expect(manifest.steps[step].status).toBe("pending");
    }
  });

  it("writes manifest to .cache/build-manifest.json", () => {
    const outputDir = makeTempDir();
    createManifest(outputDir);

    const manifestPath = getManifestPath(outputDir);
    expect(existsSync(manifestPath)).toBe(true);

    const raw = JSON.parse(readFileSync(manifestPath, "utf-8"));
    expect(raw.version).toBe(1);
  });

  it("creates .cache directory if missing", () => {
    const outputDir = makeTempDir();
    const cacheDir = join(outputDir, ".cache");
    expect(existsSync(cacheDir)).toBe(false);

    createManifest(outputDir);

    expect(existsSync(cacheDir)).toBe(true);
  });
});

describe("manifest: loadManifest", () => {
  it("returns null when no manifest exists", () => {
    const outputDir = makeTempDir();
    expect(loadManifest(outputDir)).toBeNull();
  });

  it("loads a valid manifest", () => {
    const outputDir = makeTempDir();
    const created = createManifest(outputDir);
    const loaded = loadManifest(outputDir);

    expect(loaded).not.toBeNull();
    expect(loaded!.version).toBe(1);
    expect(loaded!.started_at).toBe(created.started_at);
  });

  it("returns null for corrupted JSON", () => {
    const outputDir = makeTempDir();
    const cacheDir = join(outputDir, ".cache");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, "build-manifest.json"), "not json{{{");

    expect(loadManifest(outputDir)).toBeNull();
  });

  it("returns null for JSON with wrong version", () => {
    const outputDir = makeTempDir();
    const cacheDir = join(outputDir, ".cache");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, "build-manifest.json"), JSON.stringify({
      version: 99,
      started_at: "2025-01-01T00:00:00.000Z",
      completed_at: null,
      graph_hash: null,
      steps: {},
    }));

    expect(loadManifest(outputDir)).toBeNull();
  });

  it("returns null for JSON missing required fields", () => {
    const outputDir = makeTempDir();
    const cacheDir = join(outputDir, ".cache");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, "build-manifest.json"), JSON.stringify({
      version: 1,
      // missing started_at and steps
    }));

    expect(loadManifest(outputDir)).toBeNull();
  });
});

describe("manifest: updateStep", () => {
  it("marks a step as running with started_at", () => {
    const outputDir = makeTempDir();
    const manifest = createManifest(outputDir);

    updateStep(outputDir, manifest, "indexer", "running");

    expect(manifest.steps.indexer.status).toBe("running");
    expect(manifest.steps.indexer.started_at).toBeTruthy();
    expect(manifest.steps.indexer.completed_at).toBeUndefined();
  });

  it("marks a step as completed with completed_at", () => {
    const outputDir = makeTempDir();
    const manifest = createManifest(outputDir);

    updateStep(outputDir, manifest, "indexer", "running");
    updateStep(outputDir, manifest, "indexer", "completed");

    expect(manifest.steps.indexer.status).toBe("completed");
    expect(manifest.steps.indexer.completed_at).toBeTruthy();
  });

  it("marks a step as failed with skip_reason", () => {
    const outputDir = makeTempDir();
    const manifest = createManifest(outputDir);

    updateStep(outputDir, manifest, "community_summaries", "failed", "Model not available");

    expect(manifest.steps.community_summaries.status).toBe("failed");
    expect(manifest.steps.community_summaries.skip_reason).toBe("Model not available");
    expect(manifest.steps.community_summaries.completed_at).toBeTruthy();
  });

  it("marks a step as skipped with skip_reason", () => {
    const outputDir = makeTempDir();
    const manifest = createManifest(outputDir);

    updateStep(outputDir, manifest, "outlines", "skipped", "outlines.enabled = false");

    expect(manifest.steps.outlines.status).toBe("skipped");
    expect(manifest.steps.outlines.skip_reason).toBe("outlines.enabled = false");
  });

  it("persists state change to disk", () => {
    const outputDir = makeTempDir();
    const manifest = createManifest(outputDir);

    updateStep(outputDir, manifest, "indexer", "completed");

    const loaded = loadManifest(outputDir);
    expect(loaded!.steps.indexer.status).toBe("completed");
  });
});

describe("manifest: completeManifest", () => {
  it("sets completed_at timestamp", () => {
    const outputDir = makeTempDir();
    const manifest = createManifest(outputDir);

    completeManifest(outputDir, manifest);

    expect(manifest.completed_at).toBeTruthy();
  });

  it("optionally sets graph_hash", () => {
    const outputDir = makeTempDir();
    const manifest = createManifest(outputDir);

    completeManifest(outputDir, manifest, "abc123hash");

    expect(manifest.graph_hash).toBe("abc123hash");
  });

  it("persists to disk", () => {
    const outputDir = makeTempDir();
    const manifest = createManifest(outputDir);

    completeManifest(outputDir, manifest, "xyz");

    const loaded = loadManifest(outputDir);
    expect(loaded!.completed_at).toBeTruthy();
    expect(loaded!.graph_hash).toBe("xyz");
  });
});

describe("manifest: isManifestComplete", () => {
  it("returns false for new manifest", () => {
    const outputDir = makeTempDir();
    const manifest = createManifest(outputDir);

    expect(isManifestComplete(manifest)).toBe(false);
  });

  it("returns true after completeManifest", () => {
    const outputDir = makeTempDir();
    const manifest = createManifest(outputDir);
    completeManifest(outputDir, manifest);

    expect(isManifestComplete(manifest)).toBe(true);
  });

  it("returns false when completed_at is cleared", () => {
    const outputDir = makeTempDir();
    const manifest = createManifest(outputDir);
    completeManifest(outputDir, manifest);
    manifest.completed_at = null;

    expect(isManifestComplete(manifest)).toBe(false);
  });
});

describe("manifest: getIncompleteSteps", () => {
  it("returns all steps for a fresh manifest", () => {
    const outputDir = makeTempDir();
    const manifest = createManifest(outputDir);

    const incomplete = getIncompleteSteps(manifest);
    expect(incomplete).toHaveLength(9);
  });

  it("excludes completed steps", () => {
    const outputDir = makeTempDir();
    const manifest = createManifest(outputDir);

    updateStep(outputDir, manifest, "extraction", "completed");
    updateStep(outputDir, manifest, "graph_build", "completed");

    const incomplete = getIncompleteSteps(manifest);
    expect(incomplete).not.toContain("extraction");
    expect(incomplete).not.toContain("graph_build");
    expect(incomplete).toHaveLength(7);
  });

  it("excludes skipped steps", () => {
    const outputDir = makeTempDir();
    const manifest = createManifest(outputDir);

    updateStep(outputDir, manifest, "outlines", "skipped", "disabled");

    const incomplete = getIncompleteSteps(manifest);
    expect(incomplete).not.toContain("outlines");
  });

  it("includes running and failed steps", () => {
    const outputDir = makeTempDir();
    const manifest = createManifest(outputDir);

    updateStep(outputDir, manifest, "indexer", "running");
    updateStep(outputDir, manifest, "embeddings", "failed", "OOM");

    const incomplete = getIncompleteSteps(manifest);
    expect(incomplete).toContain("indexer");
    expect(incomplete).toContain("embeddings");
  });

  it("returns empty array when all steps are done", () => {
    const outputDir = makeTempDir();
    const manifest = createManifest(outputDir);
    const allSteps: StepName[] = [
      "extraction", "graph_build", "indexer", "outlines",
      "embeddings", "community_summaries", "node_descriptions", "html", "report",
    ];
    for (const step of allSteps) {
      updateStep(outputDir, manifest, step, "completed");
    }

    expect(getIncompleteSteps(manifest)).toHaveLength(0);
  });
});

describe("manifest: invalidateManifestStep", () => {
  it("marks step as running and clears completed_at", () => {
    const outputDir = makeTempDir();
    const manifest = createManifest(outputDir);
    const allSteps: StepName[] = [
      "extraction", "graph_build", "indexer", "outlines",
      "embeddings", "community_summaries", "node_descriptions", "html", "report",
    ];
    for (const step of allSteps) {
      updateStep(outputDir, manifest, step, "completed");
    }
    completeManifest(outputDir, manifest);

    // Now invalidate indexer (simulates standalone `reponova index`)
    invalidateManifestStep(outputDir, "indexer");

    const loaded = loadManifest(outputDir);
    expect(loaded!.steps.indexer.status).toBe("running");
    expect(loaded!.completed_at).toBeNull();
  });

  it("is a no-op when no manifest exists", () => {
    const outputDir = makeTempDir();
    // Should not throw
    invalidateManifestStep(outputDir, "indexer");
  });
});

describe("manifest: validateManifestStep", () => {
  it("marks step as completed", () => {
    const outputDir = makeTempDir();
    const manifest = createManifest(outputDir);
    invalidateManifestStep(outputDir, "indexer");

    validateManifestStep(outputDir, "indexer");

    const loaded = loadManifest(outputDir);
    expect(loaded!.steps.indexer.status).toBe("completed");
  });

  it("restores completed_at when all steps are done", () => {
    const outputDir = makeTempDir();
    const manifest = createManifest(outputDir);
    const allSteps: StepName[] = [
      "extraction", "graph_build", "indexer", "outlines",
      "embeddings", "community_summaries", "node_descriptions", "html", "report",
    ];
    for (const step of allSteps) {
      updateStep(outputDir, manifest, step, "completed");
    }
    completeManifest(outputDir, manifest);

    // Invalidate then validate
    invalidateManifestStep(outputDir, "outlines");
    validateManifestStep(outputDir, "outlines");

    const loaded = loadManifest(outputDir);
    expect(loaded!.completed_at).toBeTruthy();
  });

  it("does NOT restore completed_at when other steps still incomplete", () => {
    const outputDir = makeTempDir();
    const manifest = createManifest(outputDir);

    // Only complete extraction and graph_build
    updateStep(outputDir, manifest, "extraction", "completed");
    updateStep(outputDir, manifest, "graph_build", "completed");

    // Validate indexer
    validateManifestStep(outputDir, "indexer");

    const loaded = loadManifest(outputDir);
    // Many steps still pending, so completed_at should remain null
    expect(loaded!.completed_at).toBeNull();
  });

  it("is a no-op when no manifest exists", () => {
    const outputDir = makeTempDir();
    // Should not throw
    validateManifestStep(outputDir, "outlines");
  });
});

describe("manifest: getManifestPath", () => {
  it("returns correct path", () => {
    const outputDir = "/some/output";
    const path = getManifestPath(outputDir);
    expect(path).toContain(".cache");
    expect(path).toContain("build-manifest.json");
  });
});
