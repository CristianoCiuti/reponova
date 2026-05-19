import type { CacheContext } from "./context.js";

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
