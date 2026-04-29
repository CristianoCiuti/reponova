import type { CommandModule } from "yargs";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { checkGraphify } from "../shared/system-checks.js";

type Target = "opencode" | "cursor" | "claude" | "vscode";

// ─── Skill content ───────────────────────────────────────────────────────────

const SKILL_MD = `---
name: graphify-mcp-tools
description: MCP server for querying the project knowledge graph. Use when searching symbols, analyzing blast radius, tracing paths between nodes, or understanding architecture.
---

# graphify-mcp-tools

MCP server for querying the project's knowledge graph (built by graphify).

## Available Tools

### graph_search
Full-text search across all graph nodes (functions, classes, modules).

Parameters:
- \`query\` (required): search text
- \`top_k\`: max results (default: 10)
- \`type\`: filter by node type — "function", "class", "module"
- \`repo\`: filter by repository name

Use when: finding symbols, locating definitions, exploring what exists.

### graph_impact
Blast radius analysis — find everything that depends on a symbol (downstream) and everything it depends on (upstream).

Parameters:
- \`symbol\` (required): symbol name or ID
- \`direction\`: "upstream", "downstream", or "both" (default: "both")
- \`max_depth\`: BFS depth limit (default: 3)
- \`include_tests\`: include test files (default: false)

Use when: assessing change risk, understanding dependencies before refactoring.

### graph_path
Shortest path between two nodes in the knowledge graph (Dijkstra).

Parameters:
- \`from\` (required): source node name or ID
- \`to\` (required): target node name or ID
- \`max_depth\`: max hops (default: 10)
- \`edge_types\`: filter by relationship types

Use when: understanding how two symbols are connected, tracing call chains.

### graph_explain
Full detail on a single node: properties, edges, community membership, centrality metrics.

Parameters:
- \`symbol\` (required): node name or ID
- \`include_code\`: also return the file outline (default: false)

Use when: deep-diving into a specific symbol, understanding its role in the architecture.

### graph_outline
File outline: function signatures, class definitions, imports — without reading the full source.

Parameters:
- \`file_path\` (required): relative path to file
- \`format\`: "markdown" or "json" (default: "markdown")

Use when: getting a quick overview of a file's structure.

### graph_status
Graph metadata: node/edge counts, repos included, build timestamp.

No parameters.

Use when: checking if the graph is available and up to date.

## Best Practices

1. **Prefer graph tools over grep/find** — graph_search uses indexed BM25 ranking and understands symbol types.
2. **Check impact before refactoring** — run graph_impact on any symbol you plan to modify.
3. **Use graph_path to trace connections** — faster and more accurate than manually following imports.
4. **Read GRAPH_REPORT.md** at \`graphify-out/GRAPH_REPORT.md\` for architecture overview, god nodes, and community structure.
5. **Keep the graph current** — after code changes, run \`graphify update .\` to rebuild (AST-only, no API cost).
`;

// ─── Context message injected by hooks ───────────────────────────────────────

const HOOK_CONTEXT =
  "graphify-mcp-tools: Knowledge graph MCP server is available. " +
  "Use graph_search, graph_impact, graph_path, graph_explain tools " +
  "instead of manually grep/find-ing the codebase. " +
  "Read graphify-out/GRAPH_REPORT.md for architecture overview.";

// ─── OpenCode plugin JS ──────────────────────────────────────────────────────

const OPENCODE_PLUGIN_JS = `// graphify-mcp-tools OpenCode plugin
// Reminds the agent that MCP graph tools are available before bash searches.
import { existsSync } from "fs";
import { join } from "path";

export const GraphifyMcpPlugin = async ({ directory }) => {
  let reminded = false;

  return {
    "tool.execute.before": async (input, output) => {
      if (reminded) return;
      if (!existsSync(join(directory, "graphify-out", "graph.json"))) return;

      if (input.tool === "bash") {
        output.args.command =
          'echo "[graphify-mcp-tools] Knowledge graph MCP server available. Use graph_search/graph_impact/graph_path tools instead of manual grep." && ' +
          output.args.command;
        reminded = true;
      }
    },
  };
};
`;

// ─── Cursor rule ─────────────────────────────────────────────────────────────

const CURSOR_RULE = `---
description: graphify-mcp-tools knowledge graph MCP server
alwaysApply: true
---

${SKILL_MD}`;

// ─── VS Code copilot instructions ────────────────────────────────────────────

const VSCODE_SECTION_MARKER = "## graphify-mcp-tools";

const VSCODE_SECTION = `## graphify-mcp-tools

${SKILL_MD}`;

// ─── Command definition ──────────────────────────────────────────────────────

export const installCommand: CommandModule = {
  command: "install",
  describe: "Install graphify-mcp-tools MCP server and hooks for your editor",
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
        describe: "Path to graphify-out/ directory (default: ./graphify-out)",
      }),
  handler: async (argv) => {
    const target = argv.target as Target;
    const graphDir = (argv.graph as string) ?? "./graphify-out";

    // Check graphify prerequisite
    warnIfGraphifyMissing();

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

// ─── Graphify check ──────────────────────────────────────────────────────────

function warnIfGraphifyMissing(): void {
  const version = checkGraphify();
  if (version) {
    console.log(`\u2713 graphify detected (v${version})`);
    return;
  }

  console.log("");
  console.log("\u26a0  WARNING: graphify not found on this system.");
  console.log("");
  console.log("  graphify-mcp-tools serves knowledge graphs generated by graphify.");
  console.log("  Without graphify, no graph data will be available for the MCP server.");
  console.log("");
  console.log("  Install graphify:");
  console.log("    uv tool install graphifyy");
  console.log("    # or: pip install graphifyy");
  console.log("");
  console.log("  Then generate a graph:");
  console.log("    graphify .");
  console.log("");
  console.log("  Docs: https://github.com/safishamsi/graphify");
  console.log("");
}

// ─── OpenCode ────────────────────────────────────────────────────────────────

function installOpenCode(graphDir: string): void {
  const projectDir = process.cwd();
  const configDir = resolve(projectDir, ".opencode");
  const configPath = join(configDir, "opencode.json");

  // 1. Register MCP server
  let config: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    config = JSON.parse(readFileSync(configPath, "utf-8"));
  }

  if (!config.mcp) config.mcp = {};
  const mcp = config.mcp as Record<string, unknown>;
  mcp["graphify"] = {
    type: "local",
    command: ["npx", "-y", "graphify-mcp-tools", "mcp", "--graph", graphDir],
  };

  // 2. Register plugin
  const pluginRelPath = ".opencode/plugins/graphify-mcp-tools.js";
  const plugins = (config.plugin as string[] | undefined) ?? [];
  if (!plugins.includes(pluginRelPath)) {
    plugins.push(pluginRelPath);
  }
  config.plugin = plugins;

  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

  // 3. Write plugin file
  const pluginDir = resolve(projectDir, ".opencode", "plugins");
  const pluginPath = join(pluginDir, "graphify-mcp-tools.js");
  if (!existsSync(pluginDir)) mkdirSync(pluginDir, { recursive: true });
  writeFileSync(pluginPath, OPENCODE_PLUGIN_JS);

  // 4. Write skill file
  const skillDir = resolve(projectDir, ".opencode", "skills", "graphify-mcp-tools");
  const skillPath = join(skillDir, "SKILL.md");
  if (!existsSync(skillDir)) mkdirSync(skillDir, { recursive: true });
  writeFileSync(skillPath, SKILL_MD);

  console.log(`\u2713 OpenCode MCP server registered: ${configPath}`);
  console.log(`\u2713 OpenCode plugin installed: ${pluginPath}`);
  console.log(`\u2713 OpenCode skill installed: ${skillPath}`);
  console.log("");
  console.log("  The MCP server starts automatically with OpenCode.");
  console.log("  The plugin reminds the agent to use graph tools before searching.");
  console.log("  The skill teaches the agent how to use each graph tool.");
}

// ─── Cursor ──────────────────────────────────────────────────────────────────

function installCursor(graphDir: string): void {
  const projectDir = process.cwd();

  // 1. Register MCP server
  const mcpDir = resolve(projectDir, ".cursor");
  const mcpPath = join(mcpDir, "mcp.json");

  let mcpConfig: Record<string, unknown> = {};
  if (existsSync(mcpPath)) {
    mcpConfig = JSON.parse(readFileSync(mcpPath, "utf-8"));
  }

  if (!mcpConfig.mcpServers) mcpConfig.mcpServers = {};
  const servers = mcpConfig.mcpServers as Record<string, unknown>;
  servers["graphify"] = {
    command: "npx",
    args: ["-y", "graphify-mcp-tools", "mcp", "--graph", graphDir],
  };

  if (!existsSync(mcpDir)) mkdirSync(mcpDir, { recursive: true });
  writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2) + "\n");

  // 2. Write cursor rule
  const rulesDir = resolve(projectDir, ".cursor", "rules");
  const rulePath = join(rulesDir, "graphify-mcp-tools.mdc");

  if (!existsSync(rulesDir)) mkdirSync(rulesDir, { recursive: true });
  writeFileSync(rulePath, CURSOR_RULE);

  console.log(`\u2713 Cursor MCP server registered: ${mcpPath}`);
  console.log(`\u2713 Cursor rule/skill installed: ${rulePath}`);
  console.log("");
  console.log("  Restart Cursor for changes to take effect.");
}

// ─── Claude Code ─────────────────────────────────────────────────────────────

function installClaude(graphDir: string): void {
  const projectDir = process.cwd();

  // 1. Write PreToolUse hook in .claude/settings.json
  const claudeDir = resolve(projectDir, ".claude");
  const settingsPath = join(claudeDir, "settings.json");

  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
  }

  const hooks = (settings.hooks as Record<string, unknown[]> | undefined) ?? {};
  const preToolUse = (hooks.PreToolUse as Array<Record<string, unknown>> | undefined) ?? [];

  // Remove existing graphify-mcp-tools hooks
  const filtered = preToolUse.filter(
    (h) => !JSON.stringify(h).includes("graphify-mcp-tools"),
  );

  // Add new hook
  filtered.push({
    matcher: "Bash",
    hooks: [
      {
        type: "command",
        command:
          '[ -f graphify-out/graph.json ] && echo \'{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"' +
          HOOK_CONTEXT +
          '"}}\' || true',
      },
    ],
  });

  hooks.PreToolUse = filtered;
  settings.hooks = hooks;

  if (!existsSync(claudeDir)) mkdirSync(claudeDir, { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");

  // 2. Write skill file
  const skillDir = resolve(projectDir, ".claude", "skills", "graphify-mcp-tools");
  const skillPath = join(skillDir, "SKILL.md");
  if (!existsSync(skillDir)) mkdirSync(skillDir, { recursive: true });
  writeFileSync(skillPath, SKILL_MD);

  // 3. Print MCP add command (Claude manages MCP via CLI)
  console.log(`\u2713 Claude PreToolUse hook installed: ${settingsPath}`);
  console.log(`\u2713 Claude skill installed: ${skillPath}`);
  console.log("");
  console.log("  To also register the MCP server, run:");
  console.log(`  claude mcp add graphify -- npx -y graphify-mcp-tools mcp --graph ${graphDir}`);
}

// ─── VS Code ─────────────────────────────────────────────────────────────────

function installVSCode(graphDir: string): void {
  const projectDir = process.cwd();

  // 1. Register MCP server
  const vscodeDir = resolve(projectDir, ".vscode");
  const mcpPath = join(vscodeDir, "mcp.json");

  let mcpConfig: Record<string, unknown> = {};
  if (existsSync(mcpPath)) {
    mcpConfig = JSON.parse(readFileSync(mcpPath, "utf-8"));
  }

  if (!mcpConfig.servers) mcpConfig.servers = {};
  const servers = mcpConfig.servers as Record<string, unknown>;
  servers["graphify"] = {
    type: "stdio",
    command: "npx",
    args: ["-y", "graphify-mcp-tools", "mcp", "--graph", graphDir],
  };

  if (!existsSync(vscodeDir)) mkdirSync(vscodeDir, { recursive: true });
  writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2) + "\n");

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

  console.log(`\u2713 VS Code MCP server registered: ${mcpPath}`);
  console.log(`\u2713 Copilot skill/instructions installed: ${instructionsPath}`);
  console.log("");
  console.log("  Ensure the GitHub Copilot extension is installed for MCP support.");
}
