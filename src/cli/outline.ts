/**
 * CLI command: outline
 *
 * Pre-computes outlines for all files matching configured patterns.
 * Uses the outline module (tree-sitter with regex fallback) — no parsing logic here.
 */
import type { CommandModule } from "yargs";
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { resolve, join, relative, dirname } from "node:path";
import { loadConfig } from "../core/config.js";
import { resolveGraphPath } from "../core/graph-resolver.js";
import { generateOutline, formatOutlineJson } from "../outline/index.js";
import { log } from "../shared/utils.js";

export const outlineCommand: CommandModule = {
  command: "outline",
  describe: "Pre-compute outlines for configured file patterns",
  builder: (yargs) =>
    yargs
      .option("config", { type: "string", describe: "Path to graphify-tools.config.yml" })
      .option("force", { type: "boolean", describe: "Regenerate all outlines", default: false }),
  handler: async (argv) => {
    const { config, configDir } = loadConfig(argv.config as string | undefined);

    if (!config.outlines.enabled) {
      log.info("Outlines are disabled in config");
      return;
    }

    const graphDir = resolveGraphPath(argv.graph as string | undefined) ?? join(configDir, config.output);
    const outlinesDir = join(graphDir, "outlines");
    if (!existsSync(outlinesDir)) mkdirSync(outlinesDir, { recursive: true });

    log.info(`Generating outlines in ${outlinesDir}...`);

    let count = 0;

    for (const repo of config.repos) {
      const repoPath = resolve(configDir, repo.path);
      if (!existsSync(repoPath)) {
        log.warn(`Repo path not found: ${repoPath}`);
        continue;
      }

      for (const pattern of config.outlines.paths) {
        const files = findFiles(repoPath, pattern, config.outlines.exclude);

        for (const file of files) {
          const relPath = `${repo.name}/${relative(repoPath, file)}`.split("\\").join("/");
          const outPath = join(outlinesDir, relPath + ".outline.json");

          if (!argv.force && existsSync(outPath)) continue;

          try {
            const source = readFileSync(file, "utf-8");
            const outline = await generateOutline(relPath, source);
            if (!outline) continue;

            const outDir = dirname(outPath);
            if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
            writeFileSync(outPath, formatOutlineJson(outline));
            count++;
          } catch (error) {
            log.warn(`Failed to process ${file}: ${error}`);
          }
        }
      }
    }

    log.info(`Generated ${count} outlines`);
  },
};

// ─── File discovery ─────────────────────────────────────────────────────────────

/**
 * Find files matching a glob-like include pattern, respecting exclusions.
 */
function findFiles(baseDir: string, pattern: string, exclude: string[]): string[] {
  const results: string[] = [];
  const ext = extractExtension(pattern);

  // Narrow the walk to the pattern's prefix directory
  const prefixMatch = pattern.match(/^([^*]*?)(?:\/?\*\*)/);
  const prefixDir = prefixMatch?.[1] || "";
  const startDir = prefixDir ? join(baseDir, prefixDir) : baseDir;
  if (!existsSync(startDir)) return results;

  function walk(dir: string): void {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      const relPath = relative(baseDir, fullPath).split("\\").join("/");

      if (exclude.some((ex) => matchExclude(relPath, ex))) continue;

      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && fullPath.endsWith(ext) && matchInclude(relPath, pattern)) {
        results.push(fullPath);
      }
    }
  }

  walk(startDir);
  return results;
}

function extractExtension(pattern: string): string {
  const match = pattern.match(/\*(\.\w+)$/);
  return match?.[1] ?? "";
}

/** Check if relPath matches an include pattern (prefix + extension). */
function matchInclude(relPath: string, pattern: string): boolean {
  const prefixMatch = pattern.match(/^([^*]*?)(?:\/?\*\*)/);
  const prefix = prefixMatch?.[1] || "";
  const ext = extractExtension(pattern);
  if (prefix && !relPath.startsWith(prefix)) return false;
  if (ext && !relPath.endsWith(ext)) return false;
  return true;
}

/** Check if relPath matches an exclusion pattern. */
function matchExclude(path: string, pattern: string): boolean {
  if (pattern.startsWith("**/")) return path.includes(pattern.slice(3));
  if (pattern.endsWith("/**")) return path.startsWith(pattern.slice(0, -3));
  return path.includes(pattern.replace(/\*\*/g, "").replace(/\*/g, ""));
}
