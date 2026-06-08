/**
 * Language plugin discovery and registration.
 *
 * Loads plugins declared in `config.plugins`. No filesystem scanning —
 * only explicitly declared plugins are loaded (`scanReponovaScope` is the
 * one exception, kept for tests that run without a config).
 *
 * Authoritative source of truth for every plugin attribute that npm could
 * possibly need to see (type, extensions) is `package.json`. The imported
 * module only contributes runtime behavior (`id`, `extractor`, `outline`,
 * `grammarPath`, `configDefaults`). This eliminates the previous duplicate
 * declaration of `extensions` in both code and manifest.
 *
 * Resolution rule: if plugin config has `package`, use it verbatim.
 * Otherwise resolve as `@reponova/lang-<key>`.
 */
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerExtractor } from "../extract/languages/registry.js";
import { registerOutlineLanguage } from "../outline/languages/registry.js";
import { registerGrammarPath } from "./grammar-registry.js";
import { PLUGIN_TYPE_LANGUAGE } from "./manifest-spec.js";
import type { LanguagePlugin } from "./types.js";
import type { RegisteredFileType } from "../extract/index.js";
import type { Config } from "../shared/types.js";
import { log } from "../shared/utils.js";

/** Discovered plugin metadata (for `reponova lang list` / `reponova check`). */
export interface DiscoveredPlugin {
  id: string;
  fileType: string;
  extensions: string[];
  packageName: string;
  version: string;
  hasGrammar: boolean;
  hasOutline: boolean;
}

/**
 * Resolved manifest data for a plugin candidate (from its `package.json`).
 * Extensions come from `manifest.reponova.extensions[]` — never from code.
 */
interface PluginManifest {
  entryPath: string;
  extensions: string[];
  version: string;
}

const discoveredPlugins: DiscoveredPlugin[] = [];

/**
 * Resolve the package name for a plugin config entry.
 */
export function resolvePluginPackage(key: string, config: { package?: string }): string {
  return config.package ?? `@reponova/lang-${key}`;
}

/**
 * Load and register plugins declared in `config.plugins`.
 * Plugins missing `reponova.type` or `reponova.extensions[]` in their
 * manifest are skipped with a warning — they cannot be safely routed.
 */
export async function loadDeclaredPlugins(config: Config): Promise<void> {
  for (const [key, pluginConfig] of Object.entries(config.plugins)) {
    if (pluginConfig.enabled === false) continue;

    const packageName = resolvePluginPackage(key, pluginConfig);
    const manifest = resolvePluginManifest(packageName);

    if (!manifest) {
      log.warn(
        `Plugin "${key}" (${packageName}) not found or invalid manifest. ` +
          `Run: reponova lang add ${packageName}`,
      );
      continue;
    }

    try {
      const mod = await import(pathToFileURL(manifest.entryPath).href);
      const plugin: LanguagePlugin = mod.plugin ?? mod.default;

      if (!plugin?.id || !plugin?.extractor) {
        log.warn(
          `Plugin "${key}" (${packageName}): invalid export ` +
            `(missing plugin.id or plugin.extractor)`,
        );
        continue;
      }

      registerExtractor(plugin.extractor, manifest.extensions);

      if (plugin.outline) {
        const extsNoDot = manifest.extensions.map((e) => e.replace(/^\./, ""));
        registerOutlineLanguage(plugin.id, extsNoDot, plugin.outline);
      }

      if (plugin.grammarPath) {
        const wasmFile = plugin.extractor.wasmFile ?? `tree-sitter-${plugin.id}.wasm`;
        registerGrammarPath(wasmFile, plugin.grammarPath);
      }

      discoveredPlugins.push({
        id: plugin.id,
        fileType: plugin.fileType ?? plugin.id,
        extensions: manifest.extensions,
        packageName,
        version: manifest.version,
        hasGrammar: !!plugin.grammarPath,
        hasOutline: !!plugin.outline,
      });

      log.info(`Plugin loaded: ${packageName} (${manifest.extensions.join(", ")})`);
    } catch (err) {
      log.warn(`Plugin "${key}" (${packageName}): failed to load — ${err}`);
    }
  }
}

/**
 * Legacy alias — calls `loadDeclaredPlugins` with an empty config (no plugins).
 * Used by `tests/setup.ts` when no config is available.
 * In test mode, falls back to scanning `@reponova/lang-*` in `node_modules`.
 */
export async function discoverLanguagePlugins(config?: Config): Promise<void> {
  if (config) {
    return loadDeclaredPlugins(config);
  }
  await scanReponovaScope();
}

/**
 * Get list of discovered plugins (after `loadDeclaredPlugins()` has run).
 */
export function getDiscoveredPlugins(): DiscoveredPlugin[] {
  return discoveredPlugins;
}

/**
 * Resolve a plugin's manifest from its installed package. Returns `null` if
 * the package is missing, isn't a reponova language plugin, or doesn't
 * declare any extensions.
 */
function resolvePluginManifest(packageName: string): PluginManifest | null {
  const nodeModulesDir = resolveNodeModulesDir();
  if (!nodeModulesDir) return null;

  const pkgDir = join(nodeModulesDir, ...packageName.split("/"));
  const pkgJsonPath = join(pkgDir, "package.json");
  if (!existsSync(pkgJsonPath)) return null;

  let pkgJson: Record<string, unknown>;
  try {
    pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
  } catch {
    return null;
  }

  const reponovaMeta = pkgJson.reponova as Record<string, unknown> | undefined;
  if (reponovaMeta?.type !== PLUGIN_TYPE_LANGUAGE) return null;

  const extensions = readExtensions(reponovaMeta);
  if (extensions.length === 0) return null;

  const exports = pkgJson.exports as Record<string, string> | undefined;
  const entryFile = exports?.["."] ?? "./dist/index.js";
  const version = typeof pkgJson.version === "string" ? pkgJson.version : "unknown";

  return {
    entryPath: join(pkgDir, entryFile),
    extensions,
    version,
  };
}

/**
 * Read and normalize `manifest.reponova.extensions[]`. Returns `[]` if
 * the field is missing or not a string array.
 */
function readExtensions(meta: Record<string, unknown> | undefined): string[] {
  if (!meta) return [];
  const raw = meta.extensions;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e): e is string => typeof e === "string" && e.length > 0)
    .map((e) => (e.startsWith(".") ? e : `.${e}`).toLowerCase());
}

/**
 * Fallback scan for tests: discover `@reponova/lang-*` from `node_modules`.
 */
async function scanReponovaScope(): Promise<void> {
  const { readdirSync } = await import("node:fs");
  const nodeModulesDir = resolveNodeModulesDir();
  if (!nodeModulesDir) return;

  const scopeDir = join(nodeModulesDir, "@reponova");
  if (!existsSync(scopeDir)) return;

  let entries: string[];
  try {
    entries = readdirSync(scopeDir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.startsWith("lang-")) continue;
    const packageName = `@reponova/${entry}`;
    const manifest = resolvePluginManifest(packageName);
    if (!manifest) continue;

    try {
      const mod = await import(pathToFileURL(manifest.entryPath).href);
      const plugin: LanguagePlugin = mod.plugin ?? mod.default;
      if (!plugin || !plugin.id || !plugin.extractor) continue;

      registerExtractor(plugin.extractor, manifest.extensions);

      if (plugin.outline) {
        const extsNoDot = manifest.extensions.map((e) => e.replace(/^\./, ""));
        registerOutlineLanguage(plugin.id, extsNoDot, plugin.outline);
      }

      if (plugin.grammarPath) {
        const wasmFile = plugin.extractor.wasmFile ?? `tree-sitter-${plugin.id}.wasm`;
        registerGrammarPath(wasmFile, plugin.grammarPath);
      }

      discoveredPlugins.push({
        id: plugin.id,
        fileType: plugin.fileType ?? plugin.id,
        extensions: manifest.extensions,
        packageName,
        version: manifest.version,
        hasGrammar: !!plugin.grammarPath,
        hasOutline: !!plugin.outline,
      });
    } catch {
      /* skip */
    }
  }
}

/**
 * Resolve the node_modules directory that contains reponova.
 *
 * Strategy: walk up from this file's location until we find a package.json
 * with name "reponova", then go to the parent directory (which is node_modules).
 *
 * For development (not installed in node_modules), returns the local node_modules.
 */
export function resolveNodeModulesDir(): string | null {
  let dir = fileURLToPath(new URL(".", import.meta.url));

  for (let i = 0; i < 10; i++) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        if (pkg.name === "reponova") {
          const parent = resolve(dir, "..");
          if (parent.endsWith("node_modules")) {
            return parent;
          }
          const localNm = join(dir, "node_modules");
          if (existsSync(localNm)) return localNm;
          return null;
        }
      } catch { /* ignore */ }
    }
    dir = resolve(dir, "..");
  }

  return null;
}

/**
 * Build the list of registered file types for detection.
 * Includes built-in "document" type + all discovered plugin types.
 */
export function getRegisteredFileTypes(config: Config): RegisteredFileType[] {
  const types: RegisteredFileType[] = [];

  const docsConfig = config.docs;
  types.push({
    id: "document",
    extensions: new Set([".md", ".txt", ".rst"]),
    enabled: docsConfig.enabled,
    patterns: docsConfig.patterns,
    exclude: docsConfig.exclude,
    maxFileSizeKb: docsConfig.max_file_size_kb,
  });

  for (const plugin of discoveredPlugins) {
    const pluginConfig = config.plugins[plugin.id];
    types.push({
      id: plugin.fileType,
      extensions: new Set(plugin.extensions),
      enabled: pluginConfig?.enabled ?? true,
      patterns: pluginConfig?.patterns as string[] ?? [],
      exclude: pluginConfig?.exclude as string[] ?? [],
    });
  }

  return types;
}
