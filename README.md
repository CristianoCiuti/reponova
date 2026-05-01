<p align="center">
  <img src="https://img.shields.io/npm/v/reponova?style=flat-square&color=cb3837&logo=npm" alt="npm version" />
  <img src="https://img.shields.io/npm/dm/reponova?style=flat-square&color=blue" alt="npm downloads" />
  <img src="https://img.shields.io/node/v/reponova?style=flat-square&color=339933&logo=node.js&logoColor=white" alt="node version" />
  <img src="https://img.shields.io/github/license/CristianoCiuti/reponova?style=flat-square&color=green" alt="license" />
  <img src="https://img.shields.io/badge/MCP-compatible-8A2BE2?style=flat-square" alt="MCP compatible" />
</p>

<h1 align="center">reponova</h1>

<p align="center">
  <strong>Turn your codebase into a knowledge graph. Query it with AI.</strong>
</p>

<p align="center">
  Knowledge graph builder &amp; <a href="https://modelcontextprotocol.io/">MCP</a> server for AI code assistants.<br/>
  Extracts symbols, relationships, and semantics from your code — then exposes the entire structure<br/>
  as 12 graph tools that any MCP-compatible agent can use.
</p>

---

> **Alpha — Active Development**
> APIs, config format, and CLI may change between releases.
> Already usable in production workflows. [Open an issue](https://github.com/CristianoCiuti/reponova/issues) if something doesn't work.

---

## Why reponova?

AI agents read files one at a time. They don't understand how your codebase fits together — which functions call what, which modules depend on which, where the architectural bottlenecks are.

**reponova fixes that.** It builds a persistent knowledge graph of your entire codebase (or multiple repos) and gives your AI agent 12 specialized tools to query it: search, impact analysis, shortest path, semantic similarity, community detection, and more.

> **One build. Persistent graph. Instant queries across sessions.**
> No re-reading files. No burning tokens on context. The graph remembers everything.

### What makes it different

- **Zero external dependencies** — no Python, no Docker, no database servers. Pure Node.js
- **Multi-repo support** — build one graph spanning multiple repositories
- **Incremental builds** — only re-processes changed files (SHA256 hash cache)
- **Local LLM-enhanced** — optional local LLM for richer community summaries and node descriptions (runs on CPU)
- **12 MCP tools** — from text search to weighted Dijkstra, semantic similarity to natural language queries
- **Works with any MCP client** — OpenCode, Cursor, Claude Code, VS Code Copilot

---

## How it works

```
  Your Codebase                      reponova build                    AI Agent
  ─────────────                      ──────────────                    ────────

  Python / TS / JS                   1. tree-sitter AST parsing        graph_search
  Markdown / Docs    ──────────►     2. Symbol + edge extraction   ──► graph_impact
  Diagrams / SVG                     3. Louvain communities            graph_path
  Multi-repo                         4. TF-IDF / ONNX embeddings       graph_similar
                                     5. Community summaries             graph_ask
                                     6. HTML visualizations             ... (12 tools)
```

---

## Install

```bash
npm install -g reponova
```

Or run directly without installing:

```bash
npx reponova
```

Requires **Node.js >= 18**.

---

## Quick Start

### 1. Install into your editor

```bash
reponova install --target opencode
```

This registers the MCP server, installs hooks/skills, and writes the default `reponova.yml` config.

Supported editors: `opencode`, `cursor`, `claude`, `vscode`

### 2. Build the knowledge graph

```bash
reponova build
```

### 3. Use it

The MCP server starts automatically with your editor. Your AI agent now has access to all 12 graph tools.

```
You: "What would be the impact of refactoring the authenticate function?"
Agent: [calls graph_impact] → shows upstream/downstream blast radius across repos
```

---

## MCP Tools

12 specialized tools exposed over MCP (stdio). Each tool is designed for a specific query pattern.

| Tool | Description |
|------|-------------|
| `graph_search` | 🔍 Full-text search across nodes. Filter by type, repo. Expand results with BFS/DFS. |
| `graph_impact` | 💥 Blast radius analysis — find all upstream/downstream dependents of any symbol. |
| `graph_path` | 🛤️ Weighted shortest path (Dijkstra) between two symbols. Filter by edge type. |
| `graph_explain` | 📋 Full detail on a node: edges, community, centrality metrics, signature, docstring. |
| `graph_similar` | 🧲 Semantic similarity search using TF-IDF or ONNX vector embeddings. |
| `graph_context` | 🧠 Smart context builder with token budget — combines search + vectors + graph expansion. |
| `graph_ask` | 💬 Natural language query — auto-classifies intent and routes to the right tool. |
| `graph_community` | 🏘️ List all nodes in a community, ranked by degree centrality. |
| `graph_hotspots` | 🔥 God nodes / architectural bottlenecks — most connected symbols in the graph. |
| `graph_outline` | 🗂️ Tree-sitter code outline: functions, classes, imports with signatures and line ranges. |
| `graph_docs` | 📄 Search documentation nodes (markdown, text, rst). |
| `graph_status` | 📊 Graph metadata: node/edge counts, repos, build timestamp, reponova version. |

---

## Agentic Workflows

reponova is designed to be the **structural memory layer** for AI coding agents. Here's how to use it effectively in agentic workflows.

### Recommended agent patterns

**Before any refactoring:**
```
1. graph_impact "TargetFunction" → understand blast radius
2. graph_path "ModuleA" "ModuleB" → see dependency chain
3. graph_community 5 → understand the module cluster
4. Make changes with full structural awareness
```

**When exploring unfamiliar code:**
```
1. graph_status → understand graph size and repos
2. graph_hotspots → identify architectural pillars
3. graph_search "authentication" → find entry points
4. graph_explain "Function:authenticate" → deep dive
```

**When answering "where is X used?":**
```
1. graph_search "X" → find the node
2. graph_impact "X" direction=downstream → who depends on it
3. graph_similar "X" → find semantically related code
```

**Natural language queries:**
```
graph_ask "which modules handle payment processing?"
graph_ask "show me the dependency chain from API to database"
graph_ask "what are the most connected classes?"
```

### Integration with editor skills

The `reponova install` command installs a **skill file** and a **hook/rule** that teaches your AI agent when and how to use each tool. The agent automatically reaches for graph tools when it needs structural information.

| Editor | MCP Config | Hook / Rule | Skill | Config |
|--------|-----------|-------------|-------|--------|
| OpenCode | `.opencode/opencode.json` | `.opencode/plugins/reponova.js` | `.opencode/skills/reponova/SKILL.md` | `.opencode/reponova.yml` |
| Cursor | `.cursor/mcp.json` | `.cursor/rules/reponova.mdc` | *(embedded in rule)* | `.cursor/reponova.yml` |
| Claude Code | `claude mcp add` | `.claude/settings.json` | `.claude/skills/reponova/SKILL.md` | `.claude/reponova.yml` |
| VS Code | `.vscode/mcp.json` | `.github/copilot-instructions.md` | *(embedded in instructions)* | `.vscode/reponova.yml` |

### Keeping the graph fresh

```bash
# Incremental rebuild — only processes changed files
reponova build

# Full clean rebuild
reponova build --force
```

> **Tip:** Add `reponova build` to your CI pipeline or as a post-commit hook to keep the graph always up-to-date.

---

## CLI Reference

### `reponova install`

Set up editor integration. Creates MCP config, hook, skill, and `reponova.yml`.

```bash
reponova install --target <editor> [--graph <path>]
```

| Option | Required | Description |
|--------|----------|-------------|
| `--target` | **Yes** | Editor to configure. Values: `opencode`, `cursor`, `claude`, `vscode` |
| `--graph` | No | Path to the `reponova-out/` directory. Default: `./reponova-out` |

### `reponova build`

Build (or rebuild) the knowledge graph.

```bash
reponova build [--config <path>] [--force]
```

| Option | Required | Description |
|--------|----------|-------------|
| `--config` | No | Path to `reponova.yml`. Default: auto-detected (see [Config Resolution](#config-resolution)) |
| `--force` | No | Delete output directory and rebuild from scratch. Default: `false` |

**Build pipeline:**

1. Detect source files, documentation, and diagrams
2. Parse with tree-sitter WASM — extract symbols, calls, imports, inheritance
3. Build directed graph with cross-file / cross-repo edges
4. Detect communities (Louvain algorithm)
5. Generate embeddings (TF-IDF or ONNX MiniLM)
6. Generate community summaries + node descriptions (algorithmic or LLM-enhanced)
7. Generate `graph.html` and `graph_communities.html` interactive visualizations
8. Generate SQLite search index (`graph_search.db`)
9. Generate code outlines and `report.md`

### `reponova mcp`

Start the MCP server over stdio. Normally launched automatically by the editor.

```bash
reponova mcp [--graph <path>]
```

| Option | Required | Description |
|--------|----------|-------------|
| `--graph` | No | Path to `reponova-out/` directory. Default: auto-detected |

### `reponova models`

Manage local models (ONNX embeddings, LLM).

```bash
reponova models list              # Show downloaded models and sizes
reponova models download          # Download all configured models
reponova models remove <name>     # Remove a downloaded model
```

### `reponova check`

Verify graph installation and report basic stats.

```bash
reponova check [--graph <path>]
```

---

## Supported Languages

### Extraction (AST parsing + graph building)

| Language | Extensions | Parser | Node Types |
|----------|-----------|--------|------------|
| Python | `.py`, `.pyw` | tree-sitter-python (WASM) | `function`, `class`, `method`, `module`, `constant` |
| Markdown | `.md`, `.txt`, `.rst` | Built-in | `document`, `section`, `heading` |
| Diagrams | `.puml`, `.plantuml`, `.svg` | Built-in | `diagram`, `component` |

### Outline (tree-sitter code outline)

| Language | Extensions | Outline Support |
|----------|-----------|-----------------|
| Python | `.py`, `.pyw` | Full: functions, classes, methods, imports, signatures, decorators, docstrings |

> **Adding a new language:** Create `src/extract/languages/<lang>.ts` implementing `LanguageExtractor`, register it in `registry.ts`, add the `.wasm` grammar to `grammars/`. Both extraction and outline pick it up automatically.

### Edge Types

Every edge in the graph has a type that describes the relationship:

| Edge Type | Description | Example |
|-----------|-------------|---------|
| `calls` | Function/method invocation | `process_data` → `validate_input` |
| `imports` | Module-level import | `api.py` → `models.py` |
| `imports_from` | Named import of a specific symbol | `api.py` → `UserModel` |
| `extends` | Class inheritance | `AdminUser` → `BaseUser` |
| `contains` | Module contains a symbol | `auth.py` → `login()` |
| `contains_section` | Document contains a section | `README.md` → `Installation` |
| `method` | Class contains a method | `UserService` → `get_user()` |

---

## Configuration

### Config Resolution

The config file is auto-detected from these locations (first match wins):

1. Explicit `--config` argument
2. `reponova.yml` in the project root
3. `.opencode/reponova.yml`
4. `.cursor/reponova.yml`
5. `.claude/reponova.yml`
6. `.vscode/reponova.yml`

All paths inside the config are **relative to the config file's location**. When placed inside an editor directory (e.g. `.opencode/`), use `../` to reference the project root.

### Full Config Reference

Every field, every valid value, every default.

```yaml
# ──────────────────────────────────────────────────────────────────────────────
# reponova.yml — Full Configuration Reference
# ──────────────────────────────────────────────────────────────────────────────

# Where to write build output (graph.json, graph.html, graph_search.db, etc.)
# Type: string
# Default: "reponova-out"
output: ../reponova-out

# ── Repositories ──────────────────────────────────────────────────────────────
# List of repositories to include in the build.
# Each repo needs a unique name and a path (relative to this config file).
repos:
  - name: api-service           # string — unique identifier for this repo
    path: ../services/api       # string — path to repo root (relative to this file)
  - name: core-lib
    path: ../services/core

# ── Centralized Model Management ─────────────────────────────────────────────
# Shared settings for all models (LLM, ONNX embeddings).
# Individual features (community_summaries, node_descriptions) can specify
# their own model via a `model` field. These settings apply to all of them.
models:
  # Directory to cache downloaded models (ONNX embeddings + LLM weights)
  # Type: string
  # Default: "~/.cache/reponova/models"
  cache_dir: ~/.cache/reponova/models

  # GPU acceleration backend for LLM inference
  # Values: "auto" | "cpu" | "cuda" | "metal" | "vulkan"
  #   - auto:    auto-detect best available backend
  #   - cpu:     force CPU inference (slower but always works)
  #   - cuda:    NVIDIA GPU (requires CUDA drivers)
  #   - metal:   Apple Silicon GPU (macOS only)
  #   - vulkan:  Cross-platform GPU (AMD, Intel, NVIDIA)
  # Default: "auto"
  gpu: auto

  # Number of CPU threads for LLM inference
  # Type: number
  # Default: 0 (auto-detect based on available cores)
  threads: 0

  # Automatically download models on first use
  # Type: boolean
  # Default: true
  download_on_first_use: true

# ── Build Options ─────────────────────────────────────────────────────────────
build:

  # Build mode: how to treat multiple repos
  # Values: "monorepo" | "separate"
  #   - monorepo:  all repos merged into one graph (cross-repo edges resolved)
  #   - separate:  each repo gets its own graph (no cross-repo edges)
  # Default: "monorepo"
  mode: monorepo

  # Glob patterns for source code files to include
  # Type: string[]
  # Default: [] (empty = auto-detect by file extension using registered extractors)
  # Example: ["src/**/*.py", "lib/**/*.ts"]
  patterns: []

  # Glob patterns to exclude from source code detection
  # Type: string[]
  # Default: []
  # Example: ["**/generated/**", "**/*.test.ts", "**/vendor/**"]
  # Note: common directories (node_modules, .git, __pycache__, etc.) are always skipped.
  exclude: []

  # Incremental builds: only re-process files whose SHA256 hash changed
  # Type: boolean
  # Default: true
  incremental: true

  # Generate interactive HTML visualizations (graph.html + graph_communities.html)
  # Type: boolean
  # Default: true
  html: true

  # Minimum node degree to include in HTML visualization
  # Useful for large graphs — filters out leaf nodes to reduce clutter
  # Type: integer (>= 1)
  # Default: not set (include all nodes)
  # html_min_degree: 3

  # ── Documentation Extraction ──────────────────────────────────────────────
  docs:
    # Enable/disable documentation extraction
    # Type: boolean
    # Default: true
    enabled: true

    # Glob patterns for documentation files (relative to repo root)
    # Type: string[]
    # Default: ["**/*.md", "**/*.txt", "**/*.rst"]
    patterns:
      - "**/*.md"
      - "**/*.txt"
      - "**/*.rst"

    # Glob patterns to exclude from documentation extraction
    # Type: string[]
    # Default: ["**/CHANGELOG.md", "**/node_modules/**"]
    exclude:
      - "**/CHANGELOG.md"
      - "**/node_modules/**"

    # Maximum file size in KB — files larger than this are skipped
    # Type: number
    # Default: 500
    max_file_size_kb: 500

  # ── Diagram / Image Extraction ────────────────────────────────────────────
  images:
    # Enable/disable diagram extraction
    # Type: boolean
    # Default: true
    enabled: true

    # Glob patterns for diagram files (relative to repo root)
    # Type: string[]
    # Default: ["**/*.puml", "**/*.plantuml", "**/*.svg"]
    patterns:
      - "**/*.puml"
      - "**/*.plantuml"
      - "**/*.svg"

    # Glob patterns to exclude
    # Type: string[]
    # Default: ["**/node_modules/**"]
    exclude:
      - "**/node_modules/**"

    # Parse PlantUML files to extract components and relationships
    # Type: boolean
    # Default: true
    parse_puml: true

    # Extract text content from SVG files
    # Type: boolean
    # Default: true
    parse_svg_text: true

  # ── Embeddings ────────────────────────────────────────────────────────────
  # Vector representations for semantic search (graph_similar, graph_context)
  embeddings:
    # Enable/disable embedding generation
    # Type: boolean
    # Default: true
    enabled: true

    # Embedding method
    # Values: "tfidf" | "onnx"
    #   - tfidf:  Feature-hashed TF-IDF (384-dim). Fast (milliseconds). No model download.
    #   - onnx:   MiniLM-L6-v2 via ONNX Runtime (384-dim). More accurate. ~86MB model download.
    # Default: "tfidf"
    method: tfidf

    # ONNX model name (only used when method: "onnx")
    # Type: string
    # Default: "all-MiniLM-L6-v2"
    model: all-MiniLM-L6-v2

    # Embedding vector dimensions
    # Type: number
    # Default: 384
    dimensions: 384

    # Batch size for ONNX inference
    # Type: number
    # Default: 128
    batch_size: 128

  # ── Community Summaries ───────────────────────────────────────────────────
  # Natural-language summaries for each detected community (cluster of related symbols).
  # Independent from node descriptions — can enable one without the other.
  community_summaries:
    # Enable/disable community summary generation
    # Type: boolean
    # Default: true
    enabled: true

    # Maximum number of communities to summarize
    # Type: integer (>= 0)
    # Default: 0 (no limit — summarize all communities)
    # Set to a positive number to cap processing time on large graphs
    max_number: 0

    # LLM model for richer summaries (optional)
    # Type: string | null
    # Default: null (algorithmic summaries — still useful, just less prose)
    # Uncomment to enable LLM-enhanced summaries:
    # model: "hf:Qwen/Qwen2.5-0.5B-Instruct-GGUF:Q4_K_M"

    # Context window size for LLM inference (only used when model is set)
    # Type: number
    # Default: 512
    context_size: 512

  # ── Node Descriptions ─────────────────────────────────────────────────────
  # Natural-language descriptions for high-degree (important) nodes.
  # Independent from community summaries — can enable one without the other.
  node_descriptions:
    # Enable/disable node description generation
    # Type: boolean
    # Default: true
    enabled: true

    # Degree threshold for node description generation
    # Type: number (0.0 – 1.0)
    # Default: 0.8
    # Meaning: top (1 - threshold)% of nodes by degree get descriptions.
    #   - 0.8 = top 20% of nodes
    #   - 0.5 = top 50% of nodes
    #   - 0.0 = all nodes (expensive!)
    #   - 1.0 = no nodes
    threshold: 0.8

    # LLM model for richer descriptions (optional)
    # Type: string | null
    # Default: null (algorithmic descriptions)
    # Uncomment to enable LLM-enhanced descriptions:
    # model: "hf:Qwen/Qwen2.5-0.5B-Instruct-GGUF:Q4_K_M"

    # Context window size for LLM inference (only used when model is set)
    # Type: number
    # Default: 512
    context_size: 512

# ── Outlines ──────────────────────────────────────────────────────────────────
# Tree-sitter code outlines: functions, classes, imports with signatures.
# Language is auto-detected from file extension (no need to specify it).
outlines:
  # Enable/disable outline generation
  # Type: boolean
  # Default: true
  enabled: true

  # Glob patterns for files to outline (relative to repo root)
  # Type: string[]
  # Default: ["src/**/*.ts", "src/**/*.py", "src/**/*.js"]
  paths:
    - "src/**/*.py"
    - "src/**/*.ts"
    - "src/**/*.js"

  # Glob patterns to exclude from outline generation
  # Type: string[]
  # Default: ["**/node_modules/**", "**/.git/**", "**/dist/**"]
  exclude:
    - "**/__pycache__/**"
    - "**/node_modules/**"
    - "**/.git/**"
    - "**/dist/**"

# ── Server ────────────────────────────────────────────────────────────────────
# MCP server options (reserved for future use)
# Type: object
# Default: {}
server: {}
```

### Minimal Config

Most fields have sensible defaults. A minimal config for a single repo:

```yaml
output: ../reponova-out
repos:
  - name: my-project
    path: ..
```

### Multi-repo Config

```yaml
output: ../reponova-out
repos:
  - name: api
    path: ../services/api
  - name: core
    path: ../services/core
  - name: shared
    path: ../libs/shared
build:
  mode: monorepo    # merge into one graph with cross-repo edges
```

### LLM-enhanced Config

For richer, natural-language community summaries and node descriptions:

```yaml
output: ../reponova-out
repos:
  - name: my-project
    path: ..
models:
  gpu: auto                 # auto-detect GPU, falls back to CPU
  download_on_first_use: true
build:
  community_summaries:
    enabled: true
    model: "hf:Qwen/Qwen2.5-0.5B-Instruct-GGUF:Q4_K_M"   # ~350MB download
  node_descriptions:
    enabled: true
    threshold: 0.5          # describe top 50% nodes by degree
    model: "hf:Qwen/Qwen2.5-0.5B-Instruct-GGUF:Q4_K_M"   # same model, auto-shared
```

> When `community_summaries.model` and `node_descriptions.model` resolve to the same file, reponova shares a single engine instance — no double memory usage.

---

## Build Output

After `reponova build`, the output directory contains:

```
reponova-out/
├── graph.json                 # Full graph: nodes, edges, metadata
├── graph.html                 # Interactive visualization (vis.js) — click, search, filter
├── graph_communities.html     # Community-focused visualization
├── graph_search.db            # SQLite search index (FTS5 + metadata)
├── report.md                  # Build report: stats, hotspots, communities
├── outlines/                  # Pre-computed code outlines per file
│   └── <repo>/<file>.json
├── vectors/                   # LanceDB vector store (embeddings)
└── .cache/                    # SHA256 file hash cache for incremental builds
```

---

## Programmatic API

Use reponova as a library in your own Node.js tools:

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

// Load and index the graph
const graphData = loadGraphData("./reponova-out/graph.json");
const db = await openDatabase(":memory:");
initializeSchema(db);
populateDatabase(db, graphData);

// Search
const results = searchNodes(db, "authentication", { top_k: 5, type: "function" });

// Impact analysis
const impact = analyzeImpact(db, "Function:authenticate_user", { max_depth: 3 });

// Shortest path
const path = findShortestPath(db, graphData, "ModuleA", "ModuleB");

// Node detail
const detail = getNodeDetail(db, graphData, "Function:process_payment");
```

---

## FAQ

**Do I need an API key?**
No. Everything runs locally. The optional LLM is a local model (Qwen 0.5B) — no cloud, no API keys, no data leaves your machine.

**How big are the models?**
- TF-IDF embeddings: no model needed (computed in-process)
- ONNX embeddings: ~86MB (MiniLM-L6-v2)
- LLM (optional): ~350MB (Qwen 0.5B Q4_K_M) — only downloaded when `community_summaries.model` or `node_descriptions.model` is set

**How long does a build take?**
Depends on codebase size. Rough benchmarks:
- Small project (500 files): ~5-10 seconds
- Medium project (5,000 files): ~30-60 seconds
- Large monorepo (20,000+ files): 2-5 minutes
- LLM summaries add ~2-3 seconds per community

**Can I use it without an editor?**
Yes. Use the CLI (`reponova build`, `reponova check`) and the programmatic API. The MCP server is just one way to query the graph.

**What about TypeScript / JavaScript extraction?**
Tree-sitter grammars are ready. The extractor implementation is on the roadmap — contributions welcome.

---

## Contributing

Contributions are welcome. See the language registry for how to add new language support:

```
src/extract/languages/registry.ts    # extraction registry
src/outline/languages/registry.ts    # outline registry
grammars/                            # tree-sitter WASM grammar files
```

---

## License

MIT — [CristianoCiuti/reponova](https://github.com/CristianoCiuti/reponova)
