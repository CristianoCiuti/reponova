/**
 * Core interfaces for the in-process extraction engine.
 *
 * Every language extractor produces FileExtraction objects. The graph builder
 * consumes them to produce a graphology graph. These types are the contract
 * between language-specific extraction and language-agnostic graph building.
 */

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
  /** Extracted symbol nodes */
  symbols: SymbolNode[];
  /** Import/export declarations */
  imports: ImportDeclaration[];
  /** Detected calls/references to other symbols */
  references: SymbolReference[];
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
  /** Symbol names called within this function body */
  calls: string[];
}

export type SymbolKind =
  | "function"
  | "class"
  | "method"
  | "variable"
  | "constant"
  | "interface"
  | "enum"
  | "module"
  | "document"
  | "section";

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
  /** Type of reference */
  kind: "call" | "type_annotation" | "attribute_access" | "inheritance";
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

  /** File extensions this extractor handles (e.g., [".py", ".pyw"]) */
  readonly extensions: string[];

  /**
   * WASM grammar filename (e.g., "tree-sitter-python.wasm").
   * Must exist in grammars/ directory. Shared with outline module.
   */
  readonly wasmFile: string;

  /**
   * Extract symbols, imports, and references from a parsed tree-sitter tree.
   *
   * @param tree - The parsed tree-sitter syntax tree
   * @param sourceCode - The raw source code string
   * @param filePath - Relative file path (for qualified name generation)
   * @returns FileExtraction with all discovered symbols and relationships
   */
  extract(tree: SyntaxTree, sourceCode: string, filePath: string): FileExtraction;

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
