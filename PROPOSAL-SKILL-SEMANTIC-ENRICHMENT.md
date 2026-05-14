# Proposal: Skill-Based Semantic Enrichment

## Context

Graphify uses the AI agent itself (the model running in the IDE session) as the LLM for semantic extraction. When a user types `/graphify .`, the skill file instructs the agent to read files, extract relationships as JSON, and write them to disk. No external API calls are made — the agent IS the model.

RepoNova currently builds its graph entirely via tree-sitter AST parsing (structural, deterministic). The LLM is only used post-build for descriptions/summaries, via external provider API calls. There is no mechanism to leverage the host agent's reasoning for graph enrichment.

## Goal

Add a `/reponova enrich` skill command that uses the host AI agent to infer semantic relationships that tree-sitter cannot detect, then merges them into the existing graph.

## How It Works

```
User types: /reponova enrich
    │
    ▼
Agent reads reponova-out/graph.json (already built by `reponova build`)
    │
    ▼
Agent groups nodes by community → creates chunks of related files
    │
    ▼
For each chunk: agent reads source files, infers semantic edges
    (parallel subagents via @agent in OpenCode)
    │
    ▼
Agent writes reponova-out/semantic_edges.json
    │
    ▼
A local merge script integrates edges into graph.json
```

## Key Design Decisions

1. **Depends on `reponova build` having already run.** The structural graph must exist first. This command enriches it, not replaces it.

2. **Chunking by community.** Files in the same community are already structurally related — grouping them gives the agent maximum context for inferring semantic relationships.

3. **Output format.** Each subagent returns:
   ```json
   [{"source": "qualified_name", "target": "qualified_name",
     "relation": "conceptually_related_to|shares_data_with|delegates_to|wraps",
     "confidence": "INFERRED|AMBIGUOUS", "confidence_score": 0.7}]
   ```

4. **Edge types added.** Only semantic edges that tree-sitter cannot produce:
   - `conceptually_related_to` — same domain concept, no structural link
   - `shares_data_with` — shared data structures without direct import
   - `delegates_to` — delegation pattern not visible in call graph
   - `semantically_similar_to` — same problem solved differently

5. **Merge strategy.** New edges are appended with `confidence: "INFERRED"`. Existing EXTRACTED edges are never modified. Duplicates (same source+target+relation) are skipped.

## Implementation

1. **Extend `.opencode/skills/reponova/SKILL.md`** with a `/reponova enrich` section containing:
   - Instructions to read `graph.json` and group files by community
   - A chunking strategy (max ~30 nodes per chunk for context budget)
   - An extraction prompt asking for semantic edges only
   - Subagent dispatch pattern (`@agent` per chunk)
   - Merge script invocation

2. **Add `src/cli/enrich-merge.ts`** — a small CLI command (`reponova enrich-merge`) that:
   - Reads `graph.json` + `semantic_edges.json`
   - Validates edges (both source and target must exist in graph)
   - Deduplicates against existing edges
   - Writes updated `graph.json`

3. **No new pipeline phase.** This is an out-of-band enrichment — it doesn't participate in the DAG pipeline. It's invoked interactively by the user via the skill.

## Costs

- Zero additional API cost (uses the IDE session tokens already being consumed)
- Quality depends on the host model's reasoning capability
- Only works interactively (not in CI) — the CLI path with providers remains for headless use
