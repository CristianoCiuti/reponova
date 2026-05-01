# reponova

> **⚠️ Alpha — Active Development**
> This package is under active development. APIs, config format, and CLI may change between releases.
> It's already usable, but expect rough edges. If you find a bug or something doesn't work as expected,
> please [open an issue](https://github.com/CristianoCiuti/reponova/issues) — it helps a lot.

Knowledge graph builder & MCP server for AI code assistants. Builds a searchable, queryable graph of your codebase — then exposes it to AI agents via MCP tools.

## What It Does

1. **Extracts** symbols (functions, classes, modules, docs, diagrams) from your codebase using tree-sitter WASM parsers
2. **Builds** a knowledge graph with cross-file and cross-repo relationships
3. **Detects** communities (Louvain) and generates embeddings (TF-IDF or ONNX)
4. **Serves** the graph over MCP — AI agents can search, trace impact, find paths, and explore architecture

```
Your Codebase                        reponova
┌──────────────────┐                ┌───────────────────────────────────┐
│ Python / TS / JS │                │ MCP Server (stdio)                │
│ Markdown / Docs  │  reponova      │ ├─ graph_search (+BFS/DFS expand) │
│ Diagrams / SVG   │  build         │ ├─ graph_impact (blast radius)    │
│                  │ ────────────►  │ ├─ graph_path (weighted Dijkstra) │
│ Multi-repo       │                │ ├─ graph_explain (node detail)    │
└──────────────────┘                │ ├─ graph_similar (semantic)       │
                                    │ ├─ graph_context (smart context)  │
                                    │ ├─ graph_ask (NL query)           │
                                    │ ├─ graph_community (membership)   │
                                    │ ├─ graph_hotspots (god nodes)     │
                                    │ ├─ graph_outline (tree-sitter)    │
                                    │ ├─ graph_docs (doc search)        │
                                    │ └─ graph_status                   │
                                    └───────────────────────────────────┘
```

Zero external runtime dependencies — no Python, no Docker, no database servers. Everything runs locally in Node.js.

## Install

```bash
npm install -g reponova
# or run directly
npx reponova
```

Requires Node.js >= 18.

## Quick Start

1. **Install into your editor** (registers MCP server, hook, skill, and config):
   ```bash
   reponova install --target opencode   # or: cursor, claude, vscode
   ```

2. **Build the knowledge graph**:
   ```bash
   reponova build
   ```

3. The MCP server starts automatically with your editor. Use the graph tools directly from the AI assistant.

## MCP Tools

| Tool | Description |
|------|-------------|
| `graph_search` | Text search across nodes. Supports type/repo filters and BFS/DFS context expansion. |
| `graph_impact` | BFS blast radius — find all upstream/downstream dependents of a symbol. |
| `graph_path` | Weighted shortest path (Dijkstra) between two symbols. Supports edge-type filters. |
| `graph_explain` | Full detail on a node: all edges, community membership, centrality metrics. |
| `graph_similar` | Semantic similarity search using TF-IDF or ONNX embeddings. |
| `graph_context` | Smart context builder with token budget — combines search, vectors, and graph expansion. |
| `graph_ask` | Natural language query — classifies intent and routes to the right tool. |
| `graph_community` | List all nodes belonging to a specific community, ranked by degree. |
| `graph_hotspots` | Most connected nodes (god nodes / architectural bottlenecks). Supports multiple metrics. |
| `graph_outline` | Tree-sitter code outline for any file: functions, classes, imports with signatures. |
| `graph_docs` | Search documentation nodes (markdown, text, rst). |
| `graph_status` | Graph metadata: node/edge counts, repos included, build timestamp. |

## CLI Reference

### `install` — Set up editor integration

```bash
reponova install --target <editor>
```

| Option | Description |
|--------|-------------|
| `--target` | **Required.** Editor to configure: `opencode`, `cursor`, `claude`, `vscode` |
| `--graph` | Path to `reponova-out/` directory (default: `./reponova-out`) |

What it does:
1. Registers the MCP server in the editor's config
2. Installs a hook/rule that reminds the AI agent to use graph tools
3. Installs a skill file that teaches the AI agent how to use each tool
4. Writes `reponova.yml` config inside the editor directory

| Target | MCP Config | Hook/Rule | Skill | Config |
|--------|-----------|-----------|-------|--------|
| OpenCode | `.opencode/opencode.json` | `.opencode/plugins/reponova.js` | `.opencode/skills/reponova/SKILL.md` | `.opencode/reponova.yml` |
| Cursor | `.cursor/mcp.json` | `.cursor/rules/reponova.mdc` | *(embedded in rule)* | `.cursor/reponova.yml` |
| Claude | `claude mcp add` (manual) | `.claude/settings.json` | `.claude/skills/reponova/SKILL.md` | `.claude/reponova.yml` |
| VS Code | `.vscode/mcp.json` | `.github/copilot-instructions.md` | *(embedded in instructions)* | `.vscode/reponova.yml` |

### `build` — Build the knowledge graph

```bash
reponova build [--config <path>] [--force]
```

| Option | Description |
|--------|-------------|
| `--config` | Path to `reponova.yml` (default: auto-detect from editor directories) |
| `--force` | Clean rebuild: deletes output directory and rebuilds from scratch |

The build pipeline:
1. Detects source files, documentation, and diagrams
2. Extracts symbols and relationships using tree-sitter WASM parsers
3. Builds the knowledge graph with cross-file and cross-repo edges
4. Detects communities (Louvain algorithm)
5. Generates embeddings (TF-IDF by default, or ONNX MiniLM)
6. Generates community summaries and node descriptions (algorithmic or LLM-enhanced)
7. Generates `graph.html` and `graph_communities.html` interactive visualizations
8. Generates the search index (`graph_search.db`)
9. Generates code outlines and `report.md`

### `mcp` — Start the MCP server

```bash
reponova mcp [--graph <path>]
```

| Option | Description |
|--------|-------------|
| `--graph` | Path to `reponova-out/` directory (default: auto-detect) |

Starts the MCP server over stdio. Normally launched automatically by the editor.

### `models` — Manage local models

```bash
reponova models list              # Show downloaded models
reponova models download          # Download embedding/LLM models
reponova models remove <name>     # Remove a downloaded model
```

### `check` — Verify installation

```bash
reponova check [--graph <path>]
```

Verifies the graph exists and reports basic stats.

## Configuration

The `install` command writes `reponova.yml` into the editor directory. All paths are **relative to the config file's location**.

The config is auto-detected from these locations (in order):
1. Explicit `--config` argument
2. `reponova.yml` in the project root
3. `.opencode/reponova.yml`, `.cursor/reponova.yml`, `.claude/reponova.yml`, `.vscode/reponova.yml`

### Full config reference

```yaml
# Where to write build output
output: ../reponova-out

# Repositories to include in the build
repos:
  - name: api-service
    path: ../services/api
  - name: core-lib
    path: ../services/core

# Build options
build:
  mode: monorepo                  # "monorepo" or "separate"
  exclude: []                     # directory names to skip (e.g. dist_package, .tox)
  html: true                      # generate interactive HTML visualizations

  # Embeddings: vector representations for semantic search
  embeddings:
    enabled: true
    method: tfidf                 # "tfidf" (fast, default) or "onnx" (MiniLM, more accurate)

  # Summaries: community summaries and node descriptions
  summaries:
    enabled: true
    max_communities: 0            # 0 = no limit

  # LLM: local language model for enhanced summaries (optional)
  llm:
    enabled: false                # set true to use Qwen 0.5B for richer summaries
    model: qwen2.5-0.5b-instruct
    gpu: auto                     # "auto", "cpu", or "cuda"/"vulkan"/"metal"

# Outline generation
outlines:
  enabled: true
  language: python
  paths:
    - "src/**/*.py"
  exclude:
    - "**/__pycache__/**"
    - "**/test_*.py"
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
} from "reponova";

const graphData = loadGraphData("./reponova-out/graph.json");
const db = await openDatabase(":memory:");
initializeSchema(db);
populateDatabase(db, graphData);

const results = searchNodes(db, "authentication", { top_k: 5, type: "function" });
const impact = analyzeImpact(db, "Function:authenticate_user", { max_depth: 3 });
```

## License

MIT
