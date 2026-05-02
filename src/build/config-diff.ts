/**
 * Config change detection for incremental builds.
 *
 * Loads the previous build's config fingerprint from graph.json metadata
 * and compares with the current config to detect subsystem-level changes.
 */
import { readFileSync, existsSync } from "node:fs";
import type { Config, BuildConfigFingerprint } from "../shared/types.js";

export interface ConfigDiff {
  /** True if any subsystem config changed */
  hasChanges: boolean;
  /** True if no previous build_config found (first build or pre-FIX-013) */
  isFirstBuild: boolean;
  /** Individual subsystem diffs */
  embeddingsChanged: boolean;
  outlinesChanged: boolean;
  communitySummariesChanged: boolean;
  nodeDescriptionsChanged: boolean;
  /** Previous config (null if first build) */
  previous: BuildConfigFingerprint | null;
}

/**
 * Load the previous build's config fingerprint from graph.json metadata
 * and compare with the current config.
 */
export function loadPreviousBuildConfig(graphJsonPath: string, currentConfig: Config): ConfigDiff {
  const noDiff: ConfigDiff = {
    hasChanges: false,
    isFirstBuild: true,
    embeddingsChanged: false,
    outlinesChanged: false,
    communitySummariesChanged: false,
    nodeDescriptionsChanged: false,
    previous: null,
  };

  if (!existsSync(graphJsonPath)) return noDiff;

  try {
    const raw = JSON.parse(readFileSync(graphJsonPath, "utf-8"));
    const prev = raw?.metadata?.build_config as BuildConfigFingerprint | undefined;
    if (!prev) return noDiff;

    const embeddingsChanged =
      prev.embeddings.enabled !== currentConfig.build.embeddings.enabled ||
      prev.embeddings.method !== currentConfig.build.embeddings.method ||
      prev.embeddings.model !== currentConfig.build.embeddings.model ||
      prev.embeddings.dimensions !== currentConfig.build.embeddings.dimensions;

    const outlinesChanged =
      prev.outlines.enabled !== currentConfig.outlines.enabled ||
      JSON.stringify(prev.outlines.paths) !== JSON.stringify(currentConfig.outlines.paths) ||
      JSON.stringify(prev.outlines.exclude) !== JSON.stringify(currentConfig.outlines.exclude) ||
      prev.outlines.exclude_common !== currentConfig.build.exclude_common;

    const communitySummariesChanged =
      prev.community_summaries.enabled !== currentConfig.build.community_summaries.enabled ||
      prev.community_summaries.max_number !== currentConfig.build.community_summaries.max_number ||
      (prev.community_summaries.model ?? null) !== (currentConfig.build.community_summaries.model ?? null) ||
      prev.community_summaries.context_size !== currentConfig.build.community_summaries.context_size;

    const nodeDescriptionsChanged =
      prev.node_descriptions.enabled !== currentConfig.build.node_descriptions.enabled ||
      prev.node_descriptions.threshold !== currentConfig.build.node_descriptions.threshold ||
      (prev.node_descriptions.model ?? null) !== (currentConfig.build.node_descriptions.model ?? null) ||
      prev.node_descriptions.context_size !== currentConfig.build.node_descriptions.context_size;

    return {
      hasChanges: embeddingsChanged || outlinesChanged || communitySummariesChanged || nodeDescriptionsChanged,
      isFirstBuild: false,
      embeddingsChanged,
      outlinesChanged,
      communitySummariesChanged,
      nodeDescriptionsChanged,
      previous: prev,
    };
  } catch {
    return noDiff;
  }
}
