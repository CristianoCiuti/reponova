import { resolve } from "node:path";
import type { CommandModule } from "yargs";
import { loadConfig } from "../shared/config.js";
import { ProviderRegistry } from "../intelligence/provider-registry.js";
import { errorMessage, log } from "../shared/utils.js";

export const enrichCommand: CommandModule = {
  command: "enrich",
  describe: "Run full intelligent enrichment (requires enrich.provider configured)",
  builder: (yargs) =>
    yargs.option("config", {
      type: "string",
      describe: "Path to reponova.yml",
    }),
  handler: async (argv) => {
    try {
      const { config, configDir } = loadConfig(argv.config as string | undefined);
      const outputDir = resolve(configDir, config.output);

      if (!config.enrich.provider) {
        console.error("Error: enrich.provider must be configured for intelligent enrichment.");
        console.error("Use 'reponova build' for algorithmic mode (no provider needed).");
        process.exit(1);
      }

      // 1. Ensure structural graph exists (build up to communities)
      const { runBuild } = await import("../pipeline/build.js");
      await runBuild(config, configDir, { target: "communities" });

      // 2. Run enrichment
      const { runFullEnrichment } = await import("../pipeline/enrich/orchestrator.js");
      const providerRegistry = new ProviderRegistry(config.providers, config.models);
      try {
        const result = await runFullEnrichment({ config, outputDir, configDir, providerRegistry });
        console.log(`Enrichment complete: ${result.totalLlmCalls} LLM calls`);

        // 3. Seal cache
        const { createDefaultRegistry } = await import("../pipeline/engine/registry.js");
        const { BuildManifest } = await import("../pipeline/engine/manifest.js");
        const registry = createDefaultRegistry();
        const enrichPhase = registry.get("enrich");
        enrichPhase.sealCache({
          config,
          configDir,
          outputDir,
          workspace: outputDir,
          force: false,
          manifest: new BuildManifest(outputDir),
          providerRegistry,
        });
        console.log("Cache sealed.");
      } finally {
        await providerRegistry.disposeAll();
      }
    } catch (err) {
      log.error(errorMessage(err));
      process.exit(1);
    }
  },
};
