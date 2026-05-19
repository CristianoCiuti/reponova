/**
 * search-index phase — generates SQLite FTS search index.
 *
 * Reads graph.json, populates SQLite in-memory, saves to graph_search.db.
 * Skip logic: mtime comparison between graph.json and graph_search.db.
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Phase, PhaseContext, PhaseResult } from "../engine/phase.js";
import { loadGraphData } from "../../graph/loader.js";
import { openDatabase, initializeSchema, populateDatabase, saveDatabase } from "../../query/db.js";
import { log, errorMessage } from "../../shared/utils.js";

export const searchIndexPhase: Phase = {
  id: "index",
  label: "Search Index",
  dependencies: ["enrich"],

  async execute(ctx: PhaseContext): Promise<PhaseResult> {
    const startedAt = new Date();
    ctx.manifest.record(this.id, { status: "running", startedAt: startedAt.toISOString(), finishedAt: null, durationMs: null });
    log.info(`  [${this.id}] ${this.label}...`);

    try {
      const { outputDir, force } = ctx;
      const graphJsonPath = join(outputDir, "graph-enriched.json");
      const dbPath = join(outputDir, "graph_search.db");

      if (!shouldRun(graphJsonPath, dbPath, force)) {
        const finishedAt = new Date();
        const elapsed = ((finishedAt.getTime() - startedAt.getTime()) / 1000).toFixed(1);
        ctx.manifest.record(this.id, { status: "skipped", startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), durationMs: finishedAt.getTime() - startedAt.getTime() });
        log.info(`  [${this.id}] Skipped: up to date (${elapsed}s)`);
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

      const result: PhaseResult = { processed: graphData.nodes.length, skipped: false };
      const finishedAt = new Date();
      const elapsed = ((finishedAt.getTime() - startedAt.getTime()) / 1000).toFixed(1);
      ctx.manifest.record(this.id, { status: "completed", startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), durationMs: finishedAt.getTime() - startedAt.getTime() });
      log.info(`  [${this.id}] Done: ${result.processed} processed (${elapsed}s)`);

      return result;
    } catch (err) {
      const finishedAt = new Date();
      const elapsed = ((finishedAt.getTime() - startedAt.getTime()) / 1000).toFixed(1);
      const message = errorMessage(err);
      ctx.manifest.record(this.id, { status: "failed", startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), durationMs: finishedAt.getTime() - startedAt.getTime() });
      log.warn(`  [${this.id}] Failed: ${message} (${elapsed}s)`);
      return { processed: 0, skipped: true, skipReason: `error: ${message}` };
    }
  },
};

function shouldRun(graphJsonPath: string, dbPath: string, force: boolean): boolean {
  if (force) return true;
  if (!existsSync(dbPath)) return true;
  if (!existsSync(graphJsonPath)) return false;
  return statSync(graphJsonPath).mtimeMs > statSync(dbPath).mtimeMs;
}
