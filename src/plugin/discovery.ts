/**
 * Language plugin discovery.
 *
 * Scans the node_modules directory that contains reponova itself for
 * `@reponova/lang-*` packages. Each package must have:
 *   - package.json with `"reponova": { "type": "language" }`
 *   - A default export or named `plugin` export conforming to LanguagePlugin
 *
 * Works for both global (`npm install -g reponova`) and local installs.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerExtractor } from "../extract/languages/registry.js";
import { registerOutlineLanguage } from "../outline/languages/registry.js";
import { registerGrammarPath } from "./grammar-registry.js";
import type { LanguagePlugin } from "./types.js";
import { log } from "../shared/utils.js";

/** Discovered plugin metadata (for `reponova lang list` / `reponova check`). */
export interface DiscoveredPlugin {
  id: string;
  extensions: string[];
  packageName: string;
  version: string;
  hasGrammar: boolean;
  hasOutline: boolean;
}

const discoveredPlugins: DiscoveredPlugin[] = [];

/**
 * Discover and register @reponova/lang-* plugins from node_modules.
 */
export async function discoverLanguagePlugins(): Promise<void> {
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

    const pkgDir = join(scopeDir, entry);
    const pkgJsonPath = join(pkgDir, "package.json");
    if (!existsSync(pkgJsonPath)) continue;

    let pkgJson: Record<string, unknown>;
    try {
      pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
    } catch {
      continue;
    }

    const reponovaMeta = pkgJson.reponova as Record<string, unknown> | undefined;
    if (reponovaMeta?.type !== "language") continue;

    try {
      // Resolve entry point
      const exports = pkgJson.exports as Record<string, string> | undefined;
      const entryFile = exports?.["."] ?? "./dist/index.js";
      const entryPath = join(pkgDir, entryFile);

      const mod = await import(pathToFileURL(entryPath).href);
      const plugin: LanguagePlugin = mod.plugin ?? mod.default;

      if (!plugin || !plugin.id || !plugin.extractor) {
        log.warn(`Plugin @reponova/${entry}: invalid export (missing plugin.id or plugin.extractor)`);
        continue;
      }

      // Register extractor
      registerExtractor(plugin.extractor);

      // Register outline if provided
      if (plugin.outline) {
        const extsNoDot = plugin.extensions.map((e) => e.replace(/^\./, ""));
        registerOutlineLanguage(plugin.id, extsNoDot, plugin.outline);
      }

      // Register grammar path if provided
      if (plugin.grammarPath) {
        const wasmFile = plugin.extractor.wasmFile ?? `tree-sitter-${plugin.id}.wasm`;
        registerGrammarPath(wasmFile, plugin.grammarPath);
      }

      discoveredPlugins.push({
        id: plugin.id,
        extensions: plugin.extensions,
        packageName: `@reponova/${entry}`,
        version: (pkgJson.version as string) ?? "unknown",
        hasGrammar: !!plugin.grammarPath,
        hasOutline: !!plugin.outline,
      });

      log.info(`Plugin loaded: @reponova/${entry} (${plugin.extensions.join(", ")})`);
    } catch (err) {
      log.warn(`Plugin @reponova/${entry}: failed to load — ${err}`);
    }
  }
}

/**
 * Get list of discovered plugins (after discoverLanguagePlugins() has run).
 */
export function getDiscoveredPlugins(): DiscoveredPlugin[] {
  return discoveredPlugins;
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
          // In production: dir is node_modules/reponova/ → parent is node_modules/
          const parent = resolve(dir, "..");
          // Check if parent looks like a node_modules dir
          if (parent.endsWith("node_modules")) {
            return parent;
          }
          // In development: reponova is not inside node_modules, use its own node_modules
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
