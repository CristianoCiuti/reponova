import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { hashFile, hashObject, readHashFile, writeHashFile } from "../cache/utils.js";
import type { Config } from "../../shared/types.js";
import type { BuildManifest } from "./manifest.js";
import type { ProviderRegistry } from "../../intelligence/provider-registry.js";
import { log } from "../../shared/utils.js";

/**
 * Context provided by the orchestrator to every phase.
 * The phase reads config and filesystem — it never receives in-memory data from other phases.
 * Shared infrastructure (e.g. LLM pool) is injected here to avoid duplicate resource allocation.
 */
export interface PhaseContext {
  /** Complete config (each phase reads its own section) */
  config: Config;
  /** Absolute config directory */
  configDir: string;
  /** Absolute output directory */
  outputDir: string;
  /** Workspace root directory (resolved from repos) */
  workspace: string;
  /** If true, the phase ignores cache and regenerates everything */
  force: boolean;
  /** Shared build manifest — each phase records its own execution state */
  manifest: BuildManifest;
  /** Shared provider registry — phases acquire providers from here instead of creating their own. */
  providerRegistry: ProviderRegistry;
}

/**
 * Result returned by every phase.
 */
export interface PhaseResult {
  /** Number of items processed (for logging) */
  processed: number;
  /** If true, the phase decided not to execute (already up-to-date) */
  skipped: boolean;
  /** Reason for skipping (for logging) */
  skipReason?: string;
}

export interface Phase {
  readonly id: string;
  readonly label: string;
  readonly dependencies: string[];
  execute(ctx: PhaseContext): Promise<PhaseResult>;
}

export abstract class BasePhase implements Phase {
  abstract readonly id: string;
  abstract readonly label: string;
  abstract readonly dependencies: string[];
  abstract readonly inputs: string[];

  abstract getExpectedOutputs(config: Config): { files: string[]; dirs: string[] };
  abstract getRelevantConfig(config: Config): object;
  abstract doWork(ctx: PhaseContext): Promise<PhaseResult>;

  async execute(ctx: PhaseContext): Promise<PhaseResult> {
    this.validateInputs(ctx);

    if (!ctx.force && ctx.config.incremental) {
      if (this.outputsExist(ctx)) {
        const cache = this.checkCacheFreshness(ctx);
        if (cache.fresh) {
          log.info(`  [${this.id}] Skipped: ${cache.reason}`);
          return { processed: 0, skipped: true, skipReason: cache.reason };
        }
      }
    }

    const startedAt = new Date();
    ctx.manifest.record(this.id, {
      status: "running",
      startedAt: startedAt.toISOString(),
      finishedAt: null,
      durationMs: null,
    });
    log.info(`  [${this.id}] ${this.label}...`);

    const result = await this.doWork(ctx);

    const finishedAt = new Date();
    const elapsed = ((finishedAt.getTime() - startedAt.getTime()) / 1000).toFixed(1);
    ctx.manifest.record(this.id, {
      status: result.skipped ? "skipped" : "completed",
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
    });

    if (result.skipped) {
      log.info(`  [${this.id}] Skipped: ${result.skipReason ?? "up to date"} (${elapsed}s)`);
    } else {
      log.info(`  [${this.id}] Done: ${result.processed} processed (${elapsed}s)`);
    }

    if (!result.skipped) {
      this.sealCache(ctx);
    }

    return result;
  }

  checkCacheFreshness(ctx: PhaseContext): { fresh: boolean; reason: string } {
    if (this.inputs.length === 0) {
      return { fresh: false, reason: "no inputs (root phase)" };
    }

    const cacheDir = join(ctx.outputDir, ".cache");
    const sealDir = join(cacheDir, this.id);
    if (!existsSync(sealDir)) {
      return { fresh: false, reason: "never sealed" };
    }

    for (const input of this.inputs) {
      const inputPath = join(ctx.outputDir, input);
      if (!existsSync(inputPath)) {
        return { fresh: false, reason: `input missing: ${input}` };
      }
      const currentHash = hashFile(inputPath);
      const sealedHash = readHashFile(join(sealDir, `input-${this.sanitize(input)}.hash`));
      if (currentHash !== sealedHash) {
        return { fresh: false, reason: `input changed: ${input}` };
      }
    }

    const currentConfigHash = hashObject(this.getRelevantConfig(ctx.config));
    const sealedConfigHash = readHashFile(join(sealDir, "config.hash"));
    if (currentConfigHash !== sealedConfigHash) {
      return { fresh: false, reason: "config changed" };
    }

    return { fresh: true, reason: "all inputs and config unchanged" };
  }

  sealCache(ctx: PhaseContext): void {
    if (!this.outputsExist(ctx)) {
      const expected = this.getExpectedOutputs(ctx.config);
      throw new Error(
        `[${this.id}] Cannot seal: expected outputs missing. Files: [${expected.files.join(", ")}]. Dirs: [${expected.dirs.join(", ")}].`,
      );
    }

    const cacheDir = join(ctx.outputDir, ".cache");
    const sealDir = join(cacheDir, this.id);
    mkdirSync(sealDir, { recursive: true });

    for (const input of this.inputs) {
      const inputPath = join(ctx.outputDir, input);
      if (existsSync(inputPath)) {
        writeHashFile(join(sealDir, `input-${this.sanitize(input)}.hash`), hashFile(inputPath));
      }
    }

    writeHashFile(join(sealDir, "config.hash"), hashObject(this.getRelevantConfig(ctx.config)));
  }

  invalidateCache(ctx: PhaseContext): void {
    const cacheDir = join(ctx.outputDir, ".cache");
    const sealDir = join(cacheDir, this.id);
    if (existsSync(sealDir)) {
      rmSync(sealDir, { recursive: true, force: true });
    }
  }

  private validateInputs(ctx: PhaseContext): void {
    const missing = this.inputs.filter((file) => !existsSync(join(ctx.outputDir, file)));
    if (missing.length > 0) {
      throw new Error(
        `[${this.id}] Missing required inputs: ${missing.join(", ")}.\n` +
        "Upstream phases must produce these files before this phase can run.\n" +
        "Run a full build, or ensure the producing phases are included.",
      );
    }
  }

  private outputsExist(ctx: PhaseContext): boolean {
    const expected = this.getExpectedOutputs(ctx.config);
    for (const file of expected.files) {
      if (!existsSync(join(ctx.outputDir, file))) return false;
    }
    for (const dir of expected.dirs) {
      if (!existsSync(join(ctx.outputDir, dir))) return false;
    }
    return true;
  }

  private sanitize(input: string): string {
    return input.replace(/[/\\]/g, "_");
  }
}
