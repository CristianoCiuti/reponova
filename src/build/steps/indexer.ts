import { join } from "node:path";
import { existsSync, unlinkSync } from "node:fs";
import { loadGraphData } from "../../core/graph-loader.js";
import { openDatabase, initializeSchema, populateDatabase, saveDatabase } from "../../core/db.js";
import { log } from "../../shared/utils.js";

/**
 * Generate the SQLite search index from graph.json.
 * Deletes existing DB before writing to avoid stale data from larger previous builds.
 */
export async function runIndexer(graphJsonPath: string, outputDir: string): Promise<void> {
  log.info("Generating search index...");

  const graphData = loadGraphData(graphJsonPath);
  const dbPath = join(outputDir, "graph_search.db");

  // Truncate: delete existing DB to avoid leftover data from previous builds
  if (existsSync(dbPath)) {
    unlinkSync(dbPath);
  }

  const db = await openDatabase(dbPath);
  initializeSchema(db);
  populateDatabase(db, graphData);
  saveDatabase(db, dbPath);
  db.close();

  log.info(`\u2713 Search index: ${dbPath} (${graphData.nodes.length} nodes, ${graphData.edges.length} edges)`);
}
