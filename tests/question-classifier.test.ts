/**
 * Phase 4 tests: Natural Language Query (graph_ask) + Question Classifier
 */
import { describe, it, expect } from "vitest";
import { classifyQuestion } from "../dist/index.js";

describe("Question Classifier", () => {
  describe("impact_downstream", () => {
    it("classifies 'what depends on X'", () => {
      const r = classifyQuestion("what depends on authenticate_user");
      expect(r.strategy).toBe("impact_downstream");
      expect(r.entities[0]).toBe("authenticate_user");
    });

    it("classifies 'who calls X'", () => {
      const r = classifyQuestion("who calls the validate function");
      expect(r.strategy).toBe("impact_downstream");
      expect(r.entities[0]).toContain("validate");
    });

    it("classifies Italian 'cosa usa X'", () => {
      const r = classifyQuestion("cosa usa load_config");
      expect(r.strategy).toBe("impact_downstream");
      expect(r.entities[0]).toBe("load_config");
    });

    it("classifies 'blast radius of X'", () => {
      const r = classifyQuestion("blast radius of UserService");
      expect(r.strategy).toBe("impact_downstream");
      expect(r.entities[0]).toBe("UserService");
    });
  });

  describe("impact_upstream", () => {
    it("classifies 'what does X use'", () => {
      const r = classifyQuestion("what does authenticate_user use");
      expect(r.strategy).toBe("impact_upstream");
      expect(r.entities[0]).toBe("authenticate_user");
    });

    it("classifies 'dependencies of X'", () => {
      const r = classifyQuestion("dependencies of ConfigManager");
      expect(r.strategy).toBe("impact_upstream");
      expect(r.entities[0]).toBe("ConfigManager");
    });

    it("classifies Italian 'da cosa dipende X'", () => {
      const r = classifyQuestion("da cosa dipende UserService");
      expect(r.strategy).toBe("impact_upstream");
      expect(r.entities[0]).toBe("UserService");
    });
  });

  describe("path", () => {
    it("classifies 'how is X connected to Y'", () => {
      const r = classifyQuestion("how is auth connected to database");
      expect(r.strategy).toBe("path");
      expect(r.entities).toHaveLength(2);
      expect(r.entities[0]).toBe("auth");
      expect(r.entities[1]).toBe("database");
    });

    it("classifies 'path from X to Y'", () => {
      const r = classifyQuestion("path from UserService to DatabaseClient");
      expect(r.strategy).toBe("path");
      expect(r.entities[0]).toBe("UserService");
      expect(r.entities[1]).toBe("DatabaseClient");
    });
  });

  describe("explain", () => {
    it("classifies 'what is X'", () => {
      const r = classifyQuestion("what is ConfigManager");
      expect(r.strategy).toBe("explain");
      expect(r.entities[0]).toBe("ConfigManager");
    });

    it("classifies 'explain X'", () => {
      const r = classifyQuestion("explain the load_config function");
      expect(r.strategy).toBe("explain");
      expect(r.entities[0]).toContain("load_config");
    });

    it("classifies Italian \"cos'è X\"", () => {
      const r = classifyQuestion("cos'è UserService");
      expect(r.strategy).toBe("explain");
      expect(r.entities[0]).toBe("UserService");
    });
  });

  describe("search", () => {
    it("classifies 'find X'", () => {
      const r = classifyQuestion("find authentication handlers");
      expect(r.strategy).toBe("search");
      expect(r.entities[0]).toBe("authentication handlers");
    });

    it("classifies 'Find validation functions' (FIX-003)", () => {
      const r = classifyQuestion("Find validation functions");
      expect(r.strategy).toBe("search");
      expect(r.entities[0]).toBe("validation functions");
      expect(r.language).toBe("en");
    });

    it("classifies 'search X'", () => {
      const r = classifyQuestion("search authentication modules");
      expect(r.strategy).toBe("search");
      expect(r.entities[0]).toBe("authentication modules");
    });

    it("classifies 'where is X'", () => {
      const r = classifyQuestion("where is the config parser");
      expect(r.strategy).toBe("search");
      expect(r.entities[0]).toContain("config parser");
    });

    it("classifies Italian 'cerca X'", () => {
      const r = classifyQuestion("cerca validate_schema");
      expect(r.strategy).toBe("search");
      expect(r.entities[0]).toBe("validate_schema");
    });
  });

  describe("similar", () => {
    it("classifies 'similar to X'", () => {
      const r = classifyQuestion("similar to authenticate_user");
      expect(r.strategy).toBe("similar");
      expect(r.entities[0]).toBe("authenticate_user");
    });

    it("classifies 'find something like X'", () => {
      const r = classifyQuestion("find something like ConfigManager");
      expect(r.strategy).toBe("similar");
      expect(r.entities[0]).toBe("ConfigManager");
    });
  });

  describe("architecture", () => {
    it("classifies 'architecture'", () => {
      const r = classifyQuestion("show me the architecture");
      expect(r.strategy).toBe("architecture");
    });

    it("classifies 'main components'", () => {
      const r = classifyQuestion("what are the main components");
      expect(r.strategy).toBe("architecture");
    });

    it("classifies 'hotspots'", () => {
      const r = classifyQuestion("show hotspots");
      expect(r.strategy).toBe("architecture");
    });
  });

  describe("language detection", () => {
    it("detects English queries", () => {
      const r = classifyQuestion("what depends on authenticate_user");
      expect(r.language).toBe("en");
    });

    it("detects Italian queries", () => {
      const r = classifyQuestion("cosa usa load_config");
      expect(r.language).toBe("it");
    });

    it("accepts explicit language override", () => {
      const r = classifyQuestion("cerca validate_schema", "it");
      expect(r.language).toBe("it");
      expect(r.strategy).toBe("search");
    });

    it("returns empty for blank query", () => {
      const r = classifyQuestion("");
      expect(r.strategy).toBe("context");
      expect(r.confidence).toBe(0);
    });
  });
});
