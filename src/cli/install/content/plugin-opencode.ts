/**
 * OpenCode plugin JS template.
 * Reminds the agent that MCP graph tools exist on first bash execution.
 */
export const OPENCODE_PLUGIN_JS = `// reponova OpenCode plugin
// Reminds the agent that MCP graph tools exist and to consult the reponova-mcp skill.
import { existsSync } from "fs";
import { join } from "path";

export const ReponovaMcpPlugin = async ({ directory }) => {
  let reminded = false;

  return {
    "tool.execute.before": async (input, output) => {
      if (reminded) return;
      if (!existsSync(join(directory, "reponova-out", "graph.json"))) return;

      if (input.tool === "bash") {
        output.args.command =
          'echo "[reponova] 11 MCP graph tools available. Consult the reponova-mcp skill to know which tool to use. Use graph_search instead of grep/find." && ' +
          output.args.command;
        reminded = true;
      }
    },
  };
};
`;
