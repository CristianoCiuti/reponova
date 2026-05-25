import type { CommandModule } from "yargs";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import {
  parse as parseJsonc,
  modify as modifyJsonc,
  applyEdits,
  type FormattingOptions,
} from "jsonc-parser";

type Target = "opencode" | "cursor" | "claude" | "vscode";

// ─── JSON / JSONC helpers ────────────────────────────────────────────────────

const JSONC_FMT: FormattingOptions = {
  insertSpaces: true,
  tabSize: 2,
  eol: "\n",
};

/**
 * Resolve a JSON config file path, preferring .jsonc over .json.
 * If a .jsonc variant exists it is returned; otherwise the .json path is
 * returned (whether it exists or not — callers create it when missing).
 */
function resolveJsonConfigPath(dir: string, baseName: string): string {
  const jsoncPath = join(dir, `${baseName}.jsonc`);
  if (existsSync(jsoncPath)) return jsoncPath;
  return join(dir, `${baseName}.json`);
}

/** Read raw text from a JSON/JSONC file.  Returns `"{}"` when missing. */
function readJsoncText(filePath: string): string {
  if (!existsSync(filePath)) return "{}";
  return readFileSync(filePath, "utf-8");
}

/**
 * Set a single property inside a JSON/JSONC text via `jsonc-parser`.
 * Comments and formatting in the rest of the document are preserved.
 */
function setJsoncProperty(
  text: string,
  path: (string | number)[],
  value: unknown,
): string {
  const edits = modifyJsonc(text, path, value, {
    formattingOptions: JSONC_FMT,
  });
  return applyEdits(text, edits);
}

/** Ensure text ends with exactly one newline. */
function withTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : text + "\n";
}

// ─── Default config YAML (written into editor directory) ─────────────────────

const DEFAULT_CONFIG_YAML = `# reponova.yml — All paths relative to this file's location.

output: ../reponova-out

repos:
  - name: my-project
    path: ..

# ── Providers (optional — AI backends for embeddings, summaries, descriptions) ──
# Define named providers here, then reference them from features below.
# Default (no provider) = algorithmic mode (TF-IDF embeddings, rule-based summaries).
# providers:
#   my-openai:
#     type: openai
#     base_url: https://api.openai.com/v1
#     model: text-embedding-3-small
#     api_key: \${OPENAI_API_KEY}
#   local-llm:
#     type: llama-cpp
#     model: "hf:Qwen/Qwen2.5-0.5B-Instruct-GGUF:Q4_K_M"
#   ollama:
#     type: openai
#     base_url: http://localhost:11434/v1
#     model: nomic-embed-text

# ── Source Code File Filters (shared by graph + outlines) ──
# patterns: []                    # source files (empty = auto-detect by extension)
# exclude: []                     # e.g. ["**/generated/**", "**/*.test.ts"]
# exclude_common: true            # skip node_modules, __pycache__, .git, venv, dist, build, ...
# incremental: true

# ── Documentation ──
docs:
  enabled: true
  # patterns: []                  # empty = auto-detect (.md, .txt, .rst)
  # exclude: []                   # e.g. ["**/CHANGELOG.md"]
  # max_file_size_kb: 500

# ── Diagrams / Images ──
images:
  enabled: true
  # patterns: []                  # empty = auto-detect (.puml, .plantuml, .svg, ...)
  # exclude: []
  # parse_puml: true
  # parse_svg_text: true

# ── Embeddings ──
# Default: TF-IDF (fast, no download). Set provider for ONNX or remote embeddings.
embeddings:
  enabled: true
  # provider: my-openai           # reference a provider defined above

# ── Enrich ──
enrich:
  enabled: true
  # threshold: 0.8                # top 20% of nodes by degree
  # max_communities: 0            # 0 = no limit; N = only top N largest communities
  # provider: local-llm           # uncomment for LLM-enhanced enrichments

# ── HTML ──
# html: true
# html_min_degree: 3              # min degree for HTML visualization (unset = all nodes)

# ── Outlines ──
outlines:
  enabled: true
`;

/**
 * Write config file into the editor directory if it doesn't already exist.
 */
function writeConfigFile(editorDir: string): string | null {
  const configPath = join(editorDir, "reponova.yml");
  if (existsSync(configPath)) return null; // Don't overwrite existing
  if (!existsSync(editorDir)) mkdirSync(editorDir, { recursive: true });
  writeFileSync(configPath, DEFAULT_CONFIG_YAML);
  return configPath;
}

// ─── Skill content ───────────────────────────────────────────────────────────

/**
 * MCP tool usage guide — WHEN to use WHICH tool.
 * Parameters are NOT documented here (MCP protocol exposes them automatically).
 * Installed as the `reponova-mcp` skill (passive reference).
 */
const MCP_SKILL_MD = `# reponova — Knowledge Graph Tools

This project has a knowledge graph MCP server with 11 tools. **Use these instead of grep/find for any structural code question.** MCP auto-exposes tool parameters — this guide tells you WHEN to use each.

## Tool Selection Guide

| Question type | Use this tool | NOT this |
|---------------|--------------|----------|
| "Where is X defined?" / "Find function Y" | \`graph_search\` | grep, find |
| "What depends on X?" / "What breaks if I change X?" | \`graph_impact\` | manual trace |
| "How are A and B connected?" | \`graph_path\` | reading imports manually |
| "Tell me everything about symbol X" | \`graph_explain\` | reading source file |
| "What's in this module/community?" | \`graph_community\` | ls, find |
| "What are the most critical/coupled nodes?" | \`graph_hotspots\` | guessing |
| "Find something similar to X" / conceptual search | \`graph_similar\` | grep (can't do semantic) |
| "Give me full context about topic X" (token-budgeted) | \`graph_context\` | reading multiple files |
| "Find docs about X" | \`graph_docs\` | grep *.md |
| "Show me file structure without reading it" | \`graph_outline\` | cat, head |
| "Is the graph built / up to date?" | \`graph_status\` | ls reponova-out |

## Key Workflows

1. **Before refactoring**: \`graph_impact\` on the target symbol → see upstream/downstream blast radius
2. **Exploring unfamiliar code**: \`graph_search\` with \`context_depth: 2\` → see neighborhood around results
3. **Architecture overview**: Read \`reponova-out/report.md\` or use \`graph_hotspots\` + \`graph_community\`
4. **Tracing a call chain**: \`graph_path\` from A to B → shows exact weighted shortest path
5. **Building context for a task**: \`graph_context\` with your task description → token-budgeted, relevance-ranked context combining text search, vectors, and graph expansion

## Important Notes

- Tool responses include **"Absolute path"** for every file reference — use it to open/edit files directly.
- After code changes, run \`reponova build\` to rebuild (incremental, only processes changed files).
- \`graph_search\` supports \`type\` filter: "function", "class", "module" — use it to narrow results.
- \`graph_impact\` supports fuzzy matching — if exact symbol not found, it suggests alternatives.
`;

/**
 * Enrich command skill — loaded ONLY when user explicitly requests enrichment.
 * This is the full multi-step workflow where the agent acts as the LLM.
 */
const ENRICH_SKILL_MD = `---
name: reponova-enrich
description: Intelligent enrichment workflow for the reponova knowledge graph. Improves community assignments, generates node descriptions, and produces community profiles using LLM reasoning. Invoke with "/reponova enrich".
---

# reponova enrich

Intelligent enrichment workflow — you are the LLM that reads source code, reasons about architectural placement, and writes intermediate files that CLI commands merge and apply.

## Quick Reference

| Step | Type | Command / Action |
|------|------|-----------------|
| Pre | CLI | \`reponova build --target communities\` |
| Check | CLI | \`reponova build --check enrich\` (exit 0 = done) |
| 0 | CLI | \`reponova enrich:metrics\` |
| 1 | YOU | Read source → write \`.enrich/descriptions/batch-NNN.json\` → \`reponova enrich:merge descriptions\` |
| 2 | YOU | Read descriptions + edges → write \`.enrich/profiles/community-NNN.json\` → \`reponova enrich:merge profiles\` |
| 3 | YOU | Read candidates + profiles → write \`.enrich/routing/batch-NNN.json\` → \`reponova enrich:merge routing\` |
| 4 | YOU | Read profiles + density + routing → write \`.enrich/restructure.json\` |
| 5 | CLI | \`reponova enrich:apply\` |
| 6 | YOU | Read modified list → re-profile → write \`.enrich/updated-profiles/community-NNN.json\` → \`reponova enrich:merge updated-profiles\` |
| 7 | CLI | \`reponova enrich:finalize\` |
| 8 | CLI | \`reponova cache --target enrich\` then \`reponova build --start-after enrich\` |

## Detailed Steps

### Step 1: Node Descriptions

For each node in \`.enrich/candidates.json\`, read its source code (\`source_file\` + \`start_line\`/\`end_line\`) and write a 1-2 sentence description of what it does architecturally.

**Output format** (\`.enrich/descriptions/batch-NNN.json\`):
\`\`\`json
[{"id": "qualified_name", "description": "Authenticates users by validating credentials against the database."}]
\`\`\`

### Step 2: Community Profiling

Group nodes by community. For each community with 3+ members, produce:

**Output format** (\`.enrich/profiles/community-NNN.json\`):
\`\`\`json
{"communityId": "auth", "label": "Authentication Services", "profile": "Manages user identity verification and token issuance.", "misfits": [{"nodeId": "utils.hash", "reason": "Generic utility, not auth-specific"}]}
\`\`\`

### Step 3: Candidate Routing

For each candidate (high boundary-ratio nodes + misfits from Step 2), decide STAY or MOVE:

**Output format** (\`.enrich/routing/batch-NNN.json\`):
\`\`\`json
[{"node": "utils.hash", "action": "move", "to": "data", "reason": "Used exclusively by database layer"}]
\`\`\`

### Step 4: Restructure Detection

Analyze community structure for merges (tightly coupled pairs) and splits (oversized/incoherent clusters):

**Output format** (\`.enrich/restructure.json\`):
\`\`\`json
{"merges": [], "splits": []}
\`\`\`

### Step 6: Updated Profiles

Same as Step 2 but only for communities listed in \`.enrich/modified-communities.json\`.

## Rules

- **SKIP** any step whose final merged file already exists (e.g., skip Step 1 if \`.enrich/descriptions.json\` exists).
- **NEVER** modify \`graph.json\` — it is immutable after the communities phase.
- **ALWAYS** seal the cache at the end: \`reponova cache --target enrich\`.
- Batch file naming: zero-padded 3-digit (\`batch-001.json\`, \`community-001.json\`).
- If a step has no work (e.g., no modified communities in Step 6), write an empty array to the final file.
`;

// ─── Context message injected by hooks ───────────────────────────────────────

const HOOK_CONTEXT =
  "reponova: 11 MCP graph tools available for structural code queries. " +
  "Consult the reponova-mcp skill to know which tool to use. " +
  "Use graph_search instead of grep/find.";

// ─── OpenCode plugin JS ──────────────────────────────────────────────────────

const OPENCODE_PLUGIN_JS = `// reponova OpenCode plugin
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

// ─── Cursor rules ────────────────────────────────────────────────────────────

const CURSOR_MCP_RULE = `---
description: reponova knowledge graph — use graph tools instead of grep/find
alwaysApply: true
---

${MCP_SKILL_MD}`;

const CURSOR_ENRICH_RULE = `---
description: Intelligent enrichment workflow for the reponova knowledge graph. Invoke when user asks to enrich the graph.
---

${ENRICH_SKILL_MD.replace(/^---[\s\S]*?---\n\n/, "")}`;

// ─── VS Code copilot instructions ────────────────────────────────────────────

const VSCODE_SECTION_MARKER = "## reponova";

const VSCODE_SECTION = `## reponova

${MCP_SKILL_MD}

## reponova enrich

${ENRICH_SKILL_MD.replace(/^---[\s\S]*?---\n\n/, "")}`;

// ─── Command definition ──────────────────────────────────────────────────────

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
    const target = argv.target as Target;
    const graphDir = (argv.graph as string) ?? "./reponova-out";

    switch (target) {
      case "opencode":
        installOpenCode(graphDir);
        break;
      case "cursor":
        installCursor(graphDir);
        break;
      case "claude":
        installClaude(graphDir);
        break;
      case "vscode":
        installVSCode(graphDir);
        break;
    }
  },
};

// ─── OpenCode ────────────────────────────────────────────────────────────────

function installOpenCode(graphDir: string): void {
  const projectDir = process.cwd();
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

  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
  writeFileSync(configPath, withTrailingNewline(text));

  // 3. Write plugin file
  const pluginDir = resolve(projectDir, ".opencode", "plugins");
  const pluginPath = join(pluginDir, "reponova.js");
  if (!existsSync(pluginDir)) mkdirSync(pluginDir, { recursive: true });
  writeFileSync(pluginPath, OPENCODE_PLUGIN_JS);

  // 4. Write skill files
  const mcpSkillDir = resolve(projectDir, ".opencode", "skills", "reponova-mcp");
  const mcpSkillPath = join(mcpSkillDir, "SKILL.md");
  const enrichSkillDir = resolve(projectDir, ".opencode", "skills", "reponova-enrich");
  const enrichSkillPath = join(enrichSkillDir, "SKILL.md");
  if (!existsSync(mcpSkillDir)) mkdirSync(mcpSkillDir, { recursive: true });
  if (!existsSync(enrichSkillDir)) mkdirSync(enrichSkillDir, { recursive: true });
  writeFileSync(mcpSkillPath, `---\nname: reponova-mcp\ndescription: Knowledge graph MCP tools — use instead of grep/find for structural code questions.\n---\n\n${MCP_SKILL_MD}`);
  writeFileSync(enrichSkillPath, ENRICH_SKILL_MD);

  // 5. Write config file
  const configWritten = writeConfigFile(configDir);

  console.log(`\u2713 OpenCode MCP server registered: ${configPath}`);
  console.log(`\u2713 OpenCode plugin installed: ${pluginPath}`);
  console.log(`\u2713 OpenCode MCP skill: ${mcpSkillPath}`);
  console.log(`\u2713 OpenCode enrich command: ${enrichSkillPath}`);
  if (configWritten) console.log(`\u2713 Config file created: ${configWritten}`);
  console.log("");
  console.log("  The MCP server starts automatically with OpenCode.");
  console.log("  The plugin reminds the agent to consult the reponova-mcp skill.");
  console.log("  Type /reponova-enrich to run the enrichment workflow.");
}

// ─── Cursor ──────────────────────────────────────────────────────────────────

function installCursor(graphDir: string): void {
  const projectDir = process.cwd();

  // 1. Register MCP server
  const mcpDir = resolve(projectDir, ".cursor");
  const mcpPath = resolveJsonConfigPath(mcpDir, "mcp");

  let text = readJsoncText(mcpPath);
  text = setJsoncProperty(text, ["mcpServers", "reponova"], {
    command: "npx",
    args: ["-y", "reponova", "mcp", "--graph", graphDir],
  });

  if (!existsSync(mcpDir)) mkdirSync(mcpDir, { recursive: true });
  writeFileSync(mcpPath, withTrailingNewline(text));

  // 2. Write cursor rules (separate files: mcp guide + enrich)
  const rulesDir = resolve(projectDir, ".cursor", "rules");
  const mcpRulePath = join(rulesDir, "reponova-mcp.mdc");
  const enrichPath = join(rulesDir, "reponova-enrich.mdc");

  if (!existsSync(rulesDir)) mkdirSync(rulesDir, { recursive: true });
  writeFileSync(mcpRulePath, CURSOR_MCP_RULE);
  writeFileSync(enrichPath, CURSOR_ENRICH_RULE);

  // 3. Write config file
  const configWritten = writeConfigFile(mcpDir);

  console.log(`\u2713 Cursor MCP server registered: ${mcpPath}`);
  console.log(`\u2713 Cursor MCP skill (always-on): ${mcpRulePath}`);
  console.log(`\u2713 Cursor enrich command: ${enrichPath}`);
  if (configWritten) console.log(`\u2713 Config file created: ${configWritten}`);
  console.log("");
  console.log("  Restart Cursor for changes to take effect.");
}

// ─── Claude Code ─────────────────────────────────────────────────────────────

function installClaude(graphDir: string): void {
  const projectDir = process.cwd();

  // 1. Write PreToolUse hook in .claude/settings.json
  const claudeDir = resolve(projectDir, ".claude");
  const settingsPath = resolveJsonConfigPath(claudeDir, "settings");

  let text = readJsoncText(settingsPath);
  const settings = (parseJsonc(text) ?? {}) as Record<string, unknown>;

  const hooks = (settings.hooks as Record<string, unknown[]> | undefined) ?? {};
  const preToolUse = (hooks.PreToolUse as Array<Record<string, unknown>> | undefined) ?? [];

  // Remove existing reponova hooks
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

  if (!existsSync(claudeDir)) mkdirSync(claudeDir, { recursive: true });
  writeFileSync(settingsPath, withTrailingNewline(text));

  // 2. Write skill files (separate: mcp guide + enrich)
  const mcpSkillDir = resolve(projectDir, ".claude", "skills", "reponova-mcp");
  const mcpSkillPath = join(mcpSkillDir, "SKILL.md");
  if (!existsSync(mcpSkillDir)) mkdirSync(mcpSkillDir, { recursive: true });
  writeFileSync(mcpSkillPath, `---\nname: reponova-mcp\ndescription: Knowledge graph MCP tools — use instead of grep/find for structural code questions.\n---\n\n${MCP_SKILL_MD}`);

  const enrichSkillDir = resolve(projectDir, ".claude", "skills", "reponova-enrich");
  const enrichSkillPath = join(enrichSkillDir, "SKILL.md");
  if (!existsSync(enrichSkillDir)) mkdirSync(enrichSkillDir, { recursive: true });
  writeFileSync(enrichSkillPath, ENRICH_SKILL_MD);

  // 3. Write config file
  const configWritten = writeConfigFile(claudeDir);

  // 4. Print MCP add command (Claude manages MCP via CLI)
  console.log(`\u2713 Claude PreToolUse hook installed: ${settingsPath}`);
  console.log(`\u2713 Claude MCP skill: ${mcpSkillPath}`);
  console.log(`\u2713 Claude enrich command: ${enrichSkillPath}`);
  if (configWritten) console.log(`\u2713 Config file created: ${configWritten}`);
  console.log("");
  console.log("  To also register the MCP server, run:");
    console.log(`  claude mcp add reponova -- npx -y reponova mcp --graph ${graphDir}`);
}

// ─── VS Code ─────────────────────────────────────────────────────────────────

function installVSCode(graphDir: string): void {
  const projectDir = process.cwd();

  // 1. Register MCP server
  const vscodeDir = resolve(projectDir, ".vscode");
  const mcpPath = resolveJsonConfigPath(vscodeDir, "mcp");

  let text = readJsoncText(mcpPath);
  text = setJsoncProperty(text, ["servers", "reponova"], {
    type: "stdio",
    command: "npx",
    args: ["-y", "reponova", "mcp", "--graph", graphDir],
  });

  if (!existsSync(vscodeDir)) mkdirSync(vscodeDir, { recursive: true });
  writeFileSync(mcpPath, withTrailingNewline(text));

  // 2. Write copilot instructions
  const githubDir = resolve(projectDir, ".github");
  const instructionsPath = join(githubDir, "copilot-instructions.md");

  if (!existsSync(githubDir)) mkdirSync(githubDir, { recursive: true });

  let content = "";
  if (existsSync(instructionsPath)) {
    content = readFileSync(instructionsPath, "utf-8");
    if (content.includes(VSCODE_SECTION_MARKER)) {
      console.log(`\u2713 VS Code MCP server registered: ${mcpPath}`);
      console.log(`\u2713 Copilot instructions already present: ${instructionsPath}`);
      return;
    }
    content = content.trimEnd() + "\n\n";
  }

  content += VSCODE_SECTION;
  writeFileSync(instructionsPath, content);

  // 3. Write config file
  const configWritten = writeConfigFile(vscodeDir);

  console.log(`\u2713 VS Code MCP server registered: ${mcpPath}`);
  console.log(`\u2713 Copilot skill/instructions installed: ${instructionsPath}`);
  if (configWritten) console.log(`\u2713 Config file created: ${configWritten}`);
  console.log("");
  console.log("  Ensure the GitHub Copilot extension is installed for MCP support.");
}

// ─── Test helpers (internal) ─────────────────────────────────────────────────

export const _testing = {
  resolveJsonConfigPath,
  readJsoncText,
  setJsoncProperty,
  withTrailingNewline,
};
