/**
 * Italian language classifier rules.
 */
import type { LanguageRuleset, PatternRule } from "./types.js";

function cleanEntity(entity: string): string {
  return entity
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\s*\?$/, "")
    // Strip Italian articles
    .replace(/^\s*(?:il|lo|la|l'|i|gli|le|un|uno|una|un')\s+/i, "")
    .trim();
}

const rules: PatternRule[] = [
  {
    strategy: "impact_downstream",
    patterns: [
      /cosa\s+(?:usa|dipende\s+da|chiama)\s+(.+)/i,
      /chi\s+(?:usa|chiama|importa)\s+(.+)/i,
      /impatt?o\s+(?:di|su)\s+(.+)/i,
    ],
    entityExtractor: (match) => [cleanEntity(match[1] ?? "")],
  },
  {
    strategy: "impact_upstream",
    patterns: [
      /(?:da\s+cosa|di\s+cosa)\s+(?:dipende|ha\s+bisogno)\s+(.+)/i,
      /cosa\s+importa\s+(.+)/i,
      /dipendenze\s+(?:di|per)\s+(.+)/i,
    ],
    entityExtractor: (match) => [cleanEntity(match[1] ?? "")],
  },
  {
    strategy: "path",
    patterns: [
      /(?:come|qual)\s*[eè]\s+(?:il\s+)?(?:percorso|collegamento)\s+(?:tra|da)\s+(.+?)\s+(?:a|e)\s+(.+)/i,
      /connessione\s+tra\s+(.+?)\s+e\s+(.+)/i,
    ],
    entityExtractor: (match) => [cleanEntity(match[1] ?? ""), cleanEntity(match[2] ?? "")],
  },
  {
    strategy: "explain",
    patterns: [
      /(?:cos['']?\s*[eè]|spiega|descrivi|dimmi\s+(?:di|su))\s+(.+)/i,
      /(?:dettagli|informazioni)\s+(?:su|di|per)\s+(.+)/i,
    ],
    entityExtractor: (match) => [cleanEntity(match[1] ?? "")],
  },
  {
    strategy: "architecture",
    patterns: [
      /(?:architettura|panoramica|componenti\s+principali|struttura)/i,
      /(?:nodi?|moduli?|simboli?)\s+(?:pi[uù]\s+)?(?:importanti?|connessi?|critici?)/i,
      /(?:mostra|dammi)\s+(?:la\s+)?(?:architettura|panoramica|struttura)/i,
    ],
    entityExtractor: (_match, query) => [query],
  },
  {
    strategy: "similar",
    patterns: [
      /(?:simile|come|correlato)\s+(?:a|con)\s+(.+)/i,
      /(?:trova|cerca)\s+(?:qualcosa\s+)?(?:simile|come)\s+(.+)/i,
    ],
    entityExtractor: (match) => [cleanEntity(match[1] ?? "")],
  },
  {
    strategy: "search",
    patterns: [
      /(?:cerca|trova|dove\s+[eè]|cerco)\s+(.+)/i,
    ],
    entityExtractor: (match) => [cleanEntity(match[1] ?? "")],
  },
];

// Italian markers for language detection
const IT_MARKERS = /\b(cosa|chi|come|dove|cerca|trova|spiega|descrivi|dimmi|mostra|dammi|dipende|chiama|importa|simile|correlato|architettura|panoramica|struttura|percorso|collegamento|connessione|impatto)\b/i;

export const it: LanguageRuleset = {
  language: "it",
  rules,
  normalizeEntity: cleanEntity,
  detectScore(query: string): number {
    const words = query.toLowerCase().split(/\s+/);
    const matches = words.filter(w => IT_MARKERS.test(w)).length;
    // Also boost for accented chars common in Italian
    const accentBoost = /[àèéìòù]/i.test(query) ? 0.15 : 0;
    return Math.min(1, matches / Math.max(1, words.length) * 2 + accentBoost);
  },
};
