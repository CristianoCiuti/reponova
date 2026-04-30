/**
 * Question classifier — routes natural language questions to the appropriate graph tool strategy.
 *
 * Zero-LLM at query time: uses regex + keyword matching.
 * Supports both English and Italian query patterns.
 */

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
}

// ─── Pattern definitions ─────────────────────────────────────────────────────

interface PatternRule {
  strategy: QueryStrategy;
  patterns: RegExp[];
  entityExtractor: (match: RegExpMatchArray, query: string) => string[];
}

const RULES: PatternRule[] = [
  // "what depends on X" / "cosa usa X" / "who calls X" / "downstream of X"
  {
    strategy: "impact_downstream",
    patterns: [
      /what\s+depends?\s+on\s+(.+)/i,
      /who\s+(?:calls?|uses?|imports?)\s+(.+)/i,
      /downstream\s+(?:of|from)\s+(.+)/i,
      /cosa\s+(?:usa|dipende\s+da|chiama)\s+(.+)/i,
      /chi\s+(?:usa|chiama|importa)\s+(.+)/i,
      /impatt?o\s+(?:di|su)\s+(.+)/i,
      /blast\s*radius\s+(?:of|for)\s+(.+)/i,
    ],
    entityExtractor: (match) => [cleanEntity(match[1] ?? "")],
  },

  // "what does X use" / "da cosa dipende X" / "upstream of X"
  {
    strategy: "impact_upstream",
    patterns: [
      /what\s+does?\s+(.+?)\s+(?:use|depend|import|call)/i,
      /(?:da\s+cosa|di\s+cosa)\s+(?:dipende|ha\s+bisogno)\s+(.+)/i,
      /dependencies?\s+(?:of|for)\s+(.+)/i,
      /upstream\s+(?:of|from)\s+(.+)/i,
      /cosa\s+importa\s+(.+)/i,
    ],
    entityExtractor: (match) => [cleanEntity(match[1] ?? "")],
  },

  // "how is X connected to Y" / "path from X to Y"
  {
    strategy: "path",
    patterns: [
      /(?:how\s+is|how\s+are)\s+(.+?)\s+connected\s+to\s+(.+)/i,
      /path\s+(?:from|between)\s+(.+?)\s+(?:to|and)\s+(.+)/i,
      /(?:come|qual)\s+[eè]\s+(?:il\s+)?(?:percorso|collegamento)\s+(?:tra|da)\s+(.+?)\s+(?:a|e)\s+(.+)/i,
      /connection\s+between\s+(.+?)\s+and\s+(.+)/i,
      /route\s+from\s+(.+?)\s+to\s+(.+)/i,
    ],
    entityExtractor: (match) => [cleanEntity(match[1] ?? ""), cleanEntity(match[2] ?? "")],
  },

  // "what is X" / "explain X" / "describe X" / "cos'è X"
  {
    strategy: "explain",
    patterns: [
      /(?:what\s+is|explain|describe|tell\s+me\s+about)\s+(.+)/i,
      /(?:cos['']?\s*[eè]|spiega|descrivi|dimmi\s+(?:di|su))\s+(.+)/i,
      /(?:detail|info|information)\s+(?:about|on|for)\s+(.+)/i,
    ],
    entityExtractor: (match) => [cleanEntity(match[1] ?? "")],
  },

  // Architecture / hotspots / overview
  {
    strategy: "architecture",
    patterns: [
      /(?:architecture|overview|main\s+components?|structure|god\s*nodes?|hotspots?)/i,
      /(?:architettura|panoramica|componenti\s+principali|struttura)/i,
      /(?:most\s+(?:important|connected|critical))\s*(?:nodes?|symbols?|modules?)?/i,
      /(?:show|give)\s+(?:me\s+)?(?:the\s+)?(?:architecture|overview|structure)/i,
    ],
    entityExtractor: (_match, query) => [query],
  },

  // "similar to X" / "like X" / "related to X"
  {
    strategy: "similar",
    patterns: [
      /(?:similar|like|related)\s+to\s+(.+)/i,
      /(?:simile|come|correlato)\s+(?:a|con)\s+(.+)/i,
      /find\s+(?:something\s+)?(?:similar|like)\s+(.+)/i,
    ],
    entityExtractor: (match) => [cleanEntity(match[1] ?? "")],
  },

  // Explicit search: "find X" / "search X" / "cerca X"
  {
    strategy: "search",
    patterns: [
      /(?:find|search|look\s*(?:for|up)|locate|where\s+is)\s+(.+)/i,
      /(?:cerca|trova|dove\s+[eè]|cerco)\s+(.+)/i,
    ],
    entityExtractor: (match) => [cleanEntity(match[1] ?? "")],
  },
];

// ─── Classifier ──────────────────────────────────────────────────────────────

/**
 * Classify a natural language question into a graph query strategy.
 */
export function classifyQuestion(query: string): ClassificationResult {
  const trimmed = query.trim();
  if (!trimmed) {
    return { strategy: "context", entities: [], confidence: 0, original: query };
  }

  for (const rule of RULES) {
    for (const pattern of rule.patterns) {
      const match = trimmed.match(pattern);
      if (match) {
        const entities = rule.entityExtractor(match, trimmed);
        return {
          strategy: rule.strategy,
          entities: entities.filter(e => e.length > 0),
          confidence: 0.85,
          original: query,
        };
      }
    }
  }

  // Fallback: use graph_context for anything unclassified
  return {
    strategy: "context",
    entities: [trimmed],
    confidence: 0.3,
    original: query,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function cleanEntity(entity: string): string {
  return entity
    .replace(/^["'`]+|["'`]+$/g, "") // strip quotes
    .replace(/\s*\?$/, "") // strip trailing question mark
    .replace(/^\s*the\s+/i, "") // strip leading "the"
    .trim();
}
