/**
 * Build step types — shared interfaces for the autonomous step system.
 *
 * Every step receives a StepContext and returns a StepResult.
 * Steps are autonomous: they decide internally whether to execute.
 */
import type { Config, BuildConfigFingerprint } from "../shared/types.js";
import type { LlmEnginePool } from "./intelligence/llm-engine-pool.js";
import type Graph from "graphology";
import type { CommunityResult } from "../extract/community.js";

/**
 * Context provided by the orchestrator to every step.
 */
export interface StepContext {
  /** Complete config (each step reads its own section) */
  config: Config;
  /** Absolute config directory (optional for standalone step invocations) */
  configDir?: string;
  /** Absolute output directory */
  outputDir: string;
  /** Absolute path to graph.json */
  graphJsonPath: string;
  /** If true, the step ignores cache and regenerates everything */
  force: boolean;
  /** Previous build config (for detecting config changes per-step). null = first build. */
  previousConfig: BuildConfigFingerprint | null;
  /** Shared LLM pool (for steps that use LLM) */
  llmPool?: LlmEnginePool;
  /** In-memory graph from the extraction phase (for HTML/export steps) */
  graph?: Graph;
  /** In-memory communities from the extraction phase (for HTML/export steps) */
  communities?: CommunityResult;
}

/**
 * Result returned by every step.
 */
export interface StepResult {
  /** Number of items processed (for logging) */
  processed: number;
  /** If true, the step decided not to execute (already up-to-date) */
  skipped: boolean;
  /** Reason for skipping (for logging) */
  skipReason?: string;
}

/**
 * Every step implements this signature.
 * The step DECIDES INTERNALLY whether it has work to do.
 */
export type BuildStep = (ctx: StepContext) => Promise<StepResult>;
