# graphify-mcp-tools

MCP server companion for [Graphify](https://github.com/safishamsi/graphify): exposes knowledge graphs as searchable, queryable tools for AI agents.

Graphify already ships its own MCP server (`python -m graphify.serve`), but this Node.js alternative requires no Python at runtime and adds blast-radius analysis, tree-sitter outlines, and weighted shortest-path queries.

```
Graphify (Python)                    graphify-mcp-tools (Node.js)
┌──────────────────┐                ┌───────────────────────────────────┐
│ tree-sitter AST  │                │ MCP Server (stdio)                │
│ semantic extract │  graph.json    │ ├─ graph_search (text search)     │
│ community detect │ ────────────►  │ ├─ graph_impact (BFS blast radius)│
│ merge-graphs     │                │ ├─ graph_outline (tree-sitter)    │
│ HTML/report/wiki │                │ ├─ graph_path (Dijkstra)          │
└──────────────────┘                │ ├─ graph_explain (node detail)    │
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

1. **Generate a graph** with [Graphify](https://github.com/safishamsi/graphify) (inside your AI assistant):
   ```
   /graphify .
   ```
   Or from CLI:
   ```bash
   pip install graphifyy
   graphify ./my-project
   ```

2. **Start the MCP server**:
   ```bash
   graphify-mcp-tools mcp --graph ./graphify-out
   ```

3. **Configure your editor** (auto-detects OpenCode, Cursor, Claude Code):
   ```bash
   graphify-mcp-tools setup
   ```

## MCP Tools

| Tool | Description |
|------|-------------|
| `graph_search` | Text search across nodes with optional type/repo filters |
| `graph_impact` | BFS blast radius — find all downstream dependents of a symbol |
| `graph_outline` | Tree-sitter code outline for any file (functions, classes, imports) |
| `graph_path` | Dijkstra shortest path between two symbols |
| `graph_explain` | Full detail on a node: edges, community, centrality metrics |
| `graph_status` | Graph metadata: node/edge counts, repos, build timestamp |

## CLI Commands

```bash
graphify-mcp-tools mcp       # Start MCP server (stdio transport)
graphify-mcp-tools build     # Orchestrate multi-repo graphify build + merge
graphify-mcp-tools index     # Generate search index from graph.json
graphify-mcp-tools outline   # Pre-compute outlines for configured patterns
graphify-mcp-tools check     # Verify graphify installation and graph status
graphify-mcp-tools setup     # Auto-configure MCP for editors
```

### Global Options

```bash
--graph   Path to graphify-out/ directory (default: auto-detect)
--config  Path to graphify-tools.config.yml
```

## Editor Configuration

### OpenCode

```json
{
  "mcpServers": {
    "graphify": {
      "command": "npx",
      "args": ["graphify-mcp-tools", "mcp", "--graph", "./graphify-out"]
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json`:
```json
{
  "mcpServers": {
    "graphify": {
      "command": "npx",
      "args": ["graphify-mcp-tools", "mcp", "--graph", "./graphify-out"]
    }
  }
}
```

### Claude Code

```bash
claude mcp add graphify -- npx graphify-mcp-tools mcp --graph ./graphify-out
```

## Configuration

Create `graphify-tools.config.yml` in your project root:

```yaml
graph_dir: ./graphify-out
repos:
  - path: ./services/api
    name: api-service
  - path: ./services/core
    name: core-lib

outline:
  patterns:
    - "src/**/*.py"
    - "src/**/*.ts"
```

## Multi-Repo Build

Orchestrate Graphify across multiple repositories and merge results:

```bash
graphify-mcp-tools build --config graphify-tools.config.yml
```

This runs `graphify <path>` on each configured repo, then uses `graphify merge-graphs` to combine the individual graphs into a unified knowledge graph.

## Programmatic API

```typescript
import {
  openDatabase,
  searchNodes,
  computeImpact,
  findShortestPath,
  getNodeDetail,
} from "graphify-mcp-tools";

const db = await openDatabase("./graphify-out/graph.json");

// Search
const results = searchNodes(db, "authentication", { top_k: 5, type: "function" });

// Impact analysis
const impact = computeImpact(db, "Function:authenticate_user", { max_depth: 3 });

// Shortest path
const path = findShortestPath(db, "Module:auth", "Module:api");

// Node detail
const detail = getNodeDetail(db, "Class:UserService");
```

## How It Works

1. **Loads** Graphify's `graph.json` into an in-memory SQLite database (via sql.js WASM)
2. **Indexes** nodes with label/type/repo fields for fast text search
3. **Serves** queries over MCP stdio protocol — compatible with any MCP client
4. **Computes** graph algorithms (BFS, Dijkstra) on-demand from the edge table
5. **Outlines** source files using tree-sitter WASM parsers (with regex fallback)

## License

MIT
