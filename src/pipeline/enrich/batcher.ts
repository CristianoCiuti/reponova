/**
 * Token-budget batching — packs graph nodes into LLM-friendly batches
 * grouped by directory for better cross-reference context.
 */
import { readFileSync } from "node:fs";
import type { GraphNode } from "../../shared/types.js";

export interface NodeCodeBlock {
  nodeId: string;
  qualifiedName: string;
  filePath: string;
  startLine: number;
  endLine: number;
  code: string;
  estimatedTokens: number;
}

export interface Batch {
  id: number;
  items: NodeCodeBlock[];
  totalTokens: number;
}

/**
 * Estimate token count (conservative: ~4 chars/token for code).
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Extract source code for a node using tree-sitter start_line/end_line.
 * Caps at maxCharsPerFile (20k default as per INTELLIGENT-ENRICHMENT.md).
 */
export function extractNodeCode(
  node: GraphNode,
  repoRoots: Map<string, string>,
  maxCharsPerFile: number = 20000,
): string | null {
  if (!node.source_file || node.start_line == null || node.end_line == null) return null;

  const repoRoot = repoRoots.get(node.repo ?? "") ?? "";
  // source_file in multi-repo graphs is prefixed with repo name (e.g. "api/src/file.py")
  // but repoRoot already resolves to the repo directory — strip the prefix to avoid duplication
  const repoPrefix = node.repo ? `${node.repo}/` : "";
  const relativePath = node.source_file.startsWith(repoPrefix)
    ? node.source_file.slice(repoPrefix.length)
    : node.source_file;
  const filePath = `${repoRoot}/${relativePath}`;

  try {
    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    const slice = lines.slice(node.start_line - 1, node.end_line).join("\n");
    return slice.length > maxCharsPerFile ? slice.slice(0, maxCharsPerFile) : slice;
  } catch {
    return null;
  }
}

/**
 * Pack nodes into batches by token budget, grouped by directory.
 * Modeled on graphify's `_pack_chunks_by_tokens`.
 */
export function packBatches(
  nodes: GraphNode[],
  repoRoots: Map<string, string>,
  tokenBudget: number,
): Batch[] {
  // Group by directory for better cross-reference in prompts
  const byDir = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    const dir = node.source_file?.split("/").slice(0, -1).join("/") ?? "(unknown)";
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir)!.push(node);
  }

  const batches: Batch[] = [];
  let currentBatch: NodeCodeBlock[] = [];
  let currentTokens = 0;
  let batchId = 1;

  for (const [_dir, dirNodes] of byDir) {
    for (const node of dirNodes) {
      const code = extractNodeCode(node, repoRoots);
      if (!code) continue;

      const tokens = estimateTokens(code);
      const block: NodeCodeBlock = {
        nodeId: node.id,
        qualifiedName: node.id,
        filePath: node.source_file ?? "",
        startLine: node.start_line ?? 0,
        endLine: node.end_line ?? 0,
        code,
        estimatedTokens: tokens,
      };

      if (currentTokens + tokens > tokenBudget && currentBatch.length > 0) {
        batches.push({ id: batchId++, items: currentBatch, totalTokens: currentTokens });
        currentBatch = [];
        currentTokens = 0;
      }

      currentBatch.push(block);
      currentTokens += tokens;
    }
  }

  if (currentBatch.length > 0) {
    batches.push({ id: batchId++, items: currentBatch, totalTokens: currentTokens });
  }

  return batches;
}
