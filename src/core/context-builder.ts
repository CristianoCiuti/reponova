/**
 * Smart Context Builder — assembles token-budgeted, ranked context for any query.
 *
 * Algorithm:
 * 1. ENTRY POINTS: text search + vector search → merge/dedup
 * 2. GRAPH EXPANSION: 1-2 hop BFS from candidates
 * 3. RELEVANCE SCORING: similarity + centrality + proximity
 * 4. TOKEN BUDGET FITTING: greedy fill sections by score
 * 5. FORMAT OUTPUT: structured JSON or narrative Markdown
 */
import type { Database } from "./db.js";
import { queryAll, queryOne } from "./db.js";
import { searchNodes } from "./search.js";
import { VectorStore } from "./vector-store.js";
import { EmbeddingEngine } from "../build/embeddings.js";
import { TfidfEmbeddingEngine } from "../build/tfidf-embeddings.js";
import type { EmbeddingsConfig } from "../shared/types.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ContextParams {
  query: string;
  max_tokens?: number;
  scope?: string;
  include_source?: boolean;
  format?: "structured" | "narrative";
}

export interface ContextResult {
  query: string;
  total_tokens: number;
  max_tokens: number;
  sections: ContextSection[];
  /** Structured format only */
  structured?: StructuredContext;
}

interface ContextSection {
  type: "candidates" | "relationships" | "community" | "source" | "metadata";
  content: string;
  tokens: number;
}

interface StructuredContext {
  candidates: CandidateNode[];
  relationships: RelationshipEntry[];
  communities: CommunitySummaryEntry[];
  source_snippets: SourceSnippet[];
}

interface CandidateNode {
  id: string;
  label: string;
  type: string;
  source_file?: string;
  repo?: string;
  community?: string;
  score: number;
  signature?: string;
  docstring?: string;
}

interface RelationshipEntry {
  from: string;
  to: string;
  edge_type: string;
  from_label?: string;
  to_label?: string;
}

interface CommunitySummaryEntry {
  community_id: string;
  summary: string;
}

interface SourceSnippet {
  file: string;
  start_line: number;
  end_line: number;
  content: string;
}

// ─── Scored candidate (internal) ─────────────────────────────────────────────

interface ScoredCandidate {
  id: string;
  label: string;
  type: string;
  source_file?: string;
  repo?: string;
  community?: string;
  signature?: string;
  docstring?: string;
  score: number;
  text_rank: number;
  vector_score: number;
  centrality: number;
}

// ─── Token counting ──────────────────────────────────────────────────────────

let tokenEncoder: { encode: (text: string) => number[] } | null = null;

function countTokens(text: string): number {
  if (!tokenEncoder) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { encodingForModel } = require("js-tiktoken") as { encodingForModel: (model: string) => { encode: (text: string) => number[] } };
      tokenEncoder = encodingForModel("gpt-4o");
    } catch {
      // Fallback: rough estimate (4 chars ≈ 1 token)
      return Math.ceil(text.length / 4);
    }
  }
  return tokenEncoder.encode(text).length;
}

// ─── Context Builder ─────────────────────────────────────────────────────────

export class ContextBuilder {
  private db: Database;
  private graphDir: string;
  private vectorStore: VectorStore | null = null;
  private embeddingEngine: EmbeddingEngine | null = null;
  private tfidfEngine: TfidfEmbeddingEngine | null = null;
  private communitySummaries: Map<string, string> = new Map();
  private nodeDescriptions: Map<string, string> = new Map();

  constructor(db: Database, graphDir: string) {
    this.db = db;
    this.graphDir = graphDir;
  }

  /**
   * Initialize optional components (vector store, community summaries).
   * Non-blocking: works in degraded mode without them.
   */
  async initialize(embeddingsConfig?: EmbeddingsConfig): Promise<void> {
    // Load community summaries if available
    const summariesPath = join(this.graphDir, "community_summaries.json");
    if (existsSync(summariesPath)) {
      try {
        const raw = JSON.parse(readFileSync(summariesPath, "utf-8")) as Array<{ community_id: string; summary: string }>;
        for (const s of raw) {
          this.communitySummaries.set(String(s.community_id), s.summary);
        }
      } catch { /* ignore */ }
    }

    // Load node descriptions if available
    const descriptionsPath = join(this.graphDir, "node_descriptions.json");
    if (existsSync(descriptionsPath)) {
      try {
        const raw = JSON.parse(readFileSync(descriptionsPath, "utf-8")) as Array<{ id: string; description: string }>;
        for (const d of raw) {
          this.nodeDescriptions.set(d.id, d.description);
        }
      } catch { /* ignore */ }
    }

    // Initialize vector store
    this.vectorStore = new VectorStore(this.graphDir);
    const hasVectors = await this.vectorStore.loadExisting();
    if (!hasVectors) {
      this.vectorStore = null;
    }

    // Initialize embedding engine for query encoding
    if (embeddingsConfig && embeddingsConfig.enabled) {
      if (embeddingsConfig.method === "tfidf") {
        const engine = new TfidfEmbeddingEngine(embeddingsConfig);
        const loaded = engine.loadVocabulary(this.graphDir);
        if (loaded) this.tfidfEngine = engine;
      } else {
        this.embeddingEngine = new EmbeddingEngine(embeddingsConfig);
        const ready = await this.embeddingEngine.initialize();
        if (!ready) this.embeddingEngine = null;
      }
    }
  }

  /**
   * Build context for a query within token budget.
   */
  async buildContext(params: ContextParams): Promise<ContextResult> {
    const {
      query,
      max_tokens = 4096,
      scope,
      include_source = false,
      format = "narrative",
    } = params;

    // Step 1: Find entry point candidates
    const candidates = await this.findCandidates(query, scope);

    // Step 2: Graph expansion (1-2 hops from candidates)
    const relationships = this.expandGraph(candidates.slice(0, 10));

    // Step 3: Collect community context
    const touchedCommunities = new Set<string>();
    for (const c of candidates) {
      if (c.community) touchedCommunities.add(c.community);
    }

    // Step 4: Collect source snippets if requested
    const sourceSnippets: SourceSnippet[] = [];
    if (include_source) {
      for (const c of candidates.slice(0, 5)) {
        const snippet = this.getSourceSnippet(c);
        if (snippet) sourceSnippets.push(snippet);
      }
    }

    // Step 5: Budget allocation and formatting
    const budget = {
      candidates: Math.floor(max_tokens * 0.40),
      relationships: Math.floor(max_tokens * 0.25),
      community: Math.floor(max_tokens * 0.15),
      source: include_source ? Math.floor(max_tokens * 0.15) : 0,
      metadata: Math.floor(max_tokens * 0.05),
    };

    // If no source requested, redistribute that budget
    if (!include_source) {
      budget.candidates += Math.floor(max_tokens * 0.10);
      budget.relationships += Math.floor(max_tokens * 0.05);
    }

    // Build sections
    const sections: ContextSection[] = [];
    let totalTokens = 0;

    // Candidates section
    const candidatesText = this.formatCandidates(candidates, budget.candidates);
    const candidatesTokens = countTokens(candidatesText);
    sections.push({ type: "candidates", content: candidatesText, tokens: candidatesTokens });
    totalTokens += candidatesTokens;

    // Relationships section
    const relText = this.formatRelationships(relationships, budget.relationships);
    const relTokens = countTokens(relText);
    sections.push({ type: "relationships", content: relText, tokens: relTokens });
    totalTokens += relTokens;

    // Community summaries section
    const commText = this.formatCommunities(touchedCommunities, budget.community);
    const commTokens = countTokens(commText);
    sections.push({ type: "community", content: commText, tokens: commTokens });
    totalTokens += commTokens;

    // Source section
    if (include_source && sourceSnippets.length > 0) {
      const srcText = this.formatSource(sourceSnippets, budget.source);
      const srcTokens = countTokens(srcText);
      sections.push({ type: "source", content: srcText, tokens: srcTokens });
      totalTokens += srcTokens;
    }

    // Metadata section
    const metaText = `Query: "${query}" | ${candidates.length} candidates | ${relationships.length} relationships | ${touchedCommunities.size} communities`;
    const metaTokens = countTokens(metaText);
    sections.push({ type: "metadata", content: metaText, tokens: metaTokens });
    totalTokens += metaTokens;

    const result: ContextResult = {
      query,
      total_tokens: totalTokens,
      max_tokens,
      sections,
    };

    if (format === "structured") {
      result.structured = {
        candidates: candidates.slice(0, 20).map(c => ({
          id: c.id,
          label: c.label,
          type: c.type,
          source_file: c.source_file,
          repo: c.repo,
          community: c.community,
          score: c.score,
          signature: c.signature,
          docstring: c.docstring,
        })),
        relationships,
        communities: [...touchedCommunities].map(id => ({
          community_id: id,
          summary: this.communitySummaries.get(id) ?? "",
        })).filter(c => c.summary),
        source_snippets: sourceSnippets,
      };
    }

    return result;
  }

  /**
   * Format context result as a single string (for MCP tool output).
   */
  formatAsText(result: ContextResult): string {
    if (result.sections.length === 0) {
      return `No relevant context found for "${result.query}"`;
    }

    const lines: string[] = [];

    // Metadata header
    const meta = result.sections.find(s => s.type === "metadata");
    if (meta) lines.push(`> ${meta.content}`, "");

    // Candidates
    const cands = result.sections.find(s => s.type === "candidates");
    if (cands && cands.content) {
      lines.push("## Relevant Symbols", "", cands.content, "");
    }

    // Relationships
    const rels = result.sections.find(s => s.type === "relationships");
    if (rels && rels.content) {
      lines.push("## Relationships", "", rels.content, "");
    }

    // Communities
    const comm = result.sections.find(s => s.type === "community");
    if (comm && comm.content) {
      lines.push("## Architecture Context", "", comm.content, "");
    }

    // Source
    const src = result.sections.find(s => s.type === "source");
    if (src && src.content) {
      lines.push("## Source Code", "", src.content, "");
    }

    lines.push(`---`, `Token usage: ${result.total_tokens}/${result.max_tokens}`);

    return lines.join("\n");
  }

  // ─── Private: Candidate Finding ──────────────────────────────────────────

  private async findCandidates(query: string, scope?: string): Promise<ScoredCandidate[]> {
    const candidateMap = new Map<string, ScoredCandidate>();

    // Text search
    const textResults = searchNodes(this.db, query, {
      top_k: 30,
      repo: scope,
    });

    for (let i = 0; i < textResults.length; i++) {
      const r = textResults[i]!;
      const nodeRow = queryOne(
        this.db,
        "SELECT id, label, type, source_file, repo, community, in_degree, out_degree, betweenness, properties FROM nodes WHERE id = ?",
        [r.id],
      );
      if (!nodeRow) continue;

      const props = nodeRow.properties ? JSON.parse(nodeRow.properties as string) as Record<string, unknown> : {};
      const totalDegree = (nodeRow.in_degree as number) + (nodeRow.out_degree as number);
      const normalizedCentrality = Math.min(totalDegree / 50, 1.0); // normalize: 50+ edges = max

      candidateMap.set(r.id, {
        id: r.id,
        label: r.label,
        type: r.type,
        source_file: r.source_file,
        repo: r.repo,
        community: r.community,
        signature: props.signature as string | undefined,
        docstring: props.docstring as string | undefined,
        score: 0,
        text_rank: 1.0 - (i / textResults.length), // 1.0 for top result, decays
        vector_score: 0,
        centrality: normalizedCentrality,
      });
    }

    // Vector search (if available)
    if (this.vectorStore && (this.embeddingEngine || this.tfidfEngine)) {
      let queryVector: number[] | Float32Array | null = null;

      if (this.tfidfEngine) {
        queryVector = this.tfidfEngine.embedQuery(query);
      } else if (this.embeddingEngine) {
        const queryEmbeddings = await this.embeddingEngine.embedBatch([{ id: "_q", text: query }]);
        if (queryEmbeddings.length > 0) queryVector = queryEmbeddings[0]!.vector;
      }

      if (queryVector) {
        const vectorResults = await this.vectorStore.query(queryVector, {
          top_k: 30,
          repo_filter: scope,
        });

        for (const vr of vectorResults) {
          const existing = candidateMap.get(vr.id);
          if (existing) {
            existing.vector_score = vr.score;
          } else {
            // New candidate from vector search only
            const nodeRow = queryOne(
              this.db,
              "SELECT id, label, type, source_file, repo, community, in_degree, out_degree, betweenness, properties FROM nodes WHERE id = ?",
              [vr.id],
            );
            if (!nodeRow) continue;

            const props = nodeRow.properties ? JSON.parse(nodeRow.properties as string) as Record<string, unknown> : {};
            const totalDegree = (nodeRow.in_degree as number) + (nodeRow.out_degree as number);
            const normalizedCentrality = Math.min(totalDegree / 50, 1.0);

            candidateMap.set(vr.id, {
              id: vr.id,
              label: nodeRow.label as string,
              type: nodeRow.type as string,
              source_file: (nodeRow.source_file as string | null) ?? undefined,
              repo: (nodeRow.repo as string | null) ?? undefined,
              community: (nodeRow.community as string | null) ?? undefined,
              signature: props.signature as string | undefined,
              docstring: props.docstring as string | undefined,
              score: 0,
              text_rank: 0,
              vector_score: vr.score,
              centrality: normalizedCentrality,
            });
          }
        }
      }
    }

    // Score: weighted combination
    const WEIGHT_TEXT = 0.35;
    const WEIGHT_VECTOR = 0.45;
    const WEIGHT_CENTRALITY = 0.20;

    for (const c of candidateMap.values()) {
      c.score = (c.text_rank * WEIGHT_TEXT) + (c.vector_score * WEIGHT_VECTOR) + (c.centrality * WEIGHT_CENTRALITY);
    }

    // Sort by score descending
    const sorted = [...candidateMap.values()].sort((a, b) => b.score - a.score);
    return sorted.slice(0, 50);
  }

  // ─── Private: Graph Expansion ────────────────────────────────────────────

  private expandGraph(candidates: ScoredCandidate[]): RelationshipEntry[] {
    const relationships: RelationshipEntry[] = [];
    const seenEdges = new Set<string>();
    const candidateIds = new Set(candidates.map(c => c.id));

    for (const candidate of candidates) {
      // 1-hop outgoing
      const outEdges = queryAll(
        this.db,
        "SELECT e.source_id, e.target_id, e.type, n.label as target_label FROM edges e JOIN nodes n ON n.id = e.target_id WHERE e.source_id = ? LIMIT 20",
        [candidate.id],
      );

      for (const edge of outEdges) {
        const key = `${edge.source_id}→${edge.target_id}:${edge.type}`;
        if (seenEdges.has(key)) continue;
        seenEdges.add(key);
        relationships.push({
          from: candidate.id,
          to: edge.target_id as string,
          edge_type: edge.type as string,
          from_label: candidate.label,
          to_label: edge.target_label as string,
        });
      }

      // 1-hop incoming
      const inEdges = queryAll(
        this.db,
        "SELECT e.source_id, e.target_id, e.type, n.label as source_label FROM edges e JOIN nodes n ON n.id = e.source_id WHERE e.target_id = ? LIMIT 20",
        [candidate.id],
      );

      for (const edge of inEdges) {
        const key = `${edge.source_id}→${edge.target_id}:${edge.type}`;
        if (seenEdges.has(key)) continue;
        seenEdges.add(key);
        relationships.push({
          from: edge.source_id as string,
          to: candidate.id,
          edge_type: edge.type as string,
          from_label: edge.source_label as string,
          to_label: candidate.label,
        });
      }
    }

    // Prioritize edges between candidates (internal connections)
    relationships.sort((a, b) => {
      const aInternal = candidateIds.has(a.from) && candidateIds.has(a.to) ? 1 : 0;
      const bInternal = candidateIds.has(b.from) && candidateIds.has(b.to) ? 1 : 0;
      return bInternal - aInternal;
    });

    return relationships;
  }

  // ─── Private: Source Snippets ────────────────────────────────────────────

  private getSourceSnippet(candidate: ScoredCandidate): SourceSnippet | null {
    if (!candidate.source_file) return null;

    const nodeRow = queryOne(
      this.db,
      "SELECT start_line, end_line FROM nodes WHERE id = ?",
      [candidate.id],
    );
    if (!nodeRow || !nodeRow.start_line || !nodeRow.end_line) return null;

    // Try to read the file (outline dir has pre-computed outlines)
    const outlineDir = join(this.graphDir, "outlines");
    const outlinePath = join(outlineDir, candidate.source_file + ".json");

    if (existsSync(outlinePath)) {
      try {
        const outline = JSON.parse(readFileSync(outlinePath, "utf-8"));
        // Find the function/class matching this node
        const allEntries = [...(outline.functions ?? []), ...(outline.classes ?? [])];
        const entry = allEntries.find((e: { name: string }) => candidate.label.includes(e.name));
        if (entry && entry.signature) {
          return {
            file: candidate.source_file,
            start_line: nodeRow.start_line as number,
            end_line: nodeRow.end_line as number,
            content: entry.signature + (entry.docstring ? `\n  """${entry.docstring}"""` : ""),
          };
        }
      } catch { /* ignore */ }
    }

    return {
      file: candidate.source_file,
      start_line: nodeRow.start_line as number,
      end_line: nodeRow.end_line as number,
      content: `${candidate.label} (lines ${nodeRow.start_line}-${nodeRow.end_line})`,
    };
  }

  // ─── Private: Formatting ─────────────────────────────────────────────────

  private formatCandidates(candidates: ScoredCandidate[], budget: number): string {
    const lines: string[] = [];
    let tokens = 0;

    for (const c of candidates) {
      const desc = this.nodeDescriptions.get(c.id);
      let line = `- **${c.label}** [${c.type}] (score: ${(c.score * 100).toFixed(0)}%)`;
      if (c.source_file) line += `\n  File: ${c.source_file}`;
      if (c.signature) line += `\n  Sig: \`${c.signature}\``;
      if (c.docstring) line += `\n  Doc: ${c.docstring.slice(0, 120)}`;
      if (desc) line += `\n  ${desc}`;

      const lineTokens = countTokens(line);
      if (tokens + lineTokens > budget) break;
      lines.push(line);
      tokens += lineTokens;
    }

    return lines.join("\n");
  }

  private formatRelationships(relationships: RelationshipEntry[], budget: number): string {
    const lines: string[] = [];
    let tokens = 0;

    // Group by edge type
    const grouped = new Map<string, RelationshipEntry[]>();
    for (const r of relationships) {
      const existing = grouped.get(r.edge_type) ?? [];
      existing.push(r);
      grouped.set(r.edge_type, existing);
    }

    for (const [edgeType, edges] of grouped) {
      const header = `### ${edgeType} (${edges.length})`;
      const headerTokens = countTokens(header);
      if (tokens + headerTokens > budget) break;
      lines.push(header);
      tokens += headerTokens;

      for (const e of edges.slice(0, 15)) {
        const line = `- ${e.from_label ?? e.from} → ${e.to_label ?? e.to}`;
        const lineTokens = countTokens(line);
        if (tokens + lineTokens > budget) break;
        lines.push(line);
        tokens += lineTokens;
      }
    }

    return lines.join("\n");
  }

  private formatCommunities(communityIds: Set<string>, budget: number): string {
    const lines: string[] = [];
    let tokens = 0;

    for (const id of communityIds) {
      const summary = this.communitySummaries.get(id);
      if (!summary) continue;

      const line = `**Community ${id}**: ${summary}`;
      const lineTokens = countTokens(line);
      if (tokens + lineTokens > budget) break;
      lines.push(line);
      tokens += lineTokens;
    }

    return lines.join("\n\n");
  }

  private formatSource(snippets: SourceSnippet[], budget: number): string {
    const lines: string[] = [];
    let tokens = 0;

    for (const s of snippets) {
      const block = `\`\`\`\n# ${s.file}:${s.start_line}-${s.end_line}\n${s.content}\n\`\`\``;
      const blockTokens = countTokens(block);
      if (tokens + blockTokens > budget) break;
      lines.push(block);
      tokens += blockTokens;
    }

    return lines.join("\n\n");
  }

  /**
   * Dispose resources.
   */
  async dispose(): Promise<void> {
    if (this.embeddingEngine) await this.embeddingEngine.dispose();
    if (this.tfidfEngine) this.tfidfEngine.dispose();
    if (this.vectorStore) await this.vectorStore.dispose();
  }
}
