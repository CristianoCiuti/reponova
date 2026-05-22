/**
 * file-detection phase — detects all source, doc, and diagram files.
 *
 * Always runs (cost of a directory walk ≈ cost of checking whether to skip).
 * Produces detected-files.json consumed by graph and outlines phases.
 */
import { basename, join } from "node:path";
import type { Config } from "../../shared/types.js";
import { detectFiles, detectDocFiles, detectDiagramFiles } from "../../extract/index.js";
import { atomicWriteJson } from "../../shared/atomic-write.js";
import { readJsonSafe } from "../../shared/fs.js";
import { hashFile } from "../../shared/hash.js";
import { buildSkipDirs } from "../../shared/path-resolver.js";
import { log } from "../../shared/utils.js";
import { BasePhase, type PhaseContext, type PhaseResult } from "../engine/phase.js";

export interface DetectedFiles {
  workspace: string;
  code: string[];
  docs: string[];
  diagrams: string[];
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
      images: config.images,
    };
  }

  async doWork(ctx: PhaseContext): Promise<PhaseResult> {
    const { config, workspace, outputDir } = ctx;

    const skipDirs = buildSkipDirs(config.exclude_common);
    skipDirs.add(basename(outputDir));

    const repoNames = config.repos.length > 1
      ? new Set(config.repos.map((repo) => repo.name))
      : undefined;

    const code = detectFiles(workspace, config.patterns, config.exclude, skipDirs, repoNames).sort();
    const docs = detectDocFiles(workspace, config.docs, skipDirs, repoNames).sort();
    const diagrams = detectDiagramFiles(workspace, config.images, skipDirs, repoNames).sort();

    const detected: DetectedFiles = { workspace, code, docs, diagrams };
    atomicWriteJson(join(outputDir, "detected-files.json"), detected);

    const allFiles = [...code, ...docs, ...diagrams].sort();
    log.info("Computing file hashes...");
    const hashes = Object.fromEntries(
      allFiles.map((relPath) => [relPath, hashFile(join(workspace, relPath))]),
    );
    atomicWriteJson(join(outputDir, "file-hashes.json"), hashes);

    const extras: string[] = [];
    if (docs.length > 0) extras.push(`${docs.length} docs`);
    if (diagrams.length > 0) extras.push(`${diagrams.length} diagrams`);
    log.info(`  ${code.length} source files${extras.length > 0 ? `, ${extras.join(", ")}` : ""}`);

    return { processed: allFiles.length, skipped: false };
  }
}

export const fileDetectionPhase = new FileDetectionPhase();
