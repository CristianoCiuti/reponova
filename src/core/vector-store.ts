/**
 * Vector store backed by LanceDB for semantic similarity search.
 *
 * Provides upsert, query, and lifecycle management.
 * Gracefully degrades to brute-force cosine similarity if LanceDB is not available.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "../shared/utils.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface VectorRecord {
  id: string;
  label: string;
  type: string;
  repo: string;
  source_file: string;
  community: string;
  text: string;
  vector: number[];
}

export interface SimilarityResult {
  id: string;
  label: string;
  type: string;
  repo: string;
  source_file: string;
  community: string;
  score: number;
}

export interface VectorQueryOptions {
  top_k?: number;
  type_filter?: string;
  repo_filter?: string;
}

// ─── LanceDB Backend ─────────────────────────────────────────────────────────

interface LanceTable {
  search(vector: number[]): { limit(n: number): { where(filter: string): { toArray(): Promise<Array<Record<string, unknown>>> }; toArray(): Promise<Array<Record<string, unknown>>> } };
  add(data: unknown[]): Promise<void>;
  countRows(): Promise<number>;
}

interface LanceDb {
  createTable(name: string, data: unknown[], opts?: unknown): Promise<LanceTable>;
  openTable(name: string): Promise<LanceTable>;
  tableNames(): Promise<string[]>;
  dropTable(name: string): Promise<void>;
}

// ─── Vector Store ────────────────────────────────────────────────────────────

export class VectorStore {
  private db: LanceDb | null = null;
  private table: LanceTable | null = null;
  private fallbackData: VectorRecord[] = [];
  private useFallback = false;
  private dbPath: string;

  constructor(outputDir: string) {
    this.dbPath = join(outputDir, "vectors");
  }

  /**
   * Initialize vector store. Tries LanceDB first, falls back to in-memory brute force.
   */
  async initialize(): Promise<boolean> {
    try {
      const lancedb = await import("@lancedb/lancedb");
      if (!existsSync(this.dbPath)) mkdirSync(this.dbPath, { recursive: true });
      this.db = await lancedb.connect(this.dbPath) as unknown as LanceDb;
      log.info(`Vector store initialized (LanceDB: ${this.dbPath})`);
      return true;
    } catch {
      log.warn("@lancedb/lancedb not available — using in-memory fallback for vector search");
      this.useFallback = true;
      return true; // Still functional via fallback
    }
  }

  /**
   * Store embeddings with metadata.
   */
  async upsert(records: VectorRecord[]): Promise<void> {
    if (records.length === 0) return;

    this.persistSidecar(records);

    if (this.useFallback) {
      this.fallbackData = records;
      log.info(`  Vector fallback: saved ${records.length} records to disk`);
      return;
    }

    if (!this.db) return;

    try {
      // Drop existing table and recreate
      const tables = await this.db.tableNames();
      if (tables.includes("embeddings")) {
        await this.db.dropTable("embeddings");
      }

      // LanceDB needs plain arrays for vectors
      const data = records.map(r => ({
        ...r,
        vector: Array.from(r.vector),
      }));

      this.table = await this.db.createTable("embeddings", data, { mode: "overwrite" });
      log.info(`  Vector store: indexed ${records.length} records`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`LanceDB upsert failed, using fallback: ${msg}`);
      this.useFallback = true;
      this.fallbackData = records;
    }
  }

  /**
   * Find similar vectors by query vector.
   */
  async query(queryVector: number[] | Float32Array, options: VectorQueryOptions = {}): Promise<SimilarityResult[]> {
    const topK = options.top_k ?? 10;
    const vector = Array.from(queryVector);

    if (this.useFallback) {
      return this.bruteForceSearch(vector, topK, options);
    }

    if (!this.db) return [];

    try {
      if (!this.table) {
        const tables = await this.db.tableNames();
        if (!tables.includes("embeddings")) return [];
        this.table = await this.db.openTable("embeddings");
      }

      let searchBuilder = this.table.search(vector).limit(topK);

      // Build filter
      const filters: string[] = [];
      if (options.type_filter) filters.push(`type = '${options.type_filter}'`);
      if (options.repo_filter) filters.push(`repo = '${options.repo_filter}'`);

      let results: Array<Record<string, unknown>>;
      if (filters.length > 0) {
        results = await searchBuilder.where(filters.join(" AND ")).toArray();
      } else {
        results = await searchBuilder.toArray();
      }

      return results.map(r => ({
        id: r.id as string,
        label: r.label as string,
        type: r.type as string,
        repo: r.repo as string,
        source_file: r.source_file as string,
        community: r.community as string,
        score: 1 - (r._distance as number ?? 0), // cosine distance → similarity
      }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`LanceDB query failed: ${msg}`);
      return this.bruteForceSearch(vector, topK, options);
    }
  }

  /**
   * Load existing vectors from disk (for server-side queries without rebuild).
   */
  async loadExisting(): Promise<boolean> {
    if (!this.useFallback && this.db) {
      try {
        const tables = await this.db.tableNames();
        if (tables.includes("embeddings")) {
          this.table = await this.db.openTable("embeddings");
          return true;
        }
      } catch {
        // Fall through to fallback
      }
    }

    // Try loading fallback file
    const fallbackPath = join(this.dbPath.replace("/vectors", ""), "vectors.json");
    if (existsSync(fallbackPath)) {
      try {
        const data = JSON.parse(readFileSync(fallbackPath, "utf-8"));
        this.fallbackData = data;
        this.useFallback = true;
        return true;
      } catch {
        return false;
      }
    }

    return false;
  }

  async loadAllRecords(): Promise<VectorRecord[]> {
    const sidecarPath = this.getSidecarPath();
    if (existsSync(sidecarPath)) {
      try {
        return JSON.parse(readFileSync(sidecarPath, "utf-8")) as VectorRecord[];
      } catch {
        return [];
      }
    }

    return [...this.fallbackData];
  }

  private bruteForceSearch(queryVector: number[], topK: number, options: VectorQueryOptions): SimilarityResult[] {
    let data = this.fallbackData;

    // Apply filters
    if (options.type_filter) {
      data = data.filter(r => r.type === options.type_filter);
    }
    if (options.repo_filter) {
      data = data.filter(r => r.repo === options.repo_filter);
    }

    // Compute cosine similarity for each record
    const scored = data.map(r => ({
      record: r,
      score: cosineSimilarity(queryVector, r.vector as unknown as number[]),
    }));

    // Sort by score descending, take top K
    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, topK).map(s => ({
      id: s.record.id,
      label: s.record.label,
      type: s.record.type,
      repo: s.record.repo,
      source_file: s.record.source_file,
      community: s.record.community,
      score: s.score,
    }));
  }

  async dispose(): Promise<void> {
    this.table = null;
    this.db = null;
  }

  private persistSidecar(records: VectorRecord[]): void {
    const sidecarPath = this.getSidecarPath();
    const dir = this.getBaseDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(sidecarPath, JSON.stringify(records.map((record) => ({
      ...record,
      vector: Array.from(record.vector),
    }))));
  }

  private getBaseDir(): string {
    return this.dbPath;
  }

  private getSidecarPath(): string {
    return join(this.getBaseDir(), "vectors.json");
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const len = Math.min(a.length, b.length);

  for (let i = 0; i < len; i++) {
    dot += (a[i] as number) * (b[i] as number);
    normA += (a[i] as number) * (a[i] as number);
    normB += (b[i] as number) * (b[i] as number);
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
