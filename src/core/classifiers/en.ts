/**
 * English language classifier rules.
 */
import type { LanguageRuleset, PatternRule } from "./types.js";

function cleanEntity(entity: string): string {
  return entity
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\s*\?$/, "")
    .replace(/^\s*the\s+/i, "")
    .replace(/^\s*a\s+/i, "")
    .trim();
}

const rules: PatternRule[] = [
  {
    strategy: "impact_downstream",
    patterns: [
      /what\s+depends?\s+on\s+(.+)/i,
      /who\s+(?:calls?|uses?|imports?)\s+(.+)/i,
      /downstream\s+(?:of|from)\s+(.+)/i,
      /blast\s*radius\s+(?:of|for)\s+(.+)/i,
    ],
    entityExtractor: (match) => [cleanEntity(match[1] ?? "")],
  },
  {
    strategy: "impact_upstream",
    patterns: [
      /what\s+does?\s+(.+?)\s+(?:use|depend|import|call)/i,
      /dependencies?\s+(?:of|for)\s+(.+)/i,
      /upstream\s+(?:of|from)\s+(.+)/i,
    ],
    entityExtractor: (match) => [cleanEntity(match[1] ?? "")],
  },
  {
    strategy: "path",
    patterns: [
      /(?:how\s+is|how\s+are)\s+(.+?)\s+connected\s+to\s+(.+)/i,
      /path\s+(?:from|between)\s+(.+?)\s+(?:to|and)\s+(.+)/i,
      /connection\s+between\s+(.+?)\s+and\s+(.+)/i,
      /route\s+from\s+(.+?)\s+to\s+(.+)/i,
    ],
    entityExtractor: (match) => [cleanEntity(match[1] ?? ""), cleanEntity(match[2] ?? "")],
  },
  {
    strategy: "explain",
    patterns: [
      /(?:what\s+is|explain|describe|tell\s+me\s+about)\s+(.+)/i,
      /(?:detail|info|information)\s+(?:about|on|for)\s+(.+)/i,
    ],
    entityExtractor: (match) => [cleanEntity(match[1] ?? "")],
  },
  {
    strategy: "architecture",
    patterns: [
      /(?:architecture|overview|main\s+components?|structure|god\s*nodes?|hotspots?)/i,
      /(?:most\s+(?:important|connected|critical))\s*(?:nodes?|symbols?|modules?)?/i,
      /(?:show|give)\s+(?:me\s+)?(?:the\s+)?(?:architecture|overview|structure)/i,
    ],
    entityExtractor: (_match, query) => [query],
  },
  {
    strategy: "similar",
    patterns: [
      /(?:similar|like|related)\s+to\s+(.+)/i,
      /find\s+(?:something\s+)?(?:similar|like)\s+(.+)/i,
    ],
    entityExtractor: (match) => [cleanEntity(match[1] ?? "")],
  },
  {
    strategy: "search",
    patterns: [
      /^find\s+(.+)/i,
      /(?:search|look\s*(?:for|up)|locate|where\s+is)\s+(.+)/i,
    ],
    entityExtractor: (match) => [cleanEntity(match[1] ?? "")],
  },
];

// Common English words for language detection heuristic
const EN_MARKERS = /\b(what|who|how|where|find|search|explain|describe|show|give|tell|path|depends?|calls?|uses?|imports?|similar|like|the|from|between|to|about|for)\b/i;

export const en: LanguageRuleset = {
  language: "en",
  rules,
  normalizeEntity: cleanEntity,
  detectScore(query: string): number {
    const words = query.toLowerCase().split(/\s+/);
    const matches = words.filter(w => EN_MARKERS.test(w)).length;
    return Math.min(1, matches / Math.max(1, words.length) * 2);
  },
};
