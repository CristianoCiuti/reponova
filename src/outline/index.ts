/**
 * Outline module — single public API for generating file outlines.
 *
 * Usage:
 *   import { generateOutline } from "../outline/index.js";
 *   const outline = await generateOutline("path/to/file.py", source);
 *
 * Internally resolves:
 *   1. Detect language from file extension
 *   2. If WASM grammar exists → parse with tree-sitter → extract via language module
 *   3. If WASM missing or tree-sitter fails → extract via regex fallback
 *
 * Consumers (CLI, MCP) never deal with parser init or strategy selection.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { detectLanguage, getLanguage } from "./languages/registry.js";
import type { SyntaxNode } from "./languages/types.js";
import type { FileOutline } from "../shared/types.js";
import { log } from "../shared/utils.js";

// Re-export for convenience
export { detectLanguage } from "./languages/registry.js";
export { formatOutlineMarkdown, formatOutlineJson } from "./formatter.js";
export type { FileOutline } from "../shared/types.js";

// ─── Tree-sitter runtime state ─────────────────────────────────────────────────

interface ParserInstance {
  parse(input: string): { rootNode: SyntaxNode };
  setLanguage(lang: unknown): void;
}

/** Cache: language name → initialized parser (or null if WASM not available) */
const parsers = new Map<string, ParserInstance | null>();

/** Whether the tree-sitter WASM runtime has been initialized */
let runtimeReady = false;

/** Resolved path to the grammars/ directory */
const grammarsDir = resolve(
  new URL(".", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1"),
  "../../grammars",
);

// ─── Public API ─────────────────────────────────────────────────────────────────

/**
 * Generate a structured outline for a source file.
 *
 * Automatically detects language, tries tree-sitter, falls back to regex.
 * Returns null if the language is not supported.
 */
export async function generateOutline(filePath: string, source: string): Promise<FileOutline | null> {
  const langName = detectLanguage(filePath);
  if (!langName) return null;

  const lang = getLanguage(langName);
  if (!lang) return null;

  const lineCount = source.split("\n").length;

  // Try tree-sitter
  const parser = await getParser(langName, lang.wasmFile);
  if (parser) {
    try {
      const tree = parser.parse(source);
      return lang.treeSitterExtract(tree.rootNode, filePath, lineCount);
    } catch (err) {
      log.debug(`Tree-sitter parse failed for ${filePath}, using regex: ${err}`);
    }
  }

  // Regex fallback
  return lang.regexExtract(filePath, source, lineCount);
}

// ─── Tree-sitter initialization (lazy, cached) ─────────────────────────────────

async function getParser(langName: string, wasmFile: string): Promise<ParserInstance | null> {
  // Return cached result (including null = not available)
  if (parsers.has(langName)) return parsers.get(langName)!;

  // Check if WASM file exists
  const wasmPath = resolve(grammarsDir, wasmFile);
  if (!existsSync(wasmPath)) {
    log.debug(`Grammar not found: ${wasmPath} — using regex for ${langName}`);
    parsers.set(langName, null);
    return null;
  }

  try {
    // Initialize runtime once
    if (!runtimeReady) {
      const mod = await import("web-tree-sitter");
      const ParserClass = (mod as Record<string, unknown>).Parser ?? (mod as Record<string, unknown>).default;
      if (!ParserClass || typeof ParserClass !== "function") throw new Error("web-tree-sitter: no Parser export");
      if (typeof (ParserClass as Record<string, unknown>).init === "function") {
        await (ParserClass as { init: () => Promise<void> }).init();
      }
      runtimeReady = true;
    }

    // Create parser for this language
    const mod = await import("web-tree-sitter");
    const ParserClass = (mod as Record<string, unknown>).Parser ?? (mod as Record<string, unknown>).default;
    const LanguageClass = (mod as Record<string, unknown>).Language ?? (ParserClass as Record<string, unknown>).Language;

    if (!LanguageClass || typeof (LanguageClass as Record<string, unknown>).load !== "function") {
      throw new Error("web-tree-sitter: no Language.load()");
    }

    const language = await (LanguageClass as { load: (p: string) => Promise<unknown> }).load(wasmPath);
    const parser = new (ParserClass as new () => ParserInstance)();
    parser.setLanguage(language);

    log.info(`Tree-sitter initialized for ${langName} (${wasmFile})`);
    parsers.set(langName, parser);
    return parser;
  } catch (err) {
    log.warn(`Tree-sitter init failed for ${langName}: ${err} — using regex`);
    parsers.set(langName, null);
    return null;
  }
}
