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
 * Cache logic (check/seal/invalidate) is entirely owned by each phase.
 * The orchestrator never touches caching — it only sequences and parallelizes.
 */
import type { Phase, PhaseContext, PhaseResult } from "./phase.js";
import type { PhaseRegistry } from "./registry.js";
import {
  buildDAG,
  validate,
  topologicalLevels,
  resolveTransitiveDeps,
  resolveTransitiveDescendants,
  pruneDAG,
} from "./dag.js";
import { errorMessage, log } from "../../shared/utils.js";

export interface OrchestratorOptions {
  /** Run only these phases + their transitive deps (null = full DAG) */
  target?: string | string[];
  /** Run only strict descendants of this phase (null = full DAG) */
  startAfter?: string;
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

  // Prune to target(s) + transitive deps if --target specified
  if (options.target) {
    const targets = Array.isArray(options.target) ? options.target : [options.target];
    const keep = new Set<string>();
    for (const t of targets) {
      for (const id of resolveTransitiveDeps(dag, t)) {
        keep.add(id);
      }
    }
    dag = pruneDAG(dag, keep);
    log.info(`Target: ${targets.join(", ")} (${keep.size} phases in dependency chain)`);
  }

  // Prune to strict descendants if --start-after specified
  if (options.startAfter) {
    const descendants = resolveTransitiveDescendants(dag, options.startAfter);
    if (descendants.size === 0) {
      log.info(`No phases downstream of "${options.startAfter}" — nothing to run.`);
      return { outputDir: ctx.outputDir, phases: new Map(), totalProcessed: 0 };
    }
    dag = pruneDAG(dag, descendants);
    log.info(`Start after: ${options.startAfter} (${descendants.size} downstream phases)`);
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
      collectResults(batch, batchResults, results, ctx);
    }
  } else {
    // Execute all in parallel
    const settled = await Promise.allSettled(
      phases.map((phase) => executePhase(phase, ctx)),
    );
    collectResults(phases, settled, results, ctx);
  }

  return results;
}

/**
 * Execute a single phase.
 *
 * Phases own their own cache check/seal, timing, logging, and error handling.
 * The orchestrator only sequences and parallelizes.
 */
async function executePhase(phase: Phase, ctx: PhaseContext): Promise<PhaseResult> {
  return phase.execute(ctx);
}

/**
 * Collect results from Promise.allSettled, handling failures gracefully.
 */
function collectResults(
  phases: Phase[],
  settled: PromiseSettledResult<PhaseResult>[],
  results: Map<string, PhaseResult>,
  ctx: PhaseContext,
): void {
  for (let i = 0; i < phases.length; i++) {
    const phase = phases[i]!;
    const outcome = settled[i]!;

    if (outcome.status === "fulfilled") {
      results.set(phase.id, outcome.value);
    } else {
      // Safety net: phase threw an uncaught error.
      // If the phase already recorded "failed" (via its own try/catch), respect it.
      // Only overwrite if the manifest still shows "running" (actual crash scenario).
      const message = errorMessage(outcome.reason);
      const existing = ctx.manifest.readEntry(phase.id);
      if (!existing || existing.status === "running") {
        const finishedAt = new Date();
        ctx.manifest.record(phase.id, {
          status: "failed",
          startedAt: existing?.startedAt ?? finishedAt.toISOString(),
          finishedAt: finishedAt.toISOString(),
          durationMs: existing
            ? finishedAt.getTime() - new Date(existing.startedAt).getTime()
            : 0,
        });
      }
      log.warn(`  [${phase.id}] Failed (non-blocking): ${message}`);
      results.set(phase.id, {
        processed: 0,
        skipped: true,
        skipReason: `error: ${message}`,
      });
    }
  }
}
