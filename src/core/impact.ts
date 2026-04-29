import type { Database } from "./db.js";
import { queryAll, queryOne } from "./db.js";
import type { ImpactResult, ImpactLayer, ImpactNode, GraphNode } from "../shared/types.js";

export interface ImpactOptions {
  direction?: "upstream" | "downstream" | "both";
  max_depth?: number;
  include_tests?: boolean;
}

/**
 * Perform blast-radius impact analysis using BFS on the edge graph.
 */
export function analyzeImpact(db: Database, symbolId: string, options: ImpactOptions = {}): ImpactResult | null {
  const { direction = "both", max_depth = 3, include_tests = false } = options;

  const targetRow = queryOne(
    db,
    "SELECT id, label, type, source_file, repo, community FROM nodes WHERE id = ?",
    [symbolId],
  );
  if (!targetRow) return null;

  const target: GraphNode = {
    id: targetRow.id as string,
    label: targetRow.label as string,
    type: targetRow.type as string,
    source_file: (targetRow.source_file as string | null) ?? undefined,
    repo: (targetRow.repo as string | null) ?? undefined,
    community: (targetRow.community as string | null) ?? undefined,
  };

  const upstream: ImpactLayer[] = [];
  const downstream: ImpactLayer[] = [];

  if (direction === "upstream" || direction === "both") {
    upstream.push(...bfs(db, symbolId, "upstream", max_depth, include_tests));
  }
  if (direction === "downstream" || direction === "both") {
    downstream.push(...bfs(db, symbolId, "downstream", max_depth, include_tests));
  }

  const cross_repo_summary = new Map<string, number>();
  for (const layer of [...upstream, ...downstream]) {
    for (const node of layer.nodes) {
      if (node.repo && node.repo !== target.repo) {
        cross_repo_summary.set(node.repo, (cross_repo_summary.get(node.repo) ?? 0) + 1);
      }
    }
  }

  return { target, upstream, downstream, cross_repo_summary };
}

function bfs(db: Database, startId: string, direction: "upstream" | "downstream", maxDepth: number, includeTests: boolean): ImpactLayer[] {
  const layers: ImpactLayer[] = [];
  const visited = new Set<string>([startId]);
  let frontier = [startId];

  const edgeSql = direction === "upstream"
    ? "SELECT source_id, target_id, type FROM edges WHERE target_id = ?"
    : "SELECT source_id, target_id, type FROM edges WHERE source_id = ?";

  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const nextFrontier: string[] = [];
    const layerNodes: ImpactNode[] = [];

    for (const currentId of frontier) {
      const edges = queryAll(db, edgeSql, [currentId]);
      for (const edge of edges) {
        const neighborId = (direction === "upstream" ? edge.source_id : edge.target_id) as string;
        if (visited.has(neighborId)) continue;
        visited.add(neighborId);

        const nodeRow = queryOne(db, "SELECT id, label, source_file, repo FROM nodes WHERE id = ?", [neighborId]);
        if (!nodeRow) continue;
        if (!includeTests && isTestFile(nodeRow.source_file as string | null)) continue;

        layerNodes.push({
          id: nodeRow.id as string,
          label: nodeRow.label as string,
          source_file: (nodeRow.source_file as string | null) ?? undefined,
          repo: (nodeRow.repo as string | null) ?? undefined,
          edge_type: edge.type as string,
          via: depth > 1 ? currentId : undefined,
        });
        nextFrontier.push(neighborId);
      }
    }

    if (layerNodes.length > 0) layers.push({ depth, nodes: layerNodes });
    frontier = nextFrontier;
  }

  return layers;
}

function isTestFile(filePath: string | null): boolean {
  if (!filePath) return false;
  return /\/(test_|tests\/|_test\.|\.test\.|spec\/|\.spec\.)/.test(filePath);
}

/**
 * Format impact result as markdown.
 */
export function formatImpactMarkdown(result: ImpactResult): string {
  const lines: string[] = [];
  lines.push(`## Impact analysis: ${result.target.label}`);
  lines.push("");
  lines.push(`TARGET: ${result.target.type} ${result.target.label}`);
  if (result.target.source_file) lines.push(`  File: ${result.target.source_file}`);
  if (result.target.community) lines.push(`  Community: "${result.target.community}"`);
  lines.push("");

  if (result.upstream.length > 0) {
    const total = result.upstream.reduce((s, l) => s + l.nodes.length, 0);
    lines.push(`UPSTREAM (what depends on this) \u2014 ${total} symbols:`);
    for (const layer of result.upstream) {
      lines.push(`  Depth ${layer.depth} (${layer.depth === 1 ? "DIRECT" : "INDIRECT"}):`);
      for (const node of layer.nodes) {
        const file = node.source_file ?? "";
        const via = node.via ? ` [via ${node.via}]` : "";
        lines.push(`    ${file}  ${node.label} [${node.edge_type}]${via}`);
      }
    }
    lines.push("");
  }

  if (result.downstream.length > 0) {
    const total = result.downstream.reduce((s, l) => s + l.nodes.length, 0);
    lines.push(`DOWNSTREAM (what this depends on) \u2014 ${total} symbols:`);
    for (const layer of result.downstream) {
      lines.push(`  Depth ${layer.depth} (${layer.depth === 1 ? "DIRECT" : "INDIRECT"}):`);
      for (const node of layer.nodes) {
        lines.push(`    ${node.source_file ?? ""}  ${node.label} [${node.edge_type}]`);
      }
    }
    lines.push("");
  }

  if (result.cross_repo_summary.size > 0) {
    lines.push("CROSS-REPO SUMMARY:");
    for (const [repo, count] of result.cross_repo_summary) {
      lines.push(`  ${repo}: ${count} affected symbols`);
    }
  }

  return lines.join("\n");
}
