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
  /**
   * Default values for plugin-specific config properties.
   *
   * Two effects at runtime:
   *
   * 1. **`reponova lang add` documentation surface** — `addPluginToConfig`
   *    writes these defaults into `reponova.yml` under the plugin's key
   *    so users discover the available knobs without reading the README.
   * 2. **Effective config delivered to the plugin** — at build time the
   *    loader merges these defaults with the user's `config.plugins[id]`
   *    (user overrides win), strips the loader-reserved fields
   *    (`package`, `enabled`, `patterns`, `exclude`), and passes the
   *    resulting object as the optional `pluginConfig` argument of
   *    {@link LanguageExtractor.extract}, {@link LanguageSupport.treeSitterExtract},
   *    and {@link LanguageSupport.regexExtract}.
   *
   * Plugins are free to declare any keys they want — RepoNova never
   * inspects the contents. The convention is to use camelCase keys and
   * primitive / JSON-friendly values so they round-trip cleanly through
   * `reponova.yml`.
   */
  readonly configDefaults?: Record<string, unknown>;
}
