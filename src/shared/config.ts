import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { z } from "zod";
import { parse as parseYaml } from "yaml";
import type { Config, ProviderConfig } from "../shared/types.js";
import { DEFAULT_CONFIG } from "../shared/types.js";
import { log } from "../shared/utils.js";

const RepoConfigSchema = z.object({
  name: z.string(),
  path: z.string(),
});

const ModelsConfigSchema = z.object({
  cache_dir: z.string().default("~/.cache/reponova/models"),
  gpu: z.enum(["auto", "cpu", "cuda", "metal", "vulkan"]).default("auto"),
  threads: z.number().default(0),
  download_on_first_use: z.boolean().default(true),
});

const DocsConfigSchema = z.object({
  enabled: z.boolean().default(true),
  patterns: z.array(z.string()).default([]),
  exclude: z.array(z.string()).default([]),
  max_file_size_kb: z.number().default(500),
});

const PluginConfigSchema = z.object({
  package: z.string().optional(),
  enabled: z.boolean().default(true),
  patterns: z.array(z.string()).default([]),
  exclude: z.array(z.string()).default([]),
}).passthrough();

const ProviderConfigSchema = z.object({
  type: z.enum(["openai", "llama-cpp", "onnx"]),
  model: z.string().optional(),
  base_url: z.string().optional(),
  api_key: z.string().optional(),
  timeout: z.number().min(1).default(30).optional(),
  context_size: z.number().optional(),
});

const EmbeddingsConfigSchema = z.object({
  enabled: z.boolean().default(true),
  provider: z.string().optional(),
  batch_size: z.number().default(128),
});

const EnrichMaxTokensSchema = z.object({
  descriptions: z.number().min(1).default(32768),
  profiles: z.number().min(1).default(2048),
  routing: z.number().min(1).default(8192),
  restructure: z.number().min(1).default(4096),
});

const EnrichProfileSchema = z.object({
  max_nodes: z.number().min(1).default(80),
  max_edges: z.number().min(1).default(50),
});

const EnrichConfigSchema = z.object({
  enabled: z.boolean().default(true),
  provider: z.string().optional(),
  threshold: z.number().min(0).max(1).default(0.8),
  max_communities: z.number().min(0).default(0),
  candidate_threshold: z.number().min(0).max(1).default(0.3),
  description_batch_tokens: z.number().default(40000),
  routing_batch_size: z.number().default(30),
  concurrency: z.number().min(1).default(4),
  max_retry_depth: z.number().min(0).default(3),
  max_tokens: EnrichMaxTokensSchema.default({}),
  profile: EnrichProfileSchema.default({}),
  restructure_max_pairs: z.number().min(1).default(20),
});

const OutlineConfigSchema = z.object({
  enabled: z.boolean().default(true),
});

const ServerConfigSchema = z.record(z.unknown()).default({});

/**
 * Flat config schema — no more nested `build` level.
 * All build-related fields promoted to root.
 *
 * MIGRATION: If the raw YAML still contains a `build` key, its children
 * are promoted to the root level before validation.
 */
const ConfigSchema = z.object({
  output: z.string().default("reponova-out"),
  repos: z.array(RepoConfigSchema).default([]),
  models: ModelsConfigSchema.default({}),
  providers: z.record(z.string(), ProviderConfigSchema).default({}),
  patterns: z.array(z.string()).default([]),
  exclude: z.array(z.string()).default([]),
  exclude_common: z.boolean().default(true),
  incremental: z.boolean().default(true),
  docs: DocsConfigSchema.default({}),
  plugins: z.record(z.string(), PluginConfigSchema).default({}),
  embeddings: EmbeddingsConfigSchema.default({}),
  enrich: EnrichConfigSchema.default({}),
  html: z.boolean().default(true),
  html_min_degree: z.number().int().min(1).optional(),
  outlines: OutlineConfigSchema.default({}),
  server: ServerConfigSchema.default({}),
});

/**
 * Migrate legacy config with `build` nesting to flat format.
 * If the raw YAML contains a `build` key, promote its children to root.
 */
function migrateLegacyConfig(raw: Record<string, unknown>): Record<string, unknown> {
  const migrated = { ...raw };

  if (raw.build && typeof raw.build === "object") {
    const build = raw.build as Record<string, unknown>;
    delete migrated.build;

    // Promote build children to root (only if not already set at root level)
    for (const [key, value] of Object.entries(build)) {
      if (!(key in migrated)) {
        migrated[key] = value;
      }
    }

    log.info("Migrated legacy config: promoted build.* fields to root level");
  }

  // Migrate legacy outlines config (patterns/exclude/exclude_common under outlines)
  if (migrated.outlines && typeof migrated.outlines === "object") {
    const outlines = migrated.outlines as Record<string, unknown>;
    // Strip old fields from outlines — they're now at root level
    migrated.outlines = { enabled: outlines.enabled ?? true };
  }

  // Reject legacy config keys — no backward compatibility
  if (migrated.community_summaries || migrated.node_descriptions) {
    throw new Error(
      "Legacy config detected: 'community_summaries' and 'node_descriptions' are no longer supported. " +
      "Replace with 'enrich:' section. See INTELLIGENT-ENRICHMENT.md for the new config format.",
    );
  }

  return migrated;
}

/**
 * Load and validate configuration from a YAML file.
 */
export function loadConfig(configPath?: string): { config: Config; configDir: string } {
  const resolvedPath = resolveConfigPath(configPath);

  if (!resolvedPath) {
    log.warn("No config file found (checked: reponova.yml, .opencode/, .cursor/, .claude/, .vscode/). Using defaults: single repo at current directory.");
    return { config: DEFAULT_CONFIG, configDir: process.cwd() };
  }

  log.info(`Using config: ${resolvedPath}`);

  const raw = readFileSync(resolvedPath, "utf-8");
  const parsed = parseYaml(raw) as Record<string, unknown>;

  // Migrate legacy configs with `build` nesting
  const migrated = migrateLegacyConfig(parsed ?? {});
  const validated = ConfigSchema.parse(migrated);
  validateProviderReferences(validated as Config);

  return {
    config: validated as Config,
    configDir: dirname(resolvedPath),
  };
}

/**
 * Resolve config file path using priority chain:
 * 1. Explicit path
 * 2. CWD / reponova.yml
 * 3. Editor directory configs (.opencode/, .cursor/, .claude/, .vscode/)
 */
function resolveConfigPath(explicitPath?: string): string | null {
  if (explicitPath) {
    const abs = resolve(explicitPath);
    if (existsSync(abs)) return abs;
    throw new Error(`Config file not found: ${abs}`);
  }

  // Check project root
  const cwdConfig = resolve(process.cwd(), "reponova.yml");
  if (existsSync(cwdConfig)) return cwdConfig;

  // Check editor directories
  const editorDirs = [".opencode", ".cursor", ".claude", ".vscode"];
  for (const dir of editorDirs) {
    const editorConfig = resolve(process.cwd(), dir, "reponova.yml");
    if (existsSync(editorConfig)) return editorConfig;
  }

  return null;
}

function validateProviderReferences(config: Config): void {
  for (const [providerName, provider] of Object.entries(config.providers)) {
  validateProviderRequirements(providerName, provider);
  }

  validateEmbeddingProvider(config);
  validateLlmProvider(config, "enrich", config.enrich.provider);
}

function validateEmbeddingProvider(config: Config): void {
  const providerName = config.embeddings.provider;
  if (!providerName) return;

  const provider = getNamedProvider(config.providers, providerName, "embeddings.provider");
  if (provider.type !== "openai" && provider.type !== "onnx") {
    throw new Error(
      `Invalid embeddings.provider \"${providerName}\": provider type \"${provider.type}\" is not supported for embeddings (expected openai or onnx)`,
    );
  }
}

function validateLlmProvider(config: Config, fieldName: string, providerName?: string): void {
  if (!providerName) return;

  const provider = getNamedProvider(config.providers, providerName, `${fieldName}.provider`);
  if (provider.type !== "openai" && provider.type !== "llama-cpp") {
    throw new Error(
      `Invalid ${fieldName}.provider \"${providerName}\": provider type \"${provider.type}\" is not supported for LLM features (expected openai or llama-cpp)`,
    );
  }
}

function getNamedProvider(
  providers: Record<string, ProviderConfig>,
  providerName: string,
  fieldName: string,
): ProviderConfig {
  const provider = providers[providerName];
  if (!provider) {
    throw new Error(`Invalid ${fieldName}: provider \"${providerName}\" is not defined in config.providers`);
  }
  return provider;
}

function validateProviderRequirements(providerName: string, provider: ProviderConfig): void {
  if (provider.type === "openai") {
    if (!provider.base_url) {
      throw new Error(`Provider \"${providerName}\" (openai) requires base_url`);
    }
    if (!provider.model) {
      throw new Error(`Provider \"${providerName}\" (openai) requires model`);
    }
    return;
  }

  if ((provider.type === "llama-cpp" || provider.type === "onnx") && !provider.model) {
    throw new Error(`Provider \"${providerName}\" (${provider.type}) requires model`);
  }
}

export { ConfigSchema };
