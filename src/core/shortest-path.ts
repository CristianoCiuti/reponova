import type { Database } from "./db.js";
import { queryAll, queryOne } from "./db.js";
import type { PathResult, PathStep } from "../shared/types.js";
import { DEFAULT_EDGE_WEIGHTS } from "../shared/types.js";
import { fuzzyMatchNode } from "./search.js";
import type { ResolvedPaths } from "./path-resolver.js";

export interface ShortestPathOptions {
  max_depth?: number;
  edge_types?: string[];
  edge_weights?: Record<string, number>;
}

/**
 * Find the shortest path between two nodes using weighted Dijkstra.
 */
export function findShortestPath(db: Database, fromName: string, toName: string, options: ShortestPathOptions = {}): PathResult {
  const { max_depth = 10, edge_types = ["CALLS", "IMPORTS", "EXTENDS", "MEMBER_OF"], edge_weights = DEFAULT_EDGE_WEIGHTS } = options;

  const fromId = resolveNodeId(db, fromName);
  const toId = resolveNodeId(db, toName);

  if (!fromId || !toId) {
    return { found: false, from: fromName, to: toName, hops: 0, path: [] };
  }

  if (fromId === toId) {
    const node = getNode(db, fromId);
    return {
      found: true, from: fromName, to: toName, hops: 0,
      path: node ? [{ node_id: node.id, label: node.label, source_file: node.source_file ?? undefined }] : [],
    };
  }

  // Dijkstra
  const dist = new Map<string, number>();
  const prev = new Map<string, { nodeId: string; edgeType: string }>();
  const visited = new Set<string>();
  const queue: Array<{ id: string; cost: number }> = [];
  const allowedTypes = new Set(edge_types);

  dist.set(fromId, 0);
  queue.push({ id: fromId, cost: 0 });

  let iterations = 0;
  while (queue.length > 0 && iterations < 10000) {
    iterations++;
    queue.sort((a, b) => a.cost - b.cost);
    const current = queue.shift()!;

    if (visited.has(current.id)) continue;
    visited.add(current.id);
    if (current.id === toId) break;

    const currentDist = dist.get(current.id) ?? 0;
    if (currentDist >= max_depth) continue;

    const edges = queryAll(db, "SELECT source_id, target_id, type FROM edges WHERE source_id = ?", [current.id]);
    for (const edge of edges) {
      const edgeType = edge.type as string;
      const targetId = edge.target_id as string;
      if (!allowedTypes.has(edgeType) || visited.has(targetId)) continue;

      const weight = edge_weights[edgeType] ?? 1.0;
      const newDist = currentDist + weight;
      const oldDist = dist.get(targetId);

      if (oldDist === undefined || newDist < oldDist) {
        dist.set(targetId, newDist);
        prev.set(targetId, { nodeId: current.id, edgeType });
        queue.push({ id: targetId, cost: newDist });
      }
    }
  }

  if (!prev.has(toId)) {
    return { found: false, from: fromName, to: toName, hops: 0, path: [] };
  }

  // Reconstruct
  const path: PathStep[] = [];
  let currentId: string | undefined = toId;
  const edgeTypesUsed = new Map<string, number>();

  while (currentId && currentId !== fromId) {
    const node = getNode(db, currentId);
    const prevInfo = prev.get(currentId);
    path.unshift({ node_id: currentId, label: node?.label ?? currentId, source_file: node?.source_file ?? undefined, edge_type: prevInfo?.edgeType });
    if (prevInfo?.edgeType) edgeTypesUsed.set(prevInfo.edgeType, (edgeTypesUsed.get(prevInfo.edgeType) ?? 0) + 1);
    currentId = prevInfo?.nodeId;
  }

  const fromNode = getNode(db, fromId);
  path.unshift({ node_id: fromId, label: fromNode?.label ?? fromId, source_file: fromNode?.source_file ?? undefined });

  const repos = new Set<string>();
  for (const p of path) { const n = getNode(db, p.node_id); if (n?.repo) repos.add(n.repo); }
  const crossRepo = repos.size > 1 ? [...repos].join(" \u2192 ") : undefined;

  return { found: true, from: fromName, to: toName, hops: path.length - 1, path, cross_repo: crossRepo, edge_types_used: edgeTypesUsed };
}

function resolveNodeId(db: Database, name: string): string | null {
  const exact = queryOne(db, "SELECT id FROM nodes WHERE id = ?", [name]);
  if (exact) return exact.id as string;
  const byLabel = queryOne(db, "SELECT id FROM nodes WHERE label = ?", [name]);
  if (byLabel) return byLabel.id as string;
  const fuzzy = fuzzyMatchNode(db, name, 1);
  return fuzzy.length > 0 ? fuzzy[0]!.id : null;
}

interface NodeInfo { id: string; label: string; source_file: string | null; repo: string | null; }

function getNode(db: Database, id: string): NodeInfo | null {
  const row = queryOne(db, "SELECT id, label, source_file, repo FROM nodes WHERE id = ?", [id]);
  if (!row) return null;
  return { id: row.id as string, label: row.label as string, source_file: row.source_file as string | null, repo: row.repo as string | null };
}

/**
 * Format path result as markdown.
 */
export function formatPathMarkdown(
  result: PathResult,
  resolvePath?: (sourceFile: string) => ResolvedPaths,
): string {
  if (!result.found) {
    return [`## Path: ${result.from} \u2192 ${result.to}`, "", "No path found within the configured depth."].join("\n");
  }
  const lines: string[] = [`## Path: ${result.from} \u2192 ${result.to} (${result.hops} hops)`, ""];
  for (let i = 0; i < result.path.length; i++) {
    const step = result.path[i]!;
    lines.push(`${step.label}${step.source_file ? ` (${step.source_file})` : ""}`);
    if (step.source_file) {
      const paths = resolvePath?.(step.source_file);
      if (paths?.graph_rel_path) lines.push(`  Graph path: ${paths.graph_rel_path}`);
      if (paths?.absolute_path) lines.push(`  Absolute path: ${paths.absolute_path}`);
    }
    if (i < result.path.length - 1) {
      const next = result.path[i + 1]!;
      lines.push(`  \u2500\u2500[${next.edge_type ?? "UNKNOWN"}]\u2500\u2500\u25ba`);
    }
  }
  lines.push("");
  if (result.cross_repo) lines.push(`Cross-repo: ${result.cross_repo}`);
  if (result.edge_types_used?.size) {
    lines.push(`Edge types used: ${[...result.edge_types_used.entries()].map(([t, c]) => `${t} (${c})`).join(", ")}`);
  }
  return lines.join("\n");
}
