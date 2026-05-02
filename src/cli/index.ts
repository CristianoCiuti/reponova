import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { mcpCommand } from "./mcp.js";
import { buildCommand } from "./build.js";
import { indexCommand } from "./cmd-index.js";
import { outlineCommand } from "./outline.js";
import { checkCommand } from "./check.js";
import { installCommand } from "./install.js";
import { modelsCommand } from "./models.js";

yargs(hideBin(process.argv))
  .scriptName("reponova")
  .usage("$0 <command> [options]")
  .command(mcpCommand)
  .command(buildCommand)
  .command(indexCommand)
  .command(outlineCommand)
  .command(checkCommand)
  .command(installCommand)
  .command(modelsCommand)
  .option("graph", {
    type: "string",
    describe: "Path to reponova-out/ directory",
    global: true,
  })
  .option("config", {
    type: "string",
    describe: "Path to reponova.yml",
    global: true,
  })
  .demandCommand(1, "Please specify a command")
  .strict()
  .strictCommands()
  .help()
  .version()
  .parse();
