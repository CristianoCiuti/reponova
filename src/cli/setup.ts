import type { CommandModule } from "yargs";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { log } from "../shared/utils.js";

export const setupCommand: CommandModule = {
  command: "setup",
  describe: "Auto-configure MCP for editors (OpenCode, Cursor, Claude Code)",
  builder: (yargs) =>
    yargs.option("editor", {
      type: "string",
      describe: "Editor to configure",
      choices: ["opencode", "cursor", "claude"],
      demandOption: true,
    }),
  handler: async (argv) => {
    const editor = argv.editor as string;
    const graphDir = resolve(process.cwd(), "graphify-out");

    switch (editor) {
      case "opencode":
        configureOpenCode(graphDir);
        break;
      case "cursor":
        configureCursor(graphDir);
        break;
      case "claude":
        configureClaude(graphDir);
        break;
      default:
        log.error(`Unknown editor: ${editor}`);
        process.exit(1);
    }
  },
};

function configureOpenCode(graphDir: string): void {
  const configDir = resolve(process.cwd(), ".opencode");
  const configPath = join(configDir, "opencode.json");

  let config: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    config = JSON.parse(readFileSync(configPath, "utf-8"));
  }

  if (!config.mcpServers) config.mcpServers = {};
  const servers = config.mcpServers as Record<string, unknown>;

  servers["graphify"] = {
    command: "npx",
    args: ["-y", "graphify-mcp-tools", "mcp", "--graph", graphDir],
  };

  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log(`\u2713 OpenCode configured: ${configPath}`);
  console.log(`  MCP server: graphify-mcp-tools mcp --graph ${graphDir}`);
}

function configureCursor(graphDir: string): void {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const configPath = join(home, ".cursor", "mcp.json");
  const configDir = join(home, ".cursor");

  let config: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    config = JSON.parse(readFileSync(configPath, "utf-8"));
  }

  if (!config.mcpServers) config.mcpServers = {};
  const servers = config.mcpServers as Record<string, unknown>;

  servers["graphify"] = {
    command: "npx",
    args: ["-y", "graphify-mcp-tools", "mcp", "--graph", graphDir],
  };

  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log(`\u2713 Cursor configured: ${configPath}`);
}

function configureClaude(graphDir: string): void {
  console.log("To configure Claude Code, run:");
  console.log("");
  console.log(`  claude mcp add graphify -- npx -y graphify-mcp-tools mcp --graph ${graphDir}`);
  console.log("");
  console.log("Or add to your Claude Code settings manually.");
}
