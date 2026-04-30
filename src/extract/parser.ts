/**
 * Shared WASM parser manager.
 *
 * Single point of tree-sitter initialization, used by BOTH the extraction
 * engine and the outline module. Replaces the private parser logic that
 * was previously in src/outline/index.ts.
 *
 * Responsibilities:
 * - Load web-tree-sitter runtime (once, lazily)
 * - Load WASM grammar files from grammars/ directory (per-language, cached)
 * - Provide parse(source, wasmFile) → SyntaxTree
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { SyntaxTree, SyntaxNode } from "./types.js";
import { log } from "../shared/utils.js";

// ─── Internal State ──────────────────────────────────────────────────────────

interface ParserInstance {
  parse(input: string): { rootNode: SyntaxNode };
  setLanguage(lang: unknown): void;
}

/** Cache: wasmFile → initialized parser (or null if not available) */
const parsers = new Map<string, ParserInstance | null>();

/** Whether the tree-sitter WASM runtime has been initialized */
let runtimeReady = false;

/** The tree-sitter Parser class (loaded once) */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let ParserClass: any = null;

/** The tree-sitter Language class (loaded once) */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let LanguageClass: any = null;

// ─── Grammars Directory ──────────────────────────────────────────────────────

/** Resolved path to the grammars/ directory */
const grammarsDir = resolve(
  new URL(".", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1"),
  "../../grammars",
);

/** Get the resolved grammars directory path */
export function getGrammarsDir(): string {
  return grammarsDir;
}

/** Check if a grammar WASM file exists in grammars/ */
export function hasGrammar(wasmFile: string): boolean {
  return existsSync(resolve(grammarsDir, wasmFile));
}

// ─── Runtime Init ────────────────────────────────────────────────────────────

async function ensureRuntime(): Promise<boolean> {
  if (runtimeReady) return true;

  try {
    const mod = await import("web-tree-sitter");
    ParserClass = (mod as Record<string, unknown>).Parser ?? (mod as Record<string, unknown>).default;

    if (!ParserClass || typeof ParserClass !== "function") {
      throw new Error("web-tree-sitter: no Parser export found");
    }

    if (typeof ParserClass.init === "function") {
      await (ParserClass as { init: () => Promise<void> }).init();
    }

    LanguageClass = (mod as Record<string, unknown>).Language ?? ParserClass.Language;

    if (!LanguageClass || typeof LanguageClass.load !== "function") {
      throw new Error("web-tree-sitter: no Language.load() found");
    }

    runtimeReady = true;
    return true;
  } catch (err) {
    log.warn(`Tree-sitter runtime init failed: ${err}`);
    return false;
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Parse source code using a WASM grammar. Returns the tree-sitter AST.
 * Returns null if the grammar is not available or parsing fails.
 *
 * Results are cached per grammar file for process lifetime.
 */
export async function parse(source: string, wasmFile: string): Promise<SyntaxTree | null> {
  const parser = await getParser(wasmFile);
  if (!parser) return null;

  try {
    return parser.parse(source) as SyntaxTree;
  } catch (err) {
    log.debug(`Tree-sitter parse failed with ${wasmFile}: ${err}`);
    return null;
  }
}

/**
 * Get or create a cached parser for a specific WASM grammar.
 * Returns null if grammar not available or init fails.
 */
async function getParser(wasmFile: string): Promise<ParserInstance | null> {
  // Return cached result (including null = not available)
  if (parsers.has(wasmFile)) return parsers.get(wasmFile)!;

  // Check WASM file exists
  const wasmPath = resolve(grammarsDir, wasmFile);
  if (!existsSync(wasmPath)) {
    log.debug(`Grammar not found: ${wasmPath}`);
    parsers.set(wasmFile, null);
    return null;
  }

  // Ensure runtime is initialized
  if (!await ensureRuntime()) {
    parsers.set(wasmFile, null);
    return null;
  }

  try {
    const language = await LanguageClass.load(wasmPath);
    const parser = new ParserClass() as ParserInstance;
    parser.setLanguage(language);

    log.info(`Tree-sitter parser initialized: ${wasmFile}`);
    parsers.set(wasmFile, parser);
    return parser;
  } catch (err) {
    log.warn(`Tree-sitter parser init failed for ${wasmFile}: ${err}`);
    parsers.set(wasmFile, null);
    return null;
  }
}

/**
 * Clear the parser cache. Useful for testing.
 */
export function clearParserCache(): void {
  parsers.clear();
  runtimeReady = false;
  ParserClass = null;
  LanguageClass = null;
}
