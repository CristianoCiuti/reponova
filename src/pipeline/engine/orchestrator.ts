/**
 * Generic DAG orchestrator — executes phases level-by-level with maximum parallelism.
 *
 * The orchestrator knows NOTHING about specific phases. It:
 * 1. Takes a registry of phases
 * 2. Builds and validates a DAG
 * 3. Computes topological levels
 * 4. Executes level-by-level (phases within a level run in parallel)
 * 5. Collects results
 *
 * Phase-specific logic (skip criteria, cache, config invalidation) is
 * entirely internal to each phase.
 */
import type { Phase, PhaseContext, PhaseResult } from "./phase.js";
import type { PhaseRegistry } from "./registry.js";
import { buildDAG, validate, topologicalLevels, resolveTransitiveDeps, pruneDAG } from "./dag.js";
import { errorMessage, log } from "../../shared/utils.js";

export interface OrchestratorOptions {
  /** Run only this phase + its transitive deps (null = full DAG) */
  target?: string;
  /** Force all phases to ignore cache */
  force: boolean;
  /** Max concurrent phases per level (0 = unlimited) */
  concurrency?: number;
}

export interface BuildResult {
  /** Absolute output directory */
  outputDir: string;
  /** Per-phase results */
  phases: Map<string, PhaseResult>;
  /** Total items processed across all phases */
  totalProcessed: number;
}

/**
 * Run the pipeline: resolve DAG, execute level-by-level.
 */
export async function orchestrate(
  registry: PhaseRegistry,
  ctx: PhaseContext,
  options: OrchestratorOptions,
): Promise<BuildResult> {
  const allPhases = registry.getAll();
  let dag = buildDAG(allPhases);

  // Validate full DAG first (catches missing deps even for pruned runs)
  validate(dag);

  // Prune to target + transitive deps if --target specified
  if (options.target) {
    const keep = resolveTransitiveDeps(dag, options.target);
    dag = pruneDAG(dag, keep);
    log.info(`Target: ${options.target} (${keep.size} phases in dependency chain)`);
  }

  const levels = topologicalLevels(dag);
  const results = new Map<string, PhaseResult>();
  let totalProcessed = 0;

  log.info(`Pipeline: ${dag.size} phases, ${levels.length} execution levels`);

  for (let levelIdx = 0; levelIdx < levels.length; levelIdx++) {
    const level = levels[levelIdx]!;
    const levelLabels = level.map((p) => p.id).join(", ");
    log.info("");
    log.info(`── Level ${levelIdx}: ${levelLabels} ──`);

    const phaseResults = await executeLevel(level, ctx, options);

    for (const [id, result] of phaseResults) {
      results.set(id, result);
      totalProcessed += result.processed;
    }
  }

  return {
    outputDir: ctx.outputDir,
    phases: results,
    totalProcessed,
  };
}

/**
 * Execute all phases in a level. Phases within a level run in parallel.
 */
async function executeLevel(
  phases: Phase[],
  ctx: PhaseContext,
  options: OrchestratorOptions,
): Promise<Map<string, PhaseResult>> {
  const results = new Map<string, PhaseResult>();
  const concurrency = options.concurrency ?? 0;

  if (concurrency > 0 && phases.length > concurrency) {
    // Execute in batches
    for (let i = 0; i < phases.length; i += concurrency) {
      const batch = phases.slice(i, i + concurrency);
      const batchResults = await Promise.allSettled(
        batch.map((phase) => executePhase(phase, ctx)),
      );
      collectResults(batch, batchResults, results);
    }
  } else {
    // Execute all in parallel
    const settled = await Promise.allSettled(
      phases.map((phase) => executePhase(phase, ctx)),
    );
    collectResults(phases, settled, results);
  }

  return results;
}

/**
 * Execute a single phase with error handling and logging.
 */
async function executePhase(phase: Phase, ctx: PhaseContext): Promise<PhaseResult> {
  log.info(`  [${phase.id}] ${phase.label}...`);
  const start = Date.now();

  const result = await phase.execute(ctx);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  if (result.skipped) {
    log.info(`  [${phase.id}] Skipped: ${result.skipReason ?? "up to date"} (${elapsed}s)`);
  } else {
    log.info(`  [${phase.id}] Done: ${result.processed} processed (${elapsed}s)`);
  }

  return result;
}

/**
 * Collect results from Promise.allSettled, handling failures gracefully.
 */
function collectResults(
  phases: Phase[],
  settled: PromiseSettledResult<PhaseResult>[],
  results: Map<string, PhaseResult>,
): void {
  for (let i = 0; i < phases.length; i++) {
    const phase = phases[i]!;
    const outcome = settled[i]!;

    if (outcome.status === "fulfilled") {
      results.set(phase.id, outcome.value);
    } else {
      const message = errorMessage(outcome.reason);
      log.warn(`  [${phase.id}] Failed (non-blocking): ${message}`);
      results.set(phase.id, {
        processed: 0,
        skipped: true,
        skipReason: `error: ${message}`,
      });
    }
  }
}
