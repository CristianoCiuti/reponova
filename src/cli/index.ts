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
  .scriptName("graphify-mcp-tools")
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
    describe: "Path to graphify-out/ directory",
    global: true,
  })
  .option("config", {
    type: "string",
    describe: "Path to graphify-mcp-tools.yml",
    global: true,
  })
  .demandCommand(1, "Please specify a command")
  .strict()
  .help()
  .version()
  .parse();
