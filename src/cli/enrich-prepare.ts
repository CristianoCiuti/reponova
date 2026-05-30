import { resolve } from "node:path";
import type { CommandModule } from "yargs";
import { loadConfig } from "../shared/config.js";
import { errorMessage, log } from "../shared/utils.js";
import type { PrepareStep } from "../pipeline/enrich/prepare.js";

export async function enrichPrepareHandler(argv: Record<string, unknown>): Promise<void> {
  try {
    const { config, configDir } = loadConfig(argv.config as string | undefined);
    const outputDir = resolve(configDir, config.output);
    const { runPrepare } = await import("../pipeline/enrich/prepare.js");
    const result = runPrepare({ outputDir, config, configDir }, argv.step as PrepareStep);
    console.log(`Prepared ${result.batchCount} input batch(es) in .enrich/input/${result.step}/`);
  } catch (err) {
    log.error(errorMessage(err));
    process.exit(1);
  }
}

/** @deprecated Use enrichPrepareHandler directly */
export const enrichPrepareCommand: CommandModule = {
  command: "enrich:prepare <step>",
  describe: "Prepare input batches for an enrichment step (agent reads these)",
  builder: (yargs) =>
    yargs
      .positional("step", {
        type: "string",
        choices: ["descriptions", "profiles", "routing", "restructure", "updated-profiles"] as const,
        describe: "Step to prepare input batches for",
        demandOption: true,
      })
      .option("config", { type: "string", describe: "Path to reponova.yml" }),
  handler: async (argv) => {
    await enrichPrepareHandler(argv as Record<string, unknown>);
  },
};
