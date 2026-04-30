# graphify-mcp-tools

MCP server companion for [Graphify](https://github.com/safishamsi/graphify): exposes knowledge graphs as searchable, queryable tools for AI agents.

## Why This Project?

Graphify already ships its own MCP server (`python -m graphify.serve`), but it has limitations:

| | Graphify MCP (built-in) | graphify-mcp-tools |
|---|---|---|
| **Runtime** | Requires Python + graphify installed | Node.js only (no Python needed at runtime) |
| **Search** | Keyword matching (split + score) | Indexed text search with type/repo filters |
| **Impact analysis** | Not available | BFS blast radius (upstream + downstream) |
| **Context expansion** | BFS/DFS from keywords | BFS/DFS from ranked search results |
| **Shortest path** | Unweighted `nx.shortest_path` | Weighted Dijkstra with edge-type filters |
| **Code outlines** | Not available | Tree-sitter signatures, decorators, docstrings |
| **Hotspots / God nodes** | Separate tool, degree only | Degree, in/out degree, betweenness centrality |
| **Community exploration** | Basic listing | Full community membership with degree ranking |
| **Multi-repo** | Manual merge | Automated build + merge + index pipeline |

In short: graphify-mcp-tools is a **drop-in replacement** that adds richer queries, requires no Python at query time, and integrates with any MCP-compatible editor out of the box.

```
Graphify (Python)                    graphify-mcp-tools (Node.js)
┌──────────────────┐                ┌───────────────────────────────────┐
│ tree-sitter AST  │                │ MCP Server (stdio)                │
│ semantic extract │  graph.json    │ ├─ graph_search (+BFS/DFS expand) │
│ community detect │ ────────────►  │ ├─ graph_impact (blast radius)    │
│ merge-graphs     │                │ ├─ graph_path (weighted Dijkstra) │
│ HTML/report/wiki │                │ ├─ graph_explain (node detail)    │
└──────────────────┘                │ ├─ graph_community (membership)   │
                                    │ ├─ graph_hotspots (god nodes)     │
                                    │ ├─ graph_outline (tree-sitter)    │
                                    │ └─ graph_status                   │
                                    └───────────────────────────────────┘
```

## Install

```bash
npm install -g graphify-mcp-tools
# or run directly
npx graphify-mcp-tools
```

Requires Node.js >= 18.

## Quick Start

1. **Generate a graph** with [Graphify](https://github.com/safishamsi/graphify):

   From an AI assistant (Claude Code, OpenCode, Cursor, etc.):
   ```
   /graphify .
   ```

   Or install graphify and use the build command:
   ```bash
   pip install graphifyy
   graphify-mcp-tools build --config graphify-tools.config.yml
   ```

2. **Configure your editor**:
   ```bash
   graphify-mcp-tools install --target opencode   # or: cursor, claude, vscode
   ```

   This registers the MCP server, installs a hook, and writes a skill file — all in one step.

3. The MCP server starts automatically with your editor. Use the graph tools directly from the AI assistant.

## MCP Tools

| Tool | Description |
|------|-------------|
| `graph_search` | Text search across nodes with optional BFS/DFS context expansion |
| `graph_impact` | BFS blast radius — find all upstream/downstream dependents of a symbol |
| `graph_path` | Weighted shortest path (Dijkstra) between two symbols |
| `graph_explain` | Full detail on a node: edges, community, centrality metrics |
| `graph_community` | List all nodes belonging to a specific community |
| `graph_hotspots` | Most connected nodes (god nodes / architectural bottlenecks) |
| `graph_outline` | Tree-sitter code outline for any file (functions, classes, imports) |
| `graph_status` | Graph metadata: node/edge counts, repos, build timestamp |

## CLI Commands

```bash
graphify-mcp-tools install   # Install MCP server + hooks + skill for your editor
graphify-mcp-tools mcp       # Start MCP server (stdio transport)
graphify-mcp-tools build     # Build graph from configured repos (requires graphify)
graphify-mcp-tools index     # Generate search index from graph.json
graphify-mcp-tools outline   # Pre-compute outlines for configured patterns
graphify-mcp-tools check     # Verify graphify installation and graph status
```

### Command Options

```bash
# mcp, install, check, index, outline:
--graph   Path to graphify-out/ directory (default: auto-detect)

# build:
--config  Path to graphify-tools.config.yml
--force   Force full rebuild (skip incremental update)

# install:
--target  Editor to configure: opencode, cursor, claude, vscode
```

## Editor Configuration

The quickest way to configure your editor is with the `install` command:

```bash
graphify-mcp-tools install --target opencode
graphify-mcp-tools install --target cursor
graphify-mcp-tools install --target claude
graphify-mcp-tools install --target vscode
```

The `install` command does four things for each target:

1. **Registers the MCP server** — so the editor can call graph tools
2. **Installs a hook/rule** — reminds the AI agent to use graph tools instead of manual file searches
3. **Installs a skill file** — teaches the AI agent how to use each graph tool (parameters, use cases, best practices)
4. **Writes the config file** — `graphify-tools.config.yml` inside the editor directory (e.g. `.opencode/graphify-tools.config.yml`)

| Target | MCP Config | Hook/Rule | Skill |
|--------|-----------|-----------|-------|
| OpenCode | `.opencode/opencode.json` | `.opencode/plugins/graphify-mcp-tools.js` (`tool.execute.before`) | `.opencode/skills/graphify-mcp-tools/SKILL.md` |
| Cursor | `.cursor/mcp.json` | `.cursor/rules/graphify-mcp-tools.mdc` (always-on rule + skill) | *(included in rule)* |
| Claude Code | `claude mcp add` (manual) | `.claude/settings.json` (`PreToolUse` hook) | `.claude/skills/graphify-mcp-tools/SKILL.md` |
| VS Code | `.vscode/mcp.json` | `.github/copilot-instructions.md` | *(included in instructions)* |

### OpenCode

MCP server (`.opencode/opencode.json`):

```jsonc
{
  "mcp": {
    "graphify": {
      "type": "local",
      "command": ["npx", "-y", "graphify-mcp-tools", "mcp", "--graph", "./graphify-out"]
    }
  }
}
```

Plugin hook (`.opencode/plugins/graphify-mcp-tools.js`) — fires before bash tool calls to remind the agent that graph tools are available when `graphify-out/graph.json` exists.

### Cursor

MCP server (`.cursor/mcp.json`):
```json
{
  "mcpServers": {
    "graphify": {
      "command": "npx",
      "args": ["-y", "graphify-mcp-tools", "mcp", "--graph", "./graphify-out"]
    }
  }
}
```

Rule (`.cursor/rules/graphify-mcp-tools.mdc`) — always-active rule with full tool documentation.

### VS Code

MCP server (`.vscode/mcp.json`):
```json
{
  "servers": {
    "graphify": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "graphify-mcp-tools", "mcp", "--graph", "./graphify-out"]
    }
  }
}
```

Copilot instructions (`.github/copilot-instructions.md`) — appends a section guiding Copilot to use the MCP graph tools.

### Claude Code

```bash
claude mcp add graphify -- npx -y graphify-mcp-tools mcp --graph ./graphify-out
```

Hook (`.claude/settings.json`) — a `PreToolUse` hook that fires before bash commands, injecting a reminder that graph tools are available.

## Configuration

The `install` command writes `graphify-tools.config.yml` into the editor directory (e.g. `.opencode/graphify-tools.config.yml`). The config is auto-detected from editor directories, or you can pass `--config` explicitly.

```yaml
output: graphify-out

repos:
  - name: api-service
    path: ./services/api
  - name: core-lib
    path: ./services/core

build:
  graphify_args: []
  exclude:               # directory names to skip during detect
    - "dist_package"
    - "build_output"
    - ".tox"
  html: true             # generate graph.html visualization
  # html_min_degree: 3   # if set, only include nodes with degree >= this value

outlines:
  enabled: true
  language: python
  paths:
    - "src/**/*.py"
    - "src/**/*.ts"
  exclude:
    - "**/__pycache__/**"
    - "**/test_*.py"
```

## Multi-Repo Build

Orchestrate graph builds across multiple repositories and merge results:

```bash
graphify-mcp-tools build --config .opencode/graphify-tools.config.yml
```

The build pipeline:
1. For each repo: runs graphify's Python API (`detect` → `extract` → `build` → `cluster` → `to_json`) for initial builds, or `graphify update <path>` for incremental rebuilds
2. Merges individual graphs via `graphify merge-graphs`
3. Normalizes file paths across repos
4. Runs post-build analysis: generates `GRAPH_REPORT.md` (always) and `graph.html` (if `html: true`)
5. Generates the search index (`graph_search.db`)

Requires graphify installed (`pip install graphifyy`). The MCP server itself does NOT require Python — only the `build` command does.

## Programmatic API

```typescript
import {
  openDatabase,
  initializeSchema,
  populateDatabase,
  loadGraphData,
  searchNodes,
  analyzeImpact,
  findShortestPath,
  getNodeDetail,
} from "graphify-mcp-tools";

// Load graph and create in-memory database
const graphData = loadGraphData("./graphify-out/graph.json");
const db = await openDatabase(":memory:");
initializeSchema(db);
populateDatabase(db, graphData);

// Search
const results = searchNodes(db, "authentication", { top_k: 5, type: "function" });

// Impact analysis
const impact = analyzeImpact(db, "Function:authenticate_user", { max_depth: 3 });

// Shortest path
const path = findShortestPath(db, "Module:auth", "Module:api");

// Node detail
const detail = getNodeDetail(db, "Class:UserService");
```

## How It Works

1. **Loads** Graphify's `graph.json` into an in-memory SQLite database (via sql.js WASM)
2. **Indexes** nodes with label/type/repo/community fields for fast text search
3. **Serves** queries over MCP stdio protocol — compatible with any MCP client
4. **Computes** graph algorithms (BFS, DFS, Dijkstra) on-demand from the edge table
5. **Outlines** source files using tree-sitter WASM parsers (with regex fallback)

## License

MIT
