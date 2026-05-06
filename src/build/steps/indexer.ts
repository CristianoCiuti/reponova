import { join } from "node:path";
import { existsSync, statSync } from "node:fs";
import { loadGraphData } from "../../core/graph-loader.js";
import { openDatabase, initializeSchema, populateDatabase, saveDatabase } from "../../core/db.js";
import { log } from "../../shared/utils.js";
import type { BuildStep, StepContext } from "../types.js";

export const runIndexerStep: BuildStep = async (ctx: StepContext) => {
  const dbPath = join(ctx.outputDir, "graph_search.db");

  if (!shouldRunIndexer(ctx.graphJsonPath, dbPath, ctx.force)) {
    return { processed: 0, skipped: true, skipReason: "up to date" };
  }

  log.info("Generating search index...");
  const graphData = loadGraphData(ctx.graphJsonPath);

  // openDatabase creates in-memory, saveDatabase overwrites the file atomically
  const db = await openDatabase(dbPath);
  initializeSchema(db);
  populateDatabase(db, graphData);
  saveDatabase(db, dbPath);
  db.close();

  log.info(`  Search index: ${dbPath} (${graphData.nodes.length} nodes, ${graphData.edges.length} edges)`);
  return { processed: graphData.nodes.length, skipped: false };
};

function shouldRunIndexer(graphJsonPath: string, dbPath: string, force: boolean): boolean {
  if (force) return true;
  if (!existsSync(dbPath)) return true;
  return statSync(graphJsonPath).mtimeMs > statSync(dbPath).mtimeMs;
}
