/**
 * Vitest setup — registers language plugins before any test runs.
 *
 * Uses filesystem-based dynamic imports to load plugins from node_modules,
 * which works reliably across local dev and CI environments. Extensions
 * are read from `package.json.reponova.extensions[]` — the same source of
 * truth used by the production loader.
 */
import { resolve, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { registerExtractor } from "../src/extract/languages/registry.js";
import { registerOutlineLanguage } from "../src/outline/languages/registry.js";
import { registerGrammarPath } from "../src/plugin/grammar-registry.js";
import type { LanguagePlugin } from "../src/plugin/types.js";

const nodeModulesDir = resolve(import.meta.dirname, "../node_modules");

function readManifestExtensions(meta: unknown): string[] {
  if (typeof meta !== "object" || meta === null) return [];
  const raw = (meta as { extensions?: unknown }).extensions;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e): e is string => typeof e === "string" && e.length > 0)
    .map((e) => (e.startsWith(".") ? e : `.${e}`).toLowerCase());
}

async function loadPlugin(packageName: string): Promise<void> {
  const pkgDir = join(nodeModulesDir, ...packageName.split("/"));
  const pkgJsonPath = join(pkgDir, "package.json");
  if (!existsSync(pkgJsonPath)) return;

  const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
  const reponovaMeta = pkgJson.reponova as Record<string, unknown> | undefined;
  if (reponovaMeta?.type !== "language") return;
  const extensions = readManifestExtensions(reponovaMeta);
  if (extensions.length === 0) return;

  const exports = pkgJson.exports as Record<string, string> | undefined;
  const entryFile = exports?.["."] ?? "./dist/index.js";
  const entryPath = join(pkgDir, entryFile);

  const mod = await import(pathToFileURL(entryPath).href);
  const plugin: LanguagePlugin = mod.plugin ?? mod.default;
  if (!plugin?.id || !plugin?.extractor) return;

  registerExtractor(plugin.extractor, extensions);
  if (plugin.outline) {
    const extsNoDot = extensions.map((e: string) => e.replace(/^\./, ""));
    registerOutlineLanguage(plugin.id, extsNoDot, plugin.outline);
  }
  if (plugin.grammarPath) {
    const wasmFile = plugin.extractor.wasmFile ?? `tree-sitter-${plugin.id}.wasm`;
    registerGrammarPath(wasmFile, plugin.grammarPath);
  }
}

await loadPlugin("@reponova/lang-python");
await loadPlugin("@reponova/lang-plantuml");
await loadPlugin("@reponova/lang-svg");
