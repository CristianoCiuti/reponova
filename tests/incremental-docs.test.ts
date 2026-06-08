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
} from "../src/shared/hash.js";
import {
  loadBuildCache,
  saveBuildCache,
  diffFiles,
  loadCachedExtraction,
} from "../src/pipeline/cache.js";

// Markdown extractor
import { MarkdownExtractor } from "../src/extract/languages/markdown.js";

// Diagram extractors (from plugins)
import { PlantUmlExtractor } from "@reponova/lang-plantuml";
import { SvgExtractor } from "@reponova/lang-svg";

// Routing — the single source of truth for which extractor handles a file is
// the registry, populated from each plugin's manifest (`reponova.extensions[]`).
// Extractor classes themselves no longer carry an `extensions` field.
import { getExtractorForFile } from "../src/extract/languages/registry.js";

// Pipeline
import { detectAllFiles, type RegisteredFileType } from "../src/extract/index.js";
import { DEFAULT_CONFIG } from "../src/shared/types.js";
import type { Config } from "../src/shared/types.js";

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
      fileNode: { kind: "module" },
      symbols: [{ name: "hello", qualifiedName: "file1.py/hello", kind: "function", decorators: [], startLine: 1, endLine: 1 }],
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
    // In new architecture, document info is in fileNode, not symbols[]
    expect(extraction.fileNode).toBeDefined();
    expect(extraction.fileNode.kind).toBe("document");
  });

  it("should extract heading sections", () => {
    const sections = extraction.symbols.filter((s) => s.kind === "section");
    expect(sections.length).toBeGreaterThan(0);
    const names = sections.map((s) => s.name);
    expect(names).toContain("Components");
    expect(names).toContain("Data Flow");
    expect(names).toContain("Configuration");
  });

  it("should extract code references from backtick spans", () => {
    const refs = extraction.references.filter((r) => r.kind === "references");
    const refNames = refs.map((r) => r.name);
    expect(refNames).toContain("ConfigLoader");
    expect(refNames).toContain("DataProcessor");
    expect(refNames).toContain("validate_schema");
    expect(refNames).toContain("transform_data");
  });

  it("should extract file path references", () => {
    const fileRefs = extraction.references.filter((r) => r.kind === "references");
    const paths = fileRefs.map((r) => r.name);
    expect(paths).toContain("src/input/reader.py");
    expect(paths).toContain("src/output/writer.py");
    expect(paths).toContain("config/settings.py");
  });

  it("should have sections parented to the document", () => {
    const sections = extraction.symbols.filter((s) => s.kind === "section");
    // In new architecture, sections parent to the filename (fileNode label)
    for (const section of sections) {
      expect(section.parent).toBe("architecture.md");
    }
  });

  it("should extract docstring from first paragraph", () => {
    // In new architecture, file docstring is in fileNode
    expect(extraction.fileNode.docstring).toContain("high-level architecture");
  });

  it("routes its extensions via the registry", () => {
    // The registry is built from the built-in markdown extractor — the
    // extractor class itself no longer carries an `extensions` field.
    // We assert by `languageId` because the registry holds its own singleton
    // instance, distinct from the one constructed locally in this test.
    expect(getExtractorForFile("foo.md")?.languageId).toBe("markdown");
    expect(getExtractorForFile("foo.txt")?.languageId).toBe("markdown");
    expect(getExtractorForFile("foo.rst")?.languageId).toBe("markdown");
  });

  it("should not require wasmFile", () => {
    expect(extractor.wasmFile).toBeUndefined();
  });
});

// ─── Diagram Extractor Tests ─────────────────────────────────────────────────

describe("PlantUML Extractor", () => {
  const extractor = new PlantUmlExtractor();

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
      expect(extraction.fileNode).toBeDefined();
      expect(extraction.fileNode.kind).toBe("diagram");
      expect(extraction.fileNode.tags).toContain("plantuml");
    });

    it("should extract class definitions", () => {
      const components = extraction.symbols.filter((s) => s.kind === "component");
      const names = components.map((s) => s.name);
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
      expect(rels).toContain("docs.architecture.ConfigLoader->DataProcessor");
      expect(rels).toContain("docs.architecture.DataProcessor->OutputInterface");
    });

    it("should extract title as docstring", () => {
      expect(extraction.fileNode.docstring).toBe("System Architecture");
    });
  });

  it("routes its extensions via the registry", () => {
    const plantuml = getExtractorForFile("foo.puml");
    expect(plantuml).toBeTruthy();
    expect(plantuml?.languageId).toBe("plantuml");
    expect(getExtractorForFile("foo.plantuml")?.languageId).toBe("plantuml");
  });

  it("should not require wasmFile", () => {
    expect(extractor.wasmFile).toBeUndefined();
  });
});

describe("SVG Extractor", () => {
  const extractor = new SvgExtractor();

  it("should extract text elements from SVG", () => {
    const svgSource = `<svg><title>My Diagram</title><text>ConfigLoader</text><text>DataProcessor</text><text>x</text></svg>`;
    const extraction = extractor.extract(null, svgSource, "docs/flow.svg");
    expect(extraction.fileNode.docstring).toBe("My Diagram");
    const sections = extraction.symbols.filter((s) => s.kind === "section");
    const names = sections.map((s) => s.name);
    expect(names).toContain("ConfigLoader");
    expect(names).toContain("DataProcessor");
  });

  it("routes its extensions via the registry", () => {
    const svg = getExtractorForFile("foo.svg");
    expect(svg).toBeTruthy();
    expect(svg?.languageId).toBe("svg");
  });

  it("should not require wasmFile", () => {
    expect(extractor.wasmFile).toBeUndefined();
  });
});

// ─── File Detection Tests ────────────────────────────────────────────────────

describe("File Detection", () => {
  const tmpBase = join(tmpdir(), `reponova-test-detect-${Date.now()}`);

  const PYTHON_TYPE: RegisteredFileType = {
    id: "python",
    extensions: new Set([".py", ".pyw"]),
    enabled: true,
    patterns: [],
    exclude: [],
  };

  const DOC_TYPE: RegisteredFileType = {
    id: "document",
    extensions: new Set([".md", ".txt", ".rst"]),
    enabled: true,
    patterns: [],
    exclude: [],
    maxFileSizeKb: 500,
  };

  const PLANTUML_TYPE: RegisteredFileType = {
    id: "plantuml",
    extensions: new Set([".puml", ".plantuml"]),
    enabled: true,
    patterns: [],
    exclude: [],
  };

  const SVG_TYPE: RegisteredFileType = {
    id: "svg",
    extensions: new Set([".svg"]),
    enabled: true,
    patterns: [],
    exclude: [],
  };

  function makeConfig(overrides: Partial<Config> = {}): Config {
    return { ...DEFAULT_CONFIG, ...overrides };
  }

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
    const config = makeConfig();
    const result = detectAllFiles(tmpBase, config, [PYTHON_TYPE, DOC_TYPE, PLANTUML_TYPE, SVG_TYPE]);
    const pythonFiles = result["python"] ?? [];
    expect(pythonFiles).toContain("src/main.py");
    expect(pythonFiles).toContain("src/utils.py");
    expect(pythonFiles).not.toContain("docs/README.md");
    expect(pythonFiles).not.toContain("images/flow.puml");
  });

  it("should detect doc files with config", () => {
    const config = makeConfig();
    const types: RegisteredFileType[] = [{ ...DOC_TYPE, patterns: ["**/*.md", "**/*.txt"] }];
    const result = detectAllFiles(tmpBase, config, types);
    const docs = result["document"] ?? [];
    expect(docs).toContain("docs/README.md");
    expect(docs).toContain("docs/guide.txt");
    expect(docs).not.toContain("src/main.py");
  });

  it("should return empty when docs disabled", () => {
    const config = makeConfig();
    const types: RegisteredFileType[] = [{ ...DOC_TYPE, enabled: false }];
    const result = detectAllFiles(tmpBase, config, types);
    const docs = result["document"] ?? [];
    expect(docs).toHaveLength(0);
  });

  it("should detect diagram files with config", () => {
    const config = makeConfig();
    const types: RegisteredFileType[] = [
      { ...PLANTUML_TYPE, patterns: ["**/*.puml"] },
      { ...SVG_TYPE, patterns: ["**/*.svg"] },
    ];
    const result = detectAllFiles(tmpBase, config, types);
    expect(result["plantuml"] ?? []).toContain("images/flow.puml");
    expect(result["svg"] ?? []).toContain("images/arch.svg");
  });

  it("should return empty when images disabled", () => {
    const config = makeConfig();
    const types: RegisteredFileType[] = [{ ...PLANTUML_TYPE, enabled: false }];
    const result = detectAllFiles(tmpBase, config, types);
    const puml = result["plantuml"] ?? [];
    expect(puml).toHaveLength(0);
  });

  it("should skip node_modules in all detection modes", () => {
    const config = makeConfig();
    const result = detectAllFiles(tmpBase, config, [PYTHON_TYPE, DOC_TYPE, PLANTUML_TYPE]);
    const allFiles = Object.values(result).flat();
    for (const f of allFiles) {
      expect(f).not.toContain("node_modules");
    }
  });

  it("should skip output dir when its basename is in skipDirs", () => {
    // Simulate a reponova-out/ directory with generated files that have doc extensions
    const outDir = join(tmpBase, "reponova-out");
    const cacheDir = join(outDir, ".cache");
    mkdirSync(outDir, { recursive: true });
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(outDir, "report.md"), "# Build Report\n");
    writeFileSync(join(cacheDir, "semantic-graph-hash.txt"), "abc123\n");

    const config = makeConfig();

    // Without skipDirs containing "reponova-out", the generated files are detected
    const resultNoSkip = detectAllFiles(tmpBase, config, [DOC_TYPE], new Set());
    const docsNoSkip = resultNoSkip["document"] ?? [];
    expect(docsNoSkip).toContain("reponova-out/report.md");

    // With output dir basename in skipDirs (as orchestrator does), generated files are skipped
    const skipDirs = new Set(["node_modules", "__pycache__", "reponova-out"]);
    const resultWithSkip = detectAllFiles(tmpBase, config, [DOC_TYPE], skipDirs);
    const docsWithSkip = resultWithSkip["document"] ?? [];
    expect(docsWithSkip).not.toContain("reponova-out/report.md");
    // Real doc files are still detected
    expect(docsWithSkip).toContain("docs/README.md");
    expect(docsWithSkip).toContain("docs/guide.txt");
  });
});
