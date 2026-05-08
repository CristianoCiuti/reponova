/**
 * DAG utilities — build, validate, and topologically sort the phase graph.
 *
 * The orchestrator calls these to determine execution order.
 * No knowledge of specific phases — purely structural.
 */
import type { Phase } from "./phase.js";

/**
 * Build a DAG from registered phases.
 * Returns a Map<phaseId, Phase> for quick lookups.
 */
export function buildDAG(phases: Phase[]): Map<string, Phase> {
  const dag = new Map<string, Phase>();
  for (const phase of phases) {
    dag.set(phase.id, phase);
  }
  return dag;
}

/**
 * Validate the DAG:
 * - All dependencies reference existing phases
 * - No cycles
 *
 * Throws on validation errors.
 */
export function validate(dag: Map<string, Phase>): void {
  // Check that all dependencies exist
  for (const [id, phase] of dag) {
    for (const dep of phase.dependencies) {
      if (!dag.has(dep)) {
        throw new Error(
          `Phase "${id}" depends on "${dep}", which is not registered. ` +
          `Available phases: ${[...dag.keys()].join(", ")}`
        );
      }
    }
  }

  // Cycle detection via DFS
  const visited = new Set<string>();
  const inStack = new Set<string>();

  function dfs(id: string, path: string[]): void {
    if (inStack.has(id)) {
      const cycle = [...path.slice(path.indexOf(id)), id];
      throw new Error(`Cycle detected in phase DAG: ${cycle.join(" → ")}`);
    }
    if (visited.has(id)) return;

    inStack.add(id);
    path.push(id);

    const phase = dag.get(id)!;
    for (const dep of phase.dependencies) {
      dfs(dep, path);
    }

    path.pop();
    inStack.delete(id);
    visited.add(id);
  }

  for (const id of dag.keys()) {
    dfs(id, []);
  }
}

/**
 * Compute topological levels for maximum parallelism.
 *
 * Returns Phase[][] where each inner array is a "level" — phases
 * within a level have no dependencies on each other and can run in parallel.
 *
 * Level 0: phases with no dependencies
 * Level N: phases whose dependencies are all in levels < N
 */
export function topologicalLevels(dag: Map<string, Phase>): Phase[][] {
  const levels: Phase[][] = [];
  const assigned = new Map<string, number>(); // phaseId → level

  function getLevel(id: string): number {
    if (assigned.has(id)) return assigned.get(id)!;

    const phase = dag.get(id)!;
    if (phase.dependencies.length === 0) {
      assigned.set(id, 0);
      return 0;
    }

    let maxDepLevel = -1;
    for (const dep of phase.dependencies) {
      maxDepLevel = Math.max(maxDepLevel, getLevel(dep));
    }

    const level = maxDepLevel + 1;
    assigned.set(id, level);
    return level;
  }

  for (const id of dag.keys()) {
    getLevel(id);
  }

  for (const [id, level] of assigned) {
    while (levels.length <= level) levels.push([]);
    levels[level]!.push(dag.get(id)!);
  }

  // Sort phases within each level by ID for deterministic execution order
  for (const level of levels) {
    level.sort((a, b) => a.id.localeCompare(b.id));
  }

  return levels;
}

/**
 * Resolve the transitive dependency closure for a target phase.
 * Returns the set of phase IDs that must run (including the target itself).
 */
export function resolveTransitiveDeps(
  dag: Map<string, Phase>,
  targetId: string,
): Set<string> {
  if (!dag.has(targetId)) {
    throw new Error(
      `Target phase "${targetId}" not found. Available: ${[...dag.keys()].join(", ")}`
    );
  }

  const result = new Set<string>();

  function collect(id: string): void {
    if (result.has(id)) return;
    result.add(id);
    const phase = dag.get(id)!;
    for (const dep of phase.dependencies) {
      collect(dep);
    }
  }

  collect(targetId);
  return result;
}

/**
 * Prune a DAG to only include a subset of phase IDs.
 * Returns a new Map containing only the specified phases.
 */
export function pruneDAG(
  dag: Map<string, Phase>,
  keep: Set<string>,
): Map<string, Phase> {
  const pruned = new Map<string, Phase>();
  for (const id of keep) {
    const phase = dag.get(id);
    if (phase) pruned.set(id, phase);
  }
  return pruned;
}
