import { writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
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

export function installCursor(ctx: InstallerContext): void {
  const { projectDir, graphDir } = ctx;

  // 1. Register MCP server
  const cursorDir = resolve(projectDir, ".cursor");
  const mcpPath = resolveJsonConfigPath(cursorDir, "mcp");

  let text = readJsoncText(mcpPath);
  text = setJsoncProperty(text, ["mcpServers", "reponova"], {
    command: "npx",
    args: ["-y", "reponova", "mcp", "--graph", graphDir],
  });

  ensureDir(cursorDir);
  writeFileSync(mcpPath, withTrailingNewline(text));

  // 2. Write MCP rule (alwaysApply: true — serves as both nudge + guide)
  const rulesDir = resolve(projectDir, ".cursor", "rules");
  const mcpRulePath = join(rulesDir, "reponova-mcp.mdc");
  ensureDir(rulesDir);
  writeFileSync(
    mcpRulePath,
    `---\ndescription: reponova knowledge graph — use graph tools instead of grep/find\nalwaysApply: true\n---\n\n${MCP_SKILL_MD}`,
  );

  // 3. Write enrich COMMAND (NOT a rule — user invokes with /reponova-enrich)
  const commandsDir = resolve(projectDir, ".cursor", "commands");
  const enrichCommandPath = join(commandsDir, "reponova-enrich.md");
  ensureDir(commandsDir);
  writeFileSync(enrichCommandPath, ENRICH_COMMAND_MD);

  // 4. Write config file
  const configWritten = writeConfigFile(cursorDir);

  console.log(`\u2713 Cursor MCP server registered: ${mcpPath}`);
  console.log(`\u2713 Cursor MCP rule (always-on): ${mcpRulePath}`);
  console.log(`\u2713 Cursor enrich command: ${enrichCommandPath}`);
  if (configWritten) console.log(`\u2713 Config file created: ${configWritten}`);
  console.log("");
  console.log("  Restart Cursor for changes to take effect.");
  console.log("  Type /reponova-enrich to run the enrichment workflow.");
}
