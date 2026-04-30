import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { z } from "zod";
import yaml from "js-yaml";
import type { Config } from "../shared/types.js";
import { DEFAULT_CONFIG } from "../shared/types.js";

const RepoConfigSchema = z.object({
  name: z.string(),
  path: z.string(),
});

const BuildConfigSchema = z.object({
  graphify_args: z.array(z.string()).default([]),
  html: z.boolean().default(true),
  html_min_degree: z.number().int().min(1).optional(),
  exclude: z.array(z.string()).default([]),
});

const OutlineConfigSchema = z.object({
  enabled: z.boolean().default(true),
  language: z.string().default("python"),
  paths: z.array(z.string()).default(["src/**/*.py"]),
  exclude: z.array(z.string()).default(["**/__pycache__/**", "**/test_*.py", "**/.git/**"]),
});

const SearchConfigSchema = z.object({
  enabled: z.boolean().default(true),
  fields: z.array(z.string()).default(["label", "type", "source_file", "properties"]),
});

const ServerConfigSchema = z.record(z.unknown()).default({});

const ConfigSchema = z.object({
  output: z.string().default("graphify-out"),
  repos: z.array(RepoConfigSchema).default([]),
  build: BuildConfigSchema.default({}),
  outlines: OutlineConfigSchema.default({}),
  search: SearchConfigSchema.default({}),
  server: ServerConfigSchema.default({}),
});

/**
 * Load and validate configuration from a YAML file.
 */
export function loadConfig(configPath?: string): { config: Config; configDir: string } {
  const resolvedPath = resolveConfigPath(configPath);

  if (!resolvedPath) {
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
 * 2. CWD / graphify-tools.config.yml
 * 3. Editor directory configs (.opencode/, .cursor/, .claude/, .vscode/)
 */
function resolveConfigPath(explicitPath?: string): string | null {
  if (explicitPath) {
    const abs = resolve(explicitPath);
    if (existsSync(abs)) return abs;
    throw new Error(`Config file not found: ${abs}`);
  }

  // Check project root
  const cwdConfig = resolve(process.cwd(), "graphify-tools.config.yml");
  if (existsSync(cwdConfig)) return cwdConfig;

  // Check editor directories
  const editorDirs = [".opencode", ".cursor", ".claude", ".vscode"];
  for (const dir of editorDirs) {
    const editorConfig = resolve(process.cwd(), dir, "graphify-tools.config.yml");
    if (existsSync(editorConfig)) return editorConfig;
  }

  return null;
}

export { ConfigSchema };
