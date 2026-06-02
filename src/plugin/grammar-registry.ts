/**
 * Grammar path registry.
 *
 * Plugins register the absolute path to their WASM grammar files.
 * The parser module resolves grammar paths through this registry,
 * falling back to the built-in grammars/ directory if no plugin provides it.
 */
import { join } from "node:path";

const grammarPaths = new Map<string, string>();

/**
 * Register an absolute path for a grammar WASM file.
 * Called by plugin discovery when a plugin provides a grammarPath.
 */
export function registerGrammarPath(wasmFile: string, absolutePath: string): void {
  grammarPaths.set(wasmFile, absolutePath);
}

/**
 * Resolve a grammar WASM file to an absolute path.
 * Returns the plugin-registered path if available, otherwise falls back to `fallbackDir/wasmFile`.
 */
export function resolveGrammarPath(wasmFile: string, fallbackDir: string): string {
  return grammarPaths.get(wasmFile) ?? join(fallbackDir, wasmFile);
}

/**
 * Get all registered grammar paths (for diagnostics / `reponova check`).
 */
export function getRegisteredGrammars(): Map<string, string> {
  return new Map(grammarPaths);
}
