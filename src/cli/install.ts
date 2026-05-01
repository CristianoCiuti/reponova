import type { CommandModule } from "yargs";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";

type Target = "opencode" | "cursor" | "claude" | "vscode";

// ─── Default config YAML (written into editor directory) ─────────────────────

const DEFAULT_CONFIG_YAML = `# reponova.yml
# Configuration for reponova
# All paths are relative to this file's location.
# Since this file is inside the editor directory, use ../ to reference project root.

# Where to write build output
output: ../reponova-out

# Repositories to include in the build
repos:
  - name: my-project
    path: ..

# Build options
build:
  mode: monorepo                  # "monorepo" (default) or "separate"
  exclude: []                     # directory names to skip during detect (e.g. dist_package, .tox)
  incremental: true               # incremental builds using file hash cache
  html: true                      # generate graph.html and graph_communities.html visualizations
  # html_min_degree: 3            # if set, only include nodes with degree >= this value in HTML
  docs:
    enabled: true                 # extract documentation files (.md, .txt, .rst)
    patterns:
      - "**/*.md"
      - "**/*.txt"
      - "**/*.rst"
    exclude:
      - "**/CHANGELOG.md"
      - "**/node_modules/**"
    max_file_size_kb: 500
  images:
    enabled: true                 # extract diagram files (.puml, .svg)
    patterns:
      - "**/*.puml"
      - "**/*.plantuml"
      - "**/*.svg"
    exclude:
      - "**/node_modules/**"
    parse_puml: true
    parse_svg_text: true
  embeddings:
    enabled: true
    method: tfidf                 # "tfidf" (fast, default) or "onnx" (MiniLM, more accurate)
  summaries:
    enabled: true
    max_communities: 0            # 0 = no limit
  llm:
    enabled: false                # set true to use local Qwen 0.5B for richer summaries
    model: qwen2.5-0.5b-instruct
    gpu: auto                     # "auto", "cpu", or "cuda"/"vulkan"/"metal"

# Outline generation (auto-detects language from file extension)
outlines:
  enabled: true
  paths:                          # glob patterns for files to outline (relative to repo root)
    - "src/**/*.ts"
    - "src/**/*.py"
    - "src/**/*.js"
  exclude:
    - "**/node_modules/**"
    - "**/.git/**"
    - "**/dist/**"
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

const SKILL_MD = `---
name: reponova
description: MCP server for querying the project knowledge graph. Use when searching symbols, analyzing blast radius, tracing paths between nodes, or understanding architecture.
---

# reponova

MCP server for querying the project's knowledge graph.

## Available Tools

### graph_search
Full-text search across all graph nodes (functions, classes, modules) with optional BFS/DFS context expansion.

Parameters:
- \`query\` (required): search text
- \`top_k\`: max results (default: 10)
- \`type\`: filter by node type — "function", "class", "module"
- \`repo\`: filter by repository name
- \`context_depth\`: BFS/DFS expansion depth from top results (0 = no expansion, default: 0)
- \`context_mode\`: "bfs" (broad context) or "dfs" (trace specific path). Default: "bfs"

Use when: finding symbols, locating definitions, exploring what exists. Set context_depth > 0 to also see connected nodes around the results.

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

### graph_community
List all nodes belonging to a specific community.

Parameters:
- \`community_id\` (required): community ID or name

Use when: exploring module boundaries, understanding which symbols are clustered together.

### graph_hotspots
Most connected nodes in the graph — architectural hotspots / god nodes.

Parameters:
- \`top_n\`: number of results (default: 10)
- \`metric\`: ranking metric — "degree", "in_degree", "out_degree", "betweenness" (default: "degree")

Use when: identifying critical symbols, finding architectural bottlenecks, prioritizing refactoring targets.

### graph_similar
Semantic similarity search — find symbols similar to a query using TF-IDF or ONNX embeddings.

Parameters:
- \`query\` (required): search text or symbol name
- \`top_k\`: max results (default: 10)
- \`type\`: filter by node type
- \`repo\`: filter by repository

Use when: finding related symbols, discovering similar patterns, exploring semantic connections.

### graph_context
Smart context builder — assembles relevant context within a token budget by combining search, vectors, and graph expansion.

Parameters:
- \`query\` (required): what you need context about
- \`budget\`: max tokens (default: 4000)
- \`strategy\`: "auto", "search", "vector", "graph" (default: "auto")

Use when: building comprehensive context about a topic, gathering information for analysis.

### graph_ask
Natural language query — classifies your question and routes to the right tool automatically.

Parameters:
- \`question\` (required): natural language question about the codebase

Use when: asking questions in plain language without knowing which tool to use.

### graph_docs
Search documentation nodes (markdown, text, rst files).

Parameters:
- \`query\` (required): search text
- \`top_k\`: max results (default: 10)

Use when: finding documentation, searching through markdown files, looking for written explanations.

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

1. **Prefer graph tools over grep/find** — graph_search uses indexed ranking and understands symbol types.
2. **Check impact before refactoring** — run graph_impact on any symbol you plan to modify.
3. **Use graph_path to trace connections** — faster and more accurate than manually following imports.
4. **Use graph_hotspots to find god nodes** — high-degree nodes are architectural risks.
5. **Use context_depth for broad exploration** — set context_depth=2 on graph_search to see the neighborhood around results.
6. **Read report.md** at \`reponova-out/report.md\` for architecture overview, god nodes, and community structure.
7. **Keep the graph current** — after code changes, run \`reponova build\` to rebuild.
`;

// ─── Context message injected by hooks ───────────────────────────────────────

const HOOK_CONTEXT =
  "reponova: Knowledge graph MCP server is available. " +
  "Use graph_search, graph_impact, graph_path, graph_explain tools " +
  "instead of manually grep/find-ing the codebase. " +
  "Read reponova-out/report.md for architecture overview.";

// ─── OpenCode plugin JS ──────────────────────────────────────────────────────

const OPENCODE_PLUGIN_JS = `// reponova OpenCode plugin
// Reminds the agent that MCP graph tools are available before bash searches.
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
          'echo "[reponova] Knowledge graph MCP server available. Use graph_search/graph_impact/graph_path tools instead of manual grep." && ' +
          output.args.command;
        reminded = true;
      }
    },
  };
};
`;

// ─── Cursor rule ─────────────────────────────────────────────────────────────

const CURSOR_RULE = `---
description: reponova knowledge graph MCP server
alwaysApply: true
---

${SKILL_MD}`;

// ─── VS Code copilot instructions ────────────────────────────────────────────

const VSCODE_SECTION_MARKER = "## reponova";

const VSCODE_SECTION = `## reponova

${SKILL_MD}`;

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
  const configPath = join(configDir, "opencode.json");

  // 1. Register MCP server
  let config: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    config = JSON.parse(readFileSync(configPath, "utf-8"));
  }

  if (!config.mcp) config.mcp = {};
  const mcp = config.mcp as Record<string, unknown>;
  mcp["reponova"] = {
    type: "local",
    command: ["npx", "-y", "reponova", "mcp", "--graph", graphDir],
  };

  // 2. Register plugin
  const pluginRelPath = ".opencode/plugins/reponova.js";
  const plugins = (config.plugin as string[] | undefined) ?? [];
  if (!plugins.includes(pluginRelPath)) {
    plugins.push(pluginRelPath);
  }
  config.plugin = plugins;

  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

  // 3. Write plugin file
  const pluginDir = resolve(projectDir, ".opencode", "plugins");
  const pluginPath = join(pluginDir, "reponova.js");
  if (!existsSync(pluginDir)) mkdirSync(pluginDir, { recursive: true });
  writeFileSync(pluginPath, OPENCODE_PLUGIN_JS);

  // 4. Write skill file
  const skillDir = resolve(projectDir, ".opencode", "skills", "reponova");
  const skillPath = join(skillDir, "SKILL.md");
  if (!existsSync(skillDir)) mkdirSync(skillDir, { recursive: true });
  writeFileSync(skillPath, SKILL_MD);

  // 5. Write config file
  const configWritten = writeConfigFile(configDir);

  console.log(`\u2713 OpenCode MCP server registered: ${configPath}`);
  console.log(`\u2713 OpenCode plugin installed: ${pluginPath}`);
  console.log(`\u2713 OpenCode skill installed: ${skillPath}`);
  if (configWritten) console.log(`\u2713 Config file created: ${configWritten}`);
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
  servers["reponova"] = {
    command: "npx",
    args: ["-y", "reponova", "mcp", "--graph", graphDir],
  };

  if (!existsSync(mcpDir)) mkdirSync(mcpDir, { recursive: true });
  writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2) + "\n");

  // 2. Write cursor rule
  const rulesDir = resolve(projectDir, ".cursor", "rules");
  const rulePath = join(rulesDir, "reponova.mdc");

  if (!existsSync(rulesDir)) mkdirSync(rulesDir, { recursive: true });
  writeFileSync(rulePath, CURSOR_RULE);

  // 3. Write config file
  const configWritten = writeConfigFile(mcpDir);

  console.log(`\u2713 Cursor MCP server registered: ${mcpPath}`);
  console.log(`\u2713 Cursor rule/skill installed: ${rulePath}`);
  if (configWritten) console.log(`\u2713 Config file created: ${configWritten}`);
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

  hooks.PreToolUse = filtered;
  settings.hooks = hooks;

  if (!existsSync(claudeDir)) mkdirSync(claudeDir, { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");

  // 2. Write skill file
  const skillDir = resolve(projectDir, ".claude", "skills", "reponova");
  const skillPath = join(skillDir, "SKILL.md");
  if (!existsSync(skillDir)) mkdirSync(skillDir, { recursive: true });
  writeFileSync(skillPath, SKILL_MD);

  // 3. Write config file
  const configWritten = writeConfigFile(claudeDir);

  // 4. Print MCP add command (Claude manages MCP via CLI)
  console.log(`\u2713 Claude PreToolUse hook installed: ${settingsPath}`);
  console.log(`\u2713 Claude skill installed: ${skillPath}`);
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
  const mcpPath = join(vscodeDir, "mcp.json");

  let mcpConfig: Record<string, unknown> = {};
  if (existsSync(mcpPath)) {
    mcpConfig = JSON.parse(readFileSync(mcpPath, "utf-8"));
  }

  if (!mcpConfig.servers) mcpConfig.servers = {};
  const servers = mcpConfig.servers as Record<string, unknown>;
  servers["reponova"] = {
    type: "stdio",
    command: "npx",
    args: ["-y", "reponova", "mcp", "--graph", graphDir],
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

  // 3. Write config file
  const configWritten = writeConfigFile(vscodeDir);

  console.log(`\u2713 VS Code MCP server registered: ${mcpPath}`);
  console.log(`\u2713 Copilot skill/instructions installed: ${instructionsPath}`);
  if (configWritten) console.log(`\u2713 Config file created: ${configWritten}`);
  console.log("");
  console.log("  Ensure the GitHub Copilot extension is installed for MCP support.");
}
