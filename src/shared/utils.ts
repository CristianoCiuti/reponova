import { resolve, relative, sep, dirname } from "node:path";
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
 * Normalize a path to forward slashes, relative form.
 */
export function normalizePath(filePath: string, basePath?: string): string {
  let normalized = filePath;
  if (basePath && resolve(filePath).startsWith(resolve(basePath))) {
    normalized = relative(basePath, filePath);
  }
  return normalized.split(sep).join("/");
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
