/**
 * File hashing utilities.
 *
 * SHA-256 content hashing for incremental build decisions.
 * Used by multiple pipeline phases (extraction cache, outline hashing, etc.).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Compute SHA-256 hash of file contents.
 */
export function hashFile(absPath: string): string {
  const content = readFileSync(absPath);
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Compute hashes for all files in the list.
 * @param workspace - Workspace root directory
 * @param filePaths - Relative file paths
 * @returns Map of relPath → sha256
 */
export function computeHashes(workspace: string, filePaths: string[]): Map<string, string> {
  const hashes = new Map<string, string>();
  for (const relPath of filePaths) {
    const absPath = join(workspace, relPath);
    try {
      hashes.set(relPath, hashFile(absPath));
    } catch {
      // File might have been deleted between detection and hashing
    }
  }
  return hashes;
}
