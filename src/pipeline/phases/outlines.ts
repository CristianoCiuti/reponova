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
import type { Config } from "../../shared/types.js";
import { generateOutline, formatOutlineJson } from "../../outline/index.js";
import { getOutlineSupportedExtensions } from "../../outline/languages/registry.js";
import { atomicWriteJson, atomicWriteText } from "../../shared/atomic-write.js";
import { readJsonSafe } from "../../shared/fs.js";
import { hashFile } from "../../shared/hash.js";
import { log } from "../../shared/utils.js";
import { BasePhase, type PhaseContext, type PhaseResult } from "../engine/phase.js";
import { readDetectedFiles, readFileHashes } from "./file-detection.js";

class OutlinesPhase extends BasePhase {
  readonly id = "outlines";
  readonly label = "Outlines";
  readonly dependencies = ["file-detection"];
  readonly inputs = ["detected-files.json", "file-hashes.json"];

  getExpectedOutputs(_config: Config): { files: string[]; dirs: string[] } {
    return { files: [], dirs: ["outlines"] };
  }

  getRelevantConfig(config: Config): object {
    return { outlines: config.outlines };
  }

  async doWork(ctx: PhaseContext): Promise<PhaseResult> {
    const { config, workspace, outputDir, force } = ctx;
    const outlinesDir = join(outputDir, "outlines");
    const cachePath = join(outputDir, ".cache", "outline-hashes.json");

    if (!config.outlines.enabled) {
      removeDirectory(outlinesDir);
      removeFile(cachePath);
      return { processed: 0, skipped: true, skipReason: "disabled in config" };
    }

    const detected = readDetectedFiles(outputDir);
    const supportedExts = getOutlineSupportedExtensions();
    const codeFiles = detected.code.filter((file) => supportedExts.has(extname(file).toLowerCase()));

    if (codeFiles.length === 0) {
      return { processed: 0, skipped: true, skipReason: "no outline-supported files" };
    }

    const precomputedHashes = readFileHashes(outputDir);
    const previousHashes = force || !config.incremental ? new Map<string, string>() : loadOutlineHashes(outputDir);
    const nextHashes = new Map<string, string>();
    let count = 0;

    for (const relPath of codeFiles) {
      const absPath = join(workspace, relPath);
      if (!existsSync(absPath)) continue;

      const outPath = join(outlinesDir, relPath + ".outline.json");
      const fileHash = precomputedHashes.get(relPath) ?? hashFile(absPath);
      nextHashes.set(relPath, fileHash);

      if (!(force || !config.incremental) && existsSync(outPath) && previousHashes.get(relPath) === fileHash) {
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

    let staleCount = 0;
    for (const [relPath] of previousHashes) {
      if (!nextHashes.has(relPath)) {
        const stalePath = join(outlinesDir, relPath + ".outline.json");
        try {
          if (existsSync(stalePath)) {
            unlinkSync(stalePath);
            staleCount++;
          }
        } catch {
          // ignore
        }
      }
    }

    if (staleCount > 0) log.info(`  Removed ${staleCount} stale outline(s)`);
    removeEmptyDirs(outlinesDir);
    saveOutlineHashes(outputDir, nextHashes);

    if (count === 0 && staleCount === 0) {
      return { processed: 0, skipped: true, skipReason: "up to date" };
    }

    return { processed: count, skipped: false };
  }
}

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
      } catch {
        // ignore
      }
    }
  }
}

function removeDirectory(path: string): void {
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
}

function removeFile(path: string): void {
  if (existsSync(path)) unlinkSync(path);
}

export const outlinesPhase = new OutlinesPhase();
