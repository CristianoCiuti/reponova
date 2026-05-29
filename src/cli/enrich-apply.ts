import { resolve } from "node:path";
import type { CommandModule } from "yargs";
import { loadConfig } from "../shared/config.js";
import { errorMessage, log } from "../shared/utils.js";

export const enrichApplyCommand: CommandModule = {
  command: "enrich:apply",
  describe: "Apply routing and restructure decisions to graph",
  builder: (yargs) =>
    yargs.option("config", {
      type: "string",
      describe: "Path to reponova.yml",
    }),
  handler: async (argv) => {
    try {
      const { config, configDir } = loadConfig(argv.config as string | undefined);
      const outputDir = resolve(configDir, config.output);
      const { runApply } = await import("../pipeline/enrich/apply.js");
      const result = runApply(outputDir);
      console.log(`Applied: ${result.moved} moved, ${result.merged} merged, ${result.split} split`);
    } catch (err) {
      log.error(errorMessage(err));
      process.exit(1);
    }
  },
};
