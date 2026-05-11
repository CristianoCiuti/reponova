import type { BuildConfigFingerprint, EmbeddingsConfig } from "../shared/types.js";
import { readJsonSafe } from "../shared/fs.js";

const MISSING_BUILD_CONFIG_ERROR = "graph.json missing build_config — rebuild with: reponova build --force";

export function loadBuildConfigFingerprint(graphJsonPath: string): BuildConfigFingerprint | null {
  const raw = readJsonSafe<{ metadata?: { build_config?: BuildConfigFingerprint } }>(graphJsonPath);
  return raw?.metadata?.build_config ?? null;
}

export function requireBuildConfigFingerprint(graphJsonPath: string): BuildConfigFingerprint {
  const fingerprint = loadBuildConfigFingerprint(graphJsonPath);
  if (!fingerprint) {
    throw new Error(MISSING_BUILD_CONFIG_ERROR);
  }
  return fingerprint;
}

export function embeddingsConfigFromFingerprint(fingerprint: BuildConfigFingerprint): EmbeddingsConfig {
  return {
    enabled: fingerprint.embeddings.enabled,
    provider: fingerprint.embeddings.provider,
    batch_size: 128,
  };
}

export function getMissingBuildConfigErrorMessage(): string {
  return MISSING_BUILD_CONFIG_ERROR;
}
