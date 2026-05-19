import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { cacheCommand } from "./cache.js";
import { mcpCommand } from "./mcp.js";
import { buildCommand } from "./build.js";
import { checkCommand } from "./check.js";
import { installCommand } from "./install.js";
import { modelsCommand } from "./models.js";

yargs(hideBin(process.argv))
  .scriptName("reponova")
  .usage("$0 <command> [options]")
  .command(cacheCommand)
  .command(mcpCommand)
  .command(buildCommand)
  .command(checkCommand)
  .command(installCommand)
  .command(modelsCommand)
  .demandCommand(1, "Please specify a command")
  .strict()
  .strictCommands()
  .help()
  .version()
  .parse();
