/**
 * Tests for the in-process extraction engine (Phase 0).
 *
 * Tests:
 * - Python extractor (symbols, imports, calls, docstrings)
 * - Shared parser (WASM grammar loading)
 * - Graph builder (nodes, edges, cross-file resolution)
 * - Community detection
 * - JSON export (backward compatibility)
 * - Language registry
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, existsSync, unlinkSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { PythonExtractor } from "../src/extract/languages/python.js";
import { parse, hasGrammar, getGrammarsDir } from "../src/extract/parser.js";
import { buildGraph } from "../src/extract/graph-builder.js";
import { detectCommunities } from "../src/extract/community.js";
import { exportJson } from "../src/extract/export-json.js";
import { resolveImports } from "../src/extract/import-resolver.js";
import { getExtractorForFile, getSupportedExtensions, detectLanguageFromPath } from "../src/extract/languages/registry.js";
import type { FileExtraction } from "../src/extract/types.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const FIXTURES_DIR = resolve(__dirname, "fixtures");
const SAMPLE_MODULE = readFileSync(join(FIXTURES_DIR, "sample_module.py"), "utf-8");
const SAMPLE_CONSUMER = readFileSync(join(FIXTURES_DIR, "sample_consumer.py"), "utf-8");

// ─── Language Registry ───────────────────────────────────────────────────────

describe("Language Registry", () => {
  it("should detect Python from .py extension", () => {
    expect(detectLanguageFromPath("foo/bar.py")).toBe("python");
  });

  it("should detect Python from .pyw extension", () => {
    expect(detectLanguageFromPath("script.pyw")).toBe("python");
  });

  it("should return null for unsupported extensions", () => {
    expect(detectLanguageFromPath("file.rs")).toBeNull();
    expect(detectLanguageFromPath("file.go")).toBeNull();
  });

  it("should return extractor for Python files", () => {
    const ext = getExtractorForFile("module.py");
    expect(ext).not.toBeNull();
    expect(ext!.languageId).toBe("python");
  });

  it("should list supported extensions", () => {
    const exts = getSupportedExtensions();
    expect(exts).toContain(".py");
    expect(exts).toContain(".pyw");
  });
});

// ─── Shared Parser ──────────────────────────────────────────────────────────

describe("Shared Parser", () => {
  it("should find grammars directory", () => {
    const dir = getGrammarsDir();
    expect(existsSync(dir)).toBe(true);
  });

  it("should detect Python grammar exists", () => {
    expect(hasGrammar("tree-sitter-python.wasm")).toBe(true);
  });

  it("should return false for non-existent grammar", () => {
    expect(hasGrammar("tree-sitter-nonexistent.wasm")).toBe(false);
  });

  it("should parse Python source code", async () => {
    const tree = await parse("def hello(): pass", "tree-sitter-python.wasm");
    expect(tree).not.toBeNull();
    expect(tree!.rootNode.type).toBe("module");
    expect(tree!.rootNode.namedChildren.length).toBeGreaterThan(0);
  });

  it("should return null for missing grammar", async () => {
    const tree = await parse("let x = 1", "tree-sitter-nonexistent.wasm");
    expect(tree).toBeNull();
  });
});

// ─── Python Extractor ───────────────────────────────────────────────────────

describe("Python Extractor", () => {
  const extractor = new PythonExtractor();
  let extraction: FileExtraction;

  beforeAll(async () => {
    const tree = await parse(SAMPLE_MODULE, "tree-sitter-python.wasm");
    expect(tree).not.toBeNull();
    extraction = extractor.extract(tree!, SAMPLE_MODULE, "sample_module.py");
  });

  it("should extract the correct language", () => {
    expect(extraction.language).toBe("python");
    expect(extraction.filePath).toBe("sample_module.py");
  });

  // ── Imports ──

  it("should extract import statements", () => {
    expect(extraction.imports.length).toBeGreaterThan(0);
    const osImport = extraction.imports.find((i) => i.module === "os");
    expect(osImport).toBeDefined();
  });

  it("should extract from-import statements", () => {
    const pathImport = extraction.imports.find((i) => i.module === "pathlib");
    expect(pathImport).toBeDefined();
    expect(pathImport!.names).toContain("Path");
  });

  it("should extract typing imports", () => {
    const typingImport = extraction.imports.find((i) => i.module === "typing");
    expect(typingImport).toBeDefined();
    expect(typingImport!.names.length).toBeGreaterThan(0);
  });

  // ── Functions ──

  it("should extract top-level functions", () => {
    const funcs = extraction.symbols.filter((s) => s.kind === "function");
    const names = funcs.map((f) => f.name);
    expect(names).toContain("load_config");
    expect(names).toContain("validate_config");
    expect(names).toContain("read_file");
  });

  it("should extract function signatures", () => {
    const loadConfig = extraction.symbols.find((s) => s.name === "load_config");
    expect(loadConfig).toBeDefined();
    expect(loadConfig!.signature).toContain("path: str");
    expect(loadConfig!.signature).toContain("-> dict");
  });

  it("should extract function docstrings", () => {
    const loadConfig = extraction.symbols.find((s) => s.name === "load_config");
    expect(loadConfig).toBeDefined();
    expect(loadConfig!.docstring).toContain("Load configuration");
  });

  it("should extract function calls", () => {
    const loadConfig = extraction.symbols.find((s) => s.name === "load_config");
    expect(loadConfig).toBeDefined();
    expect(loadConfig!.calls).toContain("validate_config");
  });

  // ── Classes ──

  it("should extract classes", () => {
    const classes = extraction.symbols.filter((s) => s.kind === "class");
    const names = classes.map((c) => c.name);
    expect(names).toContain("BaseProcessor");
    expect(names).toContain("DataProcessor");
  });

  it("should extract base classes", () => {
    const dp = extraction.symbols.find((s) => s.name === "DataProcessor");
    expect(dp).toBeDefined();
    expect(dp!.bases).toContain("BaseProcessor");
  });

  it("should extract class docstrings", () => {
    const bp = extraction.symbols.find((s) => s.name === "BaseProcessor");
    expect(bp).toBeDefined();
    expect(bp!.docstring).toContain("Base class");
  });

  // ── Methods ──

  it("should extract methods", () => {
    const methods = extraction.symbols.filter((s) => s.kind === "method");
    const names = methods.map((m) => m.name);
    expect(names).toContain("__init__");
    expect(names).toContain("process");
    expect(names).toContain("transform");
  });

  it("should associate methods with parent classes", () => {
    const process = extraction.symbols.find(
      (s) => s.name === "process" && s.parent === "BaseProcessor",
    );
    expect(process).toBeDefined();
    expect(process!.kind).toBe("method");
  });

  // ── Constants ──

  it("should extract module-level constants", () => {
    const constants = extraction.symbols.filter((s) => s.kind === "constant");
    const names = constants.map((c) => c.name);
    expect(names).toContain("DEFAULT_CONFIG");
    expect(names).toContain("MAX_RETRIES");
  });

  // ── References ──

  it("should extract call references", () => {
    expect(extraction.references.length).toBeGreaterThan(0);
    const callRefs = extraction.references.filter((r) => r.kind === "call");
    expect(callRefs.length).toBeGreaterThan(0);
  });

  it("should extract inheritance references", () => {
    const inhRefs = extraction.references.filter((r) => r.kind === "inheritance");
    expect(inhRefs.length).toBeGreaterThan(0);
    const dpInheritance = inhRefs.find((r) => r.fromSymbol.includes("DataProcessor"));
    expect(dpInheritance).toBeDefined();
    expect(dpInheritance!.name).toBe("BaseProcessor");
  });

  // ── Import Resolution ──

  it("should resolve relative imports", () => {
    const paths = extractor.resolveImportPath(".utils", "pkg/sub/module.py");
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.some((p) => p.includes("utils.py"))).toBe(true);
  });

  it("should resolve absolute project imports", () => {
    const paths = extractor.resolveImportPath("config.loader", "app/main.py");
    expect(paths).toContain("config/loader.py");
    expect(paths).toContain("config/loader/__init__.py");
  });

  it("should resolve parent-relative imports", () => {
    const paths = extractor.resolveImportPath("..config", "pkg/sub/module.py");
    expect(paths.some((p) => p.includes("config.py") || p.includes("config/__init__"))).toBe(true);
  });
});

// ─── Graph Builder ──────────────────────────────────────────────────────────

describe("Graph Builder", () => {
  let moduleExtraction: FileExtraction;
  let consumerExtraction: FileExtraction;

  beforeAll(async () => {
    const extractor = new PythonExtractor();

    const tree1 = await parse(SAMPLE_MODULE, "tree-sitter-python.wasm");
    expect(tree1).not.toBeNull();
    moduleExtraction = extractor.extract(tree1!, SAMPLE_MODULE, "sample_module.py");

    const tree2 = await parse(SAMPLE_CONSUMER, "tree-sitter-python.wasm");
    expect(tree2).not.toBeNull();
    consumerExtraction = extractor.extract(tree2!, SAMPLE_CONSUMER, "sample_consumer.py");
  });

  it("should build a graph from extractions", () => {
    const { graph, stats } = buildGraph({ extractions: [moduleExtraction] });
    expect(stats.nodeCount).toBeGreaterThan(0);
    expect(stats.edgeCount).toBeGreaterThan(0);
  });

  it("should create module nodes for each file", () => {
    const { graph } = buildGraph({ extractions: [moduleExtraction, consumerExtraction] });
    let moduleCount = 0;
    graph.forEachNode((_node, attrs) => {
      if (attrs.type === "module") moduleCount++;
    });
    expect(moduleCount).toBe(2);
  });

  it("should create symbol nodes", () => {
    const { graph } = buildGraph({ extractions: [moduleExtraction] });
    let functionCount = 0;
    let classCount = 0;
    graph.forEachNode((_node, attrs) => {
      if (attrs.type === "function") functionCount++;
      if (attrs.type === "class") classCount++;
    });
    expect(functionCount).toBeGreaterThan(0);
    expect(classCount).toBeGreaterThan(0);
  });

  it("should create edges between nodes", () => {
    const { graph, stats } = buildGraph({ extractions: [moduleExtraction] });
    expect(stats.edgeCount).toBeGreaterThan(0);

    // Should have contains edges (module → symbol)
    let hasContains = false;
    graph.forEachEdge((_edge, attrs) => {
      if (attrs.relation === "contains") hasContains = true;
    });
    expect(hasContains).toBe(true);
  });

  it("should handle cross-file extractions", () => {
    const { stats } = buildGraph({
      extractions: [moduleExtraction, consumerExtraction],
    });
    expect(stats.fileCount).toBe(2);
  });

  it("should tag nodes with repo name", () => {
    const { graph } = buildGraph({
      extractions: [moduleExtraction],
      repoName: "test-repo",
    });
    graph.forEachNode((_node, attrs) => {
      expect(attrs.repo).toBe("test-repo");
    });
  });
});

// ─── Import Resolution ──────────────────────────────────────────────────────

describe("Import Resolution", () => {
  let moduleExtraction: FileExtraction;
  let consumerExtraction: FileExtraction;

  beforeAll(async () => {
    const extractor = new PythonExtractor();

    const tree1 = await parse(SAMPLE_MODULE, "tree-sitter-python.wasm");
    moduleExtraction = extractor.extract(tree1!, SAMPLE_MODULE, "sample_module.py");

    const tree2 = await parse(SAMPLE_CONSUMER, "tree-sitter-python.wasm");
    consumerExtraction = extractor.extract(tree2!, SAMPLE_CONSUMER, "sample_consumer.py");
  });

  it("should resolve imports between files", () => {
    const resolved = resolveImports([moduleExtraction, consumerExtraction]);
    expect(resolved.length).toBeGreaterThan(0);

    // The consumer imports from sample_module — should resolve
    const sampleModuleImport = resolved.find(
      (r) => r.sourceFile === "sample_consumer.py" && r.declaration.module === "sample_module",
    );
    expect(sampleModuleImport).toBeDefined();
    if (sampleModuleImport) {
      expect(sampleModuleImport.isExternal).toBe(false);
    }
  });

  it("should mark external imports as external", () => {
    const resolved = resolveImports([moduleExtraction]);
    const externalImports = resolved.filter((r) => r.isExternal);
    expect(externalImports.length).toBeGreaterThan(0);
    // 'os', 'sys', 'pathlib', 'typing' are all external
  });
});

// ─── Community Detection ────────────────────────────────────────────────────

describe("Community Detection", () => {
  it("should detect communities in a graph", async () => {
    const extractor = new PythonExtractor();
    const tree = await parse(SAMPLE_MODULE, "tree-sitter-python.wasm");
    const extraction = extractor.extract(tree!, SAMPLE_MODULE, "sample_module.py");
    const { graph } = buildGraph({ extractions: [extraction] });
    const result = detectCommunities(graph);

    expect(result.count).toBeGreaterThan(0);
    expect(result.communities.size).toBeGreaterThan(0);

    // Each node should have a community attribute
    graph.forEachNode((_node, attrs) => {
      expect(attrs.community).toBeDefined();
    });
  });

  it("should handle empty graph", () => {
    const { graph } = buildGraph({ extractions: [] });
    const result = detectCommunities(graph);
    expect(result.count).toBe(0);
  });
});

// ─── JSON Export ────────────────────────────────────────────────────────────

describe("JSON Export", () => {
  it("should produce backward-compatible JSON", async () => {
    const extractor = new PythonExtractor();
    const tree = await parse(SAMPLE_MODULE, "tree-sitter-python.wasm");
    const extraction = extractor.extract(tree!, SAMPLE_MODULE, "sample_module.py");
    const { graph } = buildGraph({ extractions: [extraction] });
    const communities = detectCommunities(graph);

    const tmpPath = join(FIXTURES_DIR, "_test_export.json");
    try {
      exportJson({ graph, communities, outputPath: tmpPath });
      expect(existsSync(tmpPath)).toBe(true);

      const data = JSON.parse(readFileSync(tmpPath, "utf-8"));
      expect(data.nodes).toBeDefined();
      expect(data.edges).toBeDefined();
      expect(Array.isArray(data.nodes)).toBe(true);
      expect(Array.isArray(data.edges)).toBe(true);

      // Check node structure
      const node = data.nodes[0];
      expect(node.id).toBeDefined();
      expect(node.label).toBeDefined();
      expect(typeof node.community).toBe("number");

      // Check edge structure
      if (data.edges.length > 0) {
        const edge = data.edges[0];
        expect(edge.source).toBeDefined();
        expect(edge.target).toBeDefined();
        expect(edge.relation).toBeDefined();
      }

      // Verify the existing graph-loader can read this format
      const { loadGraphData } = await import("../src/core/graph-loader.js");
      const loaded = loadGraphData(tmpPath);
      expect(loaded.nodes.length).toBeGreaterThan(0);
      expect(loaded.edges.length).toBeGreaterThan(0);

      // Verify node fields are mapped correctly
      const loadedNode = loaded.nodes[0]!;
      expect(loadedNode.type).toBeDefined();
      expect(loadedNode.type).not.toBe("unknown");
    } finally {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    }
  });
});
