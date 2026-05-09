/**
 * Load a graph JSON file (graph-nodes.json or graph.json) into a live graphology Graph.
 *
 * Inverse of `exportJson`. Required by:
 * - `communities` phase: loads graph-nodes.json for Louvain
 * - `html` phase: loads graph.json for degree calculations
 * - `embeddings` phase: loads graph.json for node data
 * - Any phase that needs in-memory graph operations
 */
import Graph from "graphology";
import { loadGraphData } from "./graph-loader.js";

/**
 * Load a graph JSON file into a graphology directed graph.
 */
export function loadGraphAsGraphology(jsonPath: string): Graph {
  const data = loadGraphData(jsonPath);
  const graph = new Graph({ type: "directed", multi: true, allowSelfLoops: false });

  for (const node of data.nodes) {
    graph.addNode(node.id, {
      label: node.label,
      type: node.type,
      file_type: node.properties?.file_type ?? "code",
      source_file: node.source_file,
      repo: node.repo,
      community: node.community,
      start_line: node.start_line,
      end_line: node.end_line,
      norm_label: node.properties?.norm_label ?? node.label?.toLowerCase(),
      docstring: node.docstring,
      signature: node.signature,
      bases: node.bases,
    });
  }

  for (const edge of data.edges) {
    if (graph.hasNode(edge.source) && graph.hasNode(edge.target)) {
      try {
        graph.addEdge(edge.source, edge.target, {
          relation: edge.type,
          confidence: "EXTRACTED",
          confidence_score: 1.0,
          weight: 1,
        });
      } catch {
        // Ignore duplicate edges
      }
    }
  }

  return graph;
}
