/**
 * Language classifier interface — extensible per-language NL question routing.
 *
 * To add a new language:
 * 1. Create a new file (e.g., `fr.ts`) implementing `LanguageRuleset`
 * 2. Register it in `index.ts` via `registerLanguage()`
 */
import type { QueryStrategy } from "../question-classifier.js";

/** A single pattern rule with extraction logic */
export interface PatternRule {
  strategy: QueryStrategy;
  patterns: RegExp[];
  entityExtractor: (match: RegExpMatchArray, query: string) => string[];
}

/** Per-language ruleset — provides patterns and entity normalization */
export interface LanguageRuleset {
  /** ISO 639-1 code (e.g., "en", "it", "fr") */
  language: string;
  /** Pattern rules ordered by priority (first match wins) */
  rules: PatternRule[];
  /** Language-specific entity normalization (strip articles, stopwords, etc.) */
  normalizeEntity(entity: string): string;
  /** Quick heuristic: does this query look like this language? Returns 0-1 score */
  detectScore(query: string): number;
}
