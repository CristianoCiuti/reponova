import type { CommandModule } from "yargs";
import { loadConfig } from "../shared/config.js";
import { runBuild } from "../pipeline/build.js";
import { log } from "../shared/utils.js";

export const buildCommand: CommandModule = {
  command: "build",
  describe: "Build unified graph from configured repos",
  builder: (yargs) =>
    yargs
      .option("config", {
        type: "string",
        describe: "Path to reponova.yml",
      })
      .option("force", {
        type: "boolean",
        describe: "Force rebuild even if up-to-date",
        default: false,
      })
      .option("target", {
        type: "string",
        describe: "Run only this phase + its transitive dependencies (e.g. outlines, index, html)",
      }),
  handler: async (argv) => {
    try {
      const { config, configDir } = loadConfig(argv.config as string | undefined);
      await runBuild(config, configDir, {
        force: argv.force as boolean,
        target: argv.target as string | undefined,
      });
    } catch (err) {
      log.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
};
