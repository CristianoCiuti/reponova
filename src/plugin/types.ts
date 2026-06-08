/**
 * Language plugin contract.
 *
 * External packages (`@reponova/lang-*`) export a single `plugin` object
 * conforming to this interface. Discovery (`discovery.ts`) dynamically imports
 * each plugin and registers its extractor, outline support, and grammar path.
 */
import type { LanguageExtractor } from "../extract/types.js";
import type { LanguageSupport } from "../outline/languages/types.js";

export interface LanguagePlugin {
  /** Unique language identifier (e.g. "python", "plantuml") */
  readonly id: string;
  /** Label for file categorization in detected-files.json (default: plugin id) */
  readonly fileType?: string;
  /** Absolute path to a tree-sitter WASM grammar, if needed */
  readonly grammarPath?: string;
  /** Extraction implementation */
  readonly extractor: LanguageExtractor;
  /** Outline support (optional — not all languages have outlines) */
  readonly outline?: LanguageSupport;
  /** Default values for plugin-specific config properties */
  readonly configDefaults?: Record<string, unknown>;
}
