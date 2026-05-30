import { resolve } from "node:path";
import type { CommandModule } from "yargs";
import { loadConfig } from "../shared/config.js";
import { runBuild } from "../pipeline/build.js";
import { createDefaultRegistry } from "../pipeline/engine/registry.js";
import { BuildManifest } from "../pipeline/engine/manifest.js";
import type { PhaseContext } from "../pipeline/engine/phase.js";
import { ProviderRegistry } from "../intelligence/provider-registry.js";
import { log, errorMessage } from "../shared/utils.js";

export async function buildHandler(argv: Record<string, unknown>): Promise<void> {
  try {
    const { config, configDir } = loadConfig(argv.config as string | undefined);

    if (argv.check) {
      const phaseId = argv.check as string;
      const registry = createDefaultRegistry();
      const phase = registry.get(phaseId);
      const outputDir = resolve(configDir, config.output);
      const ctx: PhaseContext = {
        config,
        configDir,
        outputDir,
        workspace: outputDir,
        force: false,
        manifest: new BuildManifest(outputDir),
        providerRegistry: new ProviderRegistry(config.providers, config.models),
      };

      try {
        const result = phase.needsRun(ctx);
        if (result.needsRun) {
          console.log(`Phase ${phaseId} needs to run: ${result.reason}`);
          process.exit(1);
        }
        console.log(`Phase ${phaseId} is up to date: ${result.reason}`);
        process.exit(0);
      } finally {
        await ctx.providerRegistry.disposeAll();
      }
    }

    await runBuild(config, configDir, {
      force: (argv.force as boolean) || false,
      target: argv.target ? (argv.target as string).split(",") : undefined,
      startAfter: argv["start-after"] as string | undefined,
    });
  } catch (err) {
    log.error(errorMessage(err));
    process.exit(1);
  }
}

/** @deprecated Use buildHandler directly — kept for backward compat */
export const buildCommand: CommandModule = {
  command: "build",
  describe: "Build unified graph from configured repos",
  builder: (yargs) =>
    yargs
      .option("config", { type: "string", describe: "Path to reponova.yml" })
      .option("force", { type: "boolean", describe: "Force rebuild even if up-to-date" })
      .option("target", { type: "string", describe: "Run only this phase + its transitive dependencies" })
      .option("start-after", { type: "string", describe: "Run only phases downstream of this phase" })
      .option("check", { type: "string", describe: "Check if a phase needs to run" })
      .conflicts("target", "start-after")
      .conflicts("check", "target")
      .conflicts("check", "start-after")
      .conflicts("check", "force"),
  handler: async (argv) => {
    await buildHandler(argv as Record<string, unknown>);
  },
};
