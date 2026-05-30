import type { CommandModule } from "yargs";
import type { Target } from "./types.js";
import { installOpenCode } from "./targets/opencode.js";
import { installCursor } from "./targets/cursor.js";
import { installClaude } from "./targets/claude.js";
import { installVSCode } from "./targets/vscode.js";

export { _testing } from "./utils.js";

export async function installHandler(argv: Record<string, unknown>): Promise<void> {
  const target = argv.target as Target;
  const graphDir = (argv.graph as string) ?? "./reponova-out";
  const ctx = { projectDir: process.cwd(), graphDir };

  switch (target) {
    case "opencode":
      installOpenCode(ctx);
      break;
    case "cursor":
      installCursor(ctx);
      break;
    case "claude":
      installClaude(ctx);
      break;
    case "vscode":
      installVSCode(ctx);
      break;
  }
}

/** @deprecated Use installHandler directly */
export const installCommand: CommandModule = {
  command: "install",
  describe: "Install reponova MCP server and hooks for your editor",
  builder: (yargs) =>
    yargs
      .option("target", {
        type: "string",
        describe: "Editor/tool to configure",
        choices: ["opencode", "cursor", "claude", "vscode"] as const,
        demandOption: true,
      })
      .option("graph", {
        type: "string",
        describe: "Path to reponova-out/ directory (default: ./reponova-out)",
      }),
  handler: async (argv) => {
    await installHandler(argv as Record<string, unknown>);
  },
};
