/**
 * search-index phase — generates SQLite FTS search index.
 *
 * Reads graph-enriched.json, populates SQLite in-memory, saves to graph_search.db.
 */
import { join } from "node:path";
import type { Config } from "../../shared/types.js";
import { loadGraphData } from "../../graph/loader.js";
import { openDatabase, initializeSchema, populateDatabase, saveDatabase } from "../../query/db.js";
import { log } from "../../shared/utils.js";
import { BasePhase, type PhaseContext, type PhaseResult } from "../engine/phase.js";

class SearchIndexPhase extends BasePhase {
  readonly id = "index";
  readonly label = "Search Index";
  readonly dependencies = ["enrich"];
  readonly inputs = ["graph-enriched.json"];

  getExpectedOutputs(_config: Config): { files: string[]; dirs: string[] } {
    return { files: ["graph_search.db"], dirs: [] };
  }

  getRelevantConfig(_config: Config): object {
    return {};
  }

  async doWork(ctx: PhaseContext): Promise<PhaseResult> {
    const { outputDir } = ctx;
    const graphJsonPath = join(outputDir, "graph-enriched.json");
    const dbPath = join(outputDir, "graph_search.db");

    log.info("Generating search index...");
    const graphData = loadGraphData(graphJsonPath);

    const db = await openDatabase(dbPath);
    initializeSchema(db);
    populateDatabase(db, graphData);
    saveDatabase(db, dbPath);
    db.close();

    log.info(`  Search index: ${graphData.nodes.length} nodes, ${graphData.edges.length} edges`);

    return { processed: graphData.nodes.length, skipped: false };
  }
}

export const searchIndexPhase = new SearchIndexPhase();
