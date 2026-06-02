# Plugin Registry: Declaration in reponova.yml

## Summary

Generalize `reponova lang add/remove` to accept full package names and declare all plugins explicitly in `reponova.yml`. Discovery becomes deterministic: only declared plugins are loaded.

---

## Config Format

```yaml
plugins:
  # Official plugin (shorthand: no "package" → resolved as @reponova/lang-<key>)
  python:
    enabled: true

  # Community plugin (explicit package name)
  rust:
    package: "@myorg/lang-rust"
    enabled: true
    exclude: ["**/generated/**"]

  # Another community plugin
  kotlin:
    package: "reponova-lang-kotlin"
    enabled: true
    some_custom_option: "value"
```

**Resolution rule**: if `package` is present → use it verbatim. If absent → `@reponova/lang-<key>`.

---

## CLI Changes

### `reponova lang add <package>`

Accepts any valid npm package name. No more shorthand-only.

```bash
reponova lang add @reponova/lang-python
reponova lang add @myorg/lang-rust
reponova lang add reponova-lang-kotlin
```

**Flow:**

1. `npm install <package>` in the resolved node_modules directory
2. Import the installed package, validate it exports a valid `LanguagePlugin` with `id`
3. Locate `reponova.yml` (auto-detect) or create one if missing
4. Add entry under `plugins:`:
   - Key = `plugin.id` (e.g. "rust")
   - If package name matches `@reponova/lang-<id>` → omit `package` field (shorthand)
   - Otherwise → write `package: "<full-name>"`
   - Set `enabled: true`
   - If plugin has `configDefaults` → write them as defaults
5. Write updated `reponova.yml`
6. Print: `✓ Installed <package> → plugins.<id> (extensions: .rs, .kt)`

**If no `reponova.yml` exists:**

Create a minimal one:

```yaml
output: reponova-out
repos:
  - name: this
    path: .

plugins:
  rust:
    package: "@myorg/lang-rust"
    enabled: true
```

### `reponova lang remove <id>`

Takes the plugin **id** (the key in `plugins:`), not the package name.

```bash
reponova lang remove rust
```

**Flow:**

1. Read `reponova.yml` → find `plugins.<id>`
2. Resolve package name: `plugins.<id>.package ?? @reponova/lang-<id>`
3. `npm uninstall <package>`
4. Remove `plugins.<id>` from `reponova.yml`
5. Write updated `reponova.yml`
6. Print: `✓ Removed <package> (was plugins.<id>)`

### `reponova lang list`

Reads `reponova.yml` → `plugins:` section. For each entry:
- Resolve package name
- Try to import it → show version + extensions
- If import fails → show "not installed" warning

```
Installed languages:

  python    .py, .pyw     @reponova/lang-python@1.2.0    tree-sitter
  rust      .rs           @myorg/lang-rust@0.3.1         tree-sitter
  kotlin    .kt, .kts     reponova-lang-kotlin@0.1.0     regex

Built-in:
  markdown  .md, .txt, .rst
```

---

## Discovery Changes

### Current (to be removed)

```typescript
// Scans node_modules/@reponova/lang-* directories
export async function discoverLanguagePlugins(): Promise<void>
```

### New

```typescript
/**
 * Load and register plugins declared in config.plugins.
 * No filesystem scanning — only explicitly declared plugins are loaded.
 */
export async function loadDeclaredPlugins(config: Config): Promise<void> {
  for (const [id, pluginConfig] of Object.entries(config.plugins)) {
    if (pluginConfig.enabled === false) continue;

    const packageName = pluginConfig.package ?? `@reponova/lang-${id}`;

    // resolve from node_modules (works with npm, pnpm, yarn)
    const entryPath = resolvePluginEntry(packageName);
    if (!entryPath) {
      log.warn(`Plugin "${id}" (${packageName}) not found in node_modules. Run: reponova lang add ${packageName}`);
      continue;
    }

    const mod = await import(pathToFileURL(entryPath).href);
    const plugin: LanguagePlugin = mod.plugin ?? mod.default;

    if (!plugin?.id || !plugin?.extractor) {
      log.warn(`Plugin "${id}" (${packageName}): invalid export`);
      continue;
    }

    registerExtractor(plugin.extractor);
    if (plugin.outline) registerOutlineLanguage(plugin.id, ...);
    if (plugin.grammarPath) registerGrammarPath(...);

    discoveredPlugins.push({ ... });
  }
}
```

**Key change**: `discoverLanguagePlugins()` → `loadDeclaredPlugins(config)`. The function now receives `Config` and iterates only over `config.plugins` entries.

### `resolvePluginEntry(packageName)`

```typescript
function resolvePluginEntry(packageName: string): string | null {
  // Strategy 1: require.resolve (works for most layouts)
  // Strategy 2: manual node_modules walk (fallback for ESM-only)
  // Returns absolute path to entry point, or null
}
```

---

## Config Schema Changes

### `PluginConfig` (update)

```typescript
interface PluginConfig {
  package?: string;           // NEW: full npm package name (optional for @reponova/lang-*)
  enabled?: boolean;          // default: true
  patterns?: string[];
  exclude?: string[];
  [key: string]: unknown;     // passthrough for plugin-specific options
}
```

Zod schema adds `package: z.string().optional()`.

---

## Impact on Existing Code

| File | Change |
|------|--------|
| `src/plugin/discovery.ts` | Replace `discoverLanguagePlugins()` with `loadDeclaredPlugins(config)` |
| `src/plugin/discovery.ts` | Add `resolvePluginEntry()` helper |
| `src/plugin/discovery.ts` | Remove node_modules/@reponova scanning logic |
| `src/cli/lang.ts` | Rewrite `langAdd` to accept full package names, write to yaml |
| `src/cli/lang.ts` | Rewrite `langRemove` to read from yaml, resolve package |
| `src/cli/lang.ts` | Rewrite `langList` to read from yaml |
| `src/shared/types.ts` | Add `package?: string` to `PluginConfig` |
| `src/shared/config.ts` | Add `package` to `PluginConfigSchema` |
| `src/pipeline/build.ts` | Pass `config` to `loadDeclaredPlugins(config)` instead of calling `discoverLanguagePlugins()` |
| `templates/reponova.yml` | Update plugin section comments |
| `LANG-PLUGIN-ARCHITECTURE.md` | Update discovery section |
| `README.md` | Update CLI reference + config reference |

---

## Edge Cases

| Case | Behavior |
|------|----------|
| Plugin in config but not installed | Warning at boot + skip. Does not fail the build. |
| `lang add` package that isn't a reponova plugin | Error: "Package X does not export a valid LanguagePlugin" → npm uninstall → exit 1 |
| `lang add` package already declared | Update entry (idempotent) |
| `lang remove` id not in config | Error: "Plugin 'X' not found in reponova.yml" |
| Multiple plugins with same `id` | Last one wins (or error? — prefer error) |
| `lang add` with no node_modules resolvable | Error: "Cannot resolve node_modules. Run from a project with package.json." |
| Official plugin added with full name | `reponova lang add @reponova/lang-python` → shorthand in yaml (no `package:` field) |

---

## Migration from Current State

No migration needed. Current `plugins:` config without `package:` field works exactly as before (resolved as `@reponova/lang-<key>`). The `package` field is purely additive.

The only breaking change: `discoverLanguagePlugins()` no longer auto-discovers installed `@reponova/lang-*` packages unless they're declared in config. Users who installed plugins but never added them to config need to add a `plugins:` entry.

**Mitigation**: `lang add` already exists and writes to config. For the transition, we can emit a one-time warning if we detect `@reponova/lang-*` packages in node_modules that aren't in config.

---

## Test Plan

1. Unit: `resolvePluginEntry` with various package name formats
2. Unit: `loadDeclaredPlugins` with mock config (enabled/disabled/missing)
3. Unit: `langAdd` writes correct yaml (shorthand vs explicit package)
4. Unit: `langRemove` removes entry and uninstalls
5. Integration: full build with community plugin declared in config
6. E2E: existing motore_documentation build produces same output
