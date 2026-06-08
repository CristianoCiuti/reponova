/**
 * Unified registry of all available language extractors.
 *
 * This registry is the SINGLE SOURCE OF TRUTH for language support.
 * Both the extraction engine and the outline module use it.
 *
 * Built-in: only markdown. All other languages are provided by plugins
 * (`@reponova/lang-*`) discovered at runtime via `discoverLanguagePlugins()`.
 *
 * Extensions are passed EXPLICITLY by the caller (loaded from
 * `package.json.reponova.extensions[]` for plugins, hard-coded for built-ins).
 * The `LanguageExtractor` interface no longer exposes `extensions` — concrete
 * extractor classes are free to keep a private field for their own logic
 * (e.g. import-path resolution), but the routing table below is built solely
 * from the explicit `extensions` parameter.
 */
import type { LanguageExtractor } from "../types.js";
import { MarkdownExtractor } from "./markdown.js";

// ─── Registry State ──────────────────────────────────────────────────────────

/** extension (with dot) → extractor */
const byExtension = new Map<string, LanguageExtractor>();

/** languageId → extractor */
const byLanguageId = new Map<string, LanguageExtractor>();

/** languageId → extensions handled (mirror of the byExtension reverse map). */
const extensionsByLanguageId = new Map<string, readonly string[]>();

// ─── Registration ────────────────────────────────────────────────────────────

export function registerExtractor(
  extractor: LanguageExtractor,
  extensions: readonly string[],
): void {
  byLanguageId.set(extractor.languageId, extractor);
  extensionsByLanguageId.set(extractor.languageId, [...extensions]);
  for (const ext of extensions) {
    byExtension.set(ext, extractor);
  }
}

/** Extensions registered for a language id (empty array if unknown). */
export function getExtensionsByLanguage(languageId: string): readonly string[] {
  return extensionsByLanguageId.get(languageId) ?? [];
}

// ─── Built-in Extractors ─────────────────────────────────────────────────────

/** Built-in: markdown / plain documentation. Other languages come from plugins. */
const MARKDOWN_EXTENSIONS = [".md", ".txt", ".rst"] as const;
registerExtractor(new MarkdownExtractor(), MARKDOWN_EXTENSIONS);

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
