import { readFileSync } from "node:fs";
import type { BuildConfigFingerprint, EmbeddingsConfig } from "../shared/types.js";

const MISSING_BUILD_CONFIG_ERROR = "graph.json missing build_config — rebuild with: reponova build --force";

export function loadBuildConfigFingerprint(graphJsonPath: string): BuildConfigFingerprint | null {
  const raw = JSON.parse(readFileSync(graphJsonPath, "utf-8")) as {
    metadata?: { build_config?: BuildConfigFingerprint };
  };
  return raw.metadata?.build_config ?? null;
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
    method: fingerprint.embeddings.method,
    model: fingerprint.embeddings.model,
    dimensions: fingerprint.embeddings.dimensions,
    batch_size: 128,
  };
}

export function getMissingBuildConfigErrorMessage(): string {
  return MISSING_BUILD_CONFIG_ERROR;
}
