import { resolve } from "node:path";
import type { CommandModule } from "yargs";
import { loadConfig } from "../shared/config.js";
import { errorMessage, log } from "../shared/utils.js";

export const enrichMetricsCommand: CommandModule = {
  command: "enrich:metrics",
  describe: "Compute graph metrics and classify candidates for enrichment",
  builder: (yargs) =>
    yargs.option("config", {
      type: "string",
      describe: "Path to reponova.yml",
    }),
  handler: async (argv) => {
    try {
      const { config, configDir } = loadConfig(argv.config as string | undefined);
      const outputDir = resolve(configDir, config.output);
      const { runMetrics } = await import("../pipeline/enrich/metrics.js");
      const result = runMetrics({ outputDir, candidateThreshold: config.enrich.candidate_threshold });
      console.log(`Candidates: ${result.candidateCount}/${result.totalNodes} (threshold: ${config.enrich.candidate_threshold})`);
    } catch (err) {
      log.error(errorMessage(err));
      process.exit(1);
    }
  },
};
