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

const BuildConfigSchema = z.object({
  html: z.boolean().default(true),
  html_min_degree: z.number().int().min(1).optional(),
  patterns: z.array(z.string()).default([]),
  exclude: z.array(z.string()).default([]),
  incremental: z.boolean().default(true),
  docs: z.object({
    enabled: z.boolean().default(true),
    patterns: z.array(z.string()).default(["**/*.md", "**/*.txt", "**/*.rst"]),
    exclude: z.array(z.string()).default(["**/CHANGELOG.md", "**/node_modules/**"]),
    max_file_size_kb: z.number().default(500),
  }).default({}),
  images: z.object({
    enabled: z.boolean().default(true),
    patterns: z.array(z.string()).default(["**/*.puml", "**/*.plantuml", "**/*.svg"]),
    exclude: z.array(z.string()).default(["**/node_modules/**"]),
    parse_puml: z.boolean().default(true),
    parse_svg_text: z.boolean().default(true),
  }).default({}),
  embeddings: z.object({
    enabled: z.boolean().default(true),
    method: z.enum(["tfidf", "onnx"]).default("tfidf"),
    model: z.string().default("all-MiniLM-L6-v2"),
    dimensions: z.number().default(384),
    batch_size: z.number().default(128),
  }).default({}),
  community_summaries: z.object({
    enabled: z.boolean().default(true),
    max_number: z.number().min(0).default(0),
    model: z.string().nullable().optional(),
    context_size: z.number().default(512),
  }).default({}),
  node_descriptions: z.object({
    enabled: z.boolean().default(true),
    threshold: z.number().min(0).max(1).default(0.8),
    model: z.string().nullable().optional(),
    context_size: z.number().default(512),
  }).default({}),
});

const OutlineConfigSchema = z.object({
  enabled: z.boolean().default(true),
  paths: z.array(z.string()).default(["src/**/*.ts", "src/**/*.py", "src/**/*.js"]),
  exclude: z.array(z.string()).default(["**/node_modules/**", "**/.git/**", "**/dist/**"]),
});

const ServerConfigSchema = z.record(z.unknown()).default({});

const ConfigSchema = z.object({
  output: z.string().default("reponova-out"),
  repos: z.array(RepoConfigSchema).default([]),
  models: ModelsConfigSchema.default({}),
  build: BuildConfigSchema.default({}),
  outlines: OutlineConfigSchema.default({}),
  server: ServerConfigSchema.default({}),
});

/**
 * Load and validate configuration from a YAML file.
 */
export function loadConfig(configPath?: string): { config: Config; configDir: string } {
  const resolvedPath = resolveConfigPath(configPath);

  if (!resolvedPath) {
    log.warn("No config file found (checked: reponova.yml, .opencode/, .cursor/, .claude/, .vscode/). Using defaults: single repo at current directory.");
    return { config: DEFAULT_CONFIG, configDir: process.cwd() };
  }

  const raw = readFileSync(resolvedPath, "utf-8");
  const parsed = yaml.load(raw) as Record<string, unknown>;
  const validated = ConfigSchema.parse(parsed ?? {});

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
