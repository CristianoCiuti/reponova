import type { Database } from "../../core/db.js";
import { existsSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getMeta } from "../../core/db.js";
import { formatNumber } from "../../shared/utils.js";

export function handleStatus(db: Database, graphDir: string, graphJsonPath: string | null) {
  const lines: string[] = ["## Graph Status", ""];
  lines.push(`Graph: ${graphDir}/graph.json`);

  const builtAt = getMeta(db, "built_at");
  if (builtAt) lines.push(`Built: ${builtAt}`);
  const gv = getMeta(db, "graphify_version");
  if (gv) lines.push(`Graphify version: ${gv}`);
  lines.push("");

  const nc = getMeta(db, "node_count") ?? "0";
  const ec = getMeta(db, "edge_count") ?? "0";
  const reposJson = getMeta(db, "repos");
  const repos: string[] = reposJson ? JSON.parse(reposJson) : [];

  lines.push(`Nodes: ${formatNumber(parseInt(nc))} | Edges: ${formatNumber(parseInt(ec))}`);
  if (repos.length > 0) lines.push(`Repos: ${repos.length} (${repos.join(", ")})`);
  lines.push("");

  const dbPath = join(graphDir, "graph_search.db");
  if (existsSync(dbPath)) {
    const stats = statSync(dbPath);
    lines.push(`Search index: graph_search.db (${(stats.size / 1048576).toFixed(1)}MB)`);
  }

  const outlinesDir = join(graphDir, "outlines");
  if (existsSync(outlinesDir)) {
    lines.push(`Outlines: pre-computed directory exists`);
  }
  lines.push("", "Staleness: UNKNOWN (run 'graphify-mcp-tools check' for git-based staleness)");
  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
}
