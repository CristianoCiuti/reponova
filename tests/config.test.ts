import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/core/config.js";

describe("loadConfig", () => {
  it("returns default config when no file exists", () => {
    const { config } = loadConfig(undefined);
    expect(config.output).toBe("graphify-out");
    expect(config.repos).toEqual([]);
    expect(config.build.graphify_args).toEqual([]);
    expect(config.outlines.enabled).toBe(true);
  });

  it("throws on non-existent explicit path", () => {
    expect(() => loadConfig("/nonexistent/path/config.yml")).toThrow("Config file not found");
  });
});
