/**
 * Language classifier registry.
 *
 * Built-in: English and Italian.
 * Extensible: call `registerLanguage()` to add new languages.
 *
 * Usage:
 *   import { detectLanguage, getLanguageRuleset, getAllRulesets } from "./classifiers/index.js";
 *   const lang = detectLanguage(query);           // "en" | "it" | ...
 *   const ruleset = getLanguageRuleset(lang);      // LanguageRuleset
 *   const allRules = getAllRulesets();              // iterate all for multi-lang matching
 */
import type { LanguageRuleset } from "./types.js";
import { en } from "./en.js";
import { it } from "./it.js";

export type { LanguageRuleset, PatternRule } from "./types.js";

// ─── Registry ────────────────────────────────────────────────────────────────

const registry = new Map<string, LanguageRuleset>();

// Register built-in languages
registry.set("en", en);
registry.set("it", it);

/**
 * Register a new language ruleset.
 * Overwrites any existing ruleset for the same language code.
 */
export function registerLanguage(ruleset: LanguageRuleset): void {
  registry.set(ruleset.language, ruleset);
}

/**
 * Get the ruleset for a specific language code.
 * Returns undefined if not registered.
 */
export function getLanguageRuleset(language: string): LanguageRuleset | undefined {
  return registry.get(language);
}

/**
 * Get all registered language rulesets (for multi-language matching).
 */
export function getAllRulesets(): LanguageRuleset[] {
  return [...registry.values()];
}

/**
 * Get all registered language codes.
 */
export function getRegisteredLanguages(): string[] {
  return [...registry.keys()];
}

/**
 * Detect the most likely language of a query.
 * Returns the language code with the highest detection score.
 * Falls back to "en" if no language scores above threshold.
 */
export function detectLanguage(query: string): string {
  let bestLang = "en";
  let bestScore = 0;

  for (const ruleset of registry.values()) {
    const score = ruleset.detectScore(query);
    if (score > bestScore) {
      bestScore = score;
      bestLang = ruleset.language;
    }
  }

  return bestLang;
}
