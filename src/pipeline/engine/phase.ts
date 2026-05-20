/**
 * Phase interface — the atomic unit of the pipeline.
 *
 * Every phase:
 * - Has a unique ID and human-readable label
 * - Declares its direct dependencies (IDs of phases it depends on)
 * - Owns its own cache logic (check/seal/invalidate) internally
 * - Communicates with other phases via filesystem only (no in-memory passing)
 */
import type { Config } from "../../shared/types.js";
import type { BuildManifest } from "./manifest.js";
import type { ProviderRegistry } from "../../intelligence/provider-registry.js";

/**
 * Context provided by the orchestrator to every phase.
 * The phase reads config and filesystem — it never receives in-memory data from other phases.
 * Shared infrastructure (e.g. LLM pool) is injected here to avoid duplicate resource allocation.
 */
export interface PhaseContext {
  /** Complete config (each phase reads its own section) */
  config: Config;
  /** Absolute config directory */
  configDir: string;
  /** Absolute output directory */
  outputDir: string;
  /** Workspace root directory (resolved from repos) */
  workspace: string;
  /** If true, the phase ignores cache and regenerates everything */
  force: boolean;
  /** Shared build manifest — each phase records its own execution state */
  manifest: BuildManifest;
  /** Shared provider registry — phases acquire providers from here instead of creating their own. */
  providerRegistry: ProviderRegistry;
}

/**
 * Result returned by every phase.
 */
export interface PhaseResult {
  /** Number of items processed (for logging) */
  processed: number;
  /** If true, the phase decided not to execute (already up-to-date) */
  skipped: boolean;
  /** Reason for skipping (for logging) */
  skipReason?: string;
}

/**
 * Every phase implements this interface.
 * The phase OWNS its cache logic — it checks freshness at the start
 * of execute() and seals on success, autonomously.
 */
export interface Phase {
  /** Unique phase identifier (used in DAG, CLI --target, logs) */
  readonly id: string;
  /** Human-readable label (for logging) */
  readonly label: string;
  /** IDs of phases that must complete before this one can run */
  readonly dependencies: string[];
  /** Execute the phase. Returns result with processed count and skip info. */
  execute(ctx: PhaseContext): Promise<PhaseResult>;
}
