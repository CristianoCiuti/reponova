/**
 * Contract for a language-specific outline generator.
 *
 * Each supported language implements this interface, providing:
 * - A tree-sitter extractor (for when the WASM grammar is available)
 * - A regex extractor (fallback, always available)
 * - The WASM filename to look for in grammars/
 */
import type { FileOutline } from "../../shared/types.js";

/**
 * AST node interface (subset of web-tree-sitter SyntaxNode).
 * Language extractors receive this from the tree-sitter parser.
 */
export interface SyntaxNode {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  children: SyntaxNode[];
  namedChildren: SyntaxNode[];
  childForFieldName(name: string): SyntaxNode | null;
}

export interface LanguageSupport {
  /** WASM grammar filename (e.g. "tree-sitter-python.wasm") */
  readonly wasmFile: string;

  /** Extract outline from a tree-sitter AST root node. */
  treeSitterExtract(rootNode: SyntaxNode, filePath: string, lineCount: number): FileOutline;

  /** Extract outline from raw source using regex (no external deps). */
  regexExtract(filePath: string, source: string, lineCount: number): FileOutline;
}
