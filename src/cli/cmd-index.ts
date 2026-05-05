import type { CommandModule } from "yargs";
import { resolveGraphPath, resolveGraphJson } from "../core/graph-resolver.js";
import { invalidateManifestStep, validateManifestStep } from "../build/manifest.js";
import { runIndexerStep } from "../build/steps/indexer.js";
import { log } from "../shared/utils.js";
import type { StepContext } from "../build/types.js";
import { DEFAULT_CONFIG } from "../shared/types.js";

export const indexCommand: CommandModule = {
  command: "index",
  describe: "Generate SQLite search index from graph.json",
  builder: (yargs) =>
    yargs.option("graph", {
      type: "string",
      describe: "Path to reponova-out/ directory",
    }),
  handler: async (argv) => {
    const graphDir = resolveGraphPath(argv.graph as string | undefined);

    if (!graphDir) {
      log.error("Could not find reponova-out directory. Use --graph flag.");
      process.exit(1);
    }

    const graphJsonPath = resolveGraphJson(graphDir);
    if (!graphJsonPath) {
      log.error(`graph.json not found in ${graphDir}`);
      process.exit(1);
    }

    invalidateManifestStep(graphDir, "indexer");

    log.info(`Indexing ${graphJsonPath}...`);
    const stepContext: StepContext = {
      config: DEFAULT_CONFIG,
      outputDir: graphDir,
      graphJsonPath,
      force: true,
      graphChanged: true,
      previousConfig: null,
    };

    const result = await runIndexerStep(stepContext);
    if (result.skipped) {
      log.info(`Search index skipped: ${result.skipReason ?? "up to date"}`);
    } else {
      log.info(`Search index created with ${result.processed} nodes`);
    }

    validateManifestStep(graphDir, "indexer");
  },
};
