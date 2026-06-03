/**
 * file-detection phase — detects all source, doc, and plugin-provided files.
 *
 * Always runs (cost of a directory walk ≈ cost of checking whether to skip).
 * Produces detected-files.json consumed by graph and outlines phases.
 */
import { basename, join } from "node:path";
import type { Config } from "../../shared/types.js";
import { detectAllFiles } from "../../extract/index.js";
import { getRegisteredFileTypes } from "../../plugin/discovery.js";
import { atomicWriteJson } from "../../shared/atomic-write.js";
import { readJsonSafe } from "../../shared/fs.js";
import { hashFile } from "../../shared/hash.js";
import { buildSkipDirs } from "../../shared/path-resolver.js";
import { log } from "../../shared/utils.js";
import { BasePhase, type PhaseContext, type PhaseResult } from "../engine/phase.js";

export interface DetectedFiles {
  workspace: string;
  files: Record<string, string[]>;
}

export function readDetectedFiles(outputDir: string): DetectedFiles {
  const path = join(outputDir, "detected-files.json");
  const raw = readJsonSafe<DetectedFiles>(path);
  if (!raw) throw new Error(`detected-files.json not found in ${outputDir} — run file-detection phase first`);
  return raw;
}

export function readFileHashes(outputDir: string): Map<string, string> {
  const path = join(outputDir, "file-hashes.json");
  const raw = readJsonSafe<Record<string, string>>(path);
  if (!raw) throw new Error(`file-hashes.json not found in ${outputDir} — run file-detection phase first`);
  return new Map(Object.entries(raw));
}

class FileDetectionPhase extends BasePhase {
  readonly id = "file-detection";
  readonly label = "File Detection";
  readonly dependencies: string[] = [];
  readonly inputs: string[] = [];

  getExpectedOutputs(_config: Config): { files: string[]; dirs: string[] } {
    return { files: ["detected-files.json", "file-hashes.json"], dirs: [] };
  }

  getRelevantConfig(config: Config): object {
    return {
      patterns: config.patterns,
      exclude: config.exclude,
      exclude_common: config.exclude_common,
      docs: config.docs,
      plugins: config.plugins,
    };
  }

  async doWork(ctx: PhaseContext): Promise<PhaseResult> {
    const { config, workspace, outputDir } = ctx;

    const skipDirs = buildSkipDirs(config.exclude_common);
    skipDirs.add(basename(outputDir));

    const repoNames = config.repos.length > 1
      ? new Set(config.repos.map((repo) => repo.name))
      : undefined;

    const registeredTypes = getRegisteredFileTypes(config);
    const files = detectAllFiles(workspace, config, registeredTypes, skipDirs, repoNames);

    const detected: DetectedFiles = { workspace, files };
    atomicWriteJson(join(outputDir, "detected-files.json"), detected);

    const allFiles = Object.values(files).flat().sort();
    log.info("Computing file hashes...");
    const hashes = Object.fromEntries(
      allFiles.map((relPath) => [relPath, hashFile(join(workspace, relPath))]),
    );
    atomicWriteJson(join(outputDir, "file-hashes.json"), hashes);

    // Dynamic log: show count per type
    const parts = Object.entries(files)
      .filter(([, paths]) => paths.length > 0)
      .map(([type, paths]) => `${paths.length} ${type}`);
    log.info(`  ${parts.join(", ")}`);

    return { processed: allFiles.length, skipped: false };
  }
}

export const fileDetectionPhase = new FileDetectionPhase();
