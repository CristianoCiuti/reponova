/**
 * Unit tests for all bug fixes implemented in COMMITS 1-5.
 *
 * BUG-005: makeNodeId eliminated → nodeId = symbol.qualifiedName / filePath
 * BUG-006: multi:true graph + addEdgeSafe (parallel different-type edges, no exact duplicates)
 * BUG-007: FileNodeKind = string (open union, custom kinds accepted)
 * BUG-008: SymbolKind = string (open union, custom kinds accepted)
 * BUG-009: "method" edge type removed → class→method uses "contains"
 * BUG-010: contains_section dead code removed (implicit — no API to test)
 * BUG-011: stale comment fixed (implicit — no API to test)
 * NEW-001: DEFAULT_EDGE_WEIGHTS keys normalized to lowercase
 */
import { describe, it, expect } from "vitest";
import { buildGraph } from "../src/graph/builder.js";
import type { FileExtraction } from "../src/extract/types.js";
import { DEFAULT_EDGE_WEIGHTS } from "../src/shared/types.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getEdgesByType(graph: ReturnType<typeof buildGraph>["graph"], type: string) {
  const edges: Array<{ source: string; target: string; attrs: Record<string, unknown> }> = [];
  graph.forEachEdge((_edge, attrs, source, target) => {
    if (attrs.relation === type) edges.push({ source, target, attrs });
  });
  return edges;
}

function getAllEdges(graph: ReturnType<typeof buildGraph>["graph"]) {
  const edges: Array<{ source: string; target: string; type: string }> = [];
  graph.forEachEdge((_edge, attrs, source, target) => {
    edges.push({ source, target, type: attrs.relation as string });
  });
  return edges;
}

// ─── BUG-005: nodeId = qualifiedName ─────────────────────────────────────────

describe("BUG-005: nodeId = qualifiedName (no makeNodeId)", () => {
  it("file node ID is the filePath (forward slashes)", () => {
    const ext: FileExtraction = {
      filePath: "src/utils/helpers.py",
      language: "python",
      fileNode: { kind: "module" },
      symbols: [],
      imports: [],
      references: [],
    };
    const { graph } = buildGraph({ extractions: [ext] });
    expect(graph.hasNode("src/utils/helpers.py")).toBe(true);
  });

  it("symbol node ID is the qualifiedName directly", () => {
    const ext: FileExtraction = {
      filePath: "core/engine.py",
      language: "python",
      fileNode: { kind: "module" },
      symbols: [
        {
          name: "run",
          qualifiedName: "core.engine.run",
          kind: "function",
          decorators: [],
          startLine: 1,
          endLine: 10,
          calls: [],
        },
      ],
      imports: [],
      references: [],
    };
    const { graph } = buildGraph({ extractions: [ext] });
    expect(graph.hasNode("core.engine.run")).toBe(true);
  });

  it("same-name symbols in different files get distinct IDs via qualifiedName", () => {
    const file1: FileExtraction = {
      filePath: "pkg_a/utils.py",
      language: "python",
      fileNode: { kind: "module" },
      symbols: [
        {
          name: "helper",
          qualifiedName: "pkg_a.utils.helper",
          kind: "function",
          decorators: [],
          startLine: 1,
          endLine: 5,
          calls: [],
        },
      ],
      imports: [],
      references: [],
    };
    const file2: FileExtraction = {
      filePath: "pkg_b/utils.py",
      language: "python",
      fileNode: { kind: "module" },
      symbols: [
        {
          name: "helper",
          qualifiedName: "pkg_b.utils.helper",
          kind: "function",
          decorators: [],
          startLine: 1,
          endLine: 5,
          calls: [],
        },
      ],
      imports: [],
      references: [],
    };
    const { graph } = buildGraph({ extractions: [file1, file2] });
    expect(graph.hasNode("pkg_a.utils.helper")).toBe(true);
    expect(graph.hasNode("pkg_b.utils.helper")).toBe(true);
    expect(graph.order).toBe(4); // 2 files + 2 functions
  });

  it("method qualifiedName includes class: moduleName.ClassName.methodName", () => {
    const ext: FileExtraction = {
      filePath: "models.py",
      language: "python",
      fileNode: { kind: "module" },
      symbols: [
        {
          name: "User",
          qualifiedName: "models.User",
          kind: "class",
          decorators: [],
          startLine: 1,
          endLine: 20,
          calls: [],
        },
        {
          name: "save",
          qualifiedName: "models.User.save",
          kind: "method",
          decorators: [],
          startLine: 5,
          endLine: 10,
          parent: "User",
          calls: [],
        },
      ],
      imports: [],
      references: [],
    };
    const { graph } = buildGraph({ extractions: [ext] });
    expect(graph.hasNode("models.User")).toBe(true);
    expect(graph.hasNode("models.User.save")).toBe(true);
  });

  it("backslash paths in filePath are normalized to forward slashes for node IDs", () => {
    const ext: FileExtraction = {
      filePath: "src\\nested\\file.py",
      language: "python",
      fileNode: { kind: "module" },
      symbols: [],
      imports: [],
      references: [],
    };
    const { graph } = buildGraph({ extractions: [ext] });
    expect(graph.hasNode("src/nested/file.py")).toBe(true);
    // The backslash version should NOT exist
    expect(graph.hasNode("src\\nested\\file.py")).toBe(false);
  });
});

// ─── BUG-006: multi:true + addEdgeSafe ───────────────────────────────────────

describe("BUG-006: multi:true graph + addEdgeSafe", () => {
  it("allows parallel edges of different types between same nodes", () => {
    // A module imports a symbol AND contains it (edge case: re-export scenario)
    // We simulate this with: file imports_from symbol + calls symbol
    const models: FileExtraction = {
      filePath: "models.py",
      language: "python",
      fileNode: { kind: "module" },
      symbols: [
        {
          name: "User",
          qualifiedName: "models.User",
          kind: "class",
          decorators: [],
          startLine: 1,
          endLine: 20,
          calls: [],
        },
      ],
      imports: [],
      references: [],
    };

    const consumer: FileExtraction = {
      filePath: "service.py",
      language: "python",
      fileNode: { kind: "module" },
      symbols: [
        {
          name: "create",
          qualifiedName: "service.create",
          kind: "function",
          decorators: [],
          startLine: 1,
          endLine: 10,
          calls: ["User"],
        },
      ],
      imports: [
        { module: "models", names: ["User"], isWildcard: false, line: 1 },
      ],
      references: [],
    };

    const { graph } = buildGraph({ extractions: [models, consumer] });

    // service.py → models.User should have imports_from edge
    const importsFrom = getEdgesByType(graph, "imports_from");
    const hasImportEdge = importsFrom.some(
      (e) => e.source === "service.py" && e.target === "models.User",
    );
    expect(hasImportEdge).toBe(true);

    // service.create → models.User should have calls edge
    const calls = getEdgesByType(graph, "calls");
    const hasCallEdge = calls.some(
      (e) => e.source === "service.create" && e.target === "models.User",
    );
    expect(hasCallEdge).toBe(true);
  });

  it("prevents exact duplicate edges (same source, target, type)", () => {
    // A function that references the same symbol in calls twice
    // should still only produce one edge
    const ext: FileExtraction = {
      filePath: "repeat.py",
      language: "python",
      fileNode: { kind: "module" },
      symbols: [
        {
          name: "target_fn",
          qualifiedName: "repeat.target_fn",
          kind: "function",
          decorators: [],
          startLine: 1,
          endLine: 5,
          calls: [],
        },
        {
          name: "caller",
          qualifiedName: "repeat.caller",
          kind: "function",
          decorators: [],
          startLine: 7,
          endLine: 15,
          calls: ["target_fn"],
        },
      ],
      imports: [],
      references: [],
    };
    const { graph } = buildGraph({ extractions: [ext] });
    const callEdges = getEdgesByType(graph, "calls").filter(
      (e) => e.source === "repeat.caller" && e.target === "repeat.target_fn",
    );
    expect(callEdges.length).toBe(1);
  });

  it("class→method and module→method both get 'contains' edges (two parallel edges)", () => {
    const ext: FileExtraction = {
      filePath: "cls.py",
      language: "python",
      fileNode: { kind: "module" },
      symbols: [
        {
          name: "MyClass",
          qualifiedName: "cls.MyClass",
          kind: "class",
          decorators: [],
          startLine: 1,
          endLine: 20,
          calls: [],
        },
        {
          name: "my_method",
          qualifiedName: "cls.MyClass.my_method",
          kind: "method",
          decorators: [],
          startLine: 3,
          endLine: 10,
          parent: "MyClass",
          calls: [],
        },
      ],
      imports: [],
      references: [],
    };
    const { graph } = buildGraph({ extractions: [ext] });

    // Both class→method and module→method should have "contains" edges
    const containsEdges = getEdgesByType(graph, "contains");
    const classToMethod = containsEdges.some(
      (e) => e.source === "cls.MyClass" && e.target === "cls.MyClass.my_method",
    );
    const moduleToMethod = containsEdges.some(
      (e) => e.source === "cls.py" && e.target === "cls.MyClass.my_method",
    );
    expect(classToMethod).toBe(true);
    expect(moduleToMethod).toBe(true);
  });

  it("self-loops are prevented by addEdgeSafe", () => {
    const ext: FileExtraction = {
      filePath: "loop.py",
      language: "python",
      fileNode: { kind: "module" },
      symbols: [
        {
          name: "recurse",
          qualifiedName: "loop.recurse",
          kind: "function",
          decorators: [],
          startLine: 1,
          endLine: 5,
          calls: ["recurse"],
        },
      ],
      imports: [],
      references: [],
    };
    const { graph } = buildGraph({ extractions: [ext] });
    const callEdges = getEdgesByType(graph, "calls");
    expect(callEdges.length).toBe(0);
  });

  it("edges are skipped when source or target node does not exist", () => {
    // The graph should not throw even if a call references a non-existent node
    const ext: FileExtraction = {
      filePath: "missing.py",
      language: "python",
      fileNode: { kind: "module" },
      symbols: [
        {
          name: "caller",
          qualifiedName: "missing.caller",
          kind: "function",
          decorators: [],
          startLine: 1,
          endLine: 5,
          calls: ["nonexistent_function"],
        },
      ],
      imports: [],
      references: [],
    };
    const { graph } = buildGraph({ extractions: [ext] });
    const callEdges = getEdgesByType(graph, "calls");
    expect(callEdges.length).toBe(0);
  });
});

// ─── BUG-007: FileNodeKind = string (open union) ─────────────────────────────

describe("BUG-007: FileNodeKind = string (open union)", () => {
  it("accepts standard kinds: module, document, diagram", () => {
    const extractions: FileExtraction[] = [
      { filePath: "a.py", language: "python", fileNode: { kind: "module" }, symbols: [], imports: [], references: [] },
      { filePath: "b.md", language: "markdown", fileNode: { kind: "document" }, symbols: [], imports: [], references: [] },
      { filePath: "c.puml", language: "diagram", fileNode: { kind: "diagram" }, symbols: [], imports: [], references: [] },
    ];
    const { graph } = buildGraph({ extractions });
    expect(graph.getNodeAttribute("a.py", "type")).toBe("module");
    expect(graph.getNodeAttribute("b.md", "type")).toBe("document");
    expect(graph.getNodeAttribute("c.puml", "type")).toBe("diagram");
  });

  it("accepts custom/extractor-defined kinds without error", () => {
    const ext: FileExtraction = {
      filePath: "custom.proto",
      language: "protobuf",
      fileNode: { kind: "schema" },
      symbols: [],
      imports: [],
      references: [],
    };
    const { graph } = buildGraph({ extractions: [ext] });
    expect(graph.getNodeAttribute("custom.proto", "type")).toBe("schema");
  });
});

// ─── BUG-008: SymbolKind = string (open union) ──────────────────────────────

describe("BUG-008: SymbolKind = string (open union)", () => {
  it("accepts standard kinds: function, class, method, constant", () => {
    const ext: FileExtraction = {
      filePath: "standard.py",
      language: "python",
      fileNode: { kind: "module" },
      symbols: [
        { name: "fn", qualifiedName: "standard.fn", kind: "function", decorators: [], startLine: 1, endLine: 5, calls: [] },
        { name: "Cls", qualifiedName: "standard.Cls", kind: "class", decorators: [], startLine: 7, endLine: 15, calls: [] },
        { name: "meth", qualifiedName: "standard.Cls.meth", kind: "method", decorators: [], startLine: 9, endLine: 12, parent: "Cls", calls: [] },
        { name: "VAL", qualifiedName: "standard.VAL", kind: "constant", decorators: [], startLine: 17, endLine: 17, calls: [] },
      ],
      imports: [],
      references: [],
    };
    const { graph } = buildGraph({ extractions: [ext] });
    expect(graph.getNodeAttribute("standard.fn", "type")).toBe("function");
    expect(graph.getNodeAttribute("standard.Cls", "type")).toBe("class");
    expect(graph.getNodeAttribute("standard.Cls.meth", "type")).toBe("method");
    expect(graph.getNodeAttribute("standard.VAL", "type")).toBe("constant");
  });

  it("accepts custom/extractor-defined symbol kinds without error", () => {
    const ext: FileExtraction = {
      filePath: "custom.proto",
      language: "protobuf",
      fileNode: { kind: "schema" },
      symbols: [
        { name: "MyMessage", qualifiedName: "custom.MyMessage", kind: "message", decorators: [], startLine: 1, endLine: 10, calls: [] },
        { name: "MyService", qualifiedName: "custom.MyService", kind: "service", decorators: [], startLine: 12, endLine: 20, calls: [] },
        { name: "MyEnum", qualifiedName: "custom.MyEnum", kind: "proto_enum", decorators: [], startLine: 22, endLine: 30, calls: [] },
      ],
      imports: [],
      references: [],
    };
    const { graph } = buildGraph({ extractions: [ext] });
    expect(graph.getNodeAttribute("custom.MyMessage", "type")).toBe("message");
    expect(graph.getNodeAttribute("custom.MyService", "type")).toBe("service");
    expect(graph.getNodeAttribute("custom.MyEnum", "type")).toBe("proto_enum");
  });
});

// ─── BUG-009: "method" edge type eliminated → always "contains" ─────────────

describe("BUG-009: No 'method' edge type — class→method uses 'contains'", () => {
  const classFile: FileExtraction = {
    filePath: "shapes.py",
    language: "python",
    fileNode: { kind: "module" },
    symbols: [
      {
        name: "Shape",
        qualifiedName: "shapes.Shape",
        kind: "class",
        decorators: [],
        startLine: 1,
        endLine: 30,
        calls: [],
      },
      {
        name: "area",
        qualifiedName: "shapes.Shape.area",
        kind: "method",
        decorators: [],
        startLine: 3,
        endLine: 8,
        parent: "Shape",
        calls: [],
      },
      {
        name: "perimeter",
        qualifiedName: "shapes.Shape.perimeter",
        kind: "method",
        decorators: [],
        startLine: 10,
        endLine: 15,
        parent: "Shape",
        calls: [],
      },
    ],
    imports: [],
    references: [],
  };

  it("no edges have type 'method'", () => {
    const { graph } = buildGraph({ extractions: [classFile] });
    const methodEdges = getEdgesByType(graph, "method");
    expect(methodEdges.length).toBe(0);
  });

  it("class→method edges use 'contains' type", () => {
    const { graph } = buildGraph({ extractions: [classFile] });
    const containsEdges = getEdgesByType(graph, "contains");
    const classToArea = containsEdges.some(
      (e) => e.source === "shapes.Shape" && e.target === "shapes.Shape.area",
    );
    const classToPerimeter = containsEdges.some(
      (e) => e.source === "shapes.Shape" && e.target === "shapes.Shape.perimeter",
    );
    expect(classToArea).toBe(true);
    expect(classToPerimeter).toBe(true);
  });

  it("module→method edges also use 'contains' for discoverability", () => {
    const { graph } = buildGraph({ extractions: [classFile] });
    const containsEdges = getEdgesByType(graph, "contains");
    const moduleToArea = containsEdges.some(
      (e) => e.source === "shapes.py" && e.target === "shapes.Shape.area",
    );
    const moduleToPerimeter = containsEdges.some(
      (e) => e.source === "shapes.py" && e.target === "shapes.Shape.perimeter",
    );
    expect(moduleToArea).toBe(true);
    expect(moduleToPerimeter).toBe(true);
  });

  it("only five valid edge types exist in any graph: calls, imports, imports_from, extends, contains", () => {
    const models: FileExtraction = {
      filePath: "models.py",
      language: "python",
      fileNode: { kind: "module" },
      symbols: [
        { name: "Base", qualifiedName: "models.Base", kind: "class", decorators: [], startLine: 1, endLine: 10, calls: [] },
        { name: "Child", qualifiedName: "models.Child", kind: "class", decorators: [], startLine: 12, endLine: 30, calls: [], bases: ["Base"] },
        { name: "do_it", qualifiedName: "models.Child.do_it", kind: "method", decorators: [], startLine: 15, endLine: 20, parent: "Child", calls: [] },
      ],
      imports: [],
      references: [],
    };
    const consumer: FileExtraction = {
      filePath: "app.py",
      language: "python",
      fileNode: { kind: "module" },
      symbols: [
        { name: "main", qualifiedName: "app.main", kind: "function", decorators: [], startLine: 1, endLine: 10, calls: ["Child"] },
      ],
      imports: [
        { module: "models", names: ["Child"], isWildcard: false, line: 1 },
      ],
      references: [],
    };
    const { graph } = buildGraph({ extractions: [models, consumer] });
    const allEdges = getAllEdges(graph);
    const validTypes = new Set(["calls", "imports", "imports_from", "extends", "contains"]);
    for (const edge of allEdges) {
      expect(validTypes.has(edge.type)).toBe(true);
    }
  });
});

// ─── NEW-001: DEFAULT_EDGE_WEIGHTS keys normalized to lowercase ─────────────

describe("NEW-001: DEFAULT_EDGE_WEIGHTS keys are lowercase", () => {
  it("all keys are lowercase", () => {
    for (const key of Object.keys(DEFAULT_EDGE_WEIGHTS)) {
      expect(key).toBe(key.toLowerCase());
    }
  });

  it("contains exactly the 5 expected edge types", () => {
    const keys = Object.keys(DEFAULT_EDGE_WEIGHTS).sort();
    expect(keys).toEqual(["calls", "contains", "extends", "imports", "imports_from"]);
  });

  it("weights are positive numbers", () => {
    for (const [_key, value] of Object.entries(DEFAULT_EDGE_WEIGHTS)) {
      expect(typeof value).toBe("number");
      expect(value).toBeGreaterThan(0);
    }
  });

  it("edge types produced by buildGraph match DEFAULT_EDGE_WEIGHTS keys", () => {
    const ext: FileExtraction = {
      filePath: "check.py",
      language: "python",
      fileNode: { kind: "module" },
      symbols: [
        { name: "fn", qualifiedName: "check.fn", kind: "function", decorators: [], startLine: 1, endLine: 5, calls: [] },
      ],
      imports: [],
      references: [],
    };
    const { graph } = buildGraph({ extractions: [ext] });
    const allEdges = getAllEdges(graph);
    for (const edge of allEdges) {
      expect(edge.type in DEFAULT_EDGE_WEIGHTS).toBe(true);
    }
  });
});

// ─── resolveCall: import-based + same-file only (no simpleNameToIds) ─────────

describe("resolveCall: no global resolution (simpleNameToIds removed)", () => {
  it("resolves same-file calls", () => {
    const ext: FileExtraction = {
      filePath: "local.py",
      language: "python",
      fileNode: { kind: "module" },
      symbols: [
        { name: "helper", qualifiedName: "local.helper", kind: "function", decorators: [], startLine: 1, endLine: 5, calls: [] },
        { name: "main", qualifiedName: "local.main", kind: "function", decorators: [], startLine: 7, endLine: 15, calls: ["helper"] },
      ],
      imports: [],
      references: [],
    };
    const { graph } = buildGraph({ extractions: [ext] });
    const calls = getEdgesByType(graph, "calls");
    expect(calls.some((e) => e.source === "local.main" && e.target === "local.helper")).toBe(true);
  });

  it("resolves cross-file calls via imports", () => {
    const lib: FileExtraction = {
      filePath: "lib.py",
      language: "python",
      fileNode: { kind: "module" },
      symbols: [
        { name: "utility", qualifiedName: "lib.utility", kind: "function", decorators: [], startLine: 1, endLine: 10, calls: [] },
      ],
      imports: [],
      references: [],
    };
    const app: FileExtraction = {
      filePath: "app.py",
      language: "python",
      fileNode: { kind: "module" },
      symbols: [
        { name: "run", qualifiedName: "app.run", kind: "function", decorators: [], startLine: 1, endLine: 10, calls: ["utility"] },
      ],
      imports: [{ module: "lib", names: ["utility"], isWildcard: false, line: 1 }],
      references: [],
    };
    const { graph } = buildGraph({ extractions: [lib, app] });
    const calls = getEdgesByType(graph, "calls");
    expect(calls.some((e) => e.source === "app.run" && e.target === "lib.utility")).toBe(true);
  });

  it("does NOT resolve calls to symbols in other files without import", () => {
    const lib: FileExtraction = {
      filePath: "lib.py",
      language: "python",
      fileNode: { kind: "module" },
      symbols: [
        { name: "unique_fn", qualifiedName: "lib.unique_fn", kind: "function", decorators: [], startLine: 1, endLine: 10, calls: [] },
      ],
      imports: [],
      references: [],
    };
    const app: FileExtraction = {
      filePath: "app.py",
      language: "python",
      fileNode: { kind: "module" },
      symbols: [
        { name: "run", qualifiedName: "app.run", kind: "function", decorators: [], startLine: 1, endLine: 10, calls: ["unique_fn"] },
      ],
      imports: [], // No import! simpleNameToIds would have resolved this, but it's removed
      references: [],
    };
    const { graph } = buildGraph({ extractions: [lib, app] });
    const calls = getEdgesByType(graph, "calls");
    // Should NOT resolve without import
    expect(calls.some((e) => e.source === "app.run" && e.target === "lib.unique_fn")).toBe(false);
  });

  it("resolves self.method calls within same class", () => {
    const ext: FileExtraction = {
      filePath: "cls.py",
      language: "python",
      fileNode: { kind: "module" },
      symbols: [
        { name: "MyClass", qualifiedName: "cls.MyClass", kind: "class", decorators: [], startLine: 1, endLine: 30, calls: [] },
        { name: "process", qualifiedName: "cls.MyClass.process", kind: "method", decorators: [], startLine: 3, endLine: 10, parent: "MyClass", calls: ["self.validate"] },
        { name: "validate", qualifiedName: "cls.MyClass.validate", kind: "method", decorators: [], startLine: 12, endLine: 20, parent: "MyClass", calls: [] },
      ],
      imports: [],
      references: [],
    };
    const { graph } = buildGraph({ extractions: [ext] });
    const calls = getEdgesByType(graph, "calls");
    expect(calls.some((e) => e.source === "cls.MyClass.process" && e.target === "cls.MyClass.validate")).toBe(true);
  });

  it("resolves ClassName.method via import-based resolution", () => {
    const lib: FileExtraction = {
      filePath: "lib.py",
      language: "python",
      fileNode: { kind: "module" },
      symbols: [
        { name: "Service", qualifiedName: "lib.Service", kind: "class", decorators: [], startLine: 1, endLine: 30, calls: [] },
        { name: "start", qualifiedName: "lib.Service.start", kind: "method", decorators: [], startLine: 3, endLine: 10, parent: "Service", calls: [] },
      ],
      imports: [],
      references: [],
    };
    const app: FileExtraction = {
      filePath: "app.py",
      language: "python",
      fileNode: { kind: "module" },
      symbols: [
        { name: "main", qualifiedName: "app.main", kind: "function", decorators: [], startLine: 1, endLine: 10, calls: ["Service.start"] },
      ],
      imports: [{ module: "lib", names: ["Service"], isWildcard: false, line: 1 }],
      references: [],
    };
    const { graph } = buildGraph({ extractions: [lib, app] });
    const calls = getEdgesByType(graph, "calls");
    expect(calls.some((e) => e.source === "app.main" && e.target === "lib.Service.start")).toBe(true);
  });
});

// ─── Graph structural invariants ─────────────────────────────────────────────

describe("Graph structural invariants", () => {
  it("graph is directed", () => {
    const ext: FileExtraction = {
      filePath: "inv.py",
      language: "python",
      fileNode: { kind: "module" },
      symbols: [],
      imports: [],
      references: [],
    };
    const { graph } = buildGraph({ extractions: [ext] });
    expect(graph.type).toBe("directed");
  });

  it("graph is multi (allows parallel edges)", () => {
    const ext: FileExtraction = {
      filePath: "inv.py",
      language: "python",
      fileNode: { kind: "module" },
      symbols: [],
      imports: [],
      references: [],
    };
    const { graph } = buildGraph({ extractions: [ext] });
    expect(graph.multi).toBe(true);
  });

  it("graph does not allow self-loops", () => {
    const ext: FileExtraction = {
      filePath: "inv.py",
      language: "python",
      fileNode: { kind: "module" },
      symbols: [],
      imports: [],
      references: [],
    };
    const { graph } = buildGraph({ extractions: [ext] });
    expect(graph.allowSelfLoops).toBe(false);
  });

  it("every edge has confidence, confidence_score, weight, and relation attributes", () => {
    const ext: FileExtraction = {
      filePath: "attrs.py",
      language: "python",
      fileNode: { kind: "module" },
      symbols: [
        { name: "fn", qualifiedName: "attrs.fn", kind: "function", decorators: [], startLine: 1, endLine: 5, calls: [] },
      ],
      imports: [],
      references: [],
    };
    const { graph } = buildGraph({ extractions: [ext] });
    graph.forEachEdge((_edge, attrs) => {
      expect(attrs.relation).toBeDefined();
      expect(attrs.confidence).toBe("EXTRACTED");
      expect(attrs.confidence_score).toBe(1.0);
      expect(attrs.weight).toBe(1);
    });
  });
});
