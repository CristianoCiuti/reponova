import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import type { Config } from "../shared/types.js";
import { checkGraphify, installGraphify } from "./graphify-check.js";
import { runIndexer } from "./indexer.js";
import { postProcess } from "./post-process.js";
import { log } from "../shared/utils.js";

export interface BuildOptions {
  semantic: boolean;
  force: boolean;
}

/**
 * Run the full build pipeline:
 * 1. Verify graphify installed (PyPI: graphifyy)
 * 2. Run `graphify <path>` on each repo
 * 3. Merge graphs via `graphify merge-graphs`
 * 4. Post-process paths
 * 5. Generate search index
 *
 * Reference: https://github.com/safishamsi/graphify
 */
export async function runBuild(config: Config, configDir: string, options: BuildOptions): Promise<void> {
  // 1. Verify graphify
  let graphifyInfo = checkGraphify();
  if (!graphifyInfo) {
    log.error("graphify (PyPI: graphifyy) is required for building the knowledge graph.");
    log.error("Install: pip install graphifyy   (or: uv tool install graphifyy)");
    const installed = installGraphify();
    if (!installed) process.exit(1);
    graphifyInfo = checkGraphify();
    if (!graphifyInfo) {
      log.error("Installation failed. Please install manually: pip install graphifyy");
      process.exit(1);
    }
  }

  const graphifyCmd = graphifyInfo.command;
  log.info(`Using graphify: ${graphifyCmd} v${graphifyInfo.version}`);

  if (config.repos.length === 0) {
    log.error("No repos configured. Add repos to graphify-tools.config.yml");
    process.exit(1);
  }

  // Create output directory
  const outputDir = resolve(configDir, config.output);
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  // Create temp directory for individual repo graphs
  const tmpDir = join(tmpdir(), `graphify-build-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });

  try {
    // 2. Run graphify on each repo
    // CLI usage: graphify <path> [--mode deep] [--no-viz] [--out <dir>]
    const repoGraphs: string[] = [];
    for (const repo of config.repos) {
      const repoPath = resolve(configDir, repo.path);
      if (!existsSync(repoPath)) {
        log.warn(`Repo not found, skipping: ${repoPath}`);
        continue;
      }

      const repoOutDir = join(tmpDir, repo.name);
      mkdirSync(repoOutDir, { recursive: true });
      const modeArgs = options.semantic ? "--mode deep" : "";
      const extraArgs = config.build.graphify_args.join(" ");
      // graphify <path> --no-viz --out <dir>
      const cmd = `${graphifyCmd} "${repoPath}" --no-viz --out "${repoOutDir}" ${modeArgs} ${extraArgs}`.trim();

      log.info(`Building graph for ${repo.name}...`);
      log.debug(`  Command: ${cmd}`);

      try {
        execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 600_000 });
        const graphJson = join(repoOutDir, "graph.json");
        if (existsSync(graphJson)) {
          repoGraphs.push(graphJson);
          log.info(`  \u2713 ${repo.name}`);
        } else {
          log.error(`  \u2717 ${repo.name}: graph.json not produced`);
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log.error(`  \u2717 ${repo.name}: ${msg}`);
      }
    }

    if (repoGraphs.length === 0) {
      log.error("No graphs were generated. Check repo paths and graphify installation.");
      process.exit(1);
    }

    // 3. Merge graphs via `graphify merge-graphs`
    const mergedPath = join(outputDir, "graph.json");
    if (repoGraphs.length > 1) {
      const filesArg = repoGraphs.map((f) => `"${f}"`).join(" ");
      const mergeCmd = `${graphifyCmd} merge-graphs ${filesArg} --out "${mergedPath}"`;
      log.info("Merging graphs...");
      execSync(mergeCmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    } else {
      // Single repo - just copy
      const { copyFileSync } = await import("node:fs");
      copyFileSync(repoGraphs[0]!, mergedPath);
    }
    log.info(`\u2713 Merged graph: ${mergedPath}`);

    // 4. Post-process
    const basePaths = config.repos.map((r) => resolve(configDir, r.path));
    postProcess(mergedPath, basePaths);

    // 5. Generate search index
    await runIndexer(mergedPath, outputDir);

    log.info("");
    log.info("Build complete!");
    log.info(`  Output: ${outputDir}`);
    log.info(`  Repos: ${config.repos.length}`);
  } finally {
    // Cleanup temp directory
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}
