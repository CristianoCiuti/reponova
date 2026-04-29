import { readFileSync } from "node:fs";
import type { GraphData, GraphNode, GraphEdge, AdjacencyMap, AdjacencyEntry } from "../shared/types.js";
import { DEFAULT_EDGE_WEIGHTS } from "../shared/types.js";
import { log } from "../shared/utils.js";

/**
 * Load graph.json from disk and parse it.
 */
export function loadGraphData(graphJsonPath: string): GraphData {
  log.info(`Loading graph from ${graphJsonPath}`);
  const raw = readFileSync(graphJsonPath, "utf-8");
  const data = JSON.parse(raw) as GraphData;

  log.info(`Loaded graph: ${data.nodes.length} nodes, ${data.edges.length} edges`);
  return data;
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
