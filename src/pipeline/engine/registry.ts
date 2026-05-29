/**
 * Phase registry — collects all registered phases for DAG construction.
 *
 * Phases are registered via `createDefaultRegistry()`, which imports
 * each phase module and registers the exported phase object.
 * The orchestrator discovers them via `registry.getAll()` — it never
 * knows phase IDs at compile time.
 */
import type { Phase } from "./phase.js";
import { fileDetectionPhase } from "../phases/file-detection.js";
import { graphPhase } from "../phases/graph.js";
import { outlinesPhase } from "../phases/outlines.js";
import { communitiesPhase } from "../phases/communities.js";
import { enrichPhase } from "../phases/enrich.js";
import { searchIndexPhase } from "../phases/search-index.js";
import { embeddingsPhase } from "../phases/embeddings.js";
import { htmlPhase } from "../phases/html.js";
import { reportPhase } from "../phases/report.js";

export class PhaseRegistry {
  private phases = new Map<string, Phase>();

  /**
   * Register a phase. Throws on duplicate IDs.
   */
  register(phase: Phase): void {
    if (this.phases.has(phase.id)) {
      throw new Error(`Duplicate phase ID: "${phase.id}"`);
    }
    this.phases.set(phase.id, phase);
  }

  /**
   * Get all registered phases.
   */
  getAll(): Phase[] {
    return [...this.phases.values()];
  }

  /**
   * Get a phase by ID. Throws if not found.
   */
  get(id: string): Phase {
    const phase = this.phases.get(id);
    if (!phase) {
      throw new Error(`Phase not found: "${id}". Available: ${[...this.phases.keys()].join(", ")}`);
    }
    return phase;
  }

  /**
   * Check if a phase with the given ID is registered.
   */
  has(id: string): boolean {
    return this.phases.has(id);
  }
}

/**
 * Create a new registry with all standard phases registered.
 */
export function createDefaultRegistry(): PhaseRegistry {
  const registry = new PhaseRegistry();

  registry.register(fileDetectionPhase);
  registry.register(graphPhase);
  registry.register(outlinesPhase);
  registry.register(communitiesPhase);
  registry.register(enrichPhase);
  registry.register(searchIndexPhase);
  registry.register(embeddingsPhase);
  registry.register(htmlPhase);
  registry.register(reportPhase);

  return registry;
}
