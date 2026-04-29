import type { CommandModule } from "yargs";
import { join } from "node:path";
import { resolveGraphPath, resolveGraphJson } from "../core/graph-resolver.js";
import { loadGraphData } from "../core/graph-loader.js";
import { openDatabase, initializeSchema, populateDatabase, saveDatabase } from "../core/db.js";
import { log } from "../shared/utils.js";

export const indexCommand: CommandModule = {
  command: "index",
  describe: "Generate SQLite search index from graph.json",
  builder: (yargs) =>
    yargs.option("graph", {
      type: "string",
      describe: "Path to graphify-out/ directory",
    }),
  handler: async (argv) => {
    const graphDir = resolveGraphPath(argv.graph as string | undefined);

    if (!graphDir) {
      log.error("Could not find graphify-out directory. Use --graph flag.");
      process.exit(1);
    }

    const graphJsonPath = resolveGraphJson(graphDir);
    if (!graphJsonPath) {
      log.error(`graph.json not found in ${graphDir}`);
      process.exit(1);
    }

    log.info(`Indexing ${graphJsonPath}...`);
    const graphData = loadGraphData(graphJsonPath);

    const dbPath = join(graphDir, "graph_search.db");
    const db = await openDatabase(dbPath);
    initializeSchema(db);
    populateDatabase(db, graphData);
    saveDatabase(db, dbPath);
    db.close();

    log.info(`Search index created: ${dbPath}`);
    log.info(`  Nodes: ${graphData.nodes.length}`);
    log.info(`  Edges: ${graphData.edges.length}`);
  },
};
