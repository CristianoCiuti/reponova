import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const CLI = join(__dirname, "../dist/cli/index.js");

function run(args: string, cwd: string): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execSync(`node "${CLI}" ${args}`, {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
      exitCode: err.status ?? 1,
    };
  }
}

describe("reponova lang CLI", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "rn-lang-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("lang add", () => {
    it("should detect linked plugin and write to new reponova.yml", () => {
      const result = run("lang add @reponova/lang-python", tmpDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("plugins.python");
      expect(result.stdout).toContain(".py");

      // Verify reponova.yml was created
      const configPath = join(tmpDir, "reponova.yml");
      expect(existsSync(configPath)).toBe(true);

      const content = readFileSync(configPath, "utf-8");
      expect(content).toContain("plugins:");
      expect(content).toContain("python:");
      expect(content).toContain("enabled: true");
      // Official package → no "package:" field
      expect(content).not.toContain("package:");
      // Result must be human-readable block YAML, not a flow-style blob.
      expect(content).toMatch(/^plugins:\r?\n\s+python:\r?\n\s+enabled: true/m);
      expect(content).not.toMatch(/\{[^}]*enabled/);
    });

    it("should add to existing reponova.yml with plugins: {}", () => {
      const configPath = join(tmpDir, "reponova.yml");
      writeFileSync(configPath, "output: out\nrepos:\n  - name: x\n    path: .\n\nplugins: {}\n");

      const result = run("lang add @reponova/lang-plantuml", tmpDir);
      expect(result.exitCode).toBe(0);

      const content = readFileSync(configPath, "utf-8");
      expect(content).toContain("plantuml:");
      expect(content).toContain("enabled: true");
      expect(content).toContain("parse: true"); // configDefaults
      // Regression: a seed `plugins: {}` (flow) used to lock the section
      // into flow style, producing `plugins: { plantuml: { enabled: ... } }`.
      // We force block style on add to avoid this.
      expect(content).not.toMatch(/\{[^}]*enabled/);
    });

    it("should produce block-style YAML when adding multiple plugins to a fresh config", () => {
      // Reproduces the `lang suggest` scenario: no reponova.yml exists, then
      // multiple plugins get installed one after the other. The resulting
      // file must be a readable multiline mapping, not a one-line flow blob.
      const r1 = run("lang add @reponova/lang-python", tmpDir);
      expect(r1.exitCode).toBe(0);
      const r2 = run("lang add @reponova/lang-plantuml", tmpDir);
      expect(r2.exitCode).toBe(0);

      const content = readFileSync(join(tmpDir, "reponova.yml"), "utf-8");
      expect(content).not.toMatch(/\{[^}]*enabled/);
      expect(content).toMatch(/^plugins:\r?\n\s+python:\r?\n\s+enabled: true/m);
      expect(content).toMatch(/\r?\n\s+plantuml:\r?\n\s+parse: true/);
    });

    it("should add to existing plugins section", () => {
      const configPath = join(tmpDir, "reponova.yml");
      writeFileSync(configPath, "output: out\nrepos:\n  - name: x\n    path: .\n\nplugins:\n  svg:\n    enabled: true\n");

      const result = run("lang add @reponova/lang-python", tmpDir);
      expect(result.exitCode).toBe(0);

      const content = readFileSync(configPath, "utf-8");
      expect(content).toContain("python:");
      expect(content).toContain("svg:");
    });

    it("should be idempotent (add same plugin twice)", () => {
      run("lang add @reponova/lang-python", tmpDir);
      const result = run("lang add @reponova/lang-python", tmpDir);
      expect(result.exitCode).toBe(0);

      const content = readFileSync(join(tmpDir, "reponova.yml"), "utf-8");
      // Should only have one python entry
      const matches = content.match(/python:/g);
      expect(matches?.length).toBe(1);
    });

    it("should not write package field for official plugins", () => {
      const result = run("lang add @reponova/lang-svg", tmpDir);
      expect(result.exitCode).toBe(0);

      const content = readFileSync(join(tmpDir, "reponova.yml"), "utf-8");
      expect(content).not.toContain("package:");
    });

    it("should error on invalid package (not a reponova plugin)", () => {
      // yargs is in node_modules but is not a reponova language plugin
      const result = run("lang add yargs", tmpDir);
      expect(result.exitCode).toBe(1);
      const output = result.stdout + result.stderr;
      // The new check distinguishes WHY a package isn't a usable plugin.
      // For yargs (no `reponova.type` field), we expect the
      // "not a reponova language plugin" diagnostic.
      expect(output).toMatch(/not a reponova language plugin|reponova\.type/i);
    });

    it("should preserve comments and user-set fields when re-adding existing plugin", () => {
      const configPath = join(tmpDir, "reponova.yml");
      writeFileSync(
        configPath,
        [
          "# RepoNova configuration",
          "output: out",
          "",
          "# Languages",
          "plugins:",
          "  # Python plugin",
          "  python:",
          "    enabled: false # explicitly disabled",
          "    exclude:",
          "      - \"**/migrations/**\"",
          "",
        ].join("\n"),
      );

      const result = run("lang add @reponova/lang-python", tmpDir);
      expect(result.exitCode).toBe(0);

      const content = readFileSync(configPath, "utf-8");
      expect(content).toContain("# RepoNova configuration");
      expect(content).toContain("# Languages");
      expect(content).toContain("# Python plugin");
      expect(content).toContain("explicitly disabled");
      expect(content).toContain("**/migrations/**");
      expect(content).toContain("enabled: false"); // user override preserved
      expect(content.match(/python:/g)?.length).toBe(1);
    });

    it("should preserve CRLF line endings", () => {
      const configPath = join(tmpDir, "reponova.yml");
      const crlf =
        "output: out\r\n\r\nplugins:\r\n  python:\r\n    enabled: true\r\n";
      writeFileSync(configPath, crlf);

      const result = run("lang add @reponova/lang-svg", tmpDir);
      expect(result.exitCode).toBe(0);

      const content = readFileSync(configPath, "utf-8");
      expect(content).toMatch(/\r\n/); // CRLF preserved
      expect(content).not.toMatch(/(?<!\r)\n/); // no bare LFs
      expect(content.match(/python:/g)?.length).toBe(1); // no duplicate
      expect(content).toContain("svg:");
    });
  });

  describe("lang remove", () => {
    it("should remove plugin entry from config", () => {
      const configPath = join(tmpDir, "reponova.yml");
      // Use a fake plugin id that won't trigger real npm uninstall side effects
      writeFileSync(configPath, "output: out\nrepos:\n  - name: x\n    path: .\n\nplugins:\n  fake-lang:\n    package: \"@fake/lang-test\"\n    enabled: true\n  svg:\n    enabled: true\n");

      const result = run("lang remove fake-lang", tmpDir);
      // npm uninstall will fail (package doesn't exist) but config is still updated
      expect(result.exitCode).toBe(0);

      const content = readFileSync(configPath, "utf-8");
      expect(content).not.toContain("fake-lang:");
      expect(content).toContain("svg:");
    });

    it("should error when plugin not in config", () => {
      const configPath = join(tmpDir, "reponova.yml");
      writeFileSync(configPath, "output: out\nrepos:\n  - name: x\n    path: .\n\nplugins: {}\n");

      const result = run("lang remove nonexistent", tmpDir);
      expect(result.exitCode).toBe(1);
      const output = result.stdout + result.stderr;
      expect(output).toContain("not found");
    });

    it("should error when no config exists", () => {
      const result = run("lang remove python", tmpDir);
      expect(result.exitCode).toBe(1);
      const output = result.stdout + result.stderr;
      expect(output).toContain("No reponova.yml found");
    });

    it("should not touch the package when --config-only is passed", () => {
      // We can't observe the absence of an npm call directly in a
      // subprocess test, but we CAN check that the config is updated
      // AND that the subprocess exits 0 even for a plugin whose
      // package isn't installed on disk (which would otherwise be a
      // no-op anyway). The real safety net is the unit-tested matrix
      // in `plan-remove-action.test.ts`.
      const configPath = join(tmpDir, "reponova.yml");
      writeFileSync(
        configPath,
        "output: out\nrepos:\n  - name: x\n    path: .\n\nplugins:\n  fake-lang:\n    package: \"@fake/lang-test\"\n    enabled: true\n",
      );

      const result = run("lang remove fake-lang --config-only", tmpDir);
      expect(result.exitCode).toBe(0);
      const content = readFileSync(configPath, "utf-8");
      expect(content).not.toContain("fake-lang:");
    });
  });

  describe("lang list", () => {
    it("should show built-in markdown", () => {
      const result = run("lang list", tmpDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("markdown");
      expect(result.stdout).toContain(".md");
    });

    it("should show declared plugins with extensions when importable", () => {
      const configPath = join(tmpDir, "reponova.yml");
      writeFileSync(configPath, "output: out\nrepos:\n  - name: x\n    path: .\n\nplugins:\n  python:\n    enabled: true\n");

      const result = run("lang list", tmpDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("python");
      // Plugin is linked in reponova's node_modules so it should be importable
      expect(result.stdout).toContain(".py");
    });

    it("should show no plugins when config has empty plugins section", () => {
      const configPath = join(tmpDir, "reponova.yml");
      writeFileSync(configPath, "output: out\nrepos:\n  - name: x\n    path: .\n\nplugins: {}\n");

      const result = run("lang list", tmpDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("No plugins declared");
    });

    it("should handle missing config gracefully", () => {
      const result = run("lang list", tmpDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("No reponova.yml found");
    });
  });
});
