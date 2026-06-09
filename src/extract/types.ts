/**
 * Core interfaces for the in-process extraction engine.
 *
 * Every language extractor produces FileExtraction objects. The graph builder
 * consumes them to produce a graphology graph. These types are the contract
 * between language-specific extraction and language-agnostic graph building.
 */

// ─── File Node Declaration (extractor declares what the file IS) ─────────────

/**
 * Declares the file-level graph node.
 * The extractor produces this — the graph-builder assembles from it mechanically.
 * This eliminates classification logic from the assembler entirely.
 */
export interface FileNodeDeclaration {
  /** The kind of the file node — determines graph node `type` */
  kind: FileNodeKind;
  /** Display label (defaults to filename if omitted) */
  label?: string;
  /** First paragraph or summary of the file */
  docstring?: string;
  /** Tags/decorators attached to the file node (e.g., ["plantuml"], ["svg"]) */
  tags?: string[];
}

/**
 * Valid kinds for file-level nodes.
 * Each maps 1:1 to the graph node `type` attribute.
 * Convention: "module" | "document" | "diagram" | ... any extractor-defined value
 */
export type FileNodeKind = string;

// ─── File Extraction (output of each language extractor) ─────────────────────

/**
 * A raw extraction from a single source file.
 * Every language extractor produces this same shape.
 */
export interface FileExtraction {
  /** Relative file path (normalized with forward slashes) */
  filePath: string;
  /** Language identifier (e.g., "python", "javascript") */
  language: string;
  /**
   * Declares the file-level graph node.
   * The extractor MUST provide this — it tells the graph-builder what kind of
   * node to create for the file itself (module, document, diagram).
   * The graph-builder uses this mechanically — zero classification logic.
   */
  fileNode: FileNodeDeclaration;
  /** Extracted symbol nodes (internal contents only — NOT the file itself) */
  symbols: SymbolNode[];
  /** Import/export declarations */
  imports: ImportDeclaration[];
  /** Detected calls/references to other symbols */
  references: SymbolReference[];
  /**
   * Explicitly exported symbol names, for languages with export semantics.
   * If undefined, all symbols are considered exported.
   * Python: derived from __all__ or public names (no _ prefix)
   */
  exports?: string[];
}

/**
 * A symbol defined in a file (function, class, method, variable).
 */
export interface SymbolNode {
  /** Simple name: "ClassName" or "method_name" */
  name: string;
  /** Qualified name with module path, used for graph node ID generation */
  qualifiedName: string;
  /** Symbol kind */
  kind: SymbolKind;
  /** Function/method signature (if applicable) */
  signature?: string;
  /** Decorators/annotations */
  decorators: string[];
  /** First line of docstring (if present) */
  docstring?: string;
  /** Start line (1-indexed) */
  startLine: number;
  /** End line (1-indexed) */
  endLine: number;
  /** Parent symbol name (e.g., class name for methods) */
  parent?: string;
  /** Base classes (for class nodes) */
  bases?: string[];
}

/**
 * Convention: "function" | "class" | "method" | "variable" | "constant"
 * | "interface" | "enum" | "module" | "document" | "diagram"
 * | "section" | "component" | ... any extractor-defined value
 */
export type SymbolKind = string;

/**
 * An import/export declaration.
 */
export interface ImportDeclaration {
  /** The module being imported from (e.g., "os.path", "./utils", "lodash") */
  module: string;
  /** Specific names imported (e.g., ["join", "dirname"]) */
  names: string[];
  /** Whether this is a wildcard import (from x import *) */
  isWildcard: boolean;
  /** Whether this is a re-export */
  isExport?: boolean;
  /** Line number (1-indexed) */
  line: number;
}

/**
 * A reference to another symbol (function call, type annotation, etc.)
 */
export interface SymbolReference {
  /** Name of the symbol being referenced */
  name: string;
  /** Context: which symbol contains this reference */
  fromSymbol: string;
  /** Edge type to create in the graph — extractor decides, builder uses as-is */
  kind: "calls" | "extends" | "references";
  /** Line number (1-indexed) */
  line: number;
}

// ─── Language Extractor Interface ────────────────────────────────────────────

/**
 * THE CORE INTERFACE that every language extractor must implement.
 *
 * To add a new language:
 * 1. Create src/extract/languages/<lang>.ts
 * 2. Implement this interface
 * 3. Register in src/extract/languages/registry.ts
 *
 * That's it. Everything else (graph building, import resolution,
 * community detection) works automatically.
 */
export interface LanguageExtractor {
  /** Language identifier (must match tree-sitter grammar name) */
  readonly languageId: string;

  /**
   * WASM grammar filename (e.g., "tree-sitter-python.wasm").
   * If provided, the pipeline parses with tree-sitter and passes the AST.
   * If omitted/empty, the extractor receives a null tree and uses sourceCode directly.
   */
  readonly wasmFile?: string;

  /**
   * Extract symbols, imports, and references from a source file.
   *
   * @param tree - The parsed tree-sitter syntax tree (null if no wasmFile)
   * @param sourceCode - The raw source code string
   * @param filePath - Relative file path (for qualified name generation)
   * @param pluginConfig - Effective plugin configuration for this call.
   *   The pipeline merges the plugin's declared `LanguagePlugin.configDefaults`
   *   with the user's `config.plugins[pluginId]` (from `reponova.yml`), strips
   *   the loader-reserved fields (`package`, `enabled`, `patterns`, `exclude`),
   *   and passes the result. The parameter is optional so plugins built
   *   against earlier RepoNova versions keep working — when omitted, the
   *   extractor should fall back to its own defaults.
   * @returns FileExtraction with all discovered symbols and relationships
   */
  extract(
    tree: SyntaxTree | null,
    sourceCode: string,
    filePath: string,
    pluginConfig?: Readonly<Record<string, unknown>>,
  ): FileExtraction;

  /**
   * Resolve an import module path to candidate relative file paths.
   *
   * Given an import like `from config.loader import X`, resolve it to
   * file paths like `config/loader.py` that can be matched against
   * other extracted files.
   *
   * @param importModule - The module path from the import declaration
   * @param currentFilePath - Path of the file containing the import
   * @returns Resolved relative file path candidates, or empty array if external
   */
  resolveImportPath(importModule: string, currentFilePath: string): string[];
}

// ─── Tree-sitter Types (WASM interface) ──────────────────────────────────────

/**
 * Tree-sitter syntax tree (web-tree-sitter WASM interface).
 * This is the SAME interface already used by the outline module.
 */
export interface SyntaxTree {
  rootNode: SyntaxNode;
}

export interface SyntaxNode {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  children: SyntaxNode[];
  childCount: number;
  namedChildren: SyntaxNode[];
  namedChildCount: number;
  parent: SyntaxNode | null;
  childForFieldName(name: string): SyntaxNode | null;
  childrenForFieldName(name: string): SyntaxNode[];
  descendantsOfType(type: string | string[]): SyntaxNode[];
}
