/**
 * Language registry — maps file extensions to LanguageSupport modules.
 *
 * Built-in: none (markdown doesn't have outline support).
 * All outline languages are provided by plugins discovered at runtime.
 *
 * Extensible: call `registerOutlineLanguage()` to add new languages at runtime.
 */
import type { LanguageSupport } from "./types.js";

// ─── Registry State ──────────────────────────────────────────────────────────

/** language name → LanguageSupport */
const byLanguage = new Map<string, LanguageSupport>();

/** extension (without dot, lowercase) → language name */
const extToLanguage = new Map<string, string>();

// ─── Registration ────────────────────────────────────────────────────────────

/**
 * Register an outline language support module.
 *
 * @param language - Language name (e.g., "python", "javascript")
 * @param extensions - File extensions without dot (e.g., ["py", "pyw"])
 * @param support - The LanguageSupport implementation
 */
export function registerOutlineLanguage(
  language: string,
  extensions: string[],
  support: LanguageSupport,
): void {
  byLanguage.set(language, support);
  for (const ext of extensions) {
    extToLanguage.set(ext.toLowerCase(), language);
  }
}

// ─── Built-in Languages ─────────────────────────────────────────────────────

// All outline languages are now provided by plugins (@reponova/lang-*).
// They are registered via discoverLanguagePlugins() at boot time.

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Resolve language name from file extension.
 */
export function detectLanguage(filePath: string): string | null {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return extToLanguage.get(ext) ?? null;
}

/**
 * Get the LanguageSupport module for a given language name.
 */
export function getLanguage(language: string): LanguageSupport | null {
  return byLanguage.get(language) ?? null;
}

/**
 * List all supported language names.
 */
export function supportedLanguages(): string[] {
  return [...byLanguage.keys()];
}

/**
 * Get all registered file extensions (with leading dot, lowercase).
 * Used for auto-detect when outline patterns are empty.
 */
export function getOutlineSupportedExtensions(): Set<string> {
  const exts = new Set<string>();
  for (const ext of extToLanguage.keys()) {
    exts.add(`.${ext}`);
  }
  return exts;
}
