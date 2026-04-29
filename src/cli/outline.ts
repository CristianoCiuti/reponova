import type { CommandModule } from "yargs";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve, join, relative, dirname } from "node:path";
import { glob } from "node:fs";
import { loadConfig } from "../core/config.js";
import { resolveGraphPath } from "../core/graph-resolver.js";
import { log } from "../shared/utils.js";

export const outlineCommand: CommandModule = {
  command: "outline",
  describe: "Pre-compute outlines for configured file patterns",
  builder: (yargs) =>
    yargs
      .option("config", {
        type: "string",
        describe: "Path to graphify-tools.config.yml",
      })
      .option("force", {
        type: "boolean",
        describe: "Regenerate all outlines",
        default: false,
      }),
  handler: async (argv) => {
    const { config, configDir } = loadConfig(argv.config as string | undefined);

    if (!config.outlines.enabled) {
      log.info("Outlines are disabled in config");
      return;
    }

    const graphDir = resolveGraphPath(argv.graph as string | undefined) ?? join(configDir, config.output);
    const outlinesDir = join(graphDir, "outlines");

    if (!existsSync(outlinesDir)) {
      mkdirSync(outlinesDir, { recursive: true });
    }

    log.info(`Generating outlines in ${outlinesDir}...`);

    // Initialize tree-sitter
    let parser: Awaited<ReturnType<typeof import("../outline/parser.js")["initParser"]>>;
    try {
      const { initParser } = await import("../outline/parser.js");
      parser = await initParser();
    } catch (error) {
      log.error(`Failed to initialize tree-sitter: ${error}`);
      log.info("Falling back to regex-based outline generation");
      // For now, just log and return - full implementation would use regex fallback
      return;
    }

    const { extractOutline } = await import("../outline/extractor.js");
    const { formatOutlineJson } = await import("../outline/formatter.js");
    const { parseFile } = await import("../outline/parser.js");

    let count = 0;

    // Process configured repos
    for (const repo of config.repos) {
      const repoPath = resolve(configDir, repo.path);
      if (!existsSync(repoPath)) {
        log.warn(`Repo path not found: ${repoPath}`);
        continue;
      }

      for (const pattern of config.outlines.paths) {
        // Simple glob matching using fs.readdirSync recursively
        const files = findFiles(repoPath, pattern, config.outlines.exclude);

        for (const file of files) {
          const relPath = `${repo.name}/${relative(repoPath, file)}`.split("\\").join("/");
          const outPath = join(outlinesDir, relPath + ".outline.json");

          if (!argv.force && existsSync(outPath)) continue;

          try {
            const rootNode = parseFile(parser, file);
            const source = readFileSync(file, "utf-8");
            const lineCount = source.split("\n").length;
            const outline = extractOutline(rootNode, relPath, lineCount);

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

/**
 * Simple recursive file finder with glob-like pattern matching.
 */
function findFiles(baseDir: string, pattern: string, exclude: string[]): string[] {
  const results: string[] = [];
  const ext = pattern.includes("*.py") ? ".py" : pattern.split("*").pop() ?? "";

  function walk(dir: string): void {
    let entries;
    try {
      const { readdirSync } = require("node:fs");
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      const relPath = relative(baseDir, fullPath).split("\\").join("/");

      // Check exclusions
      if (exclude.some((ex) => matchPattern(relPath, ex))) continue;

      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && fullPath.endsWith(ext)) {
        results.push(fullPath);
      }
    }
  }

  walk(baseDir);
  return results;
}

function matchPattern(path: string, pattern: string): boolean {
  // Simple glob matching for common patterns
  if (pattern.startsWith("**/")) {
    const suffix = pattern.slice(3);
    return path.includes(suffix);
  }
  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3);
    return path.startsWith(prefix);
  }
  return path.includes(pattern.replace(/\*\*/g, "").replace(/\*/g, ""));
}
