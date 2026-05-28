/**
 * Default reponova.yml written into the editor directory on first install.
 */
export const DEFAULT_CONFIG_YAML = `# reponova.yml — All paths relative to this file's location.

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
  # max_tokens:                   # per-step LLM output token limits
  #   descriptions: 2048
  #   profiles: 1024
  #   routing: 2048
  #   restructure: 2048
  # profile:                      # community profile prompt limits
  #   max_nodes: 80
  #   max_edges: 50
  # restructure_max_pairs: 20     # max cross-community pairs for merge/split analysis

# ── HTML ──
# html: true
# html_min_degree: 3              # min degree for HTML visualization (unset = all nodes)

# ── Outlines ──
outlines:
  enabled: true
`;
