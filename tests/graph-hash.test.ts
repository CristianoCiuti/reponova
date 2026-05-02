import { afterEach, describe, expect, it } from "vitest";
import Graph from "graphology";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { computeSemanticGraphHash, loadPreviousGraphHash, saveGraphHash } from "../src/build/graph-hash.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("PROP-I4: semantic graph hash", () => {
  it("is deterministic regardless of insertion order", () => {
    const graphA = makeGraph();
    const graphB = makeGraph(true);

    expect(computeSemanticGraphHash(graphA)).toBe(computeSemanticGraphHash(graphB));
  });

  it("changes when semantic structure changes", () => {
    const graphA = makeGraph();
    const graphB = makeGraph();
    graphB.addNode("repo_module_new_helper", {
      label: "new_helper",
      type: "function",
      file_type: "code",
      source_file: "repo/module.py",
      repo: "repo",
      signature: "() -> None",
    });

    expect(computeSemanticGraphHash(graphA)).not.toBe(computeSemanticGraphHash(graphB));
  });

  it("stays stable when only line numbers and weights change", () => {
    const graphA = makeGraph();
    const graphB = makeGraph();

    graphB.mergeNodeAttributes("repo_module_helper", {
      start_line: 999,
      end_line: 1001,
      source_location: "L999-L1001",
      community: 42,
    });

    const edgeId = graphB.edge("repo_module", "repo_module_helper");
    graphB.mergeEdgeAttributes(edgeId!, {
      confidence: "INFERRED",
      confidence_score: 0.2,
      weight: 7,
    });

    expect(computeSemanticGraphHash(graphA)).toBe(computeSemanticGraphHash(graphB));
  });

  it("persists and reloads the cached semantic graph hash", () => {
    const outputDir = makeTempDir();
    const hash = "abc123";

    saveGraphHash(outputDir, hash);

    expect(loadPreviousGraphHash(outputDir)).toBe(hash);
  });
});

function makeGraph(reverseInsert = false): Graph {
  const graph = new Graph({ type: "directed", multi: false, allowSelfLoops: false });
  const nodes: Array<[string, Record<string, unknown>]> = [
    ["repo_module", {
      label: "module.py",
      type: "module",
      file_type: "code",
      source_file: "repo/module.py",
      repo: "repo",
      start_line: 1,
      end_line: 200,
      source_location: "L1-L200",
      community: 0,
    }],
    ["repo_module_helper", {
      label: "helper",
      type: "function",
      file_type: "code",
      source_file: "repo/module.py",
      repo: "repo",
      docstring: "Provide helper behavior",
      signature: "(value: str) -> str",
      bases: ["BaseHelper"],
      start_line: 10,
      end_line: 20,
      source_location: "L10-L20",
      community: 0,
    }],
  ];

  const orderedNodes = reverseInsert ? [...nodes].reverse() : nodes;
  for (const [id, attrs] of orderedNodes) {
    graph.addNode(id, attrs);
  }

  graph.addEdge("repo_module", "repo_module_helper", {
    relation: "contains",
    confidence: "EXTRACTED",
    confidence_score: 1,
    weight: 1,
  });

  return graph;
}

function makeTempDir(): string {
  const dir = join(tmpdir(), `rn-test-prop-i4-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}
