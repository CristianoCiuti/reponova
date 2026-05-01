/**
 * Tests for Phase 1: Incremental build, doc support, diagram support
 */
import { describe, it, expect, beforeAll } from "vitest";
import { join } from "node:path";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";

// Incremental build
import {
  hashFile,
  computeHashes,
  loadBuildCache,
  saveBuildCache,
  diffFiles,
  loadCachedExtraction,
} from "../src/build/incremental.js";

// Markdown extractor
import { MarkdownExtractor } from "../src/extract/languages/markdown.js";

// Diagram extractor
import { DiagramExtractor } from "../src/extract/languages/diagrams.js";

// Pipeline
import { detectFiles, detectDocFiles, detectDiagramFiles } from "../src/extract/index.js";

import type { FileExtraction } from "../src/extract/types.js";

// ─── Test Fixtures ───────────────────────────────────────────────────────────

const FIXTURES_DIR = join(import.meta.dirname, "fixtures");
const SAMPLE_DOC = join(FIXTURES_DIR, "sample_doc.md");
const SAMPLE_DIAGRAM = join(FIXTURES_DIR, "sample_diagram.puml");

// ─── Incremental Build Tests ─────────────────────────────────────────────────

describe("Incremental Build", () => {
  const tmpBase = join(tmpdir(), `reponova-test-incr-${Date.now()}`);

  beforeAll(() => {
    mkdirSync(join(tmpBase, "workspace"), { recursive: true });
    writeFileSync(join(tmpBase, "workspace", "file1.py"), "def hello(): pass\n");
    writeFileSync(join(tmpBase, "workspace", "file2.py"), "def world(): pass\n");
    mkdirSync(join(tmpBase, "output"), { recursive: true });
  });

  it("should compute SHA-256 hashes for files", () => {
    const hash = hashFile(join(tmpBase, "workspace", "file1.py"));
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("should compute hashes for multiple files", () => {
    const hashes = computeHashes(join(tmpBase, "workspace"), ["file1.py", "file2.py"]);
    expect(hashes.size).toBe(2);
    expect(hashes.get("file1.py")).toMatch(/^[a-f0-9]{64}$/);
    expect(hashes.get("file2.py")).toMatch(/^[a-f0-9]{64}$/);
    expect(hashes.get("file1.py")).not.toBe(hashes.get("file2.py"));
  });

  it("should return null when no cache exists", () => {
    const cache = loadBuildCache(join(tmpBase, "nonexistent"));
    expect(cache).toBeNull();
  });

  it("should save and load build cache", () => {
    const hashes = new Map([["file1.py", "abc123"], ["file2.py", "def456"]]);
    const extractions: FileExtraction[] = [{
      filePath: "file1.py",
      language: "python",
      symbols: [{ name: "hello", qualifiedName: "file1.py/hello", kind: "function", decorators: [], startLine: 1, endLine: 1, calls: [] }],
      imports: [],
      references: [],
    }];

    saveBuildCache(join(tmpBase, "output"), hashes, extractions);
    const cache = loadBuildCache(join(tmpBase, "output"));
    expect(cache).not.toBeNull();
    expect(cache!.hashes.size).toBe(2);
    expect(cache!.hashes.get("file1.py")).toBe("abc123");
  });

  it("should detect unchanged files from cache", () => {
    const currentHashes = new Map([["file1.py", "abc123"], ["file2.py", "def456"]]);
    const cache = loadBuildCache(join(tmpBase, "output"))!;
    const diff = diffFiles(currentHashes, cache);
    expect(diff.unchangedFiles.length).toBe(1); // file1.py has cached extraction
    expect(diff.changedFiles).toContain("file2.py"); // file2.py has no cached extraction
  });

  it("should detect changed files when hash differs", () => {
    const currentHashes = new Map([["file1.py", "CHANGED"], ["file2.py", "def456"]]);
    const cache = loadBuildCache(join(tmpBase, "output"))!;
    const diff = diffFiles(currentHashes, cache);
    expect(diff.changedFiles).toContain("file1.py");
    expect(diff.changedFiles).toContain("file2.py");
  });

  it("should treat all files as changed when no cache", () => {
    const currentHashes = new Map([["file1.py", "abc"], ["file2.py", "def"]]);
    const diff = diffFiles(currentHashes, null);
    expect(diff.changedFiles.length).toBe(2);
    expect(diff.unchangedFiles.length).toBe(0);
    expect(diff.cachedExtractions.length).toBe(0);
  });
});

// ─── Markdown Extractor Tests ────────────────────────────────────────────────

describe("Markdown Extractor", () => {
  const extractor = new MarkdownExtractor();
  let extraction: FileExtraction;

  beforeAll(() => {
    const { readFileSync } = require("node:fs");
    const source = readFileSync(SAMPLE_DOC, "utf-8");
    extraction = extractor.extract(null, source, "docs/architecture.md");
  });

  it("should set language to markdown", () => {
    expect(extraction.language).toBe("markdown");
  });

  it("should create a document node for the file", () => {
    const doc = extraction.symbols.find((s) => s.kind === "document");
    expect(doc).toBeDefined();
    expect(doc!.name).toBe("architecture.md");
  });

  it("should extract heading sections", () => {
    const sections = extraction.symbols.filter((s) => s.kind === "section");
    expect(sections.length).toBeGreaterThan(0);
    const names = sections.map((s) => s.name);
    expect(names).toContain("Components");
    expect(names).toContain("Data_Flow");
    expect(names).toContain("Configuration");
  });

  it("should extract code references from backtick spans", () => {
    const refs = extraction.references.filter((r) => r.kind === "call");
    const refNames = refs.map((r) => r.name);
    expect(refNames).toContain("ConfigLoader");
    expect(refNames).toContain("DataProcessor");
    expect(refNames).toContain("validate_schema");
    expect(refNames).toContain("transform_data");
  });

  it("should extract file path references", () => {
    const fileRefs = extraction.references.filter((r) => r.kind === "attribute_access");
    const paths = fileRefs.map((r) => r.name);
    expect(paths).toContain("src/input/reader.py");
    expect(paths).toContain("src/output/writer.py");
    expect(paths).toContain("config/settings.py");
  });

  it("should have sections parented to the document", () => {
    const sections = extraction.symbols.filter((s) => s.kind === "section");
    for (const section of sections) {
      expect(section.parent).toBe("architecture.md");
    }
  });

  it("should extract docstring from first paragraph", () => {
    const doc = extraction.symbols.find((s) => s.kind === "document");
    expect(doc!.docstring).toContain("high-level architecture");
  });

  it("should handle extensions correctly", () => {
    expect(extractor.extensions).toContain(".md");
    expect(extractor.extensions).toContain(".txt");
    expect(extractor.extensions).toContain(".rst");
  });

  it("should not require wasmFile", () => {
    expect(extractor.wasmFile).toBeUndefined();
  });
});

// ─── Diagram Extractor Tests ─────────────────────────────────────────────────

describe("Diagram Extractor", () => {
  const extractor = new DiagramExtractor();

  describe("PlantUML", () => {
    let extraction: FileExtraction;

    beforeAll(() => {
      const { readFileSync } = require("node:fs");
      const source = readFileSync(SAMPLE_DIAGRAM, "utf-8");
      extraction = extractor.extract(null, source, "docs/architecture.puml");
    });

    it("should set language to diagram", () => {
      expect(extraction.language).toBe("diagram");
    });

    it("should create a document node for the file", () => {
      const doc = extraction.symbols.find((s) => s.kind === "document");
      expect(doc).toBeDefined();
      expect(doc!.name).toBe("architecture.puml");
      expect(doc!.decorators).toContain("plantuml");
    });

    it("should extract class definitions", () => {
      const classes = extraction.symbols.filter((s) => s.kind === "class");
      const names = classes.map((s) => s.name);
      expect(names).toContain("ConfigLoader");
      expect(names).toContain("DataProcessor");
      expect(names).toContain("FileOutput");
    });

    it("should extract interface definitions", () => {
      const interfaces = extraction.symbols.filter((s) => s.kind === "interface");
      const names = interfaces.map((s) => s.name);
      expect(names).toContain("OutputInterface");
    });

    it("should extract relationships as references", () => {
      expect(extraction.references.length).toBeGreaterThan(0);
      const rels = extraction.references.map((r) => `${r.fromSymbol}->${r.name}`);
      expect(rels).toContain("ConfigLoader->DataProcessor");
      expect(rels).toContain("DataProcessor->OutputInterface");
    });

    it("should extract title as docstring", () => {
      const doc = extraction.symbols.find((s) => s.kind === "document");
      expect(doc!.docstring).toBe("System Architecture");
    });
  });

  describe("Binary Images", () => {
    it("should create metadata node for PNG", () => {
      const extraction = extractor.extract(null, "", "images/diagram.png");
      expect(extraction.symbols.length).toBe(1);
      expect(extraction.symbols[0]!.kind).toBe("document");
      expect(extraction.symbols[0]!.name).toBe("diagram.png");
      expect(extraction.symbols[0]!.decorators).toContain("png");
    });
  });

  describe("SVG", () => {
    it("should extract text elements from SVG", () => {
      const svgSource = `<svg><title>My Diagram</title><text>ConfigLoader</text><text>DataProcessor</text><text>x</text></svg>`;
      const extraction = extractor.extract(null, svgSource, "docs/flow.svg");
      expect(extraction.symbols.length).toBeGreaterThan(1);
      const doc = extraction.symbols.find((s) => s.kind === "document");
      expect(doc!.docstring).toBe("My Diagram");
      // "x" should be filtered (too short)
      const sections = extraction.symbols.filter((s) => s.kind === "section");
      const names = sections.map((s) => s.name);
      expect(names).toContain("ConfigLoader");
      expect(names).toContain("DataProcessor");
    });
  });

  it("should handle extensions correctly", () => {
    expect(extractor.extensions).toContain(".puml");
    expect(extractor.extensions).toContain(".svg");
    expect(extractor.extensions).toContain(".png");
  });

  it("should not require wasmFile", () => {
    expect(extractor.wasmFile).toBeUndefined();
  });
});

// ─── File Detection Tests ────────────────────────────────────────────────────

describe("File Detection", () => {
  const tmpBase = join(tmpdir(), `reponova-test-detect-${Date.now()}`);

  beforeAll(() => {
    // Create test directory structure
    mkdirSync(join(tmpBase, "src"), { recursive: true });
    mkdirSync(join(tmpBase, "docs"), { recursive: true });
    mkdirSync(join(tmpBase, "images"), { recursive: true });
    mkdirSync(join(tmpBase, "node_modules"), { recursive: true });

    writeFileSync(join(tmpBase, "src", "main.py"), "def main(): pass\n");
    writeFileSync(join(tmpBase, "src", "utils.py"), "def helper(): pass\n");
    writeFileSync(join(tmpBase, "docs", "README.md"), "# Hello\n");
    writeFileSync(join(tmpBase, "docs", "guide.txt"), "Guide text\n");
    writeFileSync(join(tmpBase, "images", "flow.puml"), "@startuml\n@enduml\n");
    writeFileSync(join(tmpBase, "images", "arch.svg"), "<svg></svg>\n");
    writeFileSync(join(tmpBase, "node_modules", "pkg.py"), "# should be skipped\n");
  });

  it("should detect only code files", () => {
    const files = detectFiles(tmpBase);
    expect(files).toContain("src/main.py");
    expect(files).toContain("src/utils.py");
    expect(files).not.toContain("docs/README.md");
    expect(files).not.toContain("images/flow.puml");
  });

  it("should detect doc files with config", () => {
    const docs = detectDocFiles(tmpBase, {
      enabled: true,
      patterns: ["**/*.md", "**/*.txt"],
      exclude: [],
      max_file_size_kb: 500,
    });
    expect(docs).toContain("docs/README.md");
    expect(docs).toContain("docs/guide.txt");
    expect(docs).not.toContain("src/main.py");
  });

  it("should return empty when docs disabled", () => {
    const docs = detectDocFiles(tmpBase, {
      enabled: false,
      patterns: ["**/*.md"],
      exclude: [],
      max_file_size_kb: 500,
    });
    expect(docs).toHaveLength(0);
  });

  it("should detect diagram files with config", () => {
    const diagrams = detectDiagramFiles(tmpBase, {
      enabled: true,
      patterns: ["**/*.puml", "**/*.svg"],
      exclude: [],
      parse_puml: true,
      parse_svg_text: true,
    });
    expect(diagrams).toContain("images/flow.puml");
    expect(diagrams).toContain("images/arch.svg");
    expect(diagrams).not.toContain("src/main.py");
  });

  it("should return empty when images disabled", () => {
    const diagrams = detectDiagramFiles(tmpBase, {
      enabled: false,
      patterns: ["**/*.puml"],
      exclude: [],
      parse_puml: true,
      parse_svg_text: true,
    });
    expect(diagrams).toHaveLength(0);
  });

  it("should skip node_modules in all detection modes", () => {
    const code = detectFiles(tmpBase);
    const docs = detectDocFiles(tmpBase, { enabled: true, patterns: ["**/*.md"], exclude: [], max_file_size_kb: 500 });
    const diagrams = detectDiagramFiles(tmpBase, { enabled: true, patterns: ["**/*.puml"], exclude: [], parse_puml: true, parse_svg_text: true });
    
    for (const f of [...code, ...docs, ...diagrams]) {
      expect(f).not.toContain("node_modules");
    }
  });
});
