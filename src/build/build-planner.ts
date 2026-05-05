/**
 * Build Planner — unified decision logic for which pipeline steps to run.
 *
 * Replaces the old multi-branch early-return logic in orchestrator.ts.
 * Takes ALL signals (force, file changes, graph hash, config diff, manifest state,
 * artifact integrity) and produces a single set of steps to execute.
 *
 * Signals are ADDITIVE: each one adds steps to the set.
 * The final set is the UNION of all signals, minus disabled steps.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../shared/types.js";
import type { BuildManifest, StepName } from "./manifest.js";
import { isManifestComplete } from "./manifest.js";
import type { ConfigDiff } from "./config-diff.js";
import { openDatabase } from "../core/db.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PlannerInput {
  /** Previous manifest (null = first build or corrupted) */
  previousManifest: BuildManifest | null;
  /** Config diff result */
  configDiff: ConfigDiff;
  /** Whether source files changed during extraction */
  fileChanges: {
    reextractedFiles: number;
    removedFiles: number;
  };
  /** Previous semantic graph hash (null = none saved) */
  previousGraphHash: string | null;
  /** Current semantic graph hash (computed after graph build) */
  currentGraphHash: string;
  /** Current config (for checking what's enabled) */
  config: Config;
  /** Output directory (for artifact checks) */
  outputDir: string;
  /** Force flag */
  force: boolean;
}

export interface BuildPlan {
  /** Steps that need execution. Empty = nothing to do (early return) */
  stepsToRun: Set<StepName>;
  /** Human-readable reasons per step (for logging) */
  reasons: Map<StepName, string>;
  /** Whether this is effectively a no-op (early return) */
  isUpToDate: boolean;
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** Downstream steps managed by the planner (extraction + graph_build are always run by orchestrator) */
const DOWNSTREAM_STEPS: StepName[] = [
  "indexer", "outlines", "embeddings",
  "community_summaries", "node_descriptions",
  "html", "report",
];

// ─── Main Entry Point ────────────────────────────────────────────────────────

/**
 * Compute the build plan: which downstream steps need execution.
 *
 * All signals are additive — each one ADDS steps to the set.
 * The result is the union of all signals, filtered by disabled steps.
 */
export async function computeBuildPlan(input: PlannerInput): Promise<BuildPlan> {
  const stepsToRun = new Set<StepName>();
  const reasons = new Map<StepName, string>();

  // ─── Signal 1: Force flag ──────────────────────────────────────────
  if (input.force) {
    for (const step of DOWNSTREAM_STEPS) {
      stepsToRun.add(step);
      reasons.set(step, "force rebuild");
    }
    // Force = run everything, skip remaining checks
    filterDisabledSteps(stepsToRun, reasons, input.config);
    return { stepsToRun, reasons, isUpToDate: false };
  }

  // ─── Signal 2: File/graph changes ──────────────────────────────────
  const hasFileChanges = input.fileChanges.reextractedFiles > 0
    || input.fileChanges.removedFiles > 0;
  const hasGraphChange = input.previousGraphHash !== input.currentGraphHash;

  if (hasFileChanges || hasGraphChange) {
    for (const step of DOWNSTREAM_STEPS) {
      stepsToRun.add(step);
      reasons.set(step, hasFileChanges ? "source files changed" : "graph structure changed");
    }
  }

  // ─── Signal 3: Config changes ──────────────────────────────────────
  if (input.configDiff.embeddingsChanged) {
    stepsToRun.add("embeddings");
    reasons.set("embeddings", reasons.get("embeddings") ?? "embeddings config changed");
  }
  if (input.configDiff.outlinesChanged) {
    stepsToRun.add("outlines");
    reasons.set("outlines", reasons.get("outlines") ?? "outlines config changed");
  }
  if (input.configDiff.communitySummariesChanged) {
    stepsToRun.add("community_summaries");
    reasons.set("community_summaries", reasons.get("community_summaries") ?? "community summaries config changed");
  }
  if (input.configDiff.nodeDescriptionsChanged) {
    stepsToRun.add("node_descriptions");
    reasons.set("node_descriptions", reasons.get("node_descriptions") ?? "node descriptions config changed");
  }

  // ─── Signal 4: Previous manifest incomplete ────────────────────────
  if (input.previousManifest !== null && !isManifestComplete(input.previousManifest)) {
    for (const step of DOWNSTREAM_STEPS) {
      const status = input.previousManifest.steps[step]?.status;
      if (status === "running" || status === "pending" || status === "failed") {
        stepsToRun.add(step);
        reasons.set(step, reasons.get(step) ?? `previous build incomplete (status: ${status})`);
      }
    }
  }

  // ─── Signal 5: Missing/corrupt artifacts ───────────────────────────
  const missingArtifacts = await checkExpectedArtifacts(input.outputDir, input.config);
  for (const artifact of missingArtifacts) {
    const step = artifact as StepName;
    stepsToRun.add(step);
    reasons.set(step, reasons.get(step) ?? "artifact missing or corrupt");
  }

  // ─── Signal 6: Manifest step "running"/"failed" even if manifest complete ─
  // A completed manifest with steps marked running/failed means those artifacts
  // cannot be trusted (e.g. intelligence layer failed but build still completed)
  if (input.previousManifest !== null && isManifestComplete(input.previousManifest)) {
    for (const step of DOWNSTREAM_STEPS) {
      const status = input.previousManifest.steps[step]?.status;
      if (status === "running" || status === "failed") {
        stepsToRun.add(step);
        reasons.set(step, reasons.get(step) ?? `previous build step ${status}`);
      }
    }
  }

  // ─── Propagate dependencies ────────────────────────────────────────
  propagateDependencies(stepsToRun, reasons);

  // ─── Filter disabled steps ─────────────────────────────────────────
  filterDisabledSteps(stepsToRun, reasons, input.config);

  return {
    stepsToRun,
    reasons,
    isUpToDate: stepsToRun.size === 0,
  };
}

// ─── Dependency Propagation ──────────────────────────────────────────────────

/**
 * Propagate downstream dependencies:
 * - html depends on community_summaries
 * - report depends on community_summaries
 */
function propagateDependencies(steps: Set<StepName>, reasons: Map<StepName, string>): void {
  if (steps.has("community_summaries")) {
    if (!steps.has("html")) {
      steps.add("html");
      reasons.set("html", "dependency: community_summaries changed");
    }
    if (!steps.has("report")) {
      steps.add("report");
      reasons.set("report", "dependency: community_summaries changed");
    }
  }
}

// ─── Disabled Step Filter ────────────────────────────────────────────────────

/**
 * Remove steps that are disabled in config from the plan.
 */
function filterDisabledSteps(steps: Set<StepName>, reasons: Map<StepName, string>, config: Config): void {
  if (!config.outlines.enabled) {
    steps.delete("outlines");
    reasons.delete("outlines");
  }
  if (!config.build.embeddings.enabled) {
    steps.delete("embeddings");
    reasons.delete("embeddings");
  }
  if (!config.build.community_summaries.enabled) {
    steps.delete("community_summaries");
    reasons.delete("community_summaries");
  }
  if (!config.build.node_descriptions.enabled) {
    steps.delete("node_descriptions");
    reasons.delete("node_descriptions");
  }
  if (!config.build.html) {
    steps.delete("html");
    reasons.delete("html");
  }
}

// ─── Artifact Integrity Check ────────────────────────────────────────────────

/**
 * Check which expected artifacts are missing or corrupted in the output directory.
 * Performs both existence AND integrity checks (SQLite query, JSON parse).
 */
export async function checkExpectedArtifacts(outputDir: string, config: Config): Promise<string[]> {
  const missing: string[] = [];

  // Search index: check existence + integrity via actual SQLite query
  const dbPath = join(outputDir, "graph_search.db");
  if (!existsSync(dbPath)) {
    missing.push("indexer");
  } else {
    try {
      const db = await openDatabase(dbPath, { readonly: true });
      const result = db.exec("SELECT COUNT(*) as c FROM nodes");
      const count = result[0]?.values[0]?.[0] as number ?? 0;
      db.close();
      if (count === 0) missing.push("indexer");
    } catch {
      missing.push("indexer");
    }
  }

  if (config.build.embeddings.enabled) {
    const hasVectors = existsSync(join(outputDir, "vectors"));
    const hasVectorsJson = existsSync(join(outputDir, "vectors.json"));
    const hasTfidf = existsSync(join(outputDir, "tfidf_idf.json"));
    if (!hasVectors && !hasVectorsJson && !hasTfidf) missing.push("embeddings");
  }

  if (config.build.community_summaries.enabled) {
    const summariesPath = join(outputDir, "community_summaries.json");
    if (!existsSync(summariesPath)) {
      missing.push("community_summaries");
    } else {
      try { JSON.parse(readFileSync(summariesPath, "utf-8")); }
      catch { missing.push("community_summaries"); }
    }
  }

  if (config.build.node_descriptions.enabled) {
    const descriptionsPath = join(outputDir, "node_descriptions.json");
    if (!existsSync(descriptionsPath)) {
      missing.push("node_descriptions");
    } else {
      try { JSON.parse(readFileSync(descriptionsPath, "utf-8")); }
      catch { missing.push("node_descriptions"); }
    }
  }

  if (config.build.html && (!existsSync(join(outputDir, "graph.html")) || !existsSync(join(outputDir, "graph_communities.html")))) {
    missing.push("html");
  }

  if (config.outlines.enabled) {
    const outlinesDir = join(outputDir, "outlines");
    if (!existsSync(outlinesDir)) missing.push("outlines");
  }

  if (!existsSync(join(outputDir, "report.md"))) missing.push("report");

  return missing;
}
