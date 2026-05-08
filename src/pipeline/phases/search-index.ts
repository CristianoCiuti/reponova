/**
 * search-index phase — generates SQLite FTS search index.
 *
 * Reads graph.json, populates SQLite in-memory, saves to graph_search.db.
 * Skip logic: mtime comparison between graph.json and graph_search.db.
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Phase, PhaseContext, PhaseResult } from "../engine/phase.js";
import { loadGraphData } from "../../core/graph-loader.js";
import { openDatabase, initializeSchema, populateDatabase, saveDatabase } from "../../core/db.js";
import { log } from "../../shared/utils.js";

export const searchIndexPhase: Phase = {
  id: "index",
  label: "Search Index",
  dependencies: ["communities"],

  async execute(ctx: PhaseContext): Promise<PhaseResult> {
    const { outputDir, force } = ctx;
    const graphJsonPath = join(outputDir, "graph.json");
    const dbPath = join(outputDir, "graph_search.db");

    if (!shouldRun(graphJsonPath, dbPath, force)) {
      return { processed: 0, skipped: true, skipReason: "up to date" };
    }

    log.info("Generating search index...");
    const graphData = loadGraphData(graphJsonPath);

    const db = await openDatabase(dbPath);
    initializeSchema(db);
    populateDatabase(db, graphData);
    saveDatabase(db, dbPath);
    db.close();

    log.info(`  Search index: ${graphData.nodes.length} nodes, ${graphData.edges.length} edges`);
    return { processed: graphData.nodes.length, skipped: false };
  },
};

function shouldRun(graphJsonPath: string, dbPath: string, force: boolean): boolean {
  if (force) return true;
  if (!existsSync(dbPath)) return true;
  if (!existsSync(graphJsonPath)) return false;
  return statSync(graphJsonPath).mtimeMs > statSync(dbPath).mtimeMs;
}
