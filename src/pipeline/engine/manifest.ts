/**
 * Build manifest — shared phase execution tracker.
 *
 * Each phase writes its own entry via `record()`.
 * The manifest file is read-modify-write with an in-memory mutex
 * to prevent lost updates when phases within the same level run in parallel.
 *
 * File: `<outputDir>/build-manifest.json`
 */
import { join } from "node:path";
import { atomicWriteJson } from "../../shared/atomic-write.js";
import { readJsonSafe } from "../../shared/fs.js";

export type PhaseStatus = "running" | "completed" | "skipped" | "failed";

export interface PhaseManifestEntry {
  status: PhaseStatus;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
}

export type ManifestData = Record<string, PhaseManifestEntry>;

export class BuildManifest {
  private readonly manifestPath: string;

  constructor(outputDir: string) {
    this.manifestPath = join(outputDir, "build-manifest.json");
  }

  /**
   * Read a phase's current manifest entry (if any).
   * Returns undefined if the manifest file or the phase key does not exist.
   */
  readEntry(phaseId: string): PhaseManifestEntry | undefined {
    const manifest = readJsonSafe<ManifestData>(this.manifestPath);
    return manifest?.[phaseId];
  }

  /**
   * Record a phase's execution state.
   * Each phase writes only its own key — other entries are preserved.
   *
   * Concurrency-safe: readJsonSafe and atomicWriteJson are synchronous,
   * and JS is single-threaded, so parallel phases (Promise.allSettled)
   * cannot interleave within a synchronous read-modify-write block.
   */
  record(phaseId: string, entry: PhaseManifestEntry): void {
    const manifest = readJsonSafe<ManifestData>(this.manifestPath) ?? {};
    manifest[phaseId] = entry;
    atomicWriteJson(this.manifestPath, manifest);
  }
}
