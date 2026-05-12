/**
 * E2E tests for graph generation.
 *
 * Tests the full pipeline: FileExtraction[] → buildGraph() → graph structure.
 * Covers all file types, edge types, node types, cross-file interactions, and edge cases.
 */
import { describe, it, expect } from "vitest";
import { buildGraph } from "../src/graph/builder.js";
import type { FileExtraction } from "../src/extract/types.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getNodesByType(graph: ReturnType<typeof buildGraph>["graph"], type: string) {
  const nodes: Array<{ id: string; attrs: Record<string, unknown> }> = [];
  graph.forEachNode((id, attrs) => {
    if (attrs.type === type) nodes.push({ id, attrs });
  });
  return nodes;
}

function getEdgesByType(graph: ReturnType<typeof buildGraph>["graph"], type: string) {
  const edges: Array<{ source: string; target: string; attrs: Record<string, unknown> }> = [];
  graph.forEachEdge((_edge, attrs, source, target) => {
    if (attrs.relation === type) edges.push({ source, target, attrs });
  });
  return edges;
}

function findNode(graph: ReturnType<typeof buildGraph>["graph"], label: string) {
  let found: { id: string; attrs: Record<string, unknown> } | null = null;
  graph.forEachNode((id, attrs) => {
    if (attrs.label === label) found = { id, attrs };
  });
  return found;
}

// ─── Python Module Graph ─────────────────────────────────────────────────────

describe("Graph Generation E2E: Python modules", () => {
  const pythonExtraction: FileExtraction = {
    filePath: "src/auth.py",
    language: "python",
    fileNode: { kind: "module" },
    symbols: [
      {
        name: "authenticate",
        qualifiedName: "src/auth.py/authenticate",
        kind: "function",
        decorators: ["login_required"],
        startLine: 5,
        endLine: 20,
        signature: "(request: Request) -> User",
        docstring: "Authenticate incoming request.",
      },
      {
        name: "validate_token",
        qualifiedName: "src/auth.py/validate_token",
        kind: "function",
        decorators: [],
        startLine: 22,
        endLine: 30,
        signature: "(token: str) -> bool",
      },
      {
        name: "TOKEN_EXPIRY",
        qualifiedName: "src/auth.py/TOKEN_EXPIRY",
        kind: "constant",
        decorators: [],
        startLine: 1,
        endLine: 1,
      },
    ],
    imports: [
      { module: "src.models", names: ["User"], isWildcard: false, line: 1 },
    ],
    references: [
      { name: "validate_token", fromSymbol: "src/auth.py/authenticate", kind: "calls", line: 10 },
      { name: "get_user", fromSymbol: "src/auth.py/authenticate", kind: "calls", line: 12 },
    ],
  };

  it("should create a module node for the file", () => {
    const { graph } = buildGraph({ extractions: [pythonExtraction] });
    const modules = getNodesByType(graph, "module");
    expect(modules.length).toBe(1);
    expect(modules[0]!.attrs.source_file).toBe("src/auth.py");
    expect(modules[0]!.attrs.file_type).toBe("code");
  });

  it("should create function nodes with metadata", () => {
    const { graph } = buildGraph({ extractions: [pythonExtraction] });
    const authFn = findNode(graph, "authenticate");
    expect(authFn).not.toBeNull();
    expect(authFn!.attrs.type).toBe("function");
    expect(authFn!.attrs.signature).toBe("(request: Request) -> User");
    expect(authFn!.attrs.docstring).toBe("Authenticate incoming request.");
    expect(authFn!.attrs.start_line).toBe(5);
    expect(authFn!.attrs.end_line).toBe(20);
  });

  it("should create constant nodes", () => {
    const { graph } = buildGraph({ extractions: [pythonExtraction] });
    const constant = findNode(graph, "TOKEN_EXPIRY");
    expect(constant).not.toBeNull();
    expect(constant!.attrs.type).toBe("constant");
  });

  it("should create 'contains' edges from module to all top-level symbols", () => {
    const { graph } = buildGraph({ extractions: [pythonExtraction] });
    const containsEdges = getEdgesByType(graph, "contains");
    // 3 symbols: authenticate, validate_token, TOKEN_EXPIRY
    expect(containsEdges.length).toBe(3);
  });

  it("should create 'calls' edges for same-file function calls", () => {
    const { graph } = buildGraph({ extractions: [pythonExtraction] });
    const callsEdges = getEdgesByType(graph, "calls");
    // authenticate calls validate_token (same file) → resolved
    // authenticate calls get_user (no target) → unresolved
    expect(callsEdges.length).toBeGreaterThanOrEqual(1);
    const authNode = findNode(graph, "authenticate")!;
    const validateNode = findNode(graph, "validate_token")!;
    const hasCall = callsEdges.some(
      (e) => e.source === authNode.id && e.target === validateNode.id,
    );
    expect(hasCall).toBe(true);
  });

  it("should tag all nodes with repo name when provided", () => {
    const { graph } = buildGraph({ extractions: [pythonExtraction], repoName: "my-repo" });
    graph.forEachNode((_id, attrs) => {
      expect(attrs.repo).toBe("my-repo");
    });
  });
});

// ─── Class Hierarchy ─────────────────────────────────────────────────────────

describe("Graph Generation E2E: Class hierarchy & inheritance", () => {
  const classExtraction: FileExtraction = {
    filePath: "models.py",
    language: "python",
    fileNode: { kind: "module" },
    symbols: [
      {
        name: "BaseModel",
        qualifiedName: "models.py/BaseModel",
        kind: "class",
        decorators: [],
        startLine: 1,
        endLine: 10,
        docstring: "Base for all models.",
      },
      {
        name: "User",
        qualifiedName: "models.py/User",
        kind: "class",
        decorators: [],
        startLine: 12,
        endLine: 40,
        bases: ["BaseModel"],
        docstring: "User model.",
      },
      {
        name: "get_name",
        qualifiedName: "models.py/User.get_name",
        kind: "method",
        decorators: [],
        startLine: 15,
        endLine: 17,
        parent: "User",
        signature: "(self) -> str",
      },
      {
        name: "save",
        qualifiedName: "models.py/User.save",
        kind: "method",
        decorators: [],
        startLine: 19,
        endLine: 25,
        parent: "User",
      },
      {
        name: "validate",
        qualifiedName: "models.py/User.validate",
        kind: "method",
        decorators: [],
        startLine: 27,
        endLine: 35,
        parent: "User",
      },
    ],
    imports: [],
    references: [
      { name: "BaseModel", fromSymbol: "models.py/User", kind: "extends", line: 12 },
      { name: "validate", fromSymbol: "models.py/User.save", kind: "calls", line: 20 },
    ],
  };

  it("should create class nodes with bases and docstrings", () => {
    const { graph } = buildGraph({ extractions: [classExtraction] });
    const userNode = findNode(graph, "User");
    expect(userNode).not.toBeNull();
    expect(userNode!.attrs.type).toBe("class");
    expect(userNode!.attrs.bases).toEqual(["BaseModel"]);
    expect(userNode!.attrs.docstring).toBe("User model.");
  });

  it("should create 'extends' edges for inheritance", () => {
    const { graph } = buildGraph({ extractions: [classExtraction] });
    const extendsEdges = getEdgesByType(graph, "extends");
    expect(extendsEdges.length).toBe(1);
    const userNode = findNode(graph, "User")!;
    const baseNode = findNode(graph, "BaseModel")!;
    expect(extendsEdges[0]!.source).toBe(userNode.id);
    expect(extendsEdges[0]!.target).toBe(baseNode.id);
  });

  it("should create 'contains' edges from class to methods (not 'method' edges)", () => {
    const { graph } = buildGraph({ extractions: [classExtraction] });
    // "method" edge type was removed — class→method edges use "contains"
    const methodEdges = getEdgesByType(graph, "method");
    expect(methodEdges.length).toBe(0);
  });

  it("should also create 'contains' edges from module to methods (for discoverability)", () => {
    const { graph } = buildGraph({ extractions: [classExtraction] });
    const containsEdges = getEdgesByType(graph, "contains");
    // module → BaseModel, module → User, module → get_name, module → save, module → validate
    // + User → get_name, User → save, User → validate (class→method)
    expect(containsEdges.length).toBe(8);
  });

  it("should resolve calls between methods in the same class", () => {
    const { graph } = buildGraph({ extractions: [classExtraction] });
    const callsEdges = getEdgesByType(graph, "calls");
    const saveNode = findNode(graph, "save")!;
    const validateNode = findNode(graph, "validate")!;
    const hasCall = callsEdges.some(
      (e) => e.source === saveNode.id && e.target === validateNode.id,
    );
    expect(hasCall).toBe(true);
  });
});

// ─── Cross-File Imports ──────────────────────────────────────────────────────

describe("Graph Generation E2E: Cross-file imports", () => {
  const modelsExtraction: FileExtraction = {
    filePath: "models.py",
    language: "python",
    fileNode: { kind: "module" },
    symbols: [
      {
        name: "User",
        qualifiedName: "models.py/User",
        kind: "class",
        decorators: [],
        startLine: 1,
        endLine: 20,
      },
      {
        name: "Role",
        qualifiedName: "models.py/Role",
        kind: "class",
        decorators: [],
        startLine: 22,
        endLine: 40,
      },
    ],
    imports: [],
    references: [],
  };

  const serviceExtraction: FileExtraction = {
    filePath: "service.py",
    language: "python",
    fileNode: { kind: "module" },
    symbols: [
      {
        name: "create_user",
        qualifiedName: "service.py/create_user",
        kind: "function",
        decorators: [],
        startLine: 5,
        endLine: 15,
      },
    ],
    imports: [
      { module: "models", names: ["User", "Role"], isWildcard: false, line: 1 },
    ],
    references: [
      { name: "User", fromSymbol: "service.py/create_user", kind: "calls", line: 10 },
    ],
  };

  it("should resolve imports_from edges to specific symbols", () => {
    const { graph } = buildGraph({ extractions: [modelsExtraction, serviceExtraction] });
    const importsFromEdges = getEdgesByType(graph, "imports_from");
    expect(importsFromEdges.length).toBeGreaterThanOrEqual(1);
    // service.py module → User class (imports_from)
    const serviceModule = getNodesByType(graph, "module").find(
      (n) => n.attrs.source_file === "service.py",
    )!;
    const userNode = findNode(graph, "User")!;
    const hasImport = importsFromEdges.some(
      (e) => e.source === serviceModule.id && e.target === userNode.id,
    );
    expect(hasImport).toBe(true);
  });

  it("should resolve cross-file calls via imported names", () => {
    const { graph } = buildGraph({ extractions: [modelsExtraction, serviceExtraction] });
    const callsEdges = getEdgesByType(graph, "calls");
    const createUserNode = findNode(graph, "create_user")!;
    const userNode = findNode(graph, "User")!;
    const hasCall = callsEdges.some(
      (e) => e.source === createUserNode.id && e.target === userNode.id,
    );
    expect(hasCall).toBe(true);
  });

  it("should report cross-file edge stats", () => {
    const { stats } = buildGraph({ extractions: [modelsExtraction, serviceExtraction] });
    expect(stats.fileCount).toBe(2);
    expect(stats.crossFileEdges).toBeGreaterThan(0);
  });
});

// ─── Markdown Documents ──────────────────────────────────────────────────────

describe("Graph Generation E2E: Markdown documents", () => {
  const markdownExtraction: FileExtraction = {
    filePath: "docs/architecture.md",
    language: "markdown",
    fileNode: { kind: "document", docstring: "Overview of the system architecture." },
    symbols: [
      {
        name: "Components",
        qualifiedName: "docs.architecture.Components",
        kind: "section",
        decorators: ["h2"],
        startLine: 5,
        endLine: 30,
        parent: "architecture.md",
      },
      {
        name: "Data Flow",
        qualifiedName: "docs.architecture.Data_Flow",
        kind: "section",
        decorators: ["h2"],
        startLine: 32,
        endLine: 60,
        parent: "architecture.md",
      },
    ],
    imports: [],
    references: [
      { name: "ConfigLoader", fromSymbol: "docs.architecture.Components", kind: "references", line: 10 },
    ],
  };

  it("should create document node from fileNode", () => {
    const { graph } = buildGraph({ extractions: [markdownExtraction] });
    const docs = getNodesByType(graph, "document");
    expect(docs.length).toBe(1);
    expect(docs[0]!.attrs.docstring).toBe("Overview of the system architecture.");
    expect(docs[0]!.attrs.file_type).toBe("doc");
  });

  it("should create section nodes", () => {
    const { graph } = buildGraph({ extractions: [markdownExtraction] });
    const sections = getNodesByType(graph, "section");
    expect(sections.length).toBe(2);
    const names = sections.map((s) => s.attrs.label);
    expect(names).toContain("Components");
    expect(names).toContain("Data Flow");
  });

  it("should create contains edges from document to sections", () => {
    const { graph } = buildGraph({ extractions: [markdownExtraction] });
    const containsEdges = getEdgesByType(graph, "contains");
    expect(containsEdges.length).toBe(2);
    const docNode = getNodesByType(graph, "document")[0]!;
    for (const edge of containsEdges) {
      expect(edge.source).toBe(docNode.id);
    }
  });

  it("should set file_type to doc for document nodes and sections", () => {
    const { graph } = buildGraph({ extractions: [markdownExtraction] });
    graph.forEachNode((_id, attrs) => {
      expect(attrs.file_type).toBe("doc");
    });
  });
});

// ─── Diagrams ────────────────────────────────────────────────────────────────

describe("Graph Generation E2E: Diagrams", () => {
  const plantumlExtraction: FileExtraction = {
    filePath: "diagrams/flow.puml",
    language: "diagram",
    fileNode: { kind: "diagram", docstring: "Data flow diagram", tags: ["plantuml"] },
    symbols: [
      {
        name: "InputReader",
        qualifiedName: "diagrams/flow.puml/InputReader",
        kind: "component",
        decorators: [],
        startLine: 3,
        endLine: 3,
      },
      {
        name: "Processor",
        qualifiedName: "diagrams/flow.puml/Processor",
        kind: "component",
        decorators: [],
        startLine: 4,
        endLine: 4,
      },
      {
        name: "IOutput",
        qualifiedName: "diagrams/flow.puml/IOutput",
        kind: "interface",
        decorators: [],
        startLine: 5,
        endLine: 5,
      },
    ],
    imports: [],
    references: [
      { name: "Processor", fromSymbol: "diagrams/flow.puml/InputReader", kind: "references", line: 7 },
      { name: "IOutput", fromSymbol: "diagrams/flow.puml/Processor", kind: "references", line: 8 },
    ],
  };

  it("should create diagram node from fileNode", () => {
    const { graph } = buildGraph({ extractions: [plantumlExtraction] });
    const diagrams = getNodesByType(graph, "diagram");
    expect(diagrams.length).toBe(1);
    expect(diagrams[0]!.attrs.docstring).toBe("Data flow diagram");
    expect(diagrams[0]!.attrs.tags).toContain("plantuml");
    expect(diagrams[0]!.attrs.file_type).toBe("doc");
  });

  it("should create component nodes", () => {
    const { graph } = buildGraph({ extractions: [plantumlExtraction] });
    const components = getNodesByType(graph, "component");
    expect(components.length).toBe(2);
  });

  it("should create interface nodes", () => {
    const { graph } = buildGraph({ extractions: [plantumlExtraction] });
    const interfaces = getNodesByType(graph, "interface");
    expect(interfaces.length).toBe(1);
    expect(interfaces[0]!.attrs.label).toBe("IOutput");
  });

  it("should create contains edges from diagram to components", () => {
    const { graph } = buildGraph({ extractions: [plantumlExtraction] });
    const containsEdges = getEdgesByType(graph, "contains");
    const diagramNode = getNodesByType(graph, "diagram")[0]!;
    const fromDiagram = containsEdges.filter((e) => e.source === diagramNode.id);
    expect(fromDiagram.length).toBe(3); // InputReader, Processor, IOutput
  });

  describe("Binary image diagrams", () => {
    const imageExtraction: FileExtraction = {
      filePath: "images/arch.png",
      language: "diagram",
      fileNode: { kind: "diagram", tags: ["png"] },
      symbols: [],
      imports: [],
      references: [],
    };

    it("should create a diagram node with no children", () => {
      const { graph } = buildGraph({ extractions: [imageExtraction] });
      expect(graph.order).toBe(1);
      const node = getNodesByType(graph, "diagram")[0]!;
      expect(node.attrs.tags).toContain("png");
    });
  });

  describe("SVG diagrams", () => {
    const svgExtraction: FileExtraction = {
      filePath: "docs/flow.svg",
      language: "diagram",
      fileNode: { kind: "diagram", docstring: "Flow Diagram", tags: ["svg"] },
      symbols: [
        {
          name: "AuthModule",
          qualifiedName: "docs/flow.svg/AuthModule",
          kind: "section",
          decorators: [],
          startLine: 1,
          endLine: 1,
        },
      ],
      imports: [],
      references: [],
    };

    it("should create diagram node with SVG tag", () => {
      const { graph } = buildGraph({ extractions: [svgExtraction] });
      const diagrams = getNodesByType(graph, "diagram");
      expect(diagrams.length).toBe(1);
      expect(diagrams[0]!.attrs.tags).toContain("svg");
      expect(diagrams[0]!.attrs.docstring).toBe("Flow Diagram");
    });

    it("should create section nodes from SVG text", () => {
      const { graph } = buildGraph({ extractions: [svgExtraction] });
      const sections = getNodesByType(graph, "section");
      expect(sections.length).toBe(1);
      expect(sections[0]!.attrs.label).toBe("AuthModule");
    });
  });
});

// ─── Mixed File Types ────────────────────────────────────────────────────────

describe("Graph Generation E2E: Mixed file types in one graph", () => {
  const codeFile: FileExtraction = {
    filePath: "src/core.py",
    language: "python",
    fileNode: { kind: "module" },
    symbols: [
      {
        name: "process",
        qualifiedName: "src/core.py/process",
        kind: "function",
        decorators: [],
        startLine: 1,
        endLine: 10,
      },
    ],
    imports: [],
    references: [],
  };

  const docFile: FileExtraction = {
    filePath: "docs/README.md",
    language: "markdown",
    fileNode: { kind: "document", docstring: "Project docs." },
    symbols: [
      {
        name: "Overview",
        qualifiedName: "docs/README.md/Overview",
        kind: "section",
        decorators: ["h1"],
        startLine: 1,
        endLine: 20,
        parent: "README.md",
      },
    ],
    imports: [],
    references: [],
  };

  const diagramFile: FileExtraction = {
    filePath: "diagrams/arch.puml",
    language: "diagram",
    fileNode: { kind: "diagram", tags: ["plantuml"] },
    symbols: [],
    imports: [],
    references: [],
  };

  it("should create distinct node types for each file type", () => {
    const { graph, stats } = buildGraph({
      extractions: [codeFile, docFile, diagramFile],
    });
    expect(stats.fileCount).toBe(3);
    expect(getNodesByType(graph, "module").length).toBe(1);
    expect(getNodesByType(graph, "document").length).toBe(1);
    expect(getNodesByType(graph, "diagram").length).toBe(1);
  });

  it("should set correct file_type based on fileNode kind", () => {
    const { graph } = buildGraph({
      extractions: [codeFile, docFile, diagramFile],
    });
    const module = getNodesByType(graph, "module")[0]!;
    const doc = getNodesByType(graph, "document")[0]!;
    const diagram = getNodesByType(graph, "diagram")[0]!;
    expect(module.attrs.file_type).toBe("code");
    expect(doc.attrs.file_type).toBe("doc");
    expect(diagram.attrs.file_type).toBe("doc");
  });

  it("should handle all extractions independently without interference", () => {
    const { graph } = buildGraph({
      extractions: [codeFile, docFile, diagramFile],
    });
    // Total: 3 file nodes + 1 function + 1 section = 5
    expect(graph.order).toBe(5);
  });
});

// ─── Multi-Repo ──────────────────────────────────────────────────────────────

describe("Graph Generation E2E: Multi-repo", () => {
  const apiFile: FileExtraction = {
    filePath: "api/routes.py",
    language: "python",
    fileNode: { kind: "module" },
    symbols: [
      {
        name: "get_users",
        qualifiedName: "api/routes.py/get_users",
        kind: "function",
        decorators: [],
        startLine: 1,
        endLine: 10,
      },
    ],
    imports: [
      { module: "core.services", names: ["UserService"], isWildcard: false, line: 1 },
    ],
    references: [
      { name: "UserService", fromSymbol: "api/routes.py/get_users", kind: "calls", line: 5 },
    ],
  };

  const coreFile: FileExtraction = {
    filePath: "core/services.py",
    language: "python",
    fileNode: { kind: "module" },
    symbols: [
      {
        name: "UserService",
        qualifiedName: "core/services.py/UserService",
        kind: "class",
        decorators: [],
        startLine: 1,
        endLine: 30,
      },
    ],
    imports: [],
    references: [],
  };

  it("should infer repo names from path prefixes", () => {
    const { graph } = buildGraph({
      extractions: [apiFile, coreFile],
      repoNames: ["api", "core"],
    });
    const apiModule = getNodesByType(graph, "module").find(
      (n) => n.attrs.source_file === "api/routes.py",
    )!;
    const coreModule = getNodesByType(graph, "module").find(
      (n) => n.attrs.source_file === "core/services.py",
    )!;
    expect(apiModule.attrs.repo).toBe("api");
    expect(coreModule.attrs.repo).toBe("core");
  });
});

// ─── Edge Cases ──────────────────────────────────────────────────────────────

describe("Graph Generation E2E: Edge cases", () => {
  it("should handle empty extraction (file with no symbols)", () => {
    const emptyFile: FileExtraction = {
      filePath: "empty.py",
      language: "python",
      fileNode: { kind: "module" },
      symbols: [],
      imports: [],
      references: [],
    };

    const { graph, stats } = buildGraph({ extractions: [emptyFile] });
    expect(graph.order).toBe(1); // Only the module node
    expect(stats.edgeCount).toBe(0);
  });

  it("should handle duplicate symbol names across files", () => {
    const file1: FileExtraction = {
      filePath: "a.py",
      language: "python",
      fileNode: { kind: "module" },
      symbols: [
        {
          name: "helper",
          qualifiedName: "a.py/helper",
          kind: "function",
          decorators: [],
          startLine: 1,
          endLine: 5,
        },
      ],
      imports: [],
      references: [],
    };

    const file2: FileExtraction = {
      filePath: "b.py",
      language: "python",
      fileNode: { kind: "module" },
      symbols: [
        {
          name: "helper",
          qualifiedName: "b.py/helper",
          kind: "function",
          decorators: [],
          startLine: 1,
          endLine: 5,
        },
      ],
      imports: [],
      references: [],
    };

    const { graph } = buildGraph({ extractions: [file1, file2] });
    // 2 module nodes + 2 helper nodes (different IDs due to different filePaths)
    expect(graph.order).toBe(4);
    const functions = getNodesByType(graph, "function");
    expect(functions.length).toBe(2);
  });

  it("should prevent self-loops (function calling itself)", () => {
    const selfCall: FileExtraction = {
      filePath: "recursive.py",
      language: "python",
      fileNode: { kind: "module" },
      symbols: [
        {
          name: "factorial",
          qualifiedName: "recursive.py/factorial",
          kind: "function",
          decorators: [],
          startLine: 1,
          endLine: 5,
        },
      ],
      imports: [],
      references: [
        { name: "factorial", fromSymbol: "recursive.py/factorial", kind: "calls", line: 3 },
      ],
    };

    const { graph } = buildGraph({ extractions: [selfCall] });
    const callsEdges = getEdgesByType(graph, "calls");
    // Self-loop should be prevented by addEdgeSafe
    expect(callsEdges.length).toBe(0);
  });

  it("should handle file with only constants (no functions or classes)", () => {
    const constantsFile: FileExtraction = {
      filePath: "config.py",
      language: "python",
      fileNode: { kind: "module" },
      symbols: [
        {
          name: "DATABASE_URL",
          qualifiedName: "config.py/DATABASE_URL",
          kind: "constant",
          decorators: [],
          startLine: 1,
          endLine: 1,
        },
        {
          name: "API_KEY",
          qualifiedName: "config.py/API_KEY",
          kind: "constant",
          decorators: [],
          startLine: 2,
          endLine: 2,
        },
      ],
      imports: [],
      references: [],
    };

    const { graph } = buildGraph({ extractions: [constantsFile] });
    expect(graph.order).toBe(3); // module + 2 constants
    const containsEdges = getEdgesByType(graph, "contains");
    expect(containsEdges.length).toBe(2);
  });

  it("should handle fileNode with custom label", () => {
    const customLabel: FileExtraction = {
      filePath: "src/very/deep/path/module.py",
      language: "python",
      fileNode: { kind: "module", label: "custom_module" },
      symbols: [],
      imports: [],
      references: [],
    };

    const { graph } = buildGraph({ extractions: [customLabel] });
    const modules = getNodesByType(graph, "module");
    expect(modules[0]!.attrs.label).toBe("custom_module");
  });

  it("should handle fileNode label defaulting to filename", () => {
    const noLabel: FileExtraction = {
      filePath: "src/very/deep/path/module.py",
      language: "python",
      fileNode: { kind: "module" },
      symbols: [],
      imports: [],
      references: [],
    };

    const { graph } = buildGraph({ extractions: [noLabel] });
    const modules = getNodesByType(graph, "module");
    expect(modules[0]!.attrs.label).toBe("module.py");
  });

  it("should handle unresolved parent gracefully (parent not in graph)", () => {
    const orphanMethod: FileExtraction = {
      filePath: "broken.py",
      language: "python",
      fileNode: { kind: "module" },
      symbols: [
        {
          name: "orphan_method",
          qualifiedName: "broken.py/orphan_method",
          kind: "method",
          decorators: [],
          startLine: 1,
          endLine: 5,
          parent: "NonExistentClass",
        },
      ],
      imports: [],
      references: [],
    };

    const { graph } = buildGraph({ extractions: [orphanMethod] });
    // Should fall back to module → method "contains" edge
    const containsEdges = getEdgesByType(graph, "contains");
    expect(containsEdges.length).toBe(1);
    const modules = getNodesByType(graph, "module");
    expect(containsEdges[0]!.source).toBe(modules[0]!.id);
  });

  it("should handle large number of symbols without degeneration", () => {
    const symbols = Array.from({ length: 100 }, (_, i) => ({
      name: `fn_${i}`,
      qualifiedName: `big.py/fn_${i}`,
      kind: "function" as const,
      decorators: [],
      startLine: i * 5 + 1,
      endLine: i * 5 + 4,
    }));
    const references = Array.from({ length: 99 }, (_, i) => ({
      name: `fn_${i}`,
      fromSymbol: `big.py/fn_${i + 1}`,
      kind: "calls" as const,
      line: (i + 1) * 5 + 2,
    }));
    const manySymbols: FileExtraction = {
      filePath: "big.py",
      language: "python",
      fileNode: { kind: "module" },
      symbols,
      imports: [],
      references,
    };

    const { graph, stats } = buildGraph({ extractions: [manySymbols] });
    expect(stats.nodeCount).toBe(101); // 1 module + 100 functions
    // Each function calls the previous one (except fn_0)
    const callsEdges = getEdgesByType(graph, "calls");
    expect(callsEdges.length).toBe(99);
  });

  it("should handle graph with zero extractions", () => {
    const { graph, stats } = buildGraph({ extractions: [] });
    expect(graph.order).toBe(0);
    expect(stats.nodeCount).toBe(0);
    expect(stats.edgeCount).toBe(0);
    expect(stats.fileCount).toBe(0);
  });

  it("should not create duplicate edges between same node pair", () => {
    // Two methods in same class that both call same function
    const dupeEdge: FileExtraction = {
      filePath: "dup.py",
      language: "python",
      fileNode: { kind: "module" },
      symbols: [
        {
          name: "target",
          qualifiedName: "dup.py/target",
          kind: "function",
          decorators: [],
          startLine: 1,
          endLine: 5,
        },
        {
          name: "caller_a",
          qualifiedName: "dup.py/caller_a",
          kind: "function",
          decorators: [],
          startLine: 7,
          endLine: 12,
        },
        {
          name: "caller_b",
          qualifiedName: "dup.py/caller_b",
          kind: "function",
          decorators: [],
          startLine: 14,
          endLine: 19,
        },
      ],
      imports: [],
      references: [
{ name: "target", fromSymbol: "dup.py/caller_a", kind: "calls", line: 9 },
      { name: "target", fromSymbol: "dup.py/caller_b", kind: "calls", line: 16 },
      ],
    };

    const { graph } = buildGraph({ extractions: [dupeEdge] });
    // Graph is non-multi — should not throw
    expect(graph.order).toBe(4); // module + 3 functions
    const callsEdges = getEdgesByType(graph, "calls");
    expect(callsEdges.length).toBe(2); // caller_a→target, caller_b→target
  });

  it("should normalize backslashes in file paths", () => {
    const windowsPath: FileExtraction = {
      filePath: "src\\utils\\helper.py",
      language: "python",
      fileNode: { kind: "module" },
      symbols: [],
      imports: [],
      references: [],
    };

    const { graph } = buildGraph({ extractions: [windowsPath] });
    const modules = getNodesByType(graph, "module");
    expect(modules[0]!.attrs.source_file).toBe("src/utils/helper.py");
  });
});

// ─── Node ID Determinism ─────────────────────────────────────────────────────

describe("Graph Generation E2E: Node ID determinism", () => {
  it("should produce same graph regardless of extraction order", () => {
    const fileA: FileExtraction = {
      filePath: "a.py",
      language: "python",
      fileNode: { kind: "module" },
      symbols: [
        {
          name: "fn_a",
          qualifiedName: "a.py/fn_a",
          kind: "function",
          decorators: [],
          startLine: 1,
          endLine: 5,
        },
      ],
      imports: [{ module: "b", names: ["fn_b"], isWildcard: false, line: 1 }],
      references: [
        { name: "fn_b", fromSymbol: "a.py/fn_a", kind: "calls", line: 3 },
      ],
    };

    const fileB: FileExtraction = {
      filePath: "b.py",
      language: "python",
      fileNode: { kind: "module" },
      symbols: [
        {
          name: "fn_b",
          qualifiedName: "b.py/fn_b",
          kind: "function",
          decorators: [],
          startLine: 1,
          endLine: 5,
        },
      ],
      imports: [],
      references: [],
    };

    const result1 = buildGraph({ extractions: [fileA, fileB] });
    const result2 = buildGraph({ extractions: [fileB, fileA] });

    expect(result1.stats.nodeCount).toBe(result2.stats.nodeCount);
    expect(result1.stats.edgeCount).toBe(result2.stats.edgeCount);

    // Same nodes exist
    const nodes1 = new Set<string>();
    result1.graph.forEachNode((id) => nodes1.add(id));
    const nodes2 = new Set<string>();
    result2.graph.forEachNode((id) => nodes2.add(id));
    expect(nodes1).toEqual(nodes2);
  });
});

// ─── Unified Reference Edge Creation ─────────────────────────────────────────

describe("Graph Generation E2E: Unified reference edge creation", () => {
  it("creates 'references' edge for doc→code call references", () => {
    const doc: FileExtraction = {
      filePath: "docs/guide.md",
      language: "markdown",
      fileNode: { kind: "document", label: "guide.md" },
      symbols: [
        {
          name: "Setup Guide",
          qualifiedName: "docs/guide.md/Setup_Guide",
          kind: "section",
          decorators: [],
          startLine: 1,
          endLine: 20,
        },
      ],
      imports: [],
      references: [
        {
          name: "src/core.py/initialize",
          fromSymbol: "docs/guide.md/Setup_Guide",
          kind: "references",
          line: 5,
        },
      ],
    };

    const code: FileExtraction = {
      filePath: "src/core.py",
      language: "python",
      fileNode: { kind: "module", label: "core.py" },
      symbols: [
        {
          name: "initialize",
          qualifiedName: "src/core.py/initialize",
          kind: "function",
          decorators: [],
          startLine: 1,
          endLine: 10,
        },
      ],
      imports: [],
      references: [],
    };

    const result = buildGraph({ extractions: [doc, code] });
    const refEdges = getEdgesByType(result.graph, "references");
    expect(refEdges.length).toBe(1);
    expect(refEdges[0].source).toBe("docs/guide.md/Setup_Guide");
    expect(refEdges[0].target).toBe("src/core.py/initialize");

    // Must NOT create a "calls" edge — doc references are "references"
    const callEdges = getEdgesByType(result.graph, "calls");
    expect(callEdges.length).toBe(0);
  });

  it("creates 'calls' edge for code→code call references", () => {
    const fileA: FileExtraction = {
      filePath: "src/a.py",
      language: "python",
      fileNode: { kind: "module", label: "a.py" },
      symbols: [
        {
          name: "caller",
          qualifiedName: "src/a.py/caller",
          kind: "function",
          decorators: [],
          startLine: 1,
          endLine: 5,
        },
      ],
      imports: [{ module: "b", names: ["target_fn"], line: 1 }],
      references: [
        {
          name: "target_fn",
          fromSymbol: "src/a.py/caller",
          kind: "calls",
          line: 3,
        },
      ],
    };

    const fileB: FileExtraction = {
      filePath: "src/b.py",
      language: "python",
      fileNode: { kind: "module", label: "b.py" },
      symbols: [
        {
          name: "target_fn",
          qualifiedName: "src/b.py/target_fn",
          kind: "function",
          decorators: [],
          startLine: 1,
          endLine: 5,
        },
      ],
      imports: [],
      references: [],
    };

    const result = buildGraph({ extractions: [fileA, fileB] });
    const callEdges = getEdgesByType(result.graph, "calls");
    expect(callEdges.length).toBe(1);
    expect(callEdges[0].source).toBe("src/a.py/caller");
    expect(callEdges[0].target).toBe("src/b.py/target_fn");

    // Must NOT create a "references" edge — code calls are "calls"
    const refEdges = getEdgesByType(result.graph, "references");
    expect(refEdges.length).toBe(0);
  });

  it("creates 'extends' edge for inheritance references", () => {
    const file: FileExtraction = {
      filePath: "src/models.py",
      language: "python",
      fileNode: { kind: "module", label: "models.py" },
      symbols: [
        {
          name: "BaseModel",
          qualifiedName: "src/models.py/BaseModel",
          kind: "class",
          decorators: [],
          startLine: 1,
          endLine: 10,
        },
        {
          name: "UserModel",
          qualifiedName: "src/models.py/UserModel",
          kind: "class",
          decorators: [],
          startLine: 12,
          endLine: 20,
          bases: ["BaseModel"],
        },
      ],
      imports: [],
      references: [
        {
          name: "BaseModel",
          fromSymbol: "src/models.py/UserModel",
          kind: "extends",
          line: 12,
        },
      ],
    };

    const result = buildGraph({ extractions: [file] });
    const extendsEdges = getEdgesByType(result.graph, "extends");
    expect(extendsEdges.length).toBe(1);
    expect(extendsEdges[0].source).toBe("src/models.py/UserModel");
    expect(extendsEdges[0].target).toBe("src/models.py/BaseModel");
  });

  it("creates 'references' edge for diagram→code references", () => {
    const diagram: FileExtraction = {
      filePath: "diagrams/arch.puml",
      language: "diagrams",
      fileNode: { kind: "diagram", label: "arch.puml" },
      symbols: [
        {
          name: "AuthService",
          qualifiedName: "diagrams/arch.puml/AuthService",
          kind: "component",
          decorators: [],
          startLine: 1,
          endLine: 5,
        },
      ],
      imports: [],
      references: [
        {
          name: "src/auth.py/validate_token",
          fromSymbol: "diagrams/arch.puml/AuthService",
          kind: "references",
          line: 3,
        },
      ],
    };

    const code: FileExtraction = {
      filePath: "src/auth.py",
      language: "python",
      fileNode: { kind: "module", label: "auth.py" },
      symbols: [
        {
          name: "validate_token",
          qualifiedName: "src/auth.py/validate_token",
          kind: "function",
          decorators: [],
          startLine: 1,
          endLine: 10,
        },
      ],
      imports: [],
      references: [],
    };

    const result = buildGraph({ extractions: [diagram, code] });
    const refEdges = getEdgesByType(result.graph, "references");
    expect(refEdges.length).toBe(1);
    expect(refEdges[0].source).toBe("diagrams/arch.puml/AuthService");
    expect(refEdges[0].target).toBe("src/auth.py/validate_token");

    // Diagrams produce "references", never "calls"
    const callEdges = getEdgesByType(result.graph, "calls");
    expect(callEdges.length).toBe(0);
  });

  it("resolves references by direct node ID match", () => {
    const doc: FileExtraction = {
      filePath: "docs/api.md",
      language: "markdown",
      fileNode: { kind: "document", label: "api.md" },
      symbols: [
        {
          name: "API Reference",
          qualifiedName: "docs/api.md/API_Reference",
          kind: "section",
          decorators: [],
          startLine: 1,
          endLine: 10,
        },
      ],
      imports: [],
      references: [
        {
          name: "src/utils.py/format_output",
          fromSymbol: "docs/api.md/API_Reference",
          kind: "references",
          line: 5,
        },
      ],
    };

    const code: FileExtraction = {
      filePath: "src/utils.py",
      language: "python",
      fileNode: { kind: "module", label: "utils.py" },
      symbols: [
        {
          name: "format_output",
          qualifiedName: "src/utils.py/format_output",
          kind: "function",
          decorators: [],
          startLine: 1,
          endLine: 8,
        },
      ],
      imports: [],
      references: [],
    };

    const result = buildGraph({ extractions: [doc, code] });
    const refEdges = getEdgesByType(result.graph, "references");
    expect(refEdges.length).toBe(1);
    expect(refEdges[0].target).toBe("src/utils.py/format_output");
  });

  it("maps type_annotation and attribute_access to 'references' edge", () => {
    const file: FileExtraction = {
      filePath: "src/service.py",
      language: "python",
      fileNode: { kind: "module", label: "service.py" },
      symbols: [
        {
          name: "Config",
          qualifiedName: "src/service.py/Config",
          kind: "class",
          decorators: [],
          startLine: 1,
          endLine: 10,
        },
        {
          name: "run_service",
          qualifiedName: "src/service.py/run_service",
          kind: "function",
          decorators: [],
          startLine: 12,
          endLine: 25,
        },
      ],
      imports: [],
      references: [
        {
          name: "Config",
          fromSymbol: "src/service.py/run_service",
          kind: "references",
          line: 13,
        },
      ],
    };

    const result = buildGraph({ extractions: [file] });
    const refEdges = getEdgesByType(result.graph, "references");
    expect(refEdges.length).toBe(1);
    expect(refEdges[0].source).toBe("src/service.py/run_service");
    expect(refEdges[0].target).toBe("src/service.py/Config");

    // type_annotation produces "references", not "calls"
    const callEdges = getEdgesByType(result.graph, "calls");
    expect(callEdges.length).toBe(0);
  });
});
