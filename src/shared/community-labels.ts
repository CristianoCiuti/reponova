/**
 * Centralized community label utilities.
 *
 * Label is always present on CommunitySummary:
 *   - Algorithmic: "Community {id}"
 *   - LLM: short descriptive title (e.g. "Auth & Session")
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Format a community's display name.
 *
 * When label is the algorithmic default ("Community {id}"), returns it as-is.
 * When label is a human/LLM-generated title, appends the ID for reference.
 *
 * Examples:
 *   formatCommunityName("0", "Community 0")       → "Community 0"
 *   formatCommunityName("0", "Auth & Session")     → "Auth & Session (community 0)"
 */
export function formatCommunityName(id: string | number, label: string): string {
  if (label === `Community ${id}`) return label;
  return `${label} (community ${id})`;
}

/**
 * Load community labels from community_summaries.json.
 * Returns a map of community ID string → label string.
 */
export function loadCommunityLabels(graphDir: string): Map<string, string> {
  const p = join(graphDir, "community_summaries.json");
  if (!existsSync(p)) return new Map();
  try {
    const entries = JSON.parse(readFileSync(p, "utf-8")) as Array<{ id: string | number; label: string }>;
    const map = new Map<string, string>();
    for (const e of entries) {
      map.set(String(e.id), e.label);
    }
    return map;
  } catch { return new Map(); }
}
