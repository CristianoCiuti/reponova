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

export function installVSCode(ctx: InstallerContext): void {
  const { projectDir, graphDir } = ctx;

  // 1. Register MCP server
  const vscodeDir = resolve(projectDir, ".vscode");
  const mcpPath = resolveJsonConfigPath(vscodeDir, "mcp");

  let text = readJsoncText(mcpPath);
  text = setJsoncProperty(text, ["servers", "reponova"], {
    type: "stdio",
    command: "npx",
    args: ["-y", "reponova", "mcp", "--graph", graphDir],
  });

  ensureDir(vscodeDir);
  writeFileSync(mcpPath, withTrailingNewline(text));

  // 2. Write MCP skill (passive — user-invocable: false, auto-loaded when relevant)
  const githubDir = resolve(projectDir, ".github");
  const mcpSkillDir = resolve(githubDir, "skills", "reponova-mcp");
  const mcpSkillPath = join(mcpSkillDir, "SKILL.md");
  ensureDir(mcpSkillDir);
  writeFileSync(
    mcpSkillPath,
    `---\nname: reponova-mcp\ndescription: Knowledge graph MCP tools — use instead of grep/find for structural code questions. Use when searching symbols, analyzing dependencies, or exploring architecture.\nuser-invocable: false\n---\n\n${MCP_SKILL_MD}`,
  );

  // 3. Write enrich skill (command — disable-model-invocation: true, slash command only)
  const enrichSkillDir = resolve(githubDir, "skills", "reponova-enrich");
  const enrichSkillPath = join(enrichSkillDir, "SKILL.md");
  ensureDir(enrichSkillDir);
  writeFileSync(
    enrichSkillPath,
    `---\nname: reponova-enrich\ndescription: Intelligent enrichment workflow for the reponova knowledge graph. Invoke when user asks to enrich the graph.\ndisable-model-invocation: true\n---\n\n${ENRICH_COMMAND_MD}`,
  );

  // 4. Write config file
  const configWritten = writeConfigFile(vscodeDir);

  console.log(`\u2713 VS Code MCP server registered: ${mcpPath}`);
  console.log(`\u2713 VS Code MCP skill (auto-loaded): ${mcpSkillPath}`);
  console.log(`\u2713 VS Code enrich command: ${enrichSkillPath}`);
  if (configWritten) console.log(`\u2713 Config file created: ${configWritten}`);
  console.log("");
  console.log("  Ensure the GitHub Copilot extension is installed for MCP support.");
  console.log("  Type /reponova-enrich to run the enrichment workflow.");
}
