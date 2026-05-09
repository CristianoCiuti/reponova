import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/shared/config.js";

describe("loadConfig", () => {
  it("returns default config when no file exists", () => {
    const { config } = loadConfig(undefined);
    expect(config.output).toBe("reponova-out");
    expect(config.repos).toEqual([]);
    expect(config.incremental).toBe(true);
    expect(config.patterns).toEqual([]);
    expect(config.exclude).toEqual([]);
    expect(config.community_summaries.enabled).toBe(true);
    expect(config.community_summaries.max_number).toBe(0);
    expect(config.node_descriptions.enabled).toBe(true);
    expect(config.node_descriptions.threshold).toBe(0.8);
    expect(config.models.gpu).toBe("auto");
    expect(config.models.cache_dir).toBe("~/.cache/reponova/models");
    expect(config.models.download_on_first_use).toBe(true);
    expect(config.outlines.enabled).toBe(true);
  });

  it("throws on non-existent explicit path", () => {
    expect(() => loadConfig("/nonexistent/path/config.yml")).toThrow("Config file not found");
  });
});
