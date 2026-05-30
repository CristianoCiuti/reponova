import { resolve } from "node:path";
import type { CommandModule } from "yargs";
import { loadConfig } from "../shared/config.js";
import { createDefaultRegistry } from "../pipeline/engine/registry.js";
import { BuildManifest } from "../pipeline/engine/manifest.js";
import type { PhaseContext } from "../pipeline/engine/phase.js";
import { ProviderRegistry } from "../intelligence/provider-registry.js";
import { errorMessage, log } from "../shared/utils.js";

function pad(value: string, width: number): string {
  return value.padEnd(width, " ");
}

export async function cacheHandler(argv: Record<string, unknown>): Promise<void> {
  try {
    const { config, configDir } = loadConfig(argv.config as string | undefined);
    const outputDir = resolve(configDir, config.output);
    const registry = createDefaultRegistry();
    const ctx: PhaseContext = {
      config,
      configDir,
      outputDir,
      workspace: outputDir,
      force: false,
      manifest: new BuildManifest(outputDir),
      providerRegistry: new ProviderRegistry(config.providers, config.models),
    };

    try {
      if (argv.check) {
        const phaseId = argv.check as string;
        const phase = registry.get(phaseId);
        const result = phase.checkCacheFreshness(ctx);
        if (result.fresh) {
          console.log(`Phase ${phaseId} is fresh: ${result.reason}`);
          process.exit(0);
        }
        console.log(`Phase ${phaseId} is stale: ${result.reason}`);
        process.exit(1);
      }

      if (argv.seal) {
        const phaseId = argv.seal as string;
        const phase = registry.get(phaseId);
        phase.sealCache(ctx);
        console.log(`Phase ${phaseId} sealed.`);
        process.exit(0);
      }

      if (argv.invalidate) {
        const phaseId = argv.invalidate as string;
        const phase = registry.get(phaseId);
        phase.invalidateCache(ctx);
        console.log(`Phase ${phaseId} invalidated.`);
        process.exit(0);
      }

      const rows = registry.getAll().map((phase) => {
        const result = phase.checkCacheFreshness(ctx);
        return {
          phase: phase.id,
          status: result.fresh ? "fresh" : "stale",
          reason: result.reason,
        };
      });

      const phaseWidth = Math.max("Phase".length, ...rows.map((row) => row.phase.length));
      const statusWidth = Math.max("Status".length, ...rows.map((row) => row.status.length));

      console.log(
        `${pad("Phase", phaseWidth)}  ${pad("Status", statusWidth)}  Reason`,
      );
      console.log(
        `${pad("-".repeat("Phase".length), phaseWidth)}  ${pad("-".repeat("Status".length), statusWidth)}  ${"-".repeat("Reason".length)}`,
      );
      for (const row of rows) {
        console.log(`${pad(row.phase, phaseWidth)}  ${pad(row.status, statusWidth)}  ${row.reason}`);
      }
      process.exit(0);
    } finally {
      await ctx.providerRegistry.disposeAll();
    }
  } catch (err) {
    log.error(errorMessage(err));
    process.exit(1);
  }
}

/** @deprecated Use cacheHandler directly */
export const cacheCommand: CommandModule = {
  command: "cache",
  describe: "Inspect and manage phase cache",
  builder: (yargs) =>
    yargs
      .option("check", { type: "string", describe: "Check if a phase cache is fresh" })
      .option("seal", { type: "string", describe: "Manually seal a phase cache" })
      .option("invalidate", { type: "string", describe: "Invalidate a phase cache" })
      .option("status", { type: "boolean", describe: "Show cache status for all phases", default: false })
      .option("config", { type: "string", describe: "Path to reponova.yml" })
      .check((a) => {
        const ops = [a.check, a.seal, a.invalidate, a.status].filter(Boolean);
        if (ops.length === 0) throw new Error("Specify one of: --check, --seal, --invalidate, or --status");
        if (ops.length > 1) throw new Error("Only one operation at a time");
        return true;
      }),
  handler: async (argv) => {
    await cacheHandler(argv as Record<string, unknown>);
  },
};
