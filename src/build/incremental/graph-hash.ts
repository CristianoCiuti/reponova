import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type Graph from "graphology";

interface SemanticNodeRecord {
  id: string;
  label: string;
  type: string;
  file_type?: string;
  source_file?: string;
  repo?: string;
  docstring?: string;
  signature?: string;
  bases?: string[];
}

interface SemanticEdgeRecord {
  source: string;
  target: string;
  relation: string;
}

export function computeSemanticGraphHash(graph: Graph): string {
  const nodes: SemanticNodeRecord[] = [];
  const edges: SemanticEdgeRecord[] = [];

  graph.forEachNode((id, attrs) => {
    nodes.push({
      id,
      label: String(attrs.label ?? id),
      type: String(attrs.type ?? "unknown"),
      file_type: toOptionalString(attrs.file_type),
      source_file: toOptionalString(attrs.source_file),
      repo: toOptionalString(attrs.repo),
      docstring: toOptionalString(attrs.docstring),
      signature: toOptionalString(attrs.signature),
      bases: Array.isArray(attrs.bases) ? [...(attrs.bases as string[])].sort() : undefined,
    });
  });

  graph.forEachEdge((_edgeId, attrs, source, target) => {
    edges.push({
      source,
      target,
      relation: String(attrs.relation ?? "UNKNOWN"),
    });
  });

  nodes.sort(compareNodeRecords);
  edges.sort(compareEdgeRecords);

  return createHash("sha256")
    .update(JSON.stringify({ nodes, edges }))
    .digest("hex");
}

export function loadPreviousGraphHash(outputDir: string): string | null {
  const path = join(outputDir, ".cache", "semantic-graph-hash.txt");
  if (!existsSync(path)) return null;

  try {
    return readFileSync(path, "utf-8").trim() || null;
  } catch {
    return null;
  }
}

export function saveGraphHash(outputDir: string, hash: string): void {
  const cacheDir = join(outputDir, ".cache");
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(join(cacheDir, "semantic-graph-hash.txt"), `${hash}\n`);
}

function toOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function compareNodeRecords(a: SemanticNodeRecord, b: SemanticNodeRecord): number {
  return compareStrings(a.id, b.id)
    || compareStrings(a.label, b.label)
    || compareStrings(a.type, b.type)
    || compareStrings(a.file_type ?? "", b.file_type ?? "")
    || compareStrings(a.source_file ?? "", b.source_file ?? "")
    || compareStrings(a.repo ?? "", b.repo ?? "")
    || compareStrings(a.docstring ?? "", b.docstring ?? "")
    || compareStrings(a.signature ?? "", b.signature ?? "")
    || compareStrings((a.bases ?? []).join("\u0000"), (b.bases ?? []).join("\u0000"));
}

function compareEdgeRecords(a: SemanticEdgeRecord, b: SemanticEdgeRecord): number {
  return compareStrings(a.source, b.source)
    || compareStrings(a.target, b.target)
    || compareStrings(a.relation, b.relation);
}

function compareStrings(a: string, b: string): number {
  return a.localeCompare(b);
}
