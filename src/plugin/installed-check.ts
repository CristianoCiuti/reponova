/**
 * Canonical check: is a language plugin actually usable RIGHT NOW?
 *
 * Being "declared" in `reponova.yml` is necessary but not sufficient.
 * A plugin is considered usable only when ALL of the following hold:
 *   1. its npm package exists under the resolved `node_modules/`
 *   2. its `package.json` has `reponova.type === "language"`
 *   3. its `package.json` has a non-empty `reponova.extensions[]`
 *   4. its entry point is importable
 *   5. the imported module exports a valid `LanguagePlugin`
 *      (has `id` and `extractor`)
 *
 * Extensions are read EXCLUSIVELY from the manifest (`reponova.extensions`),
 * not from the imported module — this is the single source of truth for
 * what files the plugin claims to handle.
 *
 * Used by:
 *   • `reponova lang list`     — show ✓ vs "not installed"
 *   • `reponova lang suggest`  — skip extensions already covered
 *   • `reponova check`         — flag declared-but-not-installed entries
 *
 * This module exists to keep a single source of truth — the previous
 * inline duplicates in `cli/lang.ts` and `plugin/discovery.ts` would
 * drift over time.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PLUGIN_TYPE_LANGUAGE } from "./manifest-spec.js";
import type { LanguagePlugin } from "./types.js";

/**
 * Outcome of `checkPluginStatus`. Discriminated union so callers can
 * decide what to render (icon, hint) without branching on string codes.
 *
 * `extensions` on the `loaded` variant is the authoritative list from
 * the manifest — callers should use it directly instead of poking into
 * the loaded `plugin` object.
 */
export type PluginStatus =
  | {
      kind: "loaded";
      plugin: LanguagePlugin;
      extensions: string[];
      version: string;
    }
  | { kind: "not-installed"; reason: NotInstalledReason };

export type NotInstalledReason =
  /** No package.json under node_modules/<pkg>/ */
  | "missing"
  /** package.json exists but `reponova.type !== "language"` */
  | "not-a-language-plugin"
  /** package.json has `reponova.type === "language"` but no extensions[] */
  | "missing-extensions"
  /** Import failed (syntax error, missing native dep, ...) */
  | "import-failed"
  /** Module loaded but exported value isn't a valid LanguagePlugin */
  | "invalid-export";

/**
 * Resolve a package name (e.g. `@reponova/lang-python`) inside a
 * `node_modules/` directory and report whether it is a usable language
 * plugin. `nodeModulesDir` is typically the result of
 * `resolveNodeModulesDir()`.
 */
export async function checkPluginStatus(
  packageName: string,
  nodeModulesDir: string,
): Promise<PluginStatus> {
  const pkgDir = join(nodeModulesDir, ...packageName.split("/"));
  const pkgJsonPath = join(pkgDir, "package.json");

  if (!existsSync(pkgJsonPath)) {
    return { kind: "not-installed", reason: "missing" };
  }

  let pkgJson: Record<string, unknown>;
  try {
    pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
  } catch {
    return { kind: "not-installed", reason: "missing" };
  }

  const meta = pkgJson.reponova as Record<string, unknown> | undefined;
  if (meta?.type !== PLUGIN_TYPE_LANGUAGE) {
    return { kind: "not-installed", reason: "not-a-language-plugin" };
  }

  const extensions = normalizeExtensions(meta.extensions);
  if (extensions.length === 0) {
    return { kind: "not-installed", reason: "missing-extensions" };
  }

  const exports = pkgJson.exports as Record<string, string> | undefined;
  const entryFile = exports?.["."] ?? "./dist/index.js";
  const entryPath = join(pkgDir, entryFile);

  let mod: { plugin?: LanguagePlugin; default?: LanguagePlugin };
  try {
    mod = await import(pathToFileURL(entryPath).href);
  } catch {
    return { kind: "not-installed", reason: "import-failed" };
  }

  const plugin = mod.plugin ?? mod.default;
  if (!plugin?.id || !plugin?.extractor) {
    return { kind: "not-installed", reason: "invalid-export" };
  }

  const version = typeof pkgJson.version === "string" ? pkgJson.version : "?";
  return { kind: "loaded", plugin, extensions, version };
}

/**
 * Convenience wrapper for callers that only care whether the plugin is
 * loadable (not WHY it failed).
 */
export async function isPluginInstalled(
  packageName: string,
  nodeModulesDir: string,
): Promise<boolean> {
  const status = await checkPluginStatus(packageName, nodeModulesDir);
  return status.kind === "loaded";
}

/**
 * Human-readable, single-line description of a non-installed reason —
 * suitable for `reponova check` / `reponova lang list` output.
 */
export function describeNotInstalled(
  reason: NotInstalledReason,
  packageName: string,
): string {
  switch (reason) {
    case "missing":
      return `declared but not installed — run: reponova lang add ${packageName}`;
    case "not-a-language-plugin":
      return `${packageName} is installed but is not a reponova language plugin (missing \`reponova.type: language\` in its package.json)`;
    case "missing-extensions":
      return `${packageName} is missing \`reponova.extensions\` in its package.json (this is the authoritative list of file extensions the plugin handles)`;
    case "import-failed":
      return `${packageName} is installed but failed to import — try reinstalling: reponova lang add ${packageName}`;
    case "invalid-export":
      return `${packageName} loaded but its default/plugin export is not a valid LanguagePlugin (missing id or extractor)`;
  }
}

/** Normalize a raw extensions value from `package.json` (filter + lowercase + dot). */
function normalizeExtensions(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e): e is string => typeof e === "string" && e.length > 0)
    .map((e) => (e.startsWith(".") ? e : `.${e}`).toLowerCase());
}
