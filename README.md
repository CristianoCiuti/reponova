<p align="center">
  <img src="https://img.shields.io/npm/v/reponova?style=flat-square&color=cb3837&logo=npm" alt="npm version" />
  <img src="https://img.shields.io/npm/dm/reponova?style=flat-square&color=blue" alt="npm downloads" />
  <img src="https://img.shields.io/node/v/reponova?style=flat-square&color=339933&logo=node.js&logoColor=white" alt="node version" />
  <img src="https://img.shields.io/github/license/CristianoCiuti/reponova?style=flat-square&color=green" alt="license" />
  <img src="https://img.shields.io/badge/MCP-compatible-8A2BE2?style=flat-square" alt="MCP compatible" />
</p>

<p align="center">
  <img src="media/reponova-social.jpg" alt="RepoNova" width="600" />
</p>

<h1 align="center">🤖 RepoNova 🔭</h1>

<p align="center">
  <strong>Turn your codebase into a knowledge graph. Query it with AI.</strong>
</p>

<p align="center" style="font-style: italic;">
  Knowledge graph builder &amp; <a href="https://modelcontextprotocol.io/">MCP</a> server for AI code assistants.<br/>
  Extracts symbols, relationships, and semantics from your code — then exposes the entire structure<br/>
  as 11 graph tools that any MCP-compatible agent can use.
</p>

---

> **⚠️ Alpha — Active Development**
> APIs, config format, and CLI may change between releases.
> Already usable in production workflows. [Open an issue](https://github.com/CristianoCiuti/reponova/issues) if something doesn't work.

---

## Why RepoNova?

AI agents read files one at a time. They don't understand how your codebase fits together — which functions call what, which modules depend on which, where the architectural bottlenecks are.

**RepoNova fixes that.** It builds a persistent knowledge graph of your entire codebase (or multiple repos) and gives your AI agent 11 specialized tools to query it: search, impact analysis, shortest path, semantic similarity, community detection, and more.

> **One build. Persistent graph. Instant queries across sessions.**
> No re-reading files. No burning tokens on context. The graph remembers everything.

### What makes it different

- **Zero external dependencies** — no Python, no Docker, no database servers. Pure Node.js
- **Multi-repo support** — build one graph spanning multiple repositories
- **Smart incremental builds** — SHA256 file hashing, per-phase config change detection, selective subsystem regeneration
- **Local LLM-enhanced** — optional local LLM for richer community summaries and node descriptions (runs on CPU)
- **11 MCP tools** — from text search to weighted Dijkstra, semantic similarity to structural queries
- **Works with any MCP client** — OpenCode, Cursor, Claude Code, VS Code Copilot

---

## How it works

```
  Your Codebase                      reponova build                    AI Agent
  ─────────────                      ──────────────                    ────────

  Python ¹                           1. tree-sitter AST parsing        graph_search
  Markdown / Docs    ──────────►     2. Symbol + edge extraction   ──► graph_impact
  Diagrams / SVG                     3. Louvain communities            graph_path
  Multi-repo                         4. TF-IDF / ONNX embeddings       graph_similar
                                     5. Community summaries
                                     6. HTML visualizations            ... (11 tools)
```

¹ More languages coming soon — [contributions welcome](#contributing).

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

The MCP server starts automatically with your editor. Your AI agent now has access to all 11 graph tools.

```
You: "What would be the impact of refactoring the authenticate function?"
Agent: [calls graph_impact] → shows upstream/downstream blast radius across repos
```

---

## MCP Tools

11 specialized tools exposed over MCP (stdio). Each tool is designed for a specific query pattern.

| Tool | Description |
|------|-------------|
| `graph_search` | 🔍 Full-text search across nodes. Filter by type, repo. Expand results with BFS/DFS. |
| `graph_impact` | 💥 Blast radius analysis — find all upstream/downstream dependents of any symbol. |
| `graph_path` | 🛤️ Weighted shortest path (Dijkstra) between two symbols. Filter by edge type. |
| `graph_explain` | 📋 Full detail on a node: edges, community, centrality metrics, signature, docstring. |
| `graph_similar` | 🧲 Semantic similarity search using TF-IDF or ONNX vector embeddings. |
| `graph_context` | 🧠 Smart context builder with token budget — combines search + vectors + graph expansion. |
| `graph_community` | 🏘️ List all nodes in a community, ranked by degree centrality. |
| `graph_hotspots` | 🔥 God nodes / architectural bottlenecks — most connected symbols in the graph. |
| `graph_outline` | 🗂️ Tree-sitter code outline: functions, classes, imports with signatures and line ranges. |
| `graph_docs` | 📄 Search documentation nodes (markdown, text, rst). |
| `graph_status` | 📊 Graph metadata: node/edge counts, repos, build timestamp, reponova version, build config. |

---

## Agentic Workflows

RepoNova is designed to be the **structural memory layer** for AI coding agents. Here's how to use it effectively in agentic workflows.

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

# Force rebuild — ignores all caches, reruns every phase
reponova build --force
```

> **Tip:** Add `reponova build` to your CI pipeline or as a post-commit hook to keep the graph always up-to-date.

### How incremental builds work

RepoNova's incremental build goes beyond simple file-change detection. It minimizes redundant work at every stage of the pipeline:

| Layer | What it does | When it kicks in |
|-------|-------------|-----------------|
| **File hashing** | SHA256 per file — only re-parse changed/added files. Detects removed files too. | Every incremental build |
| **Config fingerprinting** | Compares a hash of build-relevant config fields across builds. | When `reponova.yml` changes between builds |
| **Selective subsystem regeneration** | Only reruns the subsystems affected by config changes (e.g. switching `embeddings.method` reruns embeddings but not parsing). | Config-only changes (no file changes) |
| **Incremental embeddings** | Tracks text content per node. Only re-embeds nodes whose text changed. | Every incremental build with embeddings enabled |
| **Outline hashing** | SHA256 per source file for outlines. Skips outline regeneration for unchanged files. | Every incremental build with outlines enabled |
| **Stale artifact cleanup** | Removes outdated artifacts when config changes invalidate them (e.g. deletes `tfidf_idf.json` after switching to ONNX). | After config change detection |
| **Per-phase skip** | Each phase independently checks its cache and config fingerprint. If nothing relevant changed, the phase is skipped. | Every incremental build |

The build config fingerprint is stored in `graph.json` metadata. Each phase also stores its own config hash in `.cache/` for per-phase change detection.

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
reponova build [--config <path>] [--force] [--target <phase>]
```

| Option | Required | Description |
|--------|----------|-------------|
| `--config` | No | Path to `reponova.yml`. Default: auto-detected (see [Config Resolution](#config-resolution)) |
| `--force` | No | Ignore all caches and rerun every phase. Default: `false` |
| `--target` | No | Run only this phase and its transitive dependencies. Useful for selective rebuilds without running the full pipeline. |

**Target examples:**

```bash
reponova build --target index       # file-detection → graph → communities → index
reponova build --target outlines    # file-detection → outlines
reponova build --target html        # file-detection → graph → communities → community-summaries → node-descriptions → html
reponova build --target embeddings  # file-detection → graph → communities → community-summaries → node-descriptions → embeddings
```

When `--target` is omitted, all 10 phases run in DAG order.

**Build pipeline (10 DAG phases, 5 levels):**

The pipeline executes as a directed acyclic graph — phases within the same level run in parallel:

```
Level 0: file-detection
Level 1: graph, outlines                                       (parallel)
Level 2: communities
Level 3: community-summaries, node-descriptions, search-index  (parallel)
Level 4: embeddings, html, report                              (parallel)
```

| Phase | What it does |
|-------|-------------|
| **file-detection** | Detect source files, documentation, and diagrams (centralized glob matching via [picomatch](https://github.com/micromatch/picomatch)) |
| **graph** | Diff files against previous build, parse changed files with tree-sitter WASM, extract symbols/calls/imports/inheritance, build directed graph with cross-file/cross-repo edges |
| **outlines** | Generate tree-sitter code outlines per file (SHA256 per-file hashing — skip unchanged) |
| **communities** | Detect communities (Louvain algorithm) and write final `graph.json` with community assignments |
| **community-summaries** | Generate community summaries (algorithmic or LLM-enhanced) |
| **node-descriptions** | Generate descriptions for high-degree nodes (algorithmic or LLM-enhanced) |
| **search-index** | Generate SQLite search index (`graph_search.db`) |
| **embeddings** | Generate embeddings incrementally — only re-embed nodes whose text content changed (TF-IDF or ONNX MiniLM). Clean up stale artifacts on config change. |
| **html** | Generate `graph.html` and `graph_communities.html` interactive visualizations |
| **report** | Generate `report.md` build report |

Each phase internally handles its own incremental logic: file diffing, config fingerprint comparison, cache invalidation, and stale artifact cleanup.

### `reponova mcp`

Start the MCP server over stdio. Normally launched automatically by the editor.

```bash
reponova mcp [--graph <path>]
```

| Option | Required | Description |
|--------|----------|-------------|
| `--graph` | No | Path to `reponova-out/` directory. Default: auto-detected |

### `reponova models`

Manage local AI models (ONNX embeddings, LLM). See [Models](#models) for details.

```bash
reponova models status              # Show configured and cached models
reponova models download            # Pre-download all models needed by config
reponova models remove <name>       # Remove a specific cached model
reponova models clear               # Remove all cached models
```

| Option | Required | Description |
|--------|----------|-------------|
| `--config` | No | Path to `reponova.yml`. Default: auto-detected |
| `--cache-dir` | No | Override model cache directory |

### `reponova check`

Verify graph installation, build integrity, and report stats.

```bash
reponova check [--graph <path>]
```

| Option | Required | Description |
|--------|----------|-------------|
| `--graph` | No | Path to `reponova-out/` directory. Default: auto-detected |

Checks performed:
- Graph file (`graph.json`) exists and is readable
- Build metadata presence (`build_config` fingerprint)
- Embedding artifacts consistency (TF-IDF IDF file, ONNX vectors)
- Warns if embedding method in config doesn't match the built artifacts
- Search index (`graph_search.db`) existence
- Outlines directory existence
- tree-sitter WASM availability

---

## Supported Languages

### Extraction (AST parsing + graph building)

| Language | Extensions | Parser | Node Types |
|----------|-----------|--------|------------|
| Python | `.py`, `.pyw` | tree-sitter-python (WASM) | `function`, `class`, `method`, `module`, `constant` |
| Markdown | `.md`, `.txt`, `.rst` | Built-in | `document`, `section` |
| Diagrams | `.puml`, `.plantuml`, `.svg`, `.png`, `.jpg`, `.jpeg`, `.gif` | Built-in | `diagram`, `component`, `interface`, `section` |

### Outline (tree-sitter code outline)

| Language | Extensions | Outline Support |
|----------|-----------|-----------------|
| Python | `.py`, `.pyw` | Full: functions, classes, methods, imports, signatures, decorators, docstrings |

> **Adding a new language:** Create `src/extract/languages/<lang>.ts` implementing `LanguageExtractor`, register it in `registry.ts`, add the `.wasm` grammar to `grammars/`. See [Contributing > Adding Language Support](#adding-language-support-extraction) for the full interface reference.
>
> **Note:** Extraction and outline are **separate systems** with different registries and interfaces. Registering an extractor gives you graph building (symbols, edges, imports). For code outlines (`graph_outline`), you also need a `LanguageSupport` implementation in `src/outline/languages/` — see [Contributing > Adding Outline Support](#adding-outline-support).

### Edge Types

Every edge in the graph has a type that describes the relationship:

| Edge Type | Description | Example |
|-----------|-------------|---------|
| `calls` | Function/method invocation | `process_data` → `validate_input` |
| `imports` | Module-level import | `api.py` → `models.py` |
| `imports_from` | Named import of a specific symbol | `api.py` → `UserModel` |
| `extends` | Class inheritance | `AdminUser` → `BaseUser` |
| `contains` | Parent contains a child (module→symbol, class→method, document→section) | `auth.py` → `login()` |

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

### Pattern Resolution

All glob patterns (`patterns`, `exclude`, `docs.patterns`, etc.) are matched against **workspace-relative paths**. How those paths look depends on the number of repos.

#### Single-repo

With one repo, file paths are relative to the repo root — no prefix:

```
src/core.py
src/utils/helpers.py
tests/test_core.py
```

Patterns work as you'd expect:

```yaml
repos:
  - name: my-project
    path: .
patterns: ["src/**/*.py"]            # matches src/core.py ✓
exclude: ["tests/**"]                # excludes tests/test_core.py ✓
```

#### Multi-repo

With multiple repos, each file path is **prefixed with the repo name** from the config:

```
api/src/routes.py          # ← "api" comes from repos[].name
api/src/handlers.py
core/src/models.py         # ← "core" comes from repos[].name
core/src/db.py
```

Patterns are tested against **both forms** — the full prefixed path and the repo-relative path — so the same pattern works in single and multi-repo:

```yaml
repos:
  - name: api
    path: ../services/api
  - name: core
    path: ../services/core
patterns: ["src/**/*.py"]            # matches api/src/routes.py, api/src/handlers.py, core/src/models.py, core/src/db.py ✓ (via repo-relative)
exclude: ["**/test_*.py"]            # works across all repos
```

#### Filtering a specific repo

Use the repo name as a path prefix to target one repo only:

```yaml
exclude:
  - "api/src/generated/**"           # excludes only in the api repo
  - "**/migrations/**"               # excludes in all repos
```

This works because the full workspace path is always `<repo-name>/<path>`. The repo name is the `name` field from your `repos` config — not the directory name on disk.

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

# ── Source Code File Filters ──────────────────────────────────────────────────
# Shared by graph + outlines — a single file-detection phase produces
# the file list consumed by both.

# Glob patterns for source code files to include
# Type: string[]
# Default: [] (empty = auto-detect by file extension using registered extractors)
# Example: ["src/**/*.py", "lib/**/*.ts"]
patterns: []

# Glob patterns to exclude from source code detection
# Type: string[]
# Default: []
# Example: ["**/generated/**", "**/*.test.ts", "**/vendor/**"]
exclude: []

# Exclude common non-source directories from all file detection
# (source code, documentation and diagrams).
# When true, the following directories are skipped at any depth:
#   node_modules, __pycache__, .git, .svn, .hg, venv, .venv, env, .env, .tox,
#   site-packages, dist, build, .eggs, .mypy_cache, .pytest_cache, .ruff_cache,
#   target, bin, obj
# Set to false if you need to index files inside these directories
# (e.g. vendored code in node_modules). You can still exclude specific
# directories via the `exclude` patterns above.
# Type: boolean
# Default: true
exclude_common: true

# Incremental builds: only re-process files whose SHA256 hash changed
# Type: boolean
# Default: true
incremental: true

# ── Documentation Extraction ─────────────────────────────────────────────────
docs:
  # Enable/disable documentation extraction
  # Type: boolean
  # Default: true
  enabled: true

  # Glob patterns for documentation files (relative to repo root)
  # Type: string[]
  # Default: [] (empty = auto-detect by file extension: .md, .txt, .rst)
  # Example: ["docs/**/*.md", "**/*.rst"]
  patterns: []

  # Glob patterns to exclude from documentation extraction
  # Type: string[]
  # Default: []
  # Example: ["**/CHANGELOG.md", "**/node_modules/**"]
  exclude: []

  # Maximum file size in KB — files larger than this are skipped
  # Type: number
  # Default: 500
  max_file_size_kb: 500

# ── Diagram / Image Extraction ───────────────────────────────────────────────
images:
  # Enable/disable diagram extraction
  # Type: boolean
  # Default: true
  enabled: true

  # Glob patterns for diagram files (relative to repo root)
  # Type: string[]
  # Default: [] (empty = auto-detect by file extension: .puml, .plantuml, .svg, .png, .jpg, .jpeg, .gif)
  # Example: ["diagrams/**/*.puml", "**/*.svg"]
  patterns: []

  # Glob patterns to exclude
  # Type: string[]
  # Default: []
  # Example: ["**/node_modules/**"]
  exclude: []

  # Parse PlantUML files to extract components and relationships
  # Type: boolean
  # Default: true
  parse_puml: true

  # Extract text content from SVG files
  # Type: boolean
  # Default: true
  parse_svg_text: true

# ── Embeddings ────────────────────────────────────────────────────────────────
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
  # Must be a sentence-transformers/ model on HuggingFace with ONNX export
  # and BERT-compatible tokenizer. Dimensions must match 'dimensions' below.
  # See the "Models" section for compatible models and details.
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

# ── Community Summaries ───────────────────────────────────────────────────────
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
  # Communities are sorted by size (largest first). When max_number > 0,
  # only the top N largest communities are summarized.
  # Communities with fewer than 3 nodes are always excluded.
  max_number: 0

  # LLM model for richer summaries (optional)
  # Uses hf: URI notation — see the "Models" section for details.
  # Type: string | null
  # Default: null (algorithmic summaries — still useful, just less prose)
  # model: "hf:Qwen/Qwen2.5-0.5B-Instruct-GGUF:Q4_K_M"

  # Context window size for LLM inference (only used when model is set)
  # Type: number
  # Default: 512
  context_size: 512

# ── Node Descriptions ────────────────────────────────────────────────────────
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
  # Uses hf: URI notation — see the "Models" section for details.
  # Type: string | null
  # Default: null (algorithmic descriptions)
  # model: "hf:Qwen/Qwen2.5-0.5B-Instruct-GGUF:Q4_K_M"

  # Context window size for LLM inference (only used when model is set)
  # Type: number
  # Default: 512
  context_size: 512

# ── HTML Visualizations ──────────────────────────────────────────────────────

# Generate interactive HTML visualizations (graph.html + graph_communities.html)
# Type: boolean
# Default: true
html: true

# Minimum node degree to include in HTML visualization
# Useful for large graphs — filters out leaf nodes to reduce clutter
# Type: integer (>= 1)
# Default: not set (include all nodes)
# html_min_degree: 3

# ── Outlines ──────────────────────────────────────────────────────────────────
# Tree-sitter code outlines: functions, classes, imports with signatures.
# Language is auto-detected from file extension (no need to specify it).
# File selection comes from top-level patterns / exclude / exclude_common.
outlines:
  # Enable/disable outline generation
  # Type: boolean
  # Default: true
  enabled: true

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
community_summaries:
  enabled: true
  model: "hf:Qwen/Qwen2.5-0.5B-Instruct-GGUF:Q4_K_M"   # ~350MB download
node_descriptions:
  enabled: true
  threshold: 0.5          # describe top 50% nodes by degree
  model: "hf:Qwen/Qwen2.5-0.5B-Instruct-GGUF:Q4_K_M"   # same model, auto-shared
```

> When `community_summaries.model` and `node_descriptions.model` resolve to the same file, RepoNova shares a single engine instance — no double memory usage.

### File Filtering Config

Control which source files are included in the graph:

```yaml
output: ../reponova-out
repos:
  - name: my-project
    path: ..
patterns:                      # only include files matching these globs
  - "src/**/*.py"
  - "lib/**/*.ts"
exclude:                       # exclude files matching these globs
  - "**/test/**"
  - "**/tests/**"
  - "**/migrations/**"
  - "**/*.generated.ts"
```

> When `patterns` is empty (default) for any subsystem (`docs`, `images`), RepoNova auto-detects files by extension using the corresponding registry. Source code and outlines share the top-level `patterns` / `exclude` / `exclude_common`. No configuration needed for standard project layouts.
> The configured output directory is **automatically excluded** from all file detection — no need to add it to `exclude` patterns manually.
> `exclude_common` (default: `true`) skips the following directories at any depth: `node_modules`, `__pycache__`, `.git`, `.svn`, `.hg`, `venv`, `.venv`, `env`, `.env`, `.tox`, `site-packages`, `dist`, `build`, `.eggs`, `.mypy_cache`, `.pytest_cache`, `.ruff_cache`, `target`, `bin`, `obj`.
> Set `exclude_common: false` to disable this behavior and use explicit `exclude` patterns instead.

---

## Models

RepoNova uses two types of AI models, both downloaded automatically on first use and cached locally. No API keys, no cloud services.

### ONNX Embeddings

Sentence-transformer models for semantic similarity search (`graph_similar`, `graph_context`).

| Property | Value |
|----------|-------|
| **Config field** | `embeddings.model` |
| **Notation** | Plain model name (e.g., `all-MiniLM-L6-v2`) |
| **Source** | `huggingface.co/sentence-transformers/{model}` |
| **Cache path** | `{models.cache_dir}/{model-name}/` |
| **Files downloaded** | `model.onnx`, `vocab.txt`, `tokenizer_config.json` |
| **Required when** | `embeddings.method: onnx` |

Compatible models (all 384-dim, must match `embeddings.dimensions`):

| Model | Size | Notes |
|-------|------|-------|
| `all-MiniLM-L6-v2` | ~86 MB | Default. Good speed/quality balance |
| `all-MiniLM-L12-v2` | ~130 MB | More accurate, slower |
| `paraphrase-MiniLM-L6-v2` | ~86 MB | Optimized for paraphrase detection |
| `multi-qa-MiniLM-L6-cos-v1` | ~86 MB | Optimized for Q&A |

Any model under the `sentence-transformers/` org on HuggingFace that provides an ONNX export with BERT-compatible tokenizer (WordPiece) should work. The `dimensions` config field **must** match the model's output dimension.

### LLM (GGUF)

Local language models for richer community summaries and node descriptions, powered by [node-llama-cpp](https://github.com/withcatai/node-llama-cpp).

| Property | Value |
|----------|-------|
| **Config field** | `community_summaries.model`, `node_descriptions.model` |
| **Notation** | `hf:` URI (e.g., `hf:Qwen/Qwen2.5-0.5B-Instruct-GGUF:Q4_K_M`) |
| **Format** | `hf:{user}/{repo}:{quantization}` |
| **Cache path** | `{models.cache_dir}/llm/` |
| **Required when** | `community_summaries.model` or `node_descriptions.model` is set |
| **Dependency** | `node-llama-cpp` (optional peer dependency) |

When both `community_summaries.model` and `node_descriptions.model` resolve to the same file, RepoNova shares a single engine instance — no double memory usage.

> **Why different notations?** ONNX embeddings use direct HTTP fetch from a fixed HuggingFace org (`sentence-transformers/`), downloading specific files (model.onnx, vocab.txt). LLM models delegate entirely to node-llama-cpp's `resolveModelFile()`, which handles the `hf:` URI protocol, download, and caching. The two systems are technically incompatible — the notation reflects this.

### Model Management CLI

```bash
reponova models status              # Show configured and cached models
reponova models download            # Pre-download all models needed by config
reponova models remove <name>       # Remove a specific cached model
reponova models clear               # Remove all cached models
```

Models are also downloaded automatically during `reponova build` when `models.download_on_first_use: true` (default). The CLI commands let you manage the cache independently of the build.

---

## Build Output

After `reponova build`, the output directory contains:

```
reponova-out/
├── graph.json                                # Full graph: nodes, edges, community assignments, metadata
│                                             #   metadata.build_config: config fingerprint for change detection
│                                             #   nodes include: docstring, signature, bases (when available)
├── graph-nodes.json                          # Intermediate graph (pre-community detection, no Louvain assignments)
├── detected-files.json                       # Detected file list (intermediate, consumed by graph + outlines)
├── graph.html                                # Interactive visualization (vis.js) — click, search, filter
├── graph_communities.html                    # Community-focused visualization with summary labels
├── graph_search.db                           # SQLite search index (sql.js WASM) — structural queries
├── report.md                                 # Build report: stats, hotspots, community breakdown
├── community_summaries.json                  # Community summaries (algorithmic or LLM-enhanced)
├── node_descriptions.json                    # Descriptions for high-degree nodes
├── tfidf_idf.json                            # TF-IDF vocabulary weights (for query-time embedding)
├── vectors/                                  # LanceDB vector store — semantic similarity search
│   └── (LanceDB internal files)              #   fallback: vectors.json when @lancedb/lancedb unavailable
├── outlines/                                 # Pre-computed code outlines per file
│   └── <repo>/<path>.outline.json
└── .cache/                                   # Incremental build cache
    ├── hashes.json                           # file path → SHA256 hex map (source code hashing)
    ├── outline-hashes.json                   # file path → SHA256 map for outline generation
    ├── node-texts.json                       # node id → text hash map for incremental embeddings
    ├── graph-nodes-hash.txt                  # SHA256 of graph-nodes.json (skip community detection)
    ├── embeddings-config-hash.txt            # config fingerprint for embeddings phase
    ├── community-summaries-config-hash.txt   # config fingerprint for community summaries phase
    ├── community-summary-fingerprints.json   # per-community content fingerprint (incremental)
    ├── node-descriptions-config-hash.txt     # config fingerprint for node descriptions phase
    ├── node-description-fingerprints.json    # per-node content fingerprint (incremental)
    └── extractions/                          # cached FileExtraction per file
        └── <hash>.json
```

Two storage engines serve different purposes:
- **SQLite** (`graph_search.db`) — structural index for exact lookups, graph traversal, FTS. Used by `graph_search`, `graph_impact`, `graph_path`, `graph_explain`, and more.
- **LanceDB** (`vectors/`) — vector index for semantic similarity. Used by `graph_similar` and `graph_context`. Falls back to brute-force cosine similarity (JSON) when `@lancedb/lancedb` is not installed.

---

## Programmatic API

Use RepoNova as a library in your own Node.js tools.

### Build API

Run the full build pipeline programmatically — useful for CI integrations, custom tooling, or workflows that register custom extractors/languages before building.

```typescript
import { build } from "reponova";

const result = await build("./reponova.yml");
console.log(`Output: ${result.outputDir}`);
console.log(`Total processed: ${result.totalProcessed}`);
for (const [phase, r] of result.phases) {
  console.log(`  ${phase}: ${r.skipped ? `skipped (${r.skipReason})` : `${r.processed} items`}`);
}
```

```typescript
// Force rebuild — ignores all caches, reruns every phase
const result = await build("./reponova.yml", { force: true });
```

`build()` returns a `BuildResult`:

| Field | Type | Description |
|-------|------|-------------|
| `outputDir` | `string` | Absolute path to the output directory |
| `phases` | `Map<string, PhaseResult>` | Per-phase results (processed count, skip status, skip reason) |
| `totalProcessed` | `number` | Total items processed across all phases |

If `configPath` is omitted, config is auto-detected from standard locations (see [Config Resolution](#config-resolution)).

### Runtime Registration + Build

Register custom extractors or outline languages **before** calling `build()`:

```typescript
import {
  build,
  registerExtractor,
  registerOutlineLanguage,
} from "reponova";
import type { LanguageExtractor, LanguageSupport } from "reponova";

// 1. Register a custom extractor (graph building)
const myExtractor: LanguageExtractor = { /* ... */ };
registerExtractor(myExtractor);

// 2. Register outline support (graph_outline)
const myOutline: LanguageSupport = { /* ... */ };
registerOutlineLanguage("rust", ["rs"], myOutline);

// 3. Build — all registrations are picked up automatically
const result = await build("./reponova.yml");
```

### Query API

After building, load and query the graph:

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

### Advanced API

```typescript
import {
  ContextBuilder,
  loadConfig,
} from "reponova";

// Smart context assembly (search + vectors + graph expansion)
const { config } = loadConfig("./reponova.yml");
const builder = new ContextBuilder(db, graphData, "./reponova-out");
await builder.initialize(config.embeddings);
const context = await builder.buildContext({
  query: "authentication flow",
  maxTokens: 4000,
});
```

---

## FAQ

### Do I need an API key?

No. Everything runs locally. The optional LLM is a local model (Qwen 0.5B) — no cloud, no API keys, no data leaves your machine.

### How big are the models?

| Model | Size | When downloaded |
|-------|------|----------------|
| TF-IDF embeddings | None (computed in-process) | Never |
| ONNX embeddings | ~86 MB (MiniLM-L6-v2) | First build with `method: onnx` |
| LLM (Qwen 0.5B Q4_K_M) | ~350 MB | When `community_summaries.model` or `node_descriptions.model` is set |

### How long does a build take?

Depends on codebase size. Rough benchmarks:
- Small project (500 files): ~5-10 seconds
- Medium project (5,000 files): ~30-60 seconds
- Large monorepo (20,000+ files): 2-5 minutes
- LLM summaries add ~2-3 seconds per community

### Can I use it without an editor?

Yes. Use the CLI (`reponova build`, `reponova check`) and the programmatic API. The MCP server is just one way to query the graph.

### What about TypeScript / JavaScript extraction?

Tree-sitter grammars are ready. The extractor implementation is on the roadmap — contributions welcome.

---

## Contributing

Contributions are welcome.

### Adding Language Support (Extraction)

Add new programming language extractors via tree-sitter. An extractor teaches RepoNova how to parse a language's AST and extract symbols, imports, and references for graph building.

#### Steps

1. **Create** `src/extract/languages/<lang>.ts` implementing the `LanguageExtractor` interface
2. **Register** it in `src/extract/languages/registry.ts` (or at runtime via `registerExtractor()`)
3. **Add** the tree-sitter WASM grammar to `grammars/` (e.g., `tree-sitter-javascript.wasm`)

#### `LanguageExtractor` Interface

```typescript
interface LanguageExtractor {
  /** Language identifier — must match tree-sitter grammar name (e.g., "javascript") */
  readonly languageId: string;

  /** File extensions this extractor handles (e.g., [".js", ".mjs", ".cjs"]) */
  readonly extensions: string[];

  /**
   * WASM grammar filename (e.g., "tree-sitter-javascript.wasm").
   * If provided: pipeline parses with tree-sitter and passes the SyntaxTree.
   * If omitted: extract() receives a null tree and must work from sourceCode directly.
   * (Markdown and diagram extractors use this — no WASM needed.)
   */
  readonly wasmFile?: string;

  /**
   * Extract symbols, imports, and references from a single source file.
   * @param tree - Parsed tree-sitter AST (null if wasmFile not set)
   * @param sourceCode - Raw file content
   * @param filePath - Relative path (normalized, forward slashes)
   */
  extract(tree: SyntaxTree | null, sourceCode: string, filePath: string): FileExtraction;

  /**
   * Resolve an import module path to candidate file paths.
   * Example: "config.loader" → ["config/loader.py", "config/loader/__init__.py"]
   * Return empty array for external/third-party modules.
   */
  resolveImportPath(importModule: string, currentFilePath: string): string[];
}
```

#### `FileExtraction` Return Type

```typescript
interface FileExtraction {
  filePath: string;           // Relative path (forward slashes)
  language: string;           // Must match languageId
  symbols: SymbolNode[];      // Functions, classes, methods, variables
  imports: ImportDeclaration[];  // Import/export statements
  references: SymbolReference[];  // Calls, type annotations, inheritance refs
}
```

**Key types your extractor produces:**

| Type | Fields | Purpose |
|------|--------|---------|
| `SymbolNode` | `name`, `qualifiedName`, `kind`, `signature?`, `decorators`, `docstring?`, `startLine`, `endLine`, `parent?`, `bases?`, `calls` | A symbol defined in the file |
| `ImportDeclaration` | `module`, `names`, `isWildcard`, `isExport?`, `line` | An import/export statement |
| `SymbolReference` | `name`, `fromSymbol`, `kind` (`"call"` \| `"type_annotation"` \| `"attribute_access"` \| `"inheritance"`), `line` | A reference to another symbol |
| `SymbolKind` | `"function"` \| `"class"` \| `"method"` \| `"variable"` \| `"constant"` \| `"interface"` \| `"enum"` \| `"module"` \| `"document"` \| `"section"` | Symbol classification |

See `src/extract/types.ts` for full type definitions and JSDoc.

#### How tree-sitter Parsing Works

1. If `wasmFile` is set, the pipeline loads `grammars/<wasmFile>`, parses the source, and passes a `SyntaxTree` to `extract()`
2. If `wasmFile` is omitted, `extract()` receives `null` as the tree and must work from `sourceCode` directly
3. WASM grammars are loaded from the `grammars/` directory relative to the package root
4. `SyntaxTree` / `SyntaxNode` types match the [web-tree-sitter](https://github.com/nicolo-ribaudo/tree-sitter-wasm-prebuilt) WASM interface

#### Runtime Registration

You can also register extractors at runtime via the public API (must be called before `build`):

```typescript
import { registerExtractor } from "reponova";
import type { LanguageExtractor } from "reponova";

const myExtractor: LanguageExtractor = { /* ... */ };
registerExtractor(myExtractor);
```

Note: duplicate `languageId` or `extensions` silently overwrite the previous extractor.

#### Reference Implementation

See `src/extract/languages/python.ts` for a full tree-sitter-based extractor, or `src/extract/languages/markdown.ts` for a non-tree-sitter (regex) extractor.

### Adding Outline Support

Outlines (`graph_outline`) use a **separate system** from extraction. They have their own registry, interface, and implementations.

#### Steps

1. **Create** `src/outline/languages/<lang>.ts` implementing the `LanguageSupport` interface
2. **Register** it in `src/outline/languages/registry.ts` via `registerOutlineLanguage()`
3. The same WASM grammar from `grammars/` is shared with the extraction system

#### `LanguageSupport` Interface

```typescript
interface LanguageSupport {
  /** WASM grammar filename (e.g., "tree-sitter-python.wasm") */
  readonly wasmFile: string;

  /** Extract outline from tree-sitter AST (primary method) */
  treeSitterExtract(rootNode: SyntaxNode, filePath: string, lineCount: number): FileOutline;

  /** Extract outline from raw source via regex (fallback when WASM unavailable) */
  regexExtract(filePath: string, source: string, lineCount: number): FileOutline;
}
```

#### Runtime Registration

You can also register outline languages at runtime via the public API (must be called before `build`):

```typescript
import { registerOutlineLanguage } from "reponova";
import type { LanguageSupport } from "reponova";

const myOutline: LanguageSupport = { /* ... */ };
registerOutlineLanguage("rust", ["rs"], myOutline);
```

Note: duplicate language `names` or `extensions` silently overwrite the previous registration.

See `src/outline/languages/python.ts` for the reference implementation.

---

## License

MIT — [CristianoCiuti/reponova](https://github.com/CristianoCiuti/reponova)
