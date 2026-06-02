/**
 * Build entry point — sets up workspace, creates registry, runs orchestrator.
 *
 * This replaces the old src/build/orchestrator.ts.
 * Both the CLI and the programmatic API call this.
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve, join, basename } from "node:path";
import { tmpdir } from "node:os";
import type { Config } from "../shared/types.js";
import { loadConfig } from "../shared/config.js";
import { createPathContext, prepareWorkspace, buildSkipDirs } from "../shared/path-resolver.js";
import { log } from "../shared/utils.js";
import { createDefaultRegistry } from "./engine/registry.js";
import { orchestrate, type BuildResult, type OrchestratorOptions } from "./engine/orchestrator.js";
import type { PhaseContext } from "./engine/phase.js";
import { BuildManifest } from "./engine/manifest.js";
import { ProviderRegistry } from "../intelligence/provider-registry.js";
import { discoverLanguagePlugins } from "../plugin/discovery.js";

export interface BuildOptions {
  force?: boolean;
  target?: string | string[];
  startAfter?: string;
}

/**
 * Run the full build pipeline (or a subset via --target).
 *
 * Programmatic API entry point.
 */
export async function build(configPath?: string, options?: BuildOptions): Promise<BuildResult> {
  const { config, configDir } = loadConfig(configPath);
  return runBuild(config, configDir, options ?? {});
}

/**
 * Run the build pipeline with an already-loaded config.
 */
export async function runBuild(config: Config, configDir: string, options: BuildOptions): Promise<BuildResult> {
  log.info("reponova build (pipeline engine)");

  // Discover and register language plugins before anything else
  await discoverLanguagePlugins();

  if (config.repos.length === 0) {
    throw new Error("No repos configured. Add repos to reponova.yml");
  }

  const outputDir = resolve(configDir, config.output);
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  // Ensure .cache directory exists
  const cacheDir = join(outputDir, ".cache");
  if (!existsSync(cacheDir)) {
    mkdirSync(cacheDir, { recursive: true });
  }

  const tmpDir = join(tmpdir(), `rn-build-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });

  try {
    // Resolve workspace (single-repo = repo root, multi-repo = symlink workspace)
    const skipDirs = buildSkipDirs(config.exclude_common);
    skipDirs.add(basename(outputDir));

    const pathContext = createPathContext(config, configDir, outputDir);
    const workspace = prepareWorkspace(pathContext, tmpDir, skipDirs);

    log.info(`Build${config.incremental && !options.force ? " (incremental)" : ""} [${pathContext.mode}-repo mode]...`);

    // Create phase context
    const providerRegistry = new ProviderRegistry(config.providers, config.models);
    const ctx: PhaseContext = {
      config,
      configDir,
      outputDir,
      workspace,
      force: options.force ?? false,
      manifest: new BuildManifest(outputDir),
      providerRegistry,
    };

    // Create registry with all phases
    const registry = createDefaultRegistry();

    // Run orchestrator
    const orchestratorOptions: OrchestratorOptions = {
      target: options.target,
      startAfter: options.startAfter,
      force: options.force ?? false,
    };

    try {
      const result = await orchestrate(registry, ctx, orchestratorOptions);

      log.info("");
      log.info("Build complete!");
      log.info(`  Output: ${outputDir}`);
      log.info(`  Phases: ${result.phases.size}`);
      log.info(`  Total processed: ${result.totalProcessed}`);

      return result;
    } finally {
      await providerRegistry.disposeAll();
    }
  } finally {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}
