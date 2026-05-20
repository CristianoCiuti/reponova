import { join } from "node:path";
import type { CacheContext } from "./context.js";
import type { PhaseContext, PhaseResult } from "../engine/phase.js";
import { log } from "../../shared/utils.js";

export interface CacheCheckResult {
  fresh: boolean;
  reason: string;
}

export interface CacheContract {
  readonly phaseId: string;
  check(ctx: CacheContext): CacheCheckResult;
  seal(ctx: CacheContext): void;
  invalidate(ctx: CacheContext): void;
}

/**
 * Build a CacheContext from a PhaseContext.
 */
function buildCacheContext(ctx: PhaseContext): CacheContext {
  return {
    outputDir: ctx.outputDir,
    cacheDir: join(ctx.outputDir, ".cache"),
    config: ctx.config,
  };
}

/**
 * Check if a phase can be skipped based on its cache contract.
 * Returns a PhaseResult if the phase should be skipped, or null if it should execute.
 *
 * Each phase calls this at the top of execute():
 *   const cached = checkPhaseCache(ctx, contract);
 *   if (cached) return cached;
 */
export function checkPhaseCache(ctx: PhaseContext, contract: CacheContract): PhaseResult | null {
  if (ctx.force) return null;

  const cacheCtx = buildCacheContext(ctx);
  const result = contract.check(cacheCtx);

  if (result.fresh) {
    log.info(`  [${contract.phaseId}] Skipped: ${result.reason}`);
    return { processed: 0, skipped: true, skipReason: result.reason };
  }

  return null;
}

/**
 * Seal the cache after a successful phase execution.
 * Each phase calls this at the end of execute() on success.
 *
 * Silent on failure — cache seal errors never fail the phase.
 */
export function sealPhaseCache(ctx: PhaseContext, contract: CacheContract): void {
  try {
    const cacheCtx = buildCacheContext(ctx);
    contract.seal(cacheCtx);
  } catch {
    // Cache seal errors are non-fatal — phase already succeeded
  }
}
