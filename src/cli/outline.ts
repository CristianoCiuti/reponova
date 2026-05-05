/**
 * CLI command: outline
 */
import type { CommandModule } from "yargs";
import { resolve } from "node:path";
import { loadConfig } from "../core/config.js";
import { resolveGraphPath } from "../core/graph-resolver.js";
import { runOutlinesStep } from "../build/steps/outlines.js";
import { invalidateManifestStep, validateManifestStep } from "../build/manifest.js";
import { log } from "../shared/utils.js";
import type { StepContext } from "../build/types.js";

export const outlineCommand: CommandModule = {
  command: "outline",
  describe: "Pre-compute outlines for configured file patterns",
  builder: (yargs) =>
    yargs
      .option("config", { type: "string", describe: "Path to reponova.yml" })
      .option("graph", { type: "string", describe: "Path to reponova-out/ directory" })
      .option("force", { type: "boolean", describe: "Regenerate all outlines", default: false }),
  handler: async (argv) => {
    const { config, configDir } = loadConfig(argv.config as string | undefined);

    if (!config.outlines.enabled) {
      log.info("Outlines are disabled in config");
      return;
    }

    const outputDir = argv.graph
      ? resolveGraphPath(argv.graph as string) ?? resolve(configDir, config.output)
      : resolve(configDir, config.output);

    invalidateManifestStep(outputDir, "outlines");

    const stepContext: StepContext = {
      config,
      configDir,
      outputDir,
      graphJsonPath: resolve(outputDir, "graph.json"),
      force: argv.force as boolean,
      graphChanged: true,
      previousConfig: null,
    };

    log.info(`Generating outlines in ${outputDir}/outlines...`);
    const result = await runOutlinesStep(stepContext);
    if (result.skipped) {
      log.info(`Outlines skipped: ${result.skipReason ?? "up to date"}`);
    } else {
      log.info(`Generated ${result.processed} outlines`);
    }

    validateManifestStep(outputDir, "outlines");
  },
};
