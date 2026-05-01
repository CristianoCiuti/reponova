import initSqlJs from "sql.js";
import type { Database as SqlJsDatabase } from "sql.js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import type { GraphData } from "../shared/types.js";
import { log } from "../shared/utils.js";

// Re-export the Database type for use across the codebase
export type Database = SqlJsDatabase;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS nodes (
    rowid INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT UNIQUE NOT NULL,
    label TEXT NOT NULL,
    type TEXT NOT NULL,
    source_file TEXT,
    repo TEXT,
    community TEXT,
    start_line INTEGER,
    end_line INTEGER,
    in_degree INTEGER DEFAULT 0,
    out_degree INTEGER DEFAULT 0,
    betweenness REAL DEFAULT 0.0,
    properties TEXT
);

CREATE INDEX IF NOT EXISTS idx_nodes_label ON nodes(label);
CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type);
CREATE INDEX IF NOT EXISTS idx_nodes_repo ON nodes(repo);

CREATE TABLE IF NOT EXISTS edges (
    source_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    type TEXT NOT NULL,
    confidence REAL DEFAULT 1.0,
    properties TEXT,
    PRIMARY KEY (source_id, target_id, type)
);

CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
CREATE INDEX IF NOT EXISTS idx_edges_type ON edges(type);

CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
);
`;

let sqlJsPromise: Promise<Awaited<ReturnType<typeof initSqlJs>>> | null = null;

async function getSqlJs() {
  if (!sqlJsPromise) {
    sqlJsPromise = initSqlJs();
  }
  return sqlJsPromise;
}

export interface DbOptions {
  readonly?: boolean;
}

/**
 * Open or create the SQLite database using sql.js (WASM).
 */
export async function openDatabase(dbPath: string, _options: DbOptions = {}): Promise<Database> {
  const SQL = await getSqlJs();

  if (dbPath === ":memory:") {
    return new SQL.Database();
  }

  if (existsSync(dbPath)) {
    const buffer = readFileSync(dbPath);
    return new SQL.Database(buffer);
  }

  return new SQL.Database();
}

/**
 * Save the database to disk.
 */
export function saveDatabase(db: Database, dbPath: string): void {
  if (dbPath === ":memory:") return;
  const data = db.export();
  const buffer = Buffer.from(data);
  writeFileSync(dbPath, buffer);
}

/**
 * Initialize the database schema.
 */
export function initializeSchema(db: Database): void {
  db.run(SCHEMA_SQL);
}

/**
 * Populate the database from graph data.
 */
export function populateDatabase(db: Database, graphData: GraphData): void {
  log.info("Populating database...");

  const inDegree = new Map<string, number>();
  const outDegree = new Map<string, number>();
  for (const edge of graphData.edges) {
    outDegree.set(edge.source, (outDegree.get(edge.source) ?? 0) + 1);
    inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
  }
  const totalEdges = graphData.edges.length || 1;

  db.run("DELETE FROM edges");
  db.run("DELETE FROM nodes");
  db.run("DELETE FROM meta");

  // Insert nodes
  for (const node of graphData.nodes) {
    const inDeg = inDegree.get(node.id) ?? 0;
    const outDeg = outDegree.get(node.id) ?? 0;
    const betweenness = (inDeg * outDeg) / totalEdges;

    db.run(
      `INSERT OR REPLACE INTO nodes (id, label, type, source_file, repo, community, start_line, end_line, in_degree, out_degree, betweenness, properties)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        node.id,
        node.label,
        node.type,
        node.source_file ?? null,
        node.repo ?? null,
        node.community ?? null,
        node.start_line ?? null,
        node.end_line ?? null,
        inDeg,
        outDeg,
        betweenness,
        node.properties ? JSON.stringify(node.properties) : null,
      ],
    );
  }
  log.info(`Inserted ${graphData.nodes.length} nodes`);

  // Insert edges
  for (const edge of graphData.edges) {
    db.run(
      `INSERT OR REPLACE INTO edges (source_id, target_id, type, confidence, properties) VALUES (?, ?, ?, ?, ?)`,
      [
        edge.source,
        edge.target,
        edge.type,
        edge.confidence ?? 1.0,
        edge.properties ? JSON.stringify(edge.properties) : null,
      ],
    );
  }
  log.info(`Inserted ${graphData.edges.length} edges`);

  // Metadata
  const repos = [...new Set(graphData.nodes.map((n) => n.repo).filter(Boolean))];
  db.run("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", ["node_count", String(graphData.nodes.length)]);
  db.run("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", ["edge_count", String(graphData.edges.length)]);
  db.run("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", ["repos", JSON.stringify(repos)]);
  db.run("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", ["built_at", new Date().toISOString()]);

  if (graphData.metadata?.reponova_version) {
    db.run("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", ["reponova_version", graphData.metadata.reponova_version]);
  }

  // Rebuild FTS index
  log.info("Database populated successfully");
}

/**
 * Get a metadata value.
 */
export function getMeta(db: Database, key: string): string | null {
  const results = db.exec("SELECT value FROM meta WHERE key = ?", [key]);
  if (results.length > 0 && results[0]!.values.length > 0) {
    return results[0]!.values[0]![0] as string;
  }
  return null;
}

/**
 * Run a query and return all result rows as objects.
 */
export function queryAll(db: Database, sql: string, params: unknown[] = []): Record<string, unknown>[] {
  const results = db.exec(sql, params as (string | number | null | Uint8Array)[]);
  if (results.length === 0) return [];

  const result = results[0]!;
  const columns = result.columns;
  return result.values.map((row: unknown[]) => {
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < columns.length; i++) {
      obj[columns[i]!] = row[i];
    }
    return obj;
  });
}

/**
 * Run a query and return the first result row.
 */
export function queryOne(db: Database, sql: string, params: unknown[] = []): Record<string, unknown> | null {
  const rows = queryAll(db, sql, params);
  return rows[0] ?? null;
}
