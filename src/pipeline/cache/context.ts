import type { Config } from "../../shared/types.js";

export interface CacheContext {
  outputDir: string;
  cacheDir: string;
  config: Config;
}
