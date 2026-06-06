/**
 * CLI: `reponova lang` — manage language plugins.
 *
 * Commands:
 *   reponova lang add <package>     Install a language plugin (full npm package name)
 *   reponova lang remove <id>       Uninstall a language plugin by id
 *   reponova lang list              List declared language plugins
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocument, isMap, YAMLMap, type Document } from "yaml";
import { resolveNodeModulesDir } from "../plugin/discovery.js";
import { loadConfig } from "../shared/config.js";
import {
  detectInstallContext,
  buildInstallCommand,
  buildUninstallCommand,
  describeContext,
  formatAbort,
  type InstallContext,
} from "../plugin/install-context.js";
import { checkPluginStatus, describeNotInstalled } from "../plugin/installed-check.js";

/** Standard shorthand prefix — if package matches this, no `package:` field needed in config. */
const OFFICIAL_PREFIX = "@reponova/lang-";

/**
 * Run a package-manager command for `packageName` under `ctx`.
 *
 * For `linked` contexts (development tree / `npm link`) this is a no-op
 * returning `true`: we MUST NOT call any PM there or we'd mutate reponova's
 * own dependencies. For `abort` contexts, this should not be reached —
 * callers must surface the abort before getting here.
 *
 * Returns `true` on success (including the linked no-op).
 */
function runPmAdd(packageName: string, ctx: InstallContext): boolean {
  const cmd = buildInstallCommand(packageName, ctx);
  if (!cmd) return true; // linked / abort — caller's responsibility
  return runSpawn(cmd.argv, cmd.cwd, "inherit");
}

function runPmRemove(
  packageName: string,
  ctx: InstallContext,
  opts: { silent?: boolean } = {},
): boolean {
  const cmd = buildUninstallCommand(packageName, ctx);
  if (!cmd) return true;
  return runSpawn(cmd.argv, cmd.cwd, opts.silent ? "ignore" : "inherit");
}

function runSpawn(
  argv: [string, ...string[]],
  cwd: string | undefined,
  stdio: "inherit" | "ignore",
): boolean {
  const [cmd, ...args] = argv;
  // shell: true so that Windows `.cmd` shims (npm.cmd, pnpm.cmd, yarn.cmd)
  // resolve via PATH the same way they do interactively.
  const result = spawnSync(cmd, args, { cwd, stdio, shell: true });
  return result.status === 0;
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
        console.error("  --config-only       only update reponova.yml, leave the package installed");
        console.error("  --purge-global      in global context, uninstall without confirmation");
        process.exit(1);
      }
      await langRemove(name, {
        configOnly: argv["config-only"] === true || argv.configOnly === true,
        purgeGlobal: argv["purge-global"] === true || argv.purgeGlobal === true,
      });
      break;
    case "list":
      await langList();
      break;
    case "suggest": {
      const { langSuggest } = await import("./lang-suggest.js");
      await langSuggest({
        dryRun: argv["dry-run"] === true || argv.dryRun === true,
        yes: argv.yes === true,
      });
      break;
    }
    default:
      console.error("Usage: reponova lang <add|remove|list|suggest> [package|id]");
      console.error("  remove options:  --config-only, --purge-global");
      console.error("  suggest options: --dry-run (report only), --yes (install all without prompt)");
      process.exit(1);
  }
}

export async function langAdd(packageName: string): Promise<void> {
  const ctx = detectInstallContext();
  if (ctx.kind === "abort") {
    console.error(formatAbort(ctx));
    process.exit(1);
  }

  const nodeModulesDir = resolveNodeModulesDir();
  if (!nodeModulesDir) {
    console.error("Could not resolve node_modules directory. Is reponova installed?");
    process.exit(1);
  }

  // Check if already present in node_modules (e.g. npm link, prior install).
  const pkgDir = join(nodeModulesDir, ...packageName.split("/"));
  const wasAlreadyInstalled = existsSync(pkgDir);
  let status = await checkPluginStatus(packageName, nodeModulesDir);

  if (status.kind !== "loaded") {
    if (!wasAlreadyInstalled) {
      if (ctx.kind === "linked") {
        // Dev mode / npm link: refuse to touch reponova's own dependencies.
        console.error(
          `Plugin ${packageName} is not linked into ${nodeModulesDir}, and reponova is ` +
            `running from a non-installed location (${ctx.reponovaDir}).\n` +
            `Link or install the plugin manually, e.g.\n` +
            `  cd /path/to/${packageName} && npm link\n` +
            `  cd ${ctx.reponovaDir} && npm link ${packageName}`,
        );
        process.exit(1);
      }

      console.log(`Installing ${packageName} (${describeContext(ctx)})...`);
      if (!runPmAdd(packageName, ctx)) {
        console.error(`Failed to install ${packageName}`);
        process.exit(1);
      }
    }

    status = await checkPluginStatus(packageName, nodeModulesDir);
    if (status.kind !== "loaded") {
      // Rollback only if we installed it ourselves.
      if (!wasAlreadyInstalled) {
        runPmRemove(packageName, ctx, { silent: true });
      }
      console.error(describeNotInstalled(status.reason, packageName));
      process.exit(1);
    }
  }

  const { plugin } = status;

  // Update reponova.yml
  const configPath = findOrCreateConfig();
  addPluginToConfig(configPath, plugin.id, packageName, plugin.configDefaults);

  console.log(`✓ Installed ${packageName} → plugins.${plugin.id} (extensions: ${plugin.extensions.join(", ")})`);
}

export interface RemoveOptions {
  /** `--config-only`: remove from reponova.yml without touching `node_modules/`. */
  configOnly?: boolean;
  /** `--purge-global`: in global mode, uninstall without confirmation (also enables it in non-TTY). */
  purgeGlobal?: boolean;
}

interface RemoveEnv {
  /** True when stdin/stdout are a TTY — controls whether we can prompt. */
  isInteractive: boolean;
  /** True when the package directory exists in `node_modules/`. */
  packageInstalled: boolean;
}

/**
 * Decision matrix for `reponova lang remove`. Pure function — no I/O, no
 * side effects. Determines what the caller should do given the install
 * context and CLI flags.
 *
 * Returned actions:
 *   • `config-only` — only mutate reponova.yml; do NOT call the package
 *     manager. Used when: --config-only was passed; the package isn't on
 *     disk at all; the context is `linked` (dev tree — would touch
 *     reponova's own devDependencies) or `abort` (no safe PM call).
 *   • `uninstall`   — proceed with `runPmRemove`. Used for `local`
 *     contexts (always) and for `global` when --purge-global is set.
 *   • `prompt-global` — global context, no `--purge-global` flag:
 *       - in an interactive shell, ask the user before uninstalling
 *         (uninstall affects the entire Node install, not just this
 *         project, so we don't do it silently);
 *       - in a non-interactive shell, fall back to config-only and warn
 *         the user that the package is still installed system-wide
 *         (signalled by `warningOnly: true`).
 */
export type RemoveAction =
  | { kind: "config-only"; reason: "flag" | "linked" | "abort" | "missing-pkg" }
  | { kind: "uninstall" }
  | { kind: "prompt-global"; warningOnly: boolean };

export function planRemoveAction(
  ctx: InstallContext,
  opts: RemoveOptions,
  env: RemoveEnv,
): RemoveAction {
  if (opts.configOnly) return { kind: "config-only", reason: "flag" };
  if (!env.packageInstalled) return { kind: "config-only", reason: "missing-pkg" };

  switch (ctx.kind) {
    case "linked":
      return { kind: "config-only", reason: "linked" };
    case "abort":
      return { kind: "config-only", reason: "abort" };
    case "local":
      return { kind: "uninstall" };
    case "global":
      if (opts.purgeGlobal) return { kind: "uninstall" };
      return { kind: "prompt-global", warningOnly: !env.isInteractive };
  }
}

async function langRemove(id: string, opts: RemoveOptions = {}): Promise<void> {
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

  const nodeModulesDir = resolveNodeModulesDir();
  const pkgDir = nodeModulesDir
    ? join(nodeModulesDir, ...packageName.split("/"))
    : null;
  const packageInstalled = pkgDir ? existsSync(pkgDir) : false;
  const ctx = detectInstallContext();
  const action = planRemoveAction(ctx, opts, {
    isInteractive: !!process.stdout.isTTY,
    packageInstalled,
  });

  await executeRemoveAction(packageName, ctx, action);

  removePluginFromConfig(configPath, id);
  console.log(`✓ Removed ${packageName} (was plugins.${id})`);
}

/**
 * Carry out the planned action (PM call, confirmation prompt, or
 * informative log). Keeps `langRemove` focused on orchestration.
 */
async function executeRemoveAction(
  packageName: string,
  ctx: InstallContext,
  action: RemoveAction,
): Promise<void> {
  if (action.kind === "uninstall") {
    console.log(`Removing ${packageName} (${describeContext(ctx)})...`);
    // The PM call may fail for linked packages — continue with config removal.
    runPmRemove(packageName, ctx);
    return;
  }

  if (action.kind === "prompt-global") {
    if (action.warningOnly) {
      console.warn(
        `Note: ${packageName} is still installed globally (${describeContext(ctx)}).\n` +
          `Re-run with --purge-global to also uninstall the package, or run manually:\n` +
          `  reponova lang remove ${packageName} --purge-global`,
      );
      return;
    }
    const proceed = await confirmGlobalUninstall(packageName, ctx);
    if (!proceed) {
      console.log(
        `Skipped global uninstall. ${packageName} remains installed (use --purge-global to skip this prompt next time).`,
      );
      return;
    }
    console.log(`Removing ${packageName} (${describeContext(ctx)})...`);
    runPmRemove(packageName, ctx);
    return;
  }

  // config-only — log a short reason so the user understands why no PM
  // command was run (some reasons are silent by design).
  switch (action.reason) {
    case "flag":
      // User explicitly asked: no extra noise.
      return;
    case "linked":
      console.log(
        `Skipped package manager call: reponova is in linked/dev mode (${ctx.kind === "linked" ? ctx.reponovaDir : "?"}). ` +
          `Unlink the plugin manually if needed.`,
      );
      return;
    case "missing-pkg":
      console.log(`Note: ${packageName} is not present in node_modules/ — config-only update.`);
      return;
    case "abort":
      // The install context detection already produced its own error
      // path for `add`; for `remove` we silently fall back to config
      // updates so the user can still clean up a broken state.
      return;
  }
}

/**
 * Interactive Y/n confirmation before running a global uninstall.
 * Defaults to "no" to favour the safer outcome.
 */
async function confirmGlobalUninstall(packageName: string, ctx: InstallContext): Promise<boolean> {
  const { default: confirm } = await import("@inquirer/confirm");
  try {
    return await confirm({
      message:
        `About to uninstall ${packageName} via ${describeContext(ctx)}.\n` +
        `This affects the entire Node installation, not just the current project.\n` +
        `Proceed?`,
      default: false,
    });
  } catch (err) {
    // Ctrl+C on the prompt — treat as a "no".
    if (err instanceof Error && err.name === "ExitPromptError") return false;
    throw err;
  }
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
      const result = await checkPluginStatus(packageName, nodeModulesDir);
      if (result.kind === "loaded") {
        const mode = result.plugin.grammarPath ? "tree-sitter" : "regex";
        status = `${result.plugin.extensions.join(", ")}  ${packageName}@${result.version}  [${mode}]`;
      } else {
        status = `(${describeNotInstalled(result.reason, packageName)})`;
      }
    }

    console.log(`  ${id.padEnd(12)}${status}`);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

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
