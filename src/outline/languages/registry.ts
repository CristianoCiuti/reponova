/**
 * Language registry — maps file extensions to LanguageSupport modules.
 *
 * Extensible: call `registerOutlineLanguage()` to add new languages at runtime.
 */
import type { LanguageSupport } from "./types.js";
import { python } from "./python.js";

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
 *
 * Note: duplicate language names or extensions silently overwrite the previous registration.
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

registerOutlineLanguage("python", ["py", "pyw"], python);

// Future:
// registerOutlineLanguage("java", ["java"], java);
// registerOutlineLanguage("typescript", ["ts", "tsx"], typescript);
// registerOutlineLanguage("javascript", ["js", "mjs", "cjs"], javascript);

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
