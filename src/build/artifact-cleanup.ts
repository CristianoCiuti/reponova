import { existsSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { log } from "../shared/utils.js";
import type { Config } from "../shared/types.js";
import type { ConfigDiff } from "./config-diff.js";

export function cleanStaleArtifacts(outputDir: string, diff: ConfigDiff, config: Config): void {
  if (!diff.hasChanges || diff.isFirstBuild || !diff.previous) return;

  const previousEmbeddings = diff.previous.embeddings;
  const currentEmbeddings = config.build.embeddings;

  if (diff.embeddingsChanged) {
    const vectorsChanged =
      !currentEmbeddings.enabled ||
      previousEmbeddings.method !== currentEmbeddings.method ||
      previousEmbeddings.model !== currentEmbeddings.model ||
      previousEmbeddings.dimensions !== currentEmbeddings.dimensions;

    if (vectorsChanged) {
      removeDirectory(join(outputDir, "vectors"), "stale vectors/");
    }

    const shouldRemoveTfidfIdf = previousEmbeddings.method === "tfidf" && (!currentEmbeddings.enabled || currentEmbeddings.method !== "tfidf");
    if (shouldRemoveTfidfIdf) {
      removeFile(join(outputDir, "tfidf_idf.json"), "stale tfidf_idf.json");
    }
  }

  if (diff.outlinesChanged && !config.outlines.enabled) {
    removeDirectory(join(outputDir, "outlines"), "disabled outlines/");
  }

  if (diff.communitySummariesChanged && !config.build.community_summaries.enabled) {
    removeFile(join(outputDir, "community_summaries.json"), "disabled community_summaries.json");
  }

  if (diff.nodeDescriptionsChanged && !config.build.node_descriptions.enabled) {
    removeFile(join(outputDir, "node_descriptions.json"), "disabled node_descriptions.json");
  }
}

function removeDirectory(path: string, reason: string): void {
  if (!existsSync(path)) return;
  rmSync(path, { recursive: true, force: true });
  log.info(`Removed ${reason}`);
}

function removeFile(path: string, reason: string): void {
  if (!existsSync(path)) return;
  unlinkSync(path);
  log.info(`Removed ${reason}`);
}
