import type { CommandModule } from "yargs";
import { startMcpServer } from "../mcp/server.js";

export const mcpCommand: CommandModule = {
  command: "mcp",
  describe: "Start MCP server (stdio)",
  builder: (yargs) =>
    yargs.option("graph", {
      type: "string",
      describe: "Path to graphify-out/ directory",
    }),
  handler: async (argv) => {
    await startMcpServer({
      graphPath: argv.graph as string | undefined,
    });
  },
};
