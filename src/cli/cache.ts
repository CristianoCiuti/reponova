import { resolve, join } from "node:path";
import type { CommandModule } from "yargs";
import { loadConfig } from "../shared/config.js";
import type { CacheContract, CacheContext } from "../pipeline/cache/index.js";
import { createDefaultRegistry } from "../pipeline/engine/registry.js";
import { validatePhaseOutputsExist } from "../pipeline/engine/phase-outputs.js";
import { errorMessage, log } from "../shared/utils.js";
import { fileDetectionContract } from "../pipeline/cache/contracts/file-detection.js";
import { graphContract } from "../pipeline/cache/contracts/graph.js";
import { outlinesContract } from "../pipeline/cache/contracts/outlines.js";
import { communitiesContract } from "../pipeline/cache/contracts/communities.js";
import { enrichContract } from "../pipeline/cache/contracts/enrich.js";
import { searchIndexContract } from "../pipeline/cache/contracts/search-index.js";
import { embeddingsContract } from "../pipeline/cache/contracts/embeddings.js";
import { htmlContract } from "../pipeline/cache/contracts/html.js";
import { reportContract } from "../pipeline/cache/contracts/report.js";

/** Map phase ID → its cache contract. */
const contractMap = new Map<string, CacheContract>([
  ["file-detection", fileDetectionContract],
  ["graph", graphContract],
  ["outlines", outlinesContract],
  ["communities", communitiesContract],
  ["enrich", enrichContract],
  ["index", searchIndexContract],
  ["embeddings", embeddingsContract],
  ["html", htmlContract],
  ["report", reportContract],
]);

export const cacheCommand: CommandModule = {
  command: "cache",
  describe: "Inspect and manage phase cache",
  builder: (yargs) =>
    yargs
      .option("check", {
        type: "string",
        describe: "Check if a phase cache is fresh (exit 0 = fresh, exit 1 = stale)",
      })
      .option("seal", {
        type: "string",
        describe: "Manually seal a phase cache",
      })
      .option("invalidate", {
        type: "string",
        describe: "Invalidate a phase cache",
      })
      .option("status", {
        type: "boolean",
        describe: "Show cache status for all phases",
        default: false,
      })
      .option("config", {
        type: "string",
        describe: "Path to reponova.yml",
      })
      .check((argv) => {
        const ops = [argv.check, argv.seal, argv.invalidate, argv.status].filter(Boolean);
        if (ops.length === 0) {
          throw new Error("Specify one of: --check, --seal, --invalidate, or --status");
        }
        if (ops.length > 1) {
          throw new Error("Only one operation at a time: --check, --seal, --invalidate, or --status");
        }
        return true;
      }),
  handler: async (argv) => {
    try {
      const { config, configDir } = loadConfig(argv.config as string | undefined);
      const outputDir = resolve(configDir, config.output);
      const cacheCtx: CacheContext = {
        outputDir,
        cacheDir: join(outputDir, ".cache"),
        config,
      };

      if (argv.check) {
        const phaseId = argv.check as string;
        const contract = getContract(phaseId);
        const result = contract.check(cacheCtx);
        if (result.fresh) {
          console.log(`Phase ${phaseId} is fresh: ${result.reason}`);
          process.exit(0);
        }
        console.log(`Phase ${phaseId} is stale: ${result.reason}`);
        process.exit(1);
      }

      if (argv.seal) {
        const phaseId = argv.seal as string;
        const contract = getContract(phaseId);
        validatePhaseOutputsExist(phaseId, outputDir);
        contract.seal(cacheCtx);
        console.log(`Phase ${phaseId} sealed.`);
        process.exit(0);
      }

      if (argv.invalidate) {
        const phaseId = argv.invalidate as string;
        const contract = getContract(phaseId);
        contract.invalidate(cacheCtx);
        console.log(`Phase ${phaseId} invalidated.`);
        process.exit(0);
      }

      const registry = createDefaultRegistry();
      const rows = registry.getAll().map((phase) => {
        const contract = contractMap.get(phase.id);
        const result = contract
          ? contract.check(cacheCtx)
          : { fresh: false, reason: "no contract" };
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
    } catch (err) {
      log.error(errorMessage(err));
      process.exit(1);
    }
  },
};

function getContract(phaseId: string): CacheContract {
  const contract = contractMap.get(phaseId);
  if (!contract) {
    const available = [...contractMap.keys()].join(", ");
    throw new Error(`Phase "${phaseId}" has no cache contract. Available: ${available}`);
  }
  return contract;
}

function pad(value: string, width: number): string {
  return value.padEnd(width, " ");
}
