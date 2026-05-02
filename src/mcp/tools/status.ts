import type { Database } from "../../core/db.js";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { getMeta } from "../../core/db.js";
import { formatNumber } from "../../shared/utils.js";
import { loadBuildConfigFingerprint } from "../../core/build-config-metadata.js";

export function readBuildConfigStatusLines(graphJsonPath: string | null): string[] {
  if (!graphJsonPath || !existsSync(graphJsonPath)) {
    return ["Build config: unavailable"];
  }

  const buildConfig = loadBuildConfigFingerprint(graphJsonPath);
  if (!buildConfig) {
    return ["Build config: missing from graph.json"];
  }

  return [
    "Build config:",
    `  Embeddings: ${buildConfig.embeddings.enabled ? `${buildConfig.embeddings.method} (${buildConfig.embeddings.model}, ${buildConfig.embeddings.dimensions}d)` : "disabled"}`,
    `  Outlines: ${buildConfig.outlines.enabled ? "enabled" : "disabled"}`,
    `  Community summaries: ${buildConfig.community_summaries.enabled ? "enabled" : "disabled"}`,
    `  Node descriptions: ${buildConfig.node_descriptions.enabled ? "enabled" : "disabled"}`,
  ];
}

export function handleStatus(db: Database, graphDir: string, graphJsonPath: string | null) {
  const lines: string[] = ["## Graph Status", ""];
  lines.push(`Graph: ${graphDir}/graph.json`);

  const builtAt = getMeta(db, "built_at");
  if (builtAt) lines.push(`Built: ${builtAt}`);
  const gv = getMeta(db, "reponova_version");
  if (gv) lines.push(`reponova version: ${gv}`);
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
  lines.push("");
  lines.push(...readBuildConfigStatusLines(graphJsonPath));
  lines.push("", "Staleness: UNKNOWN (run 'reponova check' for git-based staleness)");
  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
}
