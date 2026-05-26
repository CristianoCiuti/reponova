import { writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import type { InstallerContext } from "../types.js";
import {
  resolveJsonConfigPath,
  readJsoncText,
  setJsoncProperty,
  withTrailingNewline,
  ensureDir,
  writeConfigFile,
} from "../utils.js";
import { MCP_SKILL_MD } from "../content/mcp-skill.js";
import { ENRICH_COMMAND_MD } from "../content/enrich-command.js";
import { OPENCODE_PLUGIN_JS } from "../content/plugin-opencode.js";

export function installOpenCode(ctx: InstallerContext): void {
  const { projectDir, graphDir } = ctx;
  const configDir = resolve(projectDir, ".opencode");
  const configPath = resolveJsonConfigPath(configDir, "opencode");

  // 1. Register MCP server
  let text = readJsoncText(configPath);
  text = setJsoncProperty(text, ["mcp", "reponova"], {
    type: "local",
    command: ["npx", "-y", "reponova", "mcp", "--graph", graphDir],
  });

  // 2. Register plugin
  const pluginRelPath = ".opencode/plugins/reponova.js";
  const data = (parseJsonc(text) ?? {}) as Record<string, unknown>;
  const plugins = (data.plugin as string[] | undefined) ?? [];
  if (!plugins.includes(pluginRelPath)) {
    plugins.push(pluginRelPath);
  }
  text = setJsoncProperty(text, ["plugin"], plugins);

  ensureDir(configDir);
  writeFileSync(configPath, withTrailingNewline(text));

  // 3. Write plugin file
  const pluginDir = resolve(projectDir, ".opencode", "plugins");
  const pluginPath = join(pluginDir, "reponova.js");
  ensureDir(pluginDir);
  writeFileSync(pluginPath, OPENCODE_PLUGIN_JS);

  // 4. Write MCP skill (passive knowledge)
  const mcpSkillDir = resolve(projectDir, ".opencode", "skills", "reponova-mcp");
  const mcpSkillPath = join(mcpSkillDir, "SKILL.md");
  ensureDir(mcpSkillDir);
  writeFileSync(
    mcpSkillPath,
    `---\nname: reponova-mcp\ndescription: Knowledge graph MCP tools — use instead of grep/find for structural code questions.\n---\n\n${MCP_SKILL_MD}`,
  );

  // 5. Write enrich COMMAND (NOT a skill — user invokes with /reponova-enrich)
  const commandsDir = resolve(projectDir, ".opencode", "commands");
  const enrichCommandPath = join(commandsDir, "reponova-enrich.md");
  ensureDir(commandsDir);
  writeFileSync(
    enrichCommandPath,
    `---\ndescription: Intelligent enrichment workflow for the reponova knowledge graph\n---\n\n${ENRICH_COMMAND_MD}`,
  );

  // 6. Write config file
  const configWritten = writeConfigFile(configDir);

  console.log(`\u2713 OpenCode MCP server registered: ${configPath}`);
  console.log(`\u2713 OpenCode plugin installed: ${pluginPath}`);
  console.log(`\u2713 OpenCode MCP skill: ${mcpSkillPath}`);
  console.log(`\u2713 OpenCode enrich command: ${enrichCommandPath}`);
  if (configWritten) console.log(`\u2713 Config file created: ${configWritten}`);
  console.log("");
  console.log("  The MCP server starts automatically with OpenCode.");
  console.log("  The plugin reminds the agent to consult the reponova-mcp skill.");
  console.log("  Type /reponova-enrich to run the enrichment workflow.");
}
