import type { CommandModule } from "yargs";
import { loadConfig } from "../core/config.js";
import { runBuild } from "../build/orchestrator.js";

export const buildCommand: CommandModule = {
  command: "build",
  describe: "Build unified graph from configured repos",
  builder: (yargs) =>
    yargs
      .option("config", {
        type: "string",
        describe: "Path to graphify-mcp-tools.yml",
      })
      .option("force", {
        type: "boolean",
        describe: "Force rebuild even if up-to-date",
        default: false,
      }),
  handler: async (argv) => {
    const { config, configDir } = loadConfig(argv.config as string | undefined);
    await runBuild(config, configDir, { force: argv.force as boolean });
  },
};
