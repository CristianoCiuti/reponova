/**
 * `reponova lang suggest` — recommend language plugins based on the
 * file extensions actually present in the user's repos.
 *
 * High-level flow:
 *   1. Determine scan roots
 *        — `config.repos[].path` from reponova.yml if available
 *        — otherwise the current working directory (zero-config mode)
 *   2. Scan the filesystem and tally extensions (`extension-scanner`)
 *   3. Concurrently query the npm registry for plugin candidates
 *      (`registry-client`) and verify which declared plugins are
 *      ACTUALLY installed (`installed-check`)
 *   4. For every extension found, classify it:
 *        ✓ built-in   (markdown: .md/.txt/.rst — always)
 *        ✓ installed  (declared + installed + valid LanguagePlugin)
 *        → suggest    (registry has a matching plugin, not installed)
 *        · no plugin  (nothing on the registry covers it)
 *   5. Print the report
 *   6. Show an interactive checkbox of suggestions (skipped in
 *      `--dry-run`, auto-accepted in `--yes`, skipped when stdout is
 *      not a TTY) — auto-checked entries are the ones with file count
 *      ≥ INTERACTIVE_AUTOSELECT_THRESHOLD
 *   7. For each selected package, invoke `langAdd()` so the user goes
 *      through the same robust install path as `reponova lang add`
 */
import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import checkbox, { Separator } from "@inquirer/checkbox";
import { loadConfig } from "../shared/config.js";
import { resolveNodeModulesDir, resolvePluginPackage } from "../plugin/discovery.js";
import { checkPluginStatus } from "../plugin/installed-check.js";
import { scanExtensions } from "../plugin/extension-scanner.js";
import {
  discoverPluginsOnRegistry,
  indexByExtension,
  type PluginCandidate,
} from "../plugin/registry-client.js";
import { langAdd } from "./lang.js";

/** Built-in document type — these extensions never need a plugin. */
const BUILTIN_EXTENSIONS = new Set([".md", ".txt", ".rst"]);

/** How many extensions to display at most (the rest are summarised). */
const MAX_REPORT_ROWS = 30;

/**
 * Extensions with at least this many files get auto-checked in the
 * interactive prompt. Lower-count suggestions are still shown but
 * unchecked by default — the user opts in explicitly.
 */
const INTERACTIVE_AUTOSELECT_THRESHOLD = 5;

interface SuggestOptions {
  /** Skip the interactive prompt; only print the report. */
  dryRun?: boolean;
  /** Skip the prompt and install every suggested plugin without asking. */
  yes?: boolean;
}

export async function langSuggest(opts: SuggestOptions = {}): Promise<void> {
  // Load config once (or `null` if absent) and reuse it for both scan-roots
  // resolution and installed-plugin lookup — otherwise we'd log "Using
  // config: …" twice.
  const ctx = loadSuggestContext();

  // ─── 1. Scan roots ──────────────────────────────────────────────────────
  const { roots, configExclude, source } = resolveScanRoots(ctx);
  if (roots.length === 0) {
    console.error("No directory to scan (cwd does not exist?).");
    process.exit(1);
  }

  console.log(`Scanning ${describeRoots(roots, source)}...`);
  const scan = scanExtensions({ roots, excludeGlobs: configExclude });

  if (scan.totalFiles === 0) {
    console.log("No files found.");
    return;
  }
  if (scan.missingRoots.length > 0) {
    console.warn(`Note: skipped non-existent roots: ${scan.missingRoots.join(", ")}`);
  }
  if (scan.truncated) {
    console.warn("Note: walking stopped after the safety cap was reached; counts are partial.");
  }
  console.log(`Found ${scan.totalFiles.toLocaleString()} files across ${scan.counts.size} extensions.`);

  // ─── 2. Registry query + installed-plugin check (in parallel) ──────────
  console.log("Querying npm registry for available plugins...");
  const [registryCandidates, installedExtensions] = await Promise.all([
    discoverPluginsOnRegistry(),
    resolveInstalledExtensions(ctx),
  ]);
  const extToCandidate = indexByExtension(registryCandidates);

  // ─── 3. Classify each detected extension ───────────────────────────────
  const rows = classify(scan.counts, installedExtensions, extToCandidate);

  // ─── 4. Print report ───────────────────────────────────────────────────
  console.log("");
  printReport(rows);

  // ─── 5. Aggregate suggestions and prompt ───────────────────────────────
  const suggestions = aggregateSuggestions(rows);
  if (suggestions.length === 0) {
    console.log("\nNo new plugins to suggest — all detected extensions are already covered.");
    return;
  }

  if (opts.dryRun) {
    console.log("\nRun without `--dry-run` to install interactively.");
    return;
  }
  if (opts.yes) {
    await installMany(suggestions.map((s) => s.candidate.name));
    return;
  }
  if (!process.stdout.isTTY) {
    console.log("\nNon-interactive shell — to install, run any of:");
    for (const s of suggestions) {
      console.log(`  reponova lang add ${s.candidate.name}`);
    }
    return;
  }

  await promptAndInstall(suggestions);
}

// ─── Suggest context (config loaded once) ───────────────────────────────────

/**
 * Result of loading the reponova config for `lang suggest`. We load it once
 * up-front and thread it through both scan-root resolution and installed-
 * plugin lookup so that the "Using config: …" banner doesn't double-print.
 */
interface SuggestContext {
  configPath: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: any | null;
}

function loadSuggestContext(): SuggestContext {
  const configPath = findConfig();
  if (!configPath || !existsSync(configPath)) {
    return { configPath: null, config: null };
  }
  try {
    const { config } = loadConfig(configPath);
    return { configPath, config };
  } catch {
    return { configPath, config: null };
  }
}

// ─── Scan roots resolution ──────────────────────────────────────────────────

interface ScanRoots {
  roots: string[];
  configExclude: string[];
  source: "config" | "cwd";
}

function resolveScanRoots(ctx: SuggestContext): ScanRoots {
  if (ctx.configPath && ctx.config) {
    const configDir = dirname(ctx.configPath);
    const roots = (ctx.config.repos ?? [])
      .map((r: { path: string }) => (isAbsolute(r.path) ? r.path : resolve(configDir, r.path)))
      .filter((p: string) => existsSync(p));
    if (roots.length > 0) {
      return { roots, configExclude: ctx.config.exclude ?? [], source: "config" };
    }
  }
  const cwd = process.cwd();
  return { roots: [cwd], configExclude: [], source: "cwd" };
}

function findConfig(): string | null {
  const cwd = process.cwd();
  const candidates = [
    resolve(cwd, "reponova.yml"),
    resolve(cwd, ".opencode", "reponova.yml"),
    resolve(cwd, ".cursor", "reponova.yml"),
    resolve(cwd, ".claude", "reponova.yml"),
    resolve(cwd, ".vscode", "reponova.yml"),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

function describeRoots(roots: string[], source: "config" | "cwd"): string {
  if (source === "cwd") return `current directory: ${roots[0]}`;
  if (roots.length === 1) return `1 configured repo: ${roots[0]}`;
  return `${roots.length} configured repos`;
}

// ─── Installed-plugin set ───────────────────────────────────────────────────

/**
 * Returns the set of extensions already covered by a declared+installed
 * plugin in the current reponova config. Built-in markdown extensions
 * are not included here — they're handled separately in `classify`.
 */
async function resolveInstalledExtensions(ctx: SuggestContext): Promise<Set<string>> {
  const covered = new Set<string>();
  if (!ctx.config) return covered;

  const nodeModulesDir = resolveNodeModulesDir();
  if (!nodeModulesDir) return covered;

  for (const [id, cfg] of Object.entries(ctx.config.plugins ?? {})) {
    const pluginCfg = cfg as { package?: string; enabled?: boolean };
    if (pluginCfg.enabled === false) continue;
    const packageName = resolvePluginPackage(id, pluginCfg);
    const status = await checkPluginStatus(packageName, nodeModulesDir);
    if (status.kind === "loaded") {
      for (const ext of status.extensions) {
        covered.add(ext.toLowerCase());
      }
    }
  }
  return covered;
}

// ─── Classification & report ────────────────────────────────────────────────

type RowKind = "builtin" | "installed" | "suggest" | "missing";

interface Row {
  ext: string;
  count: number;
  kind: RowKind;
  candidate?: PluginCandidate;
}

function classify(
  counts: Map<string, number>,
  installed: Set<string>,
  extToCandidate: Map<string, PluginCandidate>,
): Row[] {
  const rows: Row[] = [];
  for (const [ext, count] of counts) {
    if (BUILTIN_EXTENSIONS.has(ext)) {
      rows.push({ ext, count, kind: "builtin" });
      continue;
    }
    if (installed.has(ext)) {
      rows.push({ ext, count, kind: "installed" });
      continue;
    }
    const candidate = extToCandidate.get(ext);
    if (candidate) {
      rows.push({ ext, count, kind: "suggest", candidate });
      continue;
    }
    rows.push({ ext, count, kind: "missing" });
  }
  rows.sort((a, b) => b.count - a.count || a.ext.localeCompare(b.ext));
  return rows;
}

function printReport(rows: Row[]): void {
  console.log("Detected extensions:");
  const maxExt = rows.slice(0, MAX_REPORT_ROWS).reduce((m, r) => Math.max(m, r.ext.length), 0);
  const maxCount = rows.slice(0, MAX_REPORT_ROWS).reduce(
    (m, r) => Math.max(m, r.count.toLocaleString().length),
    0,
  );

  for (const r of rows.slice(0, MAX_REPORT_ROWS)) {
    const ext = r.ext.padEnd(maxExt);
    const count = r.count.toLocaleString().padStart(maxCount);
    let suffix: string;
    switch (r.kind) {
      case "builtin":
        suffix = "✓  built-in (markdown)";
        break;
      case "installed":
        suffix = "✓  installed";
        break;
      case "suggest":
        suffix = `→  ${r.candidate!.name}${r.candidate!.isOfficial ? "" : " (community)"}`;
        break;
      case "missing":
        suffix = "·  no plugin available";
        break;
    }
    console.log(`  ${ext}  ${count} files  ${suffix}`);
  }

  if (rows.length > MAX_REPORT_ROWS) {
    console.log(`  ... (${rows.length - MAX_REPORT_ROWS} more extensions)`);
  }
}

// ─── Suggestion aggregation ─────────────────────────────────────────────────

interface Suggestion {
  candidate: PluginCandidate;
  extensions: string[];
  totalFiles: number;
}

/**
 * Collapse `Row[]` into per-candidate suggestions: a single plugin can
 * cover several extensions, and we want one entry per plugin in the
 * prompt — not one per extension.
 */
function aggregateSuggestions(rows: Row[]): Suggestion[] {
  const byName = new Map<string, Suggestion>();
  for (const r of rows) {
    if (r.kind !== "suggest" || !r.candidate) continue;
    const existing = byName.get(r.candidate.name);
    if (existing) {
      existing.extensions.push(r.ext);
      existing.totalFiles += r.count;
    } else {
      byName.set(r.candidate.name, {
        candidate: r.candidate,
        extensions: [r.ext],
        totalFiles: r.count,
      });
    }
  }
  return [...byName.values()].sort((a, b) => b.totalFiles - a.totalFiles);
}

// ─── Interactive checkbox ───────────────────────────────────────────────────

async function promptAndInstall(suggestions: Suggestion[]): Promise<void> {
  const choices = suggestions.map((s) => ({
    name: `${s.candidate.name}  (${s.extensions.join(", ")}, ${s.totalFiles.toLocaleString()} files)${s.candidate.isOfficial ? "" : " — community"}`,
    value: s.candidate.name,
    checked: s.totalFiles >= INTERACTIVE_AUTOSELECT_THRESHOLD,
    description: s.candidate.description || undefined,
  }));

  let selected: string[];
  try {
    selected = await checkbox({
      message: `Select plugins to install (${suggestions.length} suggested):`,
      choices: [
        new Separator("─── ↑/↓ navigate · space to toggle · enter to confirm ───"),
        ...choices,
      ],
      pageSize: Math.min(20, choices.length + 2),
      loop: false,
    });
  } catch (err) {
    // Inquirer throws an `ExitPromptError` on Ctrl+C — handle gracefully.
    if (err instanceof Error && err.name === "ExitPromptError") {
      console.log("Aborted.");
      return;
    }
    throw err;
  }

  if (selected.length === 0) {
    console.log("No plugins selected.");
    return;
  }
  await installMany(selected);
}

async function installMany(packageNames: string[]): Promise<void> {
  for (const pkg of packageNames) {
    console.log(`\n─── ${pkg} ───`);
    try {
      await langAdd(pkg);
    } catch (err) {
      // `langAdd` calls process.exit on hard failures; any thrown error here
      // is unexpected. Log and continue with the next package — installing
      // 3 of 4 is more useful than aborting entirely.
      console.error(`Failed to install ${pkg}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
