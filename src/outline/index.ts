/**
 * Outline module — single public API for generating file outlines.
 *
 * Usage:
 *   import { generateOutline } from "../outline/index.js";
 *   const outline = await generateOutline("path/to/file.py", source);
 *
 * Internally resolves:
 *   1. Detect language from file extension
 *   2. If WASM grammar exists → parse with tree-sitter (shared parser) → extract via language visitor
 *   3. If WASM missing or tree-sitter fails → extract via regex fallback
 *
 * Consumers (CLI, MCP) never deal with parser init or strategy selection.
 *
 * REFACTORED (Phase 0): Now uses shared parser from src/extract/parser.ts
 * instead of private parser initialization logic. The parser manager is
 * shared with the extraction engine.
 */
import { detectLanguage, getLanguage } from "./languages/registry.js";
import type { FileOutline } from "../shared/types.js";
import { parse } from "../extract/parser.js";
import { log } from "../shared/utils.js";

// Re-export for convenience
export { detectLanguage } from "./languages/registry.js";
export { formatOutlineMarkdown, formatOutlineJson } from "./formatter.js";
export type { FileOutline } from "../shared/types.js";

// ─── Public API ─────────────────────────────────────────────────────────────────

/**
 * Generate a structured outline for a source file.
 *
 * Automatically detects language, tries tree-sitter (via shared parser),
 * falls back to regex. Returns null if the language is not supported.
 */
export async function generateOutline(filePath: string, source: string): Promise<FileOutline | null> {
  const langName = detectLanguage(filePath);
  if (!langName) return null;

  const lang = getLanguage(langName);
  if (!lang) return null;

  const lineCount = source.split("\n").length;

  // Try tree-sitter via shared parser
  const tree = await parse(source, lang.wasmFile);
  if (tree) {
    try {
      return lang.treeSitterExtract(tree.rootNode, filePath, lineCount);
    } catch (err) {
      log.debug(`Tree-sitter extract failed for ${filePath}, using regex: ${err}`);
    }
  }

  // Regex fallback
  return lang.regexExtract(filePath, source, lineCount);
}
