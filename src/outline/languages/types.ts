/**
 * Contract for a language-specific outline generator.
 *
 * Each supported language implements this interface, providing:
 * - A tree-sitter extractor (for when the WASM grammar is available)
 * - A regex extractor (fallback, always available)
 * - The WASM filename to look for in grammars/
 */
import type { FileOutline } from "../../shared/types.js";
import type { SyntaxNode } from "../../extract/types.js";

export type { SyntaxNode };

export interface LanguageSupport {
  /** WASM grammar filename (e.g. "tree-sitter-python.wasm") */
  readonly wasmFile: string;

  /**
   * Extract outline from a tree-sitter AST root node.
   *
   * The optional `pluginConfig` argument carries the same merged plugin
   * configuration the pipeline forwards to `LanguageExtractor.extract()` —
   * see the JSDoc of that method for the merge rules. Plugins built
   * against earlier RepoNova versions ignore the extra parameter.
   */
  treeSitterExtract(
    rootNode: SyntaxNode,
    filePath: string,
    lineCount: number,
    pluginConfig?: Readonly<Record<string, unknown>>,
  ): FileOutline;

  /**
   * Extract outline from raw source using regex (no external deps).
   *
   * The optional `pluginConfig` argument follows the same propagation
   * contract as {@link treeSitterExtract}.
   */
  regexExtract(
    filePath: string,
    source: string,
    lineCount: number,
    pluginConfig?: Readonly<Record<string, unknown>>,
  ): FileOutline;
}
