/**
 * CLI: `reponova lang` — manage language plugins.
 *
 * Commands:
 *   reponova lang add <package>     Install a language plugin (full npm package name)
 *   reponova lang remove <id>       Uninstall a language plugin by id
 *   reponova lang list              List declared language plugins
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseDocument, isMap, YAMLMap, type Document } from "yaml";
import { resolveNodeModulesDir } from "../plugin/discovery.js";
import { loadConfig } from "../shared/config.js";
import type { LanguagePlugin } from "../plugin/types.js";

/** Standard shorthand prefix — if package matches this, no `package:` field needed in config. */
const OFFICIAL_PREFIX = "@reponova/lang-";

/**
 * How reponova was installed: either as a globally installed CLI (`npm i -g`,
 * fnm/nvm shim, etc.) or as a dependency of a local project.
 *
 * This drives whether `npm install <pkg>` is run with `-g` (global) or in the
 * owning project root (local). It is CRITICAL never to run `npm install <pkg>`
 * with cwd inside a `node_modules/` directory: npm would walk up looking for a
 * `package.json`, fail to find one, then create a synthetic one in the parent
 * (e.g. the Node-version directory itself) and PRUNE every "extraneous"
 * package — including `npm` and `corepack` themselves — leaving Node unusable.
 */
type InstallMode =
  | { kind: "global" }
  | { kind: "local"; projectRoot: string };

/**
 * Decide whether reponova lives in a global Node install context or inside a
 * regular project. We detect "global" by looking for a Node binary or a
 * `package.json` whose name matches a known Node-distribution layout next to
 * the resolved `node_modules` directory.
 */
function detectInstallMode(nodeModulesDir: string): InstallMode {
  const parent = resolve(nodeModulesDir, "..");

  // Global install: a Node distribution sits directly above node_modules.
  // Covers Windows fnm aliases dir, nvm versions dir, and `npm prefix -g` on
  // Linux/macOS (.../lib/node_modules → .../bin/node).
  if (
    existsSync(join(parent, "node.exe")) ||
    existsSync(join(parent, "node")) ||
    existsSync(join(parent, "bin", "node"))
  ) {
    return { kind: "global" };
  }

  // Otherwise reponova is a normal dependency: install/uninstall from the
  // project root that owns the node_modules directory.
  return { kind: "local", projectRoot: parent };
}

/** Run `npm install <pkg>` in the right context. Returns true on success. */
function runNpmInstall(packageName: string, mode: InstallMode): boolean {
  try {
    if (mode.kind === "global") {
      execSync(`npm install -g ${packageName}`, { stdio: "inherit" });
    } else {
      execSync(`npm install ${packageName}`, { cwd: mode.projectRoot, stdio: "inherit" });
    }
    return true;
  } catch {
    return false;
  }
}

/** Run `npm uninstall <pkg>` in the right context. Returns true on success. */
function runNpmUninstall(
  packageName: string,
  mode: InstallMode,
  opts: { silent?: boolean } = {},
): boolean {
  const stdio = opts.silent ? "ignore" : "inherit";
  try {
    if (mode.kind === "global") {
      execSync(`npm uninstall -g ${packageName}`, { stdio });
    } else {
      execSync(`npm uninstall ${packageName}`, { cwd: mode.projectRoot, stdio });
    }
    return true;
  } catch {
    return false;
  }
}

export async function langHandler(argv: Record<string, unknown>): Promise<void> {
  const positionals = argv._ as string[];
  // positionals[0] is "lang", [1] is action, [2..] is name (may be split by yargs)
  const action = positionals[1] as string | undefined;
  // Join remaining positionals in case yargs splits scoped package names
  const name = positionals.slice(2).join("/") || undefined;

  switch (action) {
    case "add":
      if (!name) {
        console.error("Usage: reponova lang add <package>");
        console.error("  e.g. reponova lang add @reponova/lang-python");
        console.error("       reponova lang add @exampleorg/lang-rust");
        process.exit(1);
      }
      await langAdd(name);
      break;
    case "remove":
      if (!name) {
        console.error("Usage: reponova lang remove <id>");
        process.exit(1);
      }
      await langRemove(name);
      break;
    case "list":
      await langList();
      break;
    default:
      console.error("Usage: reponova lang <add|remove|list> [package|id]");
      process.exit(1);
  }
}

async function langAdd(packageName: string): Promise<void> {
  const nodeModulesDir = resolveNodeModulesDir();
  if (!nodeModulesDir) {
    console.error("Could not resolve node_modules directory. Is reponova installed?");
    process.exit(1);
  }

  const installMode = detectInstallMode(nodeModulesDir);

  // Check if already present in node_modules (e.g. npm link, prior install)
  const pkgDir = join(nodeModulesDir, ...packageName.split("/"));
  const wasAlreadyInstalled = existsSync(pkgDir);
  let plugin = await importPlugin(nodeModulesDir, packageName);

  if (!plugin) {
    if (!wasAlreadyInstalled) {
      console.log(`Installing ${packageName}...`);
      if (!runNpmInstall(packageName, installMode)) {
        console.error(`Failed to install ${packageName}`);
        process.exit(1);
      }
    }

    plugin = await importPlugin(nodeModulesDir, packageName);
    if (!plugin) {
      // Rollback only if we installed it ourselves
      if (!wasAlreadyInstalled) {
        runNpmUninstall(packageName, installMode, { silent: true });
      }
      console.error(`Package ${packageName} does not export a valid LanguagePlugin (missing plugin.id or plugin.extractor)`);
      process.exit(1);
    }
  }

  // Update reponova.yml
  const configPath = findOrCreateConfig();
  addPluginToConfig(configPath, plugin.id, packageName, plugin.configDefaults);

  console.log(`✓ Installed ${packageName} → plugins.${plugin.id} (extensions: ${plugin.extensions.join(", ")})`);
}

async function langRemove(id: string): Promise<void> {
  const configPath = findConfig();
  if (!configPath) {
    console.error("No reponova.yml found. Nothing to remove.");
    process.exit(1);
  }

  const pluginEntry = findPluginInYaml(configPath, id);

  if (!pluginEntry) {
    console.error(`Plugin "${id}" not found in ${configPath}`);
    process.exit(1);
  }

  const packageName = pluginEntry.package ?? `${OFFICIAL_PREFIX}${id}`;

  // Uninstall from node_modules (only if package is actually installed, not linked)
  const nodeModulesDir = resolveNodeModulesDir();
  if (nodeModulesDir) {
    const pkgDir = join(nodeModulesDir, ...packageName.split("/"));
    if (existsSync(pkgDir)) {
      console.log(`Removing ${packageName}...`);
      // npm uninstall may fail for linked packages — continue with config removal
      runNpmUninstall(packageName, detectInstallMode(nodeModulesDir));
    }
  }

  // Remove from config
  removePluginFromConfig(configPath, id);
  console.log(`✓ Removed ${packageName} (was plugins.${id})`);
}

async function langList(): Promise<void> {
  const configPath = findConfig();

  console.log("Built-in:");
  console.log("  markdown   .md, .txt, .rst");
  console.log("");

  if (!configPath) {
    console.log("No reponova.yml found. No plugins declared.");
    return;
  }

  const plugins = readPluginsFromConfig(configPath);
  if (Object.keys(plugins).length === 0) {
    console.log("No plugins declared in config.");
    return;
  }

  console.log("Declared plugins:");

  const nodeModulesDir = resolveNodeModulesDir();

  for (const [id, cfg] of Object.entries(plugins)) {
    const packageName = cfg.package ?? `${OFFICIAL_PREFIX}${id}`;
    const enabled = cfg.enabled !== false;
    let status = "";

    if (!enabled) {
      status = "(disabled)";
    } else if (nodeModulesDir) {
      const plugin = await importPlugin(nodeModulesDir, packageName);
      if (plugin) {
        const version = readInstalledVersion(nodeModulesDir, packageName);
        const mode = plugin.grammarPath ? "tree-sitter" : "regex";
        status = `${plugin.extensions.join(", ")}  ${packageName}@${version}  [${mode}]`;
      } else {
        status = `(not installed — run: reponova lang add ${packageName})`;
      }
    }

    console.log(`  ${id.padEnd(12)}${status}`);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function importPlugin(nodeModulesDir: string, packageName: string): Promise<LanguagePlugin | null> {
  const pkgDir = join(nodeModulesDir, ...packageName.split("/"));
  const pkgJsonPath = join(pkgDir, "package.json");

  if (!existsSync(pkgJsonPath)) return null;

  try {
    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
    const meta = pkgJson.reponova as Record<string, unknown> | undefined;
    if (meta?.type !== "language") return null;

    const exports = pkgJson.exports as Record<string, string> | undefined;
    const entryFile = exports?.["."] ?? "./dist/index.js";
    const entryPath = join(pkgDir, entryFile);

    const mod = await import(pathToFileURL(entryPath).href);
    const plugin: LanguagePlugin = mod.plugin ?? mod.default;

    if (!plugin?.id || !plugin?.extractor) return null;
    return plugin;
  } catch {
    return null;
  }
}

function readInstalledVersion(nodeModulesDir: string, packageName: string): string {
  const pkgJsonPath = join(nodeModulesDir, ...packageName.split("/"), "package.json");
  try {
    const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
    return (pkg.version as string) ?? "?";
  } catch {
    return "?";
  }
}

/**
 * Find existing reponova.yml using the standard resolution chain.
 */
function findConfig(): string | null {
  const cwd = process.cwd();
  const candidates = [
    join(cwd, "reponova.yml"),
    join(cwd, ".opencode", "reponova.yml"),
    join(cwd, ".cursor", "reponova.yml"),
    join(cwd, ".claude", "reponova.yml"),
    join(cwd, ".vscode", "reponova.yml"),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

/**
 * Find config or create a minimal one at project root.
 */
function findOrCreateConfig(): string {
  const existing = findConfig();
  if (existing) return existing;

  const newPath = join(process.cwd(), "reponova.yml");
  const content = `output: reponova-out

repos:
  - name: this
    path: .

plugins: {}
`;
  writeFileSync(newPath, content, "utf-8");
  console.log(`Created ${newPath}`);
  return newPath;
}

/**
 * Parse, mutate, and re-write a YAML config file using the `yaml` package's
 * Document API.
 *
 * Unlike a plain `parse`/`stringify` round-trip, this preserves comments,
 * blank-line layout, key order, and original quoting style — the parsed
 * Document keeps the source CST and only the explicitly mutated nodes are
 * rewritten on `toString()`. The original line-ending style (LF or CRLF) is
 * also restored so Windows-authored configs stay Windows-friendly.
 */
function editConfig(
  configPath: string,
  mutate: (doc: Document) => void,
): void {
  const raw = readFileSync(configPath, "utf-8");
  const eol: "\r\n" | "\n" = raw.includes("\r\n") ? "\r\n" : "\n";

  const doc = parseDocument(raw);
  mutate(doc);

  let serialized = doc.toString({ lineWidth: 0 });

  if (eol === "\r\n") {
    serialized = serialized.replace(/\r?\n/g, "\r\n");
  }

  writeFileSync(configPath, serialized, "utf-8");
}

/**
 * Add (or update) a plugin entry in the YAML config.
 *
 * Idempotent: if the plugin id is already declared, its existing user-set
 * fields (and surrounding comments) are preserved; only missing keys are
 * filled in from `configDefaults`, `enabled` defaults to `true`, and the
 * `package` field is normalized (set for community plugins, dropped for
 * official `@reponova/lang-<id>` packages).
 */
function addPluginToConfig(
  configPath: string,
  id: string,
  packageName: string,
  configDefaults?: Record<string, unknown>,
): void {
  const isOfficial =
    packageName.startsWith(OFFICIAL_PREFIX) &&
    packageName === `${OFFICIAL_PREFIX}${id}`;

  editConfig(configPath, (doc) => {
    const pluginsNode = doc.get("plugins");
    let plugins: YAMLMap;
    if (isMap(pluginsNode)) {
      plugins = pluginsNode;
    } else {
      plugins = new YAMLMap();
      doc.set("plugins", plugins);
    }

    const entryNode = plugins.get(id);
    let entry: YAMLMap;
    if (isMap(entryNode)) {
      entry = entryNode;
    } else {
      entry = new YAMLMap();
      plugins.set(id, entry);
    }

    if (configDefaults) {
      for (const [key, value] of Object.entries(configDefaults)) {
        if (!entry.has(key)) {
          entry.set(key, value);
        }
      }
    }

    if (isOfficial) {
      if (entry.has("package")) entry.delete("package");
    } else {
      entry.set("package", packageName);
    }

    if (!entry.has("enabled")) {
      entry.set("enabled", true);
    }
  });
}

/**
 * Remove a plugin entry from the YAML config (no-op if absent).
 */
function removePluginFromConfig(configPath: string, id: string): void {
  editConfig(configPath, (doc) => {
    const plugins = doc.get("plugins");
    if (isMap(plugins)) {
      plugins.delete(id);
    }
  });
}

/**
 * Parse plugins section from config file.
 */
function readPluginsFromConfig(configPath: string): Record<string, { package?: string; enabled?: boolean }> {
  try {
    const { config } = loadConfig(configPath);
    const result: Record<string, { package?: string; enabled?: boolean }> = {};
    for (const [key, val] of Object.entries(config.plugins)) {
      result[key] = {
        package: val.package as string | undefined,
        enabled: val.enabled,
      };
    }
    return result;
  } catch {
    return {};
  }
}

/**
 * Find a plugin entry in config file.
 */
function findPluginInYaml(configPath: string, id: string): { package?: string } | null {
  try {
    const { config } = loadConfig(configPath);
    const pluginConfig = config.plugins[id];
    if (!pluginConfig) return null;
    return { package: pluginConfig.package as string | undefined };
  } catch {
    return null;
  }
}
