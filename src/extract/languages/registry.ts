/**
 * Unified registry of all available language extractors.
 *
 * This registry is the SINGLE SOURCE OF TRUTH for language support.
 * Both the extraction engine and the outline module use it.
 *
 * Built-in: only markdown. All other languages are provided by plugins
 * (`@reponova/lang-*`) discovered at runtime via `discoverLanguagePlugins()`.
 */
import type { LanguageExtractor } from "../types.js";
import { MarkdownExtractor } from "./markdown.js";

// ─── Registry State ──────────────────────────────────────────────────────────

/** extension (with dot) → extractor */
const byExtension = new Map<string, LanguageExtractor>();

/** languageId → extractor */
const byLanguageId = new Map<string, LanguageExtractor>();

// ─── Registration ────────────────────────────────────────────────────────────

export function registerExtractor(extractor: LanguageExtractor): void {
  byLanguageId.set(extractor.languageId, extractor);
  for (const ext of extractor.extensions) {
    byExtension.set(ext, extractor);
  }
}

// ─── Built-in Extractors ─────────────────────────────────────────────────────

registerExtractor(new MarkdownExtractor());

// All other languages (python, plantuml, svg, etc.) are provided by plugins.
// They are registered via discoverLanguagePlugins() at boot time.

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Get the extractor for a file based on its extension.
 * Returns null if no extractor supports this file type.
 */
export function getExtractorForFile(filePath: string): LanguageExtractor | null {
  const lastDot = filePath.lastIndexOf(".");
  if (lastDot === -1) return null;
  const ext = filePath.slice(lastDot).toLowerCase();
  return byExtension.get(ext) ?? null;
}

/**
 * Get extractor by language identifier.
 */
export function getExtractorByLanguage(languageId: string): LanguageExtractor | null {
  return byLanguageId.get(languageId) ?? null;
}

/**
 * Get all file extensions that have registered extractors.
 */
export function getSupportedExtensions(): string[] {
  return [...byExtension.keys()];
}

/**
 * Get all registered extractors (deduplicated).
 */
export function getAllExtractors(): LanguageExtractor[] {
  return [...new Set(byLanguageId.values())];
}

/**
 * Detect language from file path (by extension).
 * Returns language identifier or null.
 */
export function detectLanguageFromPath(filePath: string): string | null {
  const extractor = getExtractorForFile(filePath);
  return extractor?.languageId ?? null;
}
