import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { cacheCommand } from "./cache.js";
import { mcpCommand } from "./mcp.js";
import { buildCommand } from "./build.js";
import { checkCommand } from "./check.js";
import { installCommand } from "./install.js";
import { modelsCommand } from "./models.js";
import { enrichCommand } from "./enrich.js";
import { enrichMetricsCommand } from "./enrich-metrics.js";
import { enrichMergeCommand } from "./enrich-merge.js";
import { enrichApplyCommand } from "./enrich-apply.js";
import { enrichFinalizeCommand } from "./enrich-finalize.js";

yargs(hideBin(process.argv))
  .scriptName("reponova")
  .usage("$0 <command> [options]")
  .command(cacheCommand)
  .command(mcpCommand)
  .command(buildCommand)
  .command(checkCommand)
  .command(installCommand)
  .command(modelsCommand)
  .command(enrichCommand)
  .command(enrichMetricsCommand)
  .command(enrichMergeCommand)
  .command(enrichApplyCommand)
  .command(enrichFinalizeCommand)
  .demandCommand(1, "Please specify a command")
  .strict()
  .strictCommands()
  .help()
  .version()
  .parse();
