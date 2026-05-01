/**
 * Question classifier — routes natural language questions to the appropriate graph tool strategy.
 *
 * Zero-LLM at query time: uses regex + keyword matching.
 * Extensible multi-language support via classifiers/ modules.
 *
 * Built-in languages: English, Italian.
 * To add a new language: create a LanguageRuleset in classifiers/ and register it.
 */
import { detectLanguage, getAllRulesets, getLanguageRuleset } from "./classifiers/index.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export type QueryStrategy =
  | "impact_downstream"
  | "impact_upstream"
  | "path"
  | "explain"
  | "search"
  | "similar"
  | "architecture"
  | "context";

export interface ClassificationResult {
  strategy: QueryStrategy;
  /** Extracted entity/entities from the query */
  entities: string[];
  /** Confidence 0-1 based on pattern match quality */
  confidence: number;
  /** The original query for fallback */
  original: string;
  /** Detected language code */
  language: string;
}

// Re-export for consumers who want to register new languages
export { registerLanguage, getRegisteredLanguages } from "./classifiers/index.js";
export type { LanguageRuleset, PatternRule } from "./classifiers/types.js";

// ─── Classifier ──────────────────────────────────────────────────────────────

/**
 * Classify a natural language question into a graph query strategy.
 *
 * @param query - The natural language question
 * @param language - Optional ISO 639-1 language code to skip detection (e.g., "en", "it")
 */
export function classifyQuestion(query: string, language?: string): ClassificationResult {
  const trimmed = query.trim();
  if (!trimmed) {
    return { strategy: "context", entities: [], confidence: 0, original: query, language: language ?? "en" };
  }

  // Detect or use provided language
  const detectedLang = language ?? detectLanguage(trimmed);

  // Strategy: try the detected language first, then fall back to all others
  const primaryRuleset = getLanguageRuleset(detectedLang);
  if (primaryRuleset) {
    const result = tryRuleset(primaryRuleset, trimmed, query);
    if (result) return result;
  }

  // Fall back: try all other registered languages
  for (const ruleset of getAllRulesets()) {
    if (ruleset.language === detectedLang) continue;
    const result = tryRuleset(ruleset, trimmed, query);
    if (result) return result;
  }

  // No pattern matched — fallback to graph_context
  return {
    strategy: "context",
    entities: [trimmed],
    confidence: 0.3,
    original: query,
    language: detectedLang,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function tryRuleset(
  ruleset: import("./classifiers/types.js").LanguageRuleset,
  trimmed: string,
  original: string,
): ClassificationResult | null {
  for (const rule of ruleset.rules) {
    for (const pattern of rule.patterns) {
      const match = trimmed.match(pattern);
      if (match) {
        const entities = rule.entityExtractor(match, trimmed);
        return {
          strategy: rule.strategy,
          entities: entities.filter(e => e.length > 0),
          confidence: 0.85,
          original,
          language: ruleset.language,
        };
      }
    }
  }
  return null;
}
