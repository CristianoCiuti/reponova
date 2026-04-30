# graphify-mcp-tools

> **⚠️ Alpha — Active Development**
> This package is under active development. APIs, config format, and CLI may change between releases.
> It's already usable, but expect rough edges. If you find a bug or something doesn't work as expected,
> please [open an issue](https://github.com/CristianoCiuti/graphify-mcp-tools/issues) — it helps a lot.

MCP server companion for [Graphify](https://github.com/safishamsi/graphify): exposes knowledge graphs as searchable, queryable tools for AI agents.

## Why This Project?

Graphify already ships its own MCP server (`python -m graphify.serve`), but it has limitations:

| | Graphify MCP (built-in) | graphify-mcp-tools |
|---|---|---|
| **Runtime** | Requires Python + graphify installed | Node.js only (no Python at runtime) |
| **Search** | Keyword matching (split + score) | Indexed text search with type/repo filters |
| **Impact analysis** | Not available | BFS blast radius (upstream + downstream) |
| **Context expansion** | BFS/DFS from keywords | BFS/DFS from ranked search results |
| **Shortest path** | Unweighted `nx.shortest_path` | Weighted Dijkstra with edge-type filters |
| **Code outlines** | Not available | Tree-sitter signatures, decorators, docstrings |
| **Hotspots / God nodes** | Separate tool, degree only | Degree, in/out degree, betweenness centrality |
| **Community exploration** | Basic listing | Full community membership with degree ranking |
| **Multi-repo** | Manual merge (no cross-repo edges) | Monorepo mode with cross-repo edge resolution |

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

1. **Install into your editor** (registers MCP server, hook, skill, and config):
   ```bash
   graphify-mcp-tools install --target opencode   # or: cursor, claude, vscode
   ```

2. **Generate a graph** with [Graphify](https://github.com/safishamsi/graphify):

   From an AI assistant (Claude Code, OpenCode, Cursor, etc.):
   ```
   /graphify .
   ```

   Or via the build command (requires `pip install graphifyy`):
   ```bash
   graphify-mcp-tools build
   ```

3. The MCP server starts automatically with your editor. Use the graph tools directly from the AI assistant.

## MCP Tools

These tools are exposed to the AI agent via the MCP protocol:

| Tool | Description |
|------|-------------|
| `graph_search` | Text search across nodes. Supports type/repo filters and BFS/DFS context expansion. |
| `graph_impact` | BFS blast radius — find all upstream/downstream dependents of a symbol. |
| `graph_path` | Weighted shortest path (Dijkstra) between two symbols. Supports edge-type filters. |
| `graph_explain` | Full detail on a node: all edges, community membership, centrality metrics. |
| `graph_community` | List all nodes belonging to a specific community, ranked by degree. |
| `graph_hotspots` | Most connected nodes (god nodes / architectural bottlenecks). Supports multiple metrics. |
| `graph_outline` | Tree-sitter code outline for any file: functions, classes, imports with signatures. |
| `graph_status` | Graph metadata: node/edge counts, repos included, build timestamp. |

## CLI Reference

### `install` — Set up editor integration

```bash
graphify-mcp-tools install --target <editor>
```

| Option | Description |
|--------|-------------|
| `--target` | **Required.** Editor to configure: `opencode`, `cursor`, `claude`, `vscode` |
| `--graph` | Path to `graphify-out/` directory (default: `./graphify-out`) |

What it does:
1. Registers the MCP server in the editor's config
2. Installs a hook/rule that reminds the AI agent to use graph tools
3. Installs a skill file that teaches the AI agent how to use each tool
4. Writes `graphify-mcp-tools.yml` config inside the editor directory

| Target | MCP Config | Hook/Rule | Skill | Config |
|--------|-----------|-----------|-------|--------|
| OpenCode | `.opencode/opencode.json` | `.opencode/plugins/graphify-mcp-tools.js` | `.opencode/skills/graphify-mcp-tools/SKILL.md` | `.opencode/graphify-mcp-tools.yml` |
| Cursor | `.cursor/mcp.json` | `.cursor/rules/graphify-mcp-tools.mdc` | *(embedded in rule)* | `.cursor/graphify-mcp-tools.yml` |
| Claude | `claude mcp add` (manual) | `.claude/settings.json` | `.claude/skills/graphify-mcp-tools/SKILL.md` | `.claude/graphify-mcp-tools.yml` |
| VS Code | `.vscode/mcp.json` | `.github/copilot-instructions.md` | *(embedded in instructions)* | `.vscode/graphify-mcp-tools.yml` |

### `build` — Build the knowledge graph

```bash
graphify-mcp-tools build [--config <path>] [--force]
```

| Option | Description |
|--------|-------------|
| `--config` | Path to `graphify-mcp-tools.yml` (default: auto-detect from editor directories) |
| `--force` | Clean rebuild: deletes output directory, clears per-repo graphify caches, then rebuilds from scratch |

Requires graphify installed (`pip install graphifyy`). The MCP server does **not** require Python — only `build` does.

The build pipeline:
1. For each repo: runs graphify's Python API (`detect` → `extract` → `build` → `cluster` → `to_json`) or `graphify update` for incremental rebuilds
2. In **monorepo** mode (default): symlinks all repos into a single workspace so graphify resolves cross-repo imports in one batch
3. In **separate** mode: builds each repo independently, then merges via `graphify merge-graphs`
4. Normalizes file paths, tags nodes with repo names
5. Generates `GRAPH_REPORT.md` (architecture overview, god nodes, communities)
6. Generates `graph.html` and `graph_communities.html` interactive visualizations (if `html: true`)
7. Generates the search index (`graph_search.db`)
8. Generates code outlines (if `outlines.enabled: true`)

### `mcp` — Start the MCP server

```bash
graphify-mcp-tools mcp [--graph <path>]
```

| Option | Description |
|--------|-------------|
| `--graph` | Path to `graphify-out/` directory (default: auto-detect) |

Starts the MCP server over stdio. Normally launched automatically by the editor — you don't need to run this manually.

### `index` — Rebuild the search index

```bash
graphify-mcp-tools index [--graph <path>]
```

Regenerates `graph_search.db` from an existing `graph.json`. Useful if you modified the graph externally.

### `outline` — Generate code outlines

```bash
graphify-mcp-tools outline [--config <path>] [--graph <path>]
```

Pre-computes tree-sitter outlines for files matching the configured patterns. Results are cached and served by `graph_outline`.

### `check` — Verify installation

```bash
graphify-mcp-tools check [--graph <path>]
```

Checks if graphify is installed, verifies the graph exists, and reports basic stats.

## Configuration

The `install` command writes `graphify-mcp-tools.yml` into the editor directory. All paths in the config are **relative to the config file's location**.

Since the config lives inside the editor directory (e.g. `.opencode/`), use `../` to reference the project root.

The config is auto-detected from these locations (in order):
1. Explicit `--config` argument
2. `graphify-mcp-tools.yml` in the project root
3. `.opencode/graphify-mcp-tools.yml`, `.cursor/graphify-mcp-tools.yml`, `.claude/graphify-mcp-tools.yml`, `.vscode/graphify-mcp-tools.yml`

### Full config reference

```yaml
# Where to write build output (graph.json, graph_search.db, GRAPH_REPORT.md, graph.html)
output: ../graphify-out

# Repositories to include in the build
repos:
  - name: api-service        # label used for repo tagging
    path: ../services/api     # path to the repo root (relative to this file)
  - name: core-lib
    path: ../services/core

# Build options
build:
  mode: monorepo                  # "monorepo" (default) or "separate"
                                  #   monorepo: symlinks all repos into one workspace,
                                  #     single graphify build — resolves cross-repo imports
                                  #   separate: builds each repo independently, then merges
                                  #     with graphify merge-graphs (no cross-repo edges)
  exclude:                        # directory names to skip during file detection
    - "dist_package"              #   these are added to graphify's _SKIP_DIRS set
    - ".tox"                      #   (in addition to built-in: venv/, node_modules/, etc.)
  graphify_args: []               # extra CLI arguments passed to graphify (merge-graphs, update)
  html: true                      # generate graph.html and graph_communities.html after build
  # html_min_degree: 3            # if set, only nodes with degree >= this value are included
                                  #   in the HTML visualization (omit for full graph)

# Outline generation options
outlines:
  enabled: true                   # generate tree-sitter code outlines during build
  language: python                # target language for tree-sitter parsing
  paths:                          # glob patterns for files to outline (relative to repo root)
    - "src/**/*.py"
  exclude:                        # glob patterns to skip
    - "**/__pycache__/**"
    - "**/test_*.py"
    - "**/.git/**"

# MCP server options
server: {}                        # reserved for future configuration
```

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
