/**
 * CLI command: outline
 *
 * Standalone command to pre-compute outlines.
 * Delegates to the shared runOutlineGeneration (same logic used by `build`).
 */
import type { CommandModule } from "yargs";
import { join } from "node:path";
import { loadConfig } from "../core/config.js";
import { resolveGraphPath } from "../core/graph-resolver.js";
import { runOutlineGeneration } from "../build/outlines.js";
import { log } from "../shared/utils.js";

export const outlineCommand: CommandModule = {
  command: "outline",
  describe: "Pre-compute outlines for configured file patterns",
  builder: (yargs) =>
    yargs
      .option("config", { type: "string", describe: "Path to reponova.yml" })
      .option("force", { type: "boolean", describe: "Regenerate all outlines", default: false }),
  handler: async (argv) => {
    const { config, configDir } = loadConfig(argv.config as string | undefined);

    if (!config.outlines.enabled) {
      log.info("Outlines are disabled in config");
      return;
    }

    const outputDir = resolveGraphPath(argv.graph as string | undefined) ?? join(configDir, config.output);

    log.info(`Generating outlines in ${outputDir}/outlines...`);
    const count = await runOutlineGeneration(config, configDir, outputDir, { force: argv.force as boolean });
    log.info(`Generated ${count} outlines`);
  },
};
