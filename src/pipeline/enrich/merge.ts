/**
 * Batch merge logic — concatenates batch output files into a single final file per step.
 *
 * Used by both CLI (`enrich:merge <step>`) and the orchestrator after LLM batch execution.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteJson } from "../../shared/atomic-write.js";

export type MergeStep = "descriptions" | "profiles" | "routing" | "updated-profiles";

const STEP_CONFIG: Record<MergeStep, { dir: string; pattern: RegExp; finalFile: string }> = {
  descriptions: { dir: "descriptions", pattern: /^batch-\d+\.json$/, finalFile: "descriptions.json" },
  profiles: { dir: "profiles", pattern: /^community-\d+\.json$/, finalFile: "profiles.json" },
  routing: { dir: "routing", pattern: /^batch-\d+\.json$/, finalFile: "routing.json" },
  "updated-profiles": { dir: "updated-profiles", pattern: /^community-\d+\.json$/, finalFile: "updated-profiles.json" },
};

export function runMerge(outputDir: string, step: MergeStep): { merged: number } {
  const config = STEP_CONFIG[step];
  const enrichDir = join(outputDir, ".enrich");
  const batchDir = join(enrichDir, config.dir);
  const finalPath = join(enrichDir, config.finalFile);

  if (!existsSync(batchDir)) {
    throw new Error(`Batch directory not found: ${batchDir}. Run the corresponding LLM step first.`);
  }

  const files = readdirSync(batchDir).filter((f) => config.pattern.test(f)).sort();
  if (files.length === 0) {
    throw new Error(`No batch files found in ${batchDir} matching pattern ${config.pattern}`);
  }

  // Merge: all batch files contain JSON arrays or single objects — concatenate
  const merged: unknown[] = [];
  for (const file of files) {
    const content = JSON.parse(readFileSync(join(batchDir, file), "utf-8"));
    if (Array.isArray(content)) {
      merged.push(...content);
    } else {
      // Single-object files (community profiles)
      merged.push(content);
    }
  }

  atomicWriteJson(finalPath, merged);
  return { merged: files.length };
}
