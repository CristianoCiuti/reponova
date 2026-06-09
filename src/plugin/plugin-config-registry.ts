/**
 * Plugin config registry.
 *
 * Stores the per-plugin merged config object — the result of overlaying
 * the user's `config.plugins[pluginId]` (from `reponova.yml`) on top of
 * the plugin-declared `LanguagePlugin.configDefaults` — minus the
 * reserved loader-internal fields (`package`, `enabled`, `patterns`,
 * `exclude`) which never reach the plugin's business logic.
 *
 * This registry is populated by `loadDeclaredPlugins()` after each
 * plugin is successfully imported, and consumed at runtime by:
 *   - the extraction pipeline before invoking `extract()`
 *   - the outline pipeline before invoking `treeSitterExtract()` /
 *     `regexExtract()`
 *
 * Keys: every plugin's effective config is registered under TWO keys —
 * the plugin id (used by the outline registry) and the extractor's
 * language id (used by the extraction registry). They usually coincide
 * but the dual indexing is cheap, future-proof, and removes any
 * ambiguity about which lookup string a call site must use.
 */

const RESERVED_KEYS: readonly string[] = [
  "package",
  "enabled",
  "patterns",
  "exclude",
] as const;

const configByKey = new Map<string, Readonly<Record<string, unknown>>>();

/**
 * Compute the effective plugin config by merging the user-provided
 * overrides on top of the plugin-declared defaults, stripping the
 * loader-reserved fields. Returns a frozen, plain object — never the
 * inputs themselves, so callers cannot mutate registry state.
 *
 * Reserved fields (`package`, `enabled`, `patterns`, `exclude`) are
 * consumed by the plugin loader / file-detection pipeline and never
 * forwarded to the extractor; including them in the per-plugin payload
 * would only cause name collisions with future plugin-specific keys.
 */
export function mergePluginConfig(
  defaults: Readonly<Record<string, unknown>> | undefined,
  userConfig: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> {
  const merged: Record<string, unknown> = { ...(defaults ?? {}), ...(userConfig ?? {}) };
  for (const key of RESERVED_KEYS) {
    delete merged[key];
  }
  return Object.freeze(merged);
}

/**
 * Register a frozen plugin config under one or more lookup keys.
 * Typical call: `setPluginConfig([plugin.id, plugin.extractor.languageId], cfg)`.
 * Duplicate keys overwrite (last write wins).
 */
export function setPluginConfig(
  keys: readonly string[],
  config: Readonly<Record<string, unknown>>,
): void {
  for (const key of keys) {
    if (!key) continue;
    configByKey.set(key, config);
  }
}

/**
 * Look up the effective plugin config for a given language / plugin id.
 * Returns `undefined` if the key was never registered, so callers can
 * trivially `?? EMPTY_CONFIG` if they need a defined value.
 */
export function getPluginConfig(
  key: string,
): Readonly<Record<string, unknown>> | undefined {
  return configByKey.get(key);
}

/**
 * Drop all registered plugin configs. Primarily a test seam — production
 * code calls this implicitly when a new build re-runs plugin discovery.
 */
export function clearPluginConfigs(): void {
  configByKey.clear();
}

/**
 * Snapshot of the registry, keyed by lookup string. Read-only — useful
 * for diagnostics (e.g. `reponova lang list --verbose`) and for tests
 * that need to assert on the propagation logic without poking the
 * private map.
 */
export function getAllPluginConfigs(): ReadonlyMap<string, Readonly<Record<string, unknown>>> {
  return new Map(configByKey);
}

/** Empty frozen config — returned wherever a default value is preferable to `undefined`. */
export const EMPTY_PLUGIN_CONFIG: Readonly<Record<string, unknown>> = Object.freeze({});
