import { readFileSync } from "node:fs";
import type { GraphData, GraphNode, GraphEdge, AdjacencyMap, AdjacencyEntry } from "../shared/types.js";
import { DEFAULT_EDGE_WEIGHTS } from "../shared/types.js";
import { log } from "../shared/utils.js";

/**
 * Load graph.json from disk and parse it.
 * Handles multiple graph formats:
 *   - Nodes: { id, label, type, source_file, community, ... }
 *   - Edges: stored as "edges" or "links" with { source, target, type/relation, ... }
 */
export function loadGraphData(graphJsonPath: string): GraphData {
  log.info(`Loading graph from ${graphJsonPath}`);
  const raw = readFileSync(graphJsonPath, "utf-8");
  const data = JSON.parse(raw) as Record<string, unknown>;

  // Parse nodes — map raw fields to our schema
  const rawNodes = (data.nodes ?? []) as Array<Record<string, unknown>>;
  const nodes: GraphNode[] = rawNodes.map((n) => {
    // start_line / end_line: use explicit values or parse from source_location ("L4" or "L4-L20")
    let startLine = n.start_line as number | undefined;
    let endLine = n.end_line as number | undefined;
    if (!startLine) {
      const loc = n.source_location as string | undefined;
      if (loc) {
        const match = loc.match(/L(\d+)(?:-L(\d+))?/);
        if (match) {
          startLine = parseInt(match[1]!, 10);
          endLine = match[2] ? parseInt(match[2], 10) : undefined;
        }
      }
    }

    // properties: use nested object if present, otherwise raw node as bag of properties
    const props = (typeof n.properties === "object" && n.properties !== null)
      ? n.properties as Record<string, unknown>
      : n;

    return {
      id: n.id as string,
      label: (n.label ?? n.id ?? "") as string,
      type: (n.type ?? n.file_type ?? "unknown") as string,
      source_file: n.source_file as string | undefined,
      repo: n.repo as string | undefined,
      community: n.community != null ? String(n.community) : undefined,
      start_line: startLine,
      end_line: endLine,
      properties: props,
    };
  });

  // Parse edges — support both "edges" and "links" arrays, "type" and "relation" fields
  const rawEdges = (data.edges ?? data.links ?? []) as Array<Record<string, unknown>>;
  const edges: GraphEdge[] = rawEdges.map((e) => ({
    source: (e.source ?? e._src ?? e.from ?? "") as string,
    target: (e.target ?? e._tgt ?? e.to ?? "") as string,
    type: (e.type ?? e.relation ?? "UNKNOWN") as string,
    confidence: (e.confidence_score ?? e.confidence_value ?? (typeof e.confidence === "number" ? e.confidence : undefined)) as number | undefined,
    properties: e,
  }));

  log.info(`Loaded graph: ${nodes.length} nodes, ${edges.length} edges`);
  return { nodes, edges };
}

/**
 * Build an adjacency map from the graph edges for BFS/Dijkstra traversal.
 */
export function buildAdjacencyMap(
  edges: GraphEdge[],
  edgeWeights: Record<string, number> = DEFAULT_EDGE_WEIGHTS,
): AdjacencyMap {
  const outgoing = new Map<string, AdjacencyEntry[]>();
  const incoming = new Map<string, AdjacencyEntry[]>();

  for (const edge of edges) {
    const weight = edgeWeights[edge.type] ?? 1.0;

    // Outgoing: source → target
    if (!outgoing.has(edge.source)) {
      outgoing.set(edge.source, []);
    }
    outgoing.get(edge.source)!.push({
      nodeId: edge.target,
      edgeType: edge.type,
      weight,
    });

    // Incoming: target ← source
    if (!incoming.has(edge.target)) {
      incoming.set(edge.target, []);
    }
    incoming.get(edge.target)!.push({
      nodeId: edge.source,
      edgeType: edge.type,
      weight,
    });
  }

  return { outgoing, incoming };
}

/**
 * Build a node lookup map: id → GraphNode.
 */
export function buildNodeMap(nodes: GraphNode[]): Map<string, GraphNode> {
  const map = new Map<string, GraphNode>();
  for (const node of nodes) {
    map.set(node.id, node);
  }
  return map;
}
