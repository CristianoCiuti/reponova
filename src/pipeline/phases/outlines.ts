/**
 * outlines phase — generates tree-sitter code outlines.
 *
 * Reads detected-files.json for the file list (same as graph phase),
 * filters to outline-supported extensions, generates outlines per-file
 * with SHA-256 incremental caching.
 */
import {
  existsSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  rmSync,
} from "node:fs";
import { join, extname } from "node:path";
import type { Phase, PhaseContext, PhaseResult } from "../engine/phase.js";
import { outlinesContract } from "../cache/contracts/outlines.js";
import { readDetectedFiles } from "./file-detection.js";
import { generateOutline, formatOutlineJson } from "../../outline/index.js";
import { getOutlineSupportedExtensions } from "../../outline/languages/registry.js";
import { hashFile } from "../../shared/hash.js";
import { atomicWriteJson, atomicWriteText } from "../../shared/atomic-write.js";
import { readJsonSafe } from "../../shared/fs.js";
import { log, errorMessage } from "../../shared/utils.js";

export const outlinesPhase: Phase = {
  id: "outlines",
  label: "Outlines",
  dependencies: ["file-detection"],
  contract: outlinesContract,

  async execute(ctx: PhaseContext): Promise<PhaseResult> {
    const startedAt = new Date();
    ctx.manifest.record(this.id, { status: "running", startedAt: startedAt.toISOString(), finishedAt: null, durationMs: null });
    log.info(`  [${this.id}] ${this.label}...`);

    try {
      const { config, workspace, outputDir, force } = ctx;
      const outlinesDir = join(outputDir, "outlines");
      const cachePath = join(outputDir, ".cache", "outline-hashes.json");

      if (!config.outlines.enabled) {
        removeDirectory(outlinesDir);
        removeFile(cachePath);
        const finishedAt = new Date();
        const elapsed = ((finishedAt.getTime() - startedAt.getTime()) / 1000).toFixed(1);
        ctx.manifest.record(this.id, { status: "skipped", startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), durationMs: finishedAt.getTime() - startedAt.getTime() });
        log.info(`  [${this.id}] Skipped: disabled in config (${elapsed}s)`);
        return { processed: 0, skipped: true, skipReason: "disabled in config" };
      }

      // Read detected files and filter to outline-supported extensions
      const detected = readDetectedFiles(outputDir);
      const supportedExts = getOutlineSupportedExtensions();
      const codeFiles = detected.code.filter((f) => supportedExts.has(extname(f).toLowerCase()));

      if (codeFiles.length === 0) {
        const finishedAt = new Date();
        const elapsed = ((finishedAt.getTime() - startedAt.getTime()) / 1000).toFixed(1);
        ctx.manifest.record(this.id, { status: "skipped", startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), durationMs: finishedAt.getTime() - startedAt.getTime() });
        log.info(`  [${this.id}] Skipped: no outline-supported files (${elapsed}s)`);
        return { processed: 0, skipped: true, skipReason: "no outline-supported files" };
      }

      const previousHashes = force ? new Map<string, string>() : loadOutlineHashes(outputDir);
      const nextHashes = new Map<string, string>();

      let count = 0;

      for (const relPath of codeFiles) {
        const absPath = join(workspace, relPath);
        if (!existsSync(absPath)) continue;

        const outPath = join(outlinesDir, relPath + ".outline.json");
        const fileHash = hashFile(absPath);
        nextHashes.set(relPath, fileHash);

        if (!force && existsSync(outPath) && previousHashes.get(relPath) === fileHash) {
          continue;
        }

        try {
          const source = readFileSync(absPath, "utf-8");
          const outline = await generateOutline(relPath, source);
          if (!outline) continue;

          atomicWriteText(outPath, formatOutlineJson(outline));
          count++;
        } catch (error) {
          log.warn(`Failed to process ${absPath}: ${error}`);
        }
      }

      // Clean stale outlines
      let staleCount = 0;
      for (const [relPath] of previousHashes) {
        if (!nextHashes.has(relPath)) {
          const stalePath = join(outlinesDir, relPath + ".outline.json");
          try {
            if (existsSync(stalePath)) {
              unlinkSync(stalePath);
              staleCount++;
            }
          } catch { /* ignore */ }
        }
      }

      if (staleCount > 0) log.info(`  Removed ${staleCount} stale outline(s)`);
      removeEmptyDirs(outlinesDir);
      saveOutlineHashes(outputDir, nextHashes);

      if (count === 0 && staleCount === 0) {
        const finishedAt = new Date();
        const elapsed = ((finishedAt.getTime() - startedAt.getTime()) / 1000).toFixed(1);
        ctx.manifest.record(this.id, { status: "skipped", startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), durationMs: finishedAt.getTime() - startedAt.getTime() });
        log.info(`  [${this.id}] Skipped: up to date (${elapsed}s)`);
        return { processed: 0, skipped: true, skipReason: "up to date" };
      }

      const result: PhaseResult = { processed: count, skipped: false };
      const finishedAt = new Date();
      const elapsed = ((finishedAt.getTime() - startedAt.getTime()) / 1000).toFixed(1);
      ctx.manifest.record(this.id, { status: "completed", startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), durationMs: finishedAt.getTime() - startedAt.getTime() });
      log.info(`  [${this.id}] Done: ${result.processed} processed (${elapsed}s)`);

      return result;
    } catch (err) {
      const finishedAt = new Date();
      const elapsed = ((finishedAt.getTime() - startedAt.getTime()) / 1000).toFixed(1);
      const message = errorMessage(err);
      ctx.manifest.record(this.id, { status: "failed", startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), durationMs: finishedAt.getTime() - startedAt.getTime() });
      log.warn(`  [${this.id}] Failed: ${message} (${elapsed}s)`);
      return { processed: 0, skipped: true, skipReason: `error: ${message}` };
    }
  },
};

function loadOutlineHashes(outputDir: string): Map<string, string> {
  const hashesPath = join(outputDir, ".cache", "outline-hashes.json");
  const raw = readJsonSafe<Record<string, string>>(hashesPath);
  return raw ? new Map(Object.entries(raw)) : new Map();
}

function saveOutlineHashes(outputDir: string, hashes: Map<string, string>): void {
  const serialized: Record<string, string> = {};
  for (const [filePath, hash] of hashes) {
    serialized[filePath] = hash;
  }
  atomicWriteJson(join(outputDir, ".cache", "outline-hashes.json"), serialized);
}

function removeEmptyDirs(root: string): void {
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const child = join(root, entry.name);
      removeEmptyDirs(child);
      try {
        if (readdirSync(child).length === 0) rmSync(child, { recursive: true, force: true });
      } catch { /* ignore */ }
    }
  }
}

function removeDirectory(path: string): void {
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
}

function removeFile(path: string): void {
  if (existsSync(path)) unlinkSync(path);
}
