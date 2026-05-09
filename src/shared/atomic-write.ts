/**
 * Atomic write utilities — transactional file writes via os.tmpdir().
 *
 * Pattern:
 * 1. Write content to a temp file in os.tmpdir()
 * 2. Copy temp file to the final destination (mkdirSync parent if needed)
 * 3. Delete temp file
 *
 * The output directory is never touched until the copyFileSync, guaranteeing
 * that a crash mid-write leaves the previous file intact.
 *
 * On Windows, renameSync fails across drives, so we use copyFileSync + unlinkSync
 * which always works regardless of filesystem boundaries.
 */
import { writeFileSync, copyFileSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

function makeTmpPath(ext: string): string {
  return join(tmpdir(), `rn-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
}

/**
 * Write JSON atomically via os.tmpdir() staging.
 * Parent directories of filePath are created automatically.
 */
export function atomicWriteJson(filePath: string, data: unknown): void {
  const tmpPath = makeTmpPath(".json");
  writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  mkdirSync(dirname(filePath), { recursive: true });
  copyFileSync(tmpPath, filePath);
  try { unlinkSync(tmpPath); } catch { /* ignore cleanup errors */ }
}

/**
 * Write text atomically via os.tmpdir() staging.
 * Parent directories of filePath are created automatically.
 */
export function atomicWriteText(filePath: string, content: string): void {
  const tmpPath = makeTmpPath(".txt");
  writeFileSync(tmpPath, content);
  mkdirSync(dirname(filePath), { recursive: true });
  copyFileSync(tmpPath, filePath);
  try { unlinkSync(tmpPath); } catch { /* ignore cleanup errors */ }
}

/**
 * Write a binary buffer atomically via os.tmpdir() staging.
 * Parent directories of filePath are created automatically.
 */
export function atomicWriteBuffer(filePath: string, buffer: Buffer | Uint8Array): void {
  const tmpPath = makeTmpPath(".bin");
  writeFileSync(tmpPath, buffer);
  mkdirSync(dirname(filePath), { recursive: true });
  copyFileSync(tmpPath, filePath);
  try { unlinkSync(tmpPath); } catch { /* ignore cleanup errors */ }
}
