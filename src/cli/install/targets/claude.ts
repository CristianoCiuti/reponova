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
import { HOOK_CONTEXT } from "../content/hook-context.js";

export function installClaude(ctx: InstallerContext): void {
  const { projectDir, graphDir } = ctx;

  // 1. Write PreToolUse hook in .claude/settings.json
  const claudeDir = resolve(projectDir, ".claude");
  const settingsPath = resolveJsonConfigPath(claudeDir, "settings");

  let text = readJsoncText(settingsPath);
  const settings = (parseJsonc(text) ?? {}) as Record<string, unknown>;

  const hooks = (settings.hooks as Record<string, unknown[]> | undefined) ?? {};
  const preToolUse = (hooks.PreToolUse as Array<Record<string, unknown>> | undefined) ?? [];

  // Remove existing reponova hooks (idempotent)
  const filtered = preToolUse.filter(
    (h) => !JSON.stringify(h).includes("reponova"),
  );

  // Add new hook
  filtered.push({
    matcher: "Bash",
    hooks: [
      {
        type: "command",
        command:
          '[ -f reponova-out/graph.json ] && echo \'{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"' +
          HOOK_CONTEXT +
          '"}}\' || true',
      },
    ],
  });

  text = setJsoncProperty(text, ["hooks", "PreToolUse"], filtered);

  ensureDir(claudeDir);
  writeFileSync(settingsPath, withTrailingNewline(text));

  // 2. Write MCP skill (passive — agent loads autonomously based on description)
  const mcpSkillDir = resolve(projectDir, ".claude", "skills", "reponova-mcp");
  const mcpSkillPath = join(mcpSkillDir, "SKILL.md");
  ensureDir(mcpSkillDir);
  writeFileSync(
    mcpSkillPath,
    `---\nname: reponova-mcp\ndescription: Knowledge graph MCP tools — use instead of grep/find for structural code questions.\n---\n\n${MCP_SKILL_MD}`,
  );

  // 3. Write enrich skill (command — user invokes with /reponova-enrich)
  // In Claude Code, skills and commands share the same path. Distinction is behavioral.
  const enrichSkillDir = resolve(projectDir, ".claude", "skills", "reponova-enrich");
  const enrichSkillPath = join(enrichSkillDir, "SKILL.md");
  ensureDir(enrichSkillDir);
  writeFileSync(
    enrichSkillPath,
    `---\nname: reponova-enrich\ndescription: Intelligent enrichment workflow for the reponova knowledge graph. Improves community assignments, generates node descriptions, and produces community profiles using LLM reasoning. Invoke with "/reponova-enrich".\n---\n\n${ENRICH_COMMAND_MD}`,
  );

  // 4. Write config file
  const configWritten = writeConfigFile(claudeDir);

  // 5. Print instructions
  console.log(`\u2713 Claude PreToolUse hook installed: ${settingsPath}`);
  console.log(`\u2713 Claude MCP skill: ${mcpSkillPath}`);
  console.log(`\u2713 Claude enrich command: ${enrichSkillPath}`);
  if (configWritten) console.log(`\u2713 Config file created: ${configWritten}`);
  console.log("");
  console.log("  To also register the MCP server, run:");
  console.log(`  claude mcp add reponova -- npx -y reponova mcp --graph ${graphDir}`);
  console.log("  Type /reponova-enrich to run the enrichment workflow.");
}
