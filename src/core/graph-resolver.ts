import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { readdirSync } from "node:fs";
import { log } from "../shared/utils.js";

/**
 * Auto-detect the path to graphify-out directory.
 *
 * Resolution order:
 * 1. Explicit --graph flag
 * 2. Env var GRAPHIFY_GRAPH_PATH
 * 3. ./graphify-out/ (current directory)
 * 4. ../{sibling}/graphify-out/ - sibling probe
 * 5. null (not found)
 */
export function resolveGraphPath(explicitPath?: string): string | null {
  // 1. Explicit path
  if (explicitPath) {
    const abs = resolve(explicitPath);
    if (existsSync(abs)) {
      log.debug(`Graph path resolved from explicit flag: ${abs}`);
      return abs;
    }
    log.warn(`Explicit graph path not found: ${abs}`);
    return null;
  }

  // 2. Environment variable
  const envPath = process.env["GRAPHIFY_GRAPH_PATH"];
  if (envPath) {
    const abs = resolve(envPath);
    if (existsSync(abs)) {
      log.debug(`Graph path resolved from GRAPHIFY_GRAPH_PATH: ${abs}`);
      return abs;
    }
    log.warn(`GRAPHIFY_GRAPH_PATH set but path not found: ${abs}`);
  }

  // 3. CWD / graphify-out
  const cwdPath = resolve(process.cwd(), "graphify-out");
  if (existsSync(cwdPath)) {
    log.debug(`Graph path resolved from CWD: ${cwdPath}`);
    return cwdPath;
  }

  // 4. Sibling probe: ../<anything>/graphify-out
  const parentDir = resolve(process.cwd(), "..");
  try {
    const siblings = readdirSync(parentDir, { withFileTypes: true });
    for (const entry of siblings) {
      if (entry.isDirectory()) {
        const candidate = join(parentDir, entry.name, "graphify-out");
        if (existsSync(candidate)) {
          log.debug(`Graph path resolved from sibling: ${candidate}`);
          return candidate;
        }
      }
    }
  } catch {
    // Parent directory not readable, skip
  }

  log.debug("Graph path not found in any known location");
  return null;
}

/**
 * Resolve the graph.json file path within a graphify-out directory.
 */
export function resolveGraphJson(graphDir: string): string | null {
  const graphJson = join(graphDir, "graph.json");
  if (existsSync(graphJson)) return graphJson;
  return null;
}

/**
 * Resolve the search database path within a graphify-out directory.
 */
export function resolveSearchDb(graphDir: string): string | null {
  const dbPath = join(graphDir, "graph_search.db");
  if (existsSync(dbPath)) return dbPath;
  return null;
}
