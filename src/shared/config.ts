import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { z } from "zod";
import yaml from "js-yaml";
import type { Config } from "../shared/types.js";
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

const ImagesConfigSchema = z.object({
  enabled: z.boolean().default(true),
  patterns: z.array(z.string()).default([]),
  exclude: z.array(z.string()).default([]),
  parse_puml: z.boolean().default(true),
  parse_svg_text: z.boolean().default(true),
});

const EmbeddingsConfigSchema = z.object({
  enabled: z.boolean().default(true),
  method: z.enum(["tfidf", "onnx"]).default("tfidf"),
  model: z.string().default("all-MiniLM-L6-v2"),
  dimensions: z.number().default(384),
  batch_size: z.number().default(128),
});

const CommunitySummariesConfigSchema = z.object({
  enabled: z.boolean().default(true),
  max_number: z.number().min(0).default(0),
  model: z.string().nullable().optional(),
  context_size: z.number().default(512),
});

const NodeDescriptionsConfigSchema = z.object({
  enabled: z.boolean().default(true),
  threshold: z.number().min(0).max(1).default(0.8),
  model: z.string().nullable().optional(),
  context_size: z.number().default(512),
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
  patterns: z.array(z.string()).default([]),
  exclude: z.array(z.string()).default([]),
  exclude_common: z.boolean().default(true),
  incremental: z.boolean().default(true),
  docs: DocsConfigSchema.default({}),
  images: ImagesConfigSchema.default({}),
  embeddings: EmbeddingsConfigSchema.default({}),
  community_summaries: CommunitySummariesConfigSchema.default({}),
  node_descriptions: NodeDescriptionsConfigSchema.default({}),
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
  if (!raw.build || typeof raw.build !== "object") return raw;

  const build = raw.build as Record<string, unknown>;
  const migrated = { ...raw };
  delete migrated.build;

  // Promote build children to root (only if not already set at root level)
  for (const [key, value] of Object.entries(build)) {
    if (!(key in migrated)) {
      migrated[key] = value;
    }
  }

  // Migrate legacy outlines config (patterns/exclude/exclude_common under outlines)
  if (migrated.outlines && typeof migrated.outlines === "object") {
    const outlines = migrated.outlines as Record<string, unknown>;
    // Strip old fields from outlines — they're now at root level
    migrated.outlines = { enabled: outlines.enabled ?? true };
  }

  log.info("Migrated legacy config: promoted build.* fields to root level");
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
  const parsed = yaml.load(raw) as Record<string, unknown>;

  // Migrate legacy configs with `build` nesting
  const migrated = migrateLegacyConfig(parsed ?? {});
  const validated = ConfigSchema.parse(migrated);

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

export { ConfigSchema };
