import { resolve } from "node:path";
import type { CommandModule } from "yargs";
import { loadConfig } from "../shared/config.js";
import { errorMessage, log } from "../shared/utils.js";
import type { MergeStep } from "../pipeline/enrich/merge.js";

export const enrichMergeCommand: CommandModule = {
  command: "enrich:merge <step>",
  describe: "Merge batch output files into step's final file",
  builder: (yargs) =>
    yargs
      .positional("step", {
        type: "string",
        choices: ["descriptions", "profiles", "routing", "updated-profiles"] as const,
        describe: "Step to merge",
        demandOption: true,
      })
      .option("config", {
        type: "string",
        describe: "Path to reponova.yml",
      }),
  handler: async (argv) => {
    try {
      const { config, configDir } = loadConfig(argv.config as string | undefined);
      const outputDir = resolve(configDir, config.output);
      const { runMerge } = await import("../pipeline/enrich/merge.js");
      const result = runMerge(outputDir, argv.step as MergeStep);
      console.log(`Merged ${result.merged} batch files into .enrich/${argv.step}.json`);
    } catch (err) {
      log.error(errorMessage(err));
      process.exit(1);
    }
  },
};
