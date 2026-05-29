/**
 * Vector metadata I/O — reads/writes vectors/_meta.json.
 */
import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { readJsonSafe } from "../shared/fs.js";
import { atomicWriteJson } from "../shared/atomic-write.js";
import type { VectorMeta } from "../shared/types.js";

const META_FILENAME = "_meta.json";

export function loadVectorMeta(graphDir: string): VectorMeta | null {
  const path = join(graphDir, "vectors", META_FILENAME);
  return readJsonSafe<VectorMeta>(path) ?? null;
}

export function writeVectorMeta(outputDir: string, meta: VectorMeta): void {
  const dir = join(outputDir, "vectors");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  atomicWriteJson(join(dir, META_FILENAME), meta);
}
