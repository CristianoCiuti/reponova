import { resolve } from "node:path";
import type { CommandModule } from "yargs";
import { loadConfig } from "../shared/config.js";
import { errorMessage, log } from "../shared/utils.js";

export const enrichFinalizeCommand: CommandModule = {
  command: "enrich:finalize",
  describe: "Assemble final output files from .enrich/ intermediates",
  builder: (yargs) =>
    yargs.option("config", {
      type: "string",
      describe: "Path to reponova.yml",
    }),
  handler: async (argv) => {
    try {
      const { config, configDir } = loadConfig(argv.config as string | undefined);
      const outputDir = resolve(configDir, config.output);
      const { runFinalize } = await import("../pipeline/enrich/finalize.js");
      runFinalize(outputDir);
      console.log("Finalized: graph-enriched.json, node_descriptions.json, community_summaries.json");
    } catch (err) {
      log.error(errorMessage(err));
      process.exit(1);
    }
  },
};
