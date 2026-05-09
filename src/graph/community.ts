/**
 * Community detection via Louvain algorithm (graphology).
 *
 * Wraps graphology-communities-louvain to assign community IDs to graph nodes.
 * Returns community assignments compatible with the existing graph.json format.
 */
import louvain from "graphology-communities-louvain";
import Graph, { UndirectedGraph } from "graphology";

export interface CommunityResult {
  /** community_id (string) → list of node IDs */
  communities: Map<string, string[]>;
  /** Total number of communities detected */
  count: number;
  /** Modularity score */
  modularity: number;
}

/**
 * Run Louvain community detection on the graph.
 * Assigns `community` attribute to each node.
 * Returns community groupings.
 */
export function detectCommunities(graph: Graph): CommunityResult {
  if (graph.order === 0) {
    return { communities: new Map(), count: 0, modularity: 0 };
  }

  // graphology-communities-louvain works on undirected graphs.
  // For directed graphs, we create an undirected copy.
  let workGraph: Graph = graph;
  if (graph.type === "directed" || graph.type === "mixed") {
    const undirected = new UndirectedGraph();
    graph.forEachNode((node, attrs) => {
      undirected.addNode(node, attrs);
    });
    graph.forEachEdge((_edge, _attrs, source, target) => {
      if (!undirected.hasEdge(source, target) && source !== target) {
        try {
          undirected.addEdge(source, target);
        } catch {
          // Ignore duplicate edge errors
        }
      }
    });
    workGraph = undirected;
  }

  // Run Louvain — randomWalk:false ensures deterministic results across builds
  // (same graph → same communities → stable fingerprint cache)
  const assignments = louvain(workGraph, { resolution: 1.0, randomWalk: false });
  let modularity = 0;
  try {
    // louvain.assign mutates the graph and returns modularity
    const result = louvain.assign(workGraph, { resolution: 1.0, randomWalk: false });
    if (typeof result === "number") modularity = result;
  } catch {
    // modularity calculation might fail on some edge cases
  }

  // Collect into communities map (string keys for consistency across pipeline)
  const communities = new Map<string, string[]>();
  for (const [nodeId, communityId] of Object.entries(assignments)) {
    const cid = String(communityId as number);
    const existing = communities.get(cid);
    if (existing) {
      existing.push(nodeId);
    } else {
      communities.set(cid, [nodeId]);
    }

    // Set community attribute on the ORIGINAL directed graph (string)
    if (graph.hasNode(nodeId)) {
      graph.setNodeAttribute(nodeId, "community", cid);
    }
  }

  return {
    communities,
    count: communities.size,
    modularity,
  };
}
