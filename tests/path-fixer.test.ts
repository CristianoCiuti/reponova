import { describe, it, expect } from "vitest";
import { fixPaths, fixGraphPaths } from "../src/core/path-fixer.js";

describe("fixPaths", () => {
  it("strips base path prefix", () => {
    const result = fixPaths("/home/user/repos/project-api/src/main.py", ["/home/user/repos/project-api"]);
    expect(result).toBe("src/main.py");
  });

  it("handles Windows-style paths", () => {
    const result = fixPaths("C:\\Users\\user\\repos\\project\\src\\main.py", ["C:\\Users\\user\\repos\\project"]);
    // Should normalize to forward slashes
    expect(result).toMatch(/src\/main\.py/);
  });

  it("removes leading ./ ", () => {
    const result = fixPaths("./src/main.py", []);
    expect(result).toBe("src/main.py");
  });

  it("handles already relative paths", () => {
    const result = fixPaths("src/main.py", ["/some/base"]);
    expect(result).toBe("src/main.py");
  });
});

describe("fixGraphPaths", () => {
  it("fixes paths in-place", () => {
    const nodes = [
      { source_file: "/base/project/src/main.py" },
      { source_file: "/base/project/src/lib.py" },
      { source_file: undefined },
    ];
    fixGraphPaths(nodes, ["/base/project"]);
    expect(nodes[0]!.source_file).toBe("src/main.py");
    expect(nodes[1]!.source_file).toBe("src/lib.py");
    expect(nodes[2]!.source_file).toBeUndefined();
  });
});
