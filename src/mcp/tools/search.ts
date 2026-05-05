import type { Database } from "../../core/db.js";
import { searchNodes } from "../../core/search.js";
import { queryAll } from "../../core/db.js";
import type { PathResolver } from "../../core/path-resolver.js";

export function handleSearch(
  db: Database,
  args: Record<string, unknown>,
  resolvePaths?: PathResolver | null,
) {
  const query = args.query as string;
  if (!query) return { content: [{ type: "text" as const, text: "Error: 'query' is required" }], isError: true };

  const contextDepth = (args.context_depth as number) ?? 0;
  const contextMode = (args.context_mode as string) ?? "bfs";

  const results = searchNodes(db, query, {
    top_k: (args.top_k as number) ?? 10,
    repo: args.repo as string | undefined,
    type: args.type as string | undefined,
  });

  if (results.length === 0) return { content: [{ type: "text" as const, text: `No results for "${query}"` }] };

  const lines = [`## Results for "${query}" (${results.length} matches)`, ""];
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    lines.push(`${i + 1}. [${r.type}] ${r.label}${r.source_file ? ` \u2014 ${r.source_file}` : ""}`);
    if (resolvePaths && r.source_file) {
      const paths = resolvePaths(r.source_file);
      if (paths.graph_rel_path) lines.push(`   Graph path: ${paths.graph_rel_path}`);
      if (paths.absolute_path) lines.push(`   Absolute path: ${paths.absolute_path}`);
    }
    if (r.community) lines.push(`   Community: "${r.community}"`);
  }

  // Context expansion via BFS/DFS from search results
  if (contextDepth > 0 && results.length > 0) {
    const startIds = results.slice(0, 3).map((r) => r.id); // Top 3 as start nodes
    const { visited, edges } = contextMode === "dfs"
      ? traverseDfs(db, startIds, contextDepth)
      : traverseBfs(db, startIds, contextDepth);

    // Remove start nodes from expanded set for cleaner output
    const startSet = new Set(startIds);
    const expanded = [...visited].filter((id) => !startSet.has(id));

    if (expanded.length > 0) {
      lines.push("");
      lines.push(`## Connected context (${contextMode.toUpperCase()}, depth=${contextDepth}) \u2014 ${expanded.length} additional nodes`);
      lines.push("");

      // Group edges by depth for readability
      for (const edge of edges) {
        lines.push(`  ${edge.sourceLabel} \u2500\u2500${edge.type}\u2500\u2500\u25ba ${edge.targetLabel}`);
      }
    }
  }

  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
}

interface TraversalEdge {
  sourceLabel: string;
  targetLabel: string;
  type: string;
}

interface TraversalResult {
  visited: Set<string>;
  edges: TraversalEdge[];
}

/**
 * BFS traversal from start nodes — explores all neighbors at each depth before going deeper.
 */
function traverseBfs(db: Database, startIds: string[], maxDepth: number): TraversalResult {
  const visited = new Set<string>(startIds);
  const edges: TraversalEdge[] = [];
  let frontier = [...startIds];

  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const nextFrontier: string[] = [];
    for (const nodeId of frontier) {
      const neighbors = queryAll(
        db,
        `SELECT e.source_id, e.target_id, e.type, n1.label as src_label, n2.label as tgt_label
         FROM edges e
         JOIN nodes n1 ON n1.id = e.source_id
         JOIN nodes n2 ON n2.id = e.target_id
         WHERE e.source_id = ? OR e.target_id = ?`,
        [nodeId, nodeId],
      );
      for (const row of neighbors) {
        const neighborId = (row.source_id === nodeId ? row.target_id : row.source_id) as string;
        if (!visited.has(neighborId)) {
          visited.add(neighborId);
          nextFrontier.push(neighborId);
          edges.push({
            sourceLabel: row.src_label as string,
            targetLabel: row.tgt_label as string,
            type: row.type as string,
          });
        }
      }
    }
    frontier = nextFrontier;
  }

  return { visited, edges };
}

/**
 * DFS traversal from start nodes — follows one path as deep as possible before backtracking.
 */
function traverseDfs(db: Database, startIds: string[], maxDepth: number): TraversalResult {
  const visited = new Set<string>();
  const edges: TraversalEdge[] = [];
  const stack: Array<{ id: string; depth: number }> = startIds.map((id) => ({ id, depth: 0 })).reverse();

  while (stack.length > 0) {
    const { id: nodeId, depth } = stack.pop()!;
    if (visited.has(nodeId) || depth > maxDepth) continue;
    visited.add(nodeId);

    const neighbors = queryAll(
      db,
      `SELECT e.source_id, e.target_id, e.type, n1.label as src_label, n2.label as tgt_label
       FROM edges e
       JOIN nodes n1 ON n1.id = e.source_id
       JOIN nodes n2 ON n2.id = e.target_id
       WHERE e.source_id = ? OR e.target_id = ?`,
      [nodeId, nodeId],
    );

    for (const row of neighbors) {
      const neighborId = (row.source_id === nodeId ? row.target_id : row.source_id) as string;
      if (!visited.has(neighborId)) {
        stack.push({ id: neighborId, depth: depth + 1 });
        edges.push({
          sourceLabel: row.src_label as string,
          targetLabel: row.tgt_label as string,
          type: row.type as string,
        });
      }
    }
  }

  return { visited, edges };
}
