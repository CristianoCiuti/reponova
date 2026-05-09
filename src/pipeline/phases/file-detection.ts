/**
 * file-detection phase — detects all source, doc, and diagram files.
 *
 * Always runs (cost of a directory walk ≈ cost of checking whether to skip).
 * Produces detected-files.json consumed by graph and outlines phases.
 */
import { basename, join } from "node:path";
import type { Phase, PhaseContext, PhaseResult } from "../engine/phase.js";
import { detectFiles, detectDocFiles, detectDiagramFiles } from "../../extract/index.js";
import { buildSkipDirs } from "../../shared/path-resolver.js";
import { atomicWriteJson } from "../../shared/atomic-write.js";
import { readJsonSafe } from "../../shared/fs.js";
import { log, errorMessage } from "../../shared/utils.js";

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

export const fileDetectionPhase: Phase = {
  id: "file-detection",
  label: "File Detection",
  dependencies: [],

  async execute(ctx: PhaseContext): Promise<PhaseResult> {
    const startedAt = new Date();
    ctx.manifest.record(this.id, { status: "running", startedAt: startedAt.toISOString(), finishedAt: null, durationMs: null });
    log.info(`  [${this.id}] ${this.label}...`);

    try {
      const { config, workspace, outputDir } = ctx;

      const skipDirs = buildSkipDirs(config.exclude_common);
      skipDirs.add(basename(outputDir));

      const repoNames = config.repos.length > 1
        ? new Set(config.repos.map((r) => r.name))
        : undefined;

      const code = detectFiles(workspace, config.patterns, config.exclude, skipDirs, repoNames);
      const docs = detectDocFiles(workspace, config.docs, skipDirs, repoNames);
      const diagrams = detectDiagramFiles(workspace, config.images, skipDirs, repoNames);

      const detected: DetectedFiles = { workspace, code, docs, diagrams };
      atomicWriteJson(join(outputDir, "detected-files.json"), detected);

      const extras: string[] = [];
      if (docs.length > 0) extras.push(`${docs.length} docs`);
      if (diagrams.length > 0) extras.push(`${diagrams.length} diagrams`);
      log.info(`  ${code.length} source files${extras.length > 0 ? `, ${extras.join(", ")}` : ""}`);

      const result: PhaseResult = { processed: code.length + docs.length + diagrams.length, skipped: false };
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
