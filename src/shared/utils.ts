import { resolve, dirname } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ─── Package version ────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgPath = resolve(__dirname, "..", "..", "package.json");

let _version: string | undefined;

/**
 * Package version from package.json.
 * Resolved lazily; works in dev (src/), dist, and after npm install.
 */
export function getVersion(): string {
  if (!_version) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version: string };
      _version = pkg.version;
    } catch {
      _version = "unknown";
    }
  }
  return _version;
}

/**
 * Extract a human-readable message from an unknown catch value.
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Simple logger with levels.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let currentLevel: LogLevel = "info";

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export const log = {
  debug(msg: string, ...args: unknown[]): void {
    if (LOG_LEVELS[currentLevel]! <= LOG_LEVELS.debug) {
      console.error(`[DEBUG] ${msg}`, ...args);
    }
  },
  info(msg: string, ...args: unknown[]): void {
    if (LOG_LEVELS[currentLevel]! <= LOG_LEVELS.info) {
      console.error(`[INFO] ${msg}`, ...args);
    }
  },
  warn(msg: string, ...args: unknown[]): void {
    if (LOG_LEVELS[currentLevel]! <= LOG_LEVELS.warn) {
      console.error(`[WARN] ${msg}`, ...args);
    }
  },
  error(msg: string, ...args: unknown[]): void {
    if (LOG_LEVELS[currentLevel]! <= LOG_LEVELS.error) {
      console.error(`[ERROR] ${msg}`, ...args);
    }
  },
};

/**
 * Format a number with comma separators.
 */
export function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * Truncate a string to maxLen, appending "..." if truncated.
 */
export function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 3) + "...";
}

// ─── Token counting ─────────────────────────────────────────────────────────

let tokenEncoder: { encode: (text: string) => number[] } | null = null;
let tokenEncoderResolved = false;

/**
 * Count tokens using js-tiktoken (gpt-4o tokenizer).
 * Falls back to conservative estimate (~4 chars/token) if unavailable.
 */
export function countTokens(text: string): number {
  if (!tokenEncoderResolved) {
    tokenEncoderResolved = true;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { encodingForModel } = require("js-tiktoken") as {
        encodingForModel: (model: string) => { encode: (text: string) => number[] };
      };
      tokenEncoder = encodingForModel("gpt-4o");
    } catch {
      // js-tiktoken not available — use fallback
      tokenEncoder = null;
    }
  }
  if (tokenEncoder) {
    return tokenEncoder.encode(text).length;
  }
  return Math.ceil(text.length / 4);
}

/**
 * Lightweight progress timer for long-running loops.
 *
 * Replaces repeated inline Date.now() arithmetic across intelligence modules.
 */
export class ProgressTimer {
  private start = Date.now();
  constructor(private total: number) {}

  /** Compute elapsed, average and ETA strings after processing item at index `i` (0-based). */
  tick(i: number): { elapsed: string; avgMs: string; remaining: string } {
    const ms = Date.now() - this.start;
    const done = i + 1;
    return {
      elapsed: (ms / 1000).toFixed(1),
      avgMs: (ms / done).toFixed(0),
      remaining: ((ms / done) * (this.total - done) / 1000).toFixed(0),
    };
  }

  /** Elapsed seconds formatted as a string. */
  elapsedSec(): string {
    return ((Date.now() - this.start) / 1000).toFixed(1);
  }
}
