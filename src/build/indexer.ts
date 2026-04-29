import { join } from "node:path";
import { loadGraphData } from "../core/graph-loader.js";
import { openDatabase, initializeSchema, populateDatabase, saveDatabase } from "../core/db.js";
import { log } from "../shared/utils.js";

/**
 * Generate the SQLite search index from graph.json.
 */
export async function runIndexer(graphJsonPath: string, outputDir: string): Promise<void> {
  log.info("Generating search index...");

  const graphData = loadGraphData(graphJsonPath);
  const dbPath = join(outputDir, "graph_search.db");

  const db = await openDatabase(dbPath);
  initializeSchema(db);
  populateDatabase(db, graphData);
  saveDatabase(db, dbPath);
  db.close();

  log.info(`\u2713 Search index: ${dbPath} (${graphData.nodes.length} nodes, ${graphData.edges.length} edges)`);
}
