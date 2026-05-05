/**
 * Build manifest — tracks pipeline step completion state.
 *
 * Solves the "interrupted build" problem: if a build is killed mid-way,
 * the next incremental build can detect incomplete steps and resume.
 *
 * Storage: `<output>/.cache/build-manifest.json`
 * All writes are atomic (write-then-rename) to prevent corruption on crash.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

// ─── Types ───────────────────────────────────────────────────────────────────

export type StepName =
  | "extraction"
  | "graph_build"
  | "indexer"
  | "outlines"
  | "embeddings"
  | "community_summaries"
  | "node_descriptions"
  | "html"
  | "report";

export type StepStatus = "pending" | "running" | "completed" | "skipped" | "failed";

export interface StepState {
  status: StepStatus;
  started_at?: string;
  completed_at?: string;
  /** For best-effort steps: why it was skipped/failed (acceptable) */
  skip_reason?: string;
}

export interface BuildManifest {
  /** Schema version for future migrations */
  version: 1;
  /** Timestamp when build started */
  started_at: string;
  /** Timestamp when build completed (null = interrupted) */
  completed_at: string | null;
  /** Semantic graph hash at time of build */
  graph_hash: string | null;
  /** Step completion state */
  steps: Record<StepName, StepState>;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const MANIFEST_FILENAME = "build-manifest.json";

const ALL_STEPS: StepName[] = [
  "extraction",
  "graph_build",
  "indexer",
  "outlines",
  "embeddings",
  "community_summaries",
  "node_descriptions",
  "html",
  "report",
];

// ─── Atomic Write ────────────────────────────────────────────────────────────

/**
 * Write JSON atomically via write-then-rename.
 * Guarantees file is either the old version or the new version, never partial.
 */
export function atomicWriteJson(filePath: string, data: unknown): void {
  const tmpPath = filePath + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  renameSync(tmpPath, filePath);
}

// ─── Manifest Path ───────────────────────────────────────────────────────────

export function getManifestPath(outputDir: string): string {
  return join(outputDir, ".cache", MANIFEST_FILENAME);
}

// ─── Create ──────────────────────────────────────────────────────────────────

/**
 * Create a fresh manifest with all steps pending.
 * Called at the start of every build.
 */
export function createManifest(outputDir: string): BuildManifest {
  const cacheDir = join(outputDir, ".cache");
  mkdirSync(cacheDir, { recursive: true });

  const manifest: BuildManifest = {
    version: 1,
    started_at: new Date().toISOString(),
    completed_at: null,
    graph_hash: null,
    steps: Object.fromEntries(
      ALL_STEPS.map((step) => [step, { status: "pending" as StepStatus }]),
    ) as Record<StepName, StepState>,
  };

  atomicWriteJson(getManifestPath(outputDir), manifest);
  return manifest;
}

// ─── Load ────────────────────────────────────────────────────────────────────

/**
 * Load existing manifest. Returns null if absent or corrupted.
 */
export function loadManifest(outputDir: string): BuildManifest | null {
  const path = getManifestPath(outputDir);
  if (!existsSync(path)) return null;

  try {
    const raw = readFileSync(path, "utf-8");
    const data = JSON.parse(raw) as BuildManifest;
    // Basic validation
    if (data.version !== 1 || !data.steps || !data.started_at) return null;
    return data;
  } catch {
    return null;
  }
}

// ─── Update Step ─────────────────────────────────────────────────────────────

/**
 * Mark a step as running/completed/skipped/failed.
 * Writes manifest atomically after each state change.
 */
export function updateStep(
  outputDir: string,
  manifest: BuildManifest,
  step: StepName,
  status: StepStatus,
  skipReason?: string,
): void {
  const now = new Date().toISOString();

  manifest.steps[step] = {
    status,
    ...(status === "running" ? { started_at: now } : {}),
    ...(status === "completed" || status === "failed" || status === "skipped"
      ? { completed_at: now }
      : {}),
    ...(skipReason ? { skip_reason: skipReason } : {}),
  };

  atomicWriteJson(getManifestPath(outputDir), manifest);
}

// ─── Complete ────────────────────────────────────────────────────────────────

/**
 * Mark build as complete. Sets completed_at and optionally the graph hash.
 */
export function completeManifest(
  outputDir: string,
  manifest: BuildManifest,
  graphHash?: string,
): void {
  manifest.completed_at = new Date().toISOString();
  if (graphHash) manifest.graph_hash = graphHash;
  atomicWriteJson(getManifestPath(outputDir), manifest);
}

// ─── Query Helpers ───────────────────────────────────────────────────────────

/**
 * Get list of steps that need to be (re-)executed.
 * Returns steps with status "pending", "running", or "failed".
 */
export function getIncompleteSteps(manifest: BuildManifest): StepName[] {
  return ALL_STEPS.filter((step) => {
    const s = manifest.steps[step]?.status;
    return s === "pending" || s === "running" || s === "failed";
  });
}

/**
 * Check if the manifest indicates a fully completed build.
 */
export function isManifestComplete(manifest: BuildManifest): boolean {
  return manifest.completed_at !== null;
}

// ─── Standalone Command Helpers ──────────────────────────────────────────────

/**
 * Invalidate a manifest step (called by standalone commands at START).
 * Marks step as "running" so next build knows it's in-flight.
 * No-op if manifest doesn't exist.
 */
export function invalidateManifestStep(outputDir: string, step: StepName): void {
  const manifest = loadManifest(outputDir);
  if (!manifest) return;

  // Mark step as running and clear completed_at (build is no longer fully complete)
  manifest.completed_at = null;
  updateStep(outputDir, manifest, step, "running");
}

/**
 * Validate a manifest step (called by standalone commands at END on success).
 * Marks step as "completed". Restores completed_at if all steps are now done.
 * No-op if manifest doesn't exist.
 */
export function validateManifestStep(outputDir: string, step: StepName): void {
  const manifest = loadManifest(outputDir);
  if (!manifest) return;

  updateStep(outputDir, manifest, step, "completed");

  // If all steps are now completed/skipped, restore completed_at
  const incomplete = getIncompleteSteps(manifest);
  if (incomplete.length === 0) {
    manifest.completed_at = new Date().toISOString();
    atomicWriteJson(getManifestPath(outputDir), manifest);
  }
}
