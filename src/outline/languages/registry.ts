/**
 * Language registry — maps file extensions to LanguageSupport modules.
 */
import type { LanguageSupport } from "./types.js";
import { python } from "./python.js";

const byLanguage: Record<string, LanguageSupport> = {
  python,
};

const extToLanguage: Record<string, string> = {
  py: "python",
  pyw: "python",
  // Future:
  // java: "java",
  // ts: "typescript",
  // tsx: "typescript",
  // js: "javascript",
  // scala: "scala",
  // kt: "kotlin",
};

/**
 * Resolve language name from file extension.
 */
export function detectLanguage(filePath: string): string | null {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return extToLanguage[ext] ?? null;
}

/**
 * Get the LanguageSupport module for a given language name.
 */
export function getLanguage(language: string): LanguageSupport | null {
  return byLanguage[language] ?? null;
}

/**
 * List all supported language names.
 */
export function supportedLanguages(): string[] {
  return Object.keys(byLanguage);
}
