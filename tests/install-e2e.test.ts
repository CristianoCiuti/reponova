import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

const CLI_PATH = resolve(__dirname, "..", "dist", "cli", "index.js");

function run(target: string, cwd: string): string {
  return execSync(`node "${CLI_PATH}" install --target ${target}`, {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
}

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(filePath, "utf-8"));
}

// ─── E2E: opencode ───────────────────────────────────────────────────────────

describe("install --target opencode (E2E)", () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = join(
      tmpdir(),
      `reponova-e2e-oc-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(sandbox, { recursive: true });
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("creates opencode.json from scratch", () => {
    run("opencode", sandbox);

    const configPath = join(sandbox, ".opencode", "opencode.json");
    expect(existsSync(configPath)).toBe(true);

    const config = readJson(configPath);
    const mcp = config.mcp as Record<string, unknown>;
    expect(mcp.reponova).toBeDefined();
    expect((mcp.reponova as Record<string, unknown>).type).toBe("local");

    const plugins = config.plugin as string[];
    expect(plugins).toContain(".opencode/plugins/reponova.js");
  });

  it("updates existing opencode.json preserving other keys", () => {
    const configDir = join(sandbox, ".opencode");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "opencode.json"),
      JSON.stringify({ theme: "dark", mcp: { other: { url: "http://x" } } }, null, 2),
    );

    run("opencode", sandbox);

    const config = readJson(join(configDir, "opencode.json"));
    expect(config.theme).toBe("dark");
    const mcp = config.mcp as Record<string, unknown>;
    expect(mcp.other).toEqual({ url: "http://x" });
    expect(mcp.reponova).toBeDefined();
  });

  it("uses existing opencode.jsonc and preserves comments", () => {
    const configDir = join(sandbox, ".opencode");
    mkdirSync(configDir, { recursive: true });
    const jsoncContent = [
      "{",
      "  // My custom comment that should survive",
      '  "theme": "dark"',
      "}",
    ].join("\n");
    writeFileSync(join(configDir, "opencode.jsonc"), jsoncContent);

    run("opencode", sandbox);

    // Should NOT create opencode.json — should update .jsonc
    expect(existsSync(join(configDir, "opencode.json"))).toBe(false);
    expect(existsSync(join(configDir, "opencode.jsonc"))).toBe(true);

    const result = readFileSync(join(configDir, "opencode.jsonc"), "utf-8");
    expect(result).toContain("// My custom comment that should survive");
    expect(result).toContain('"theme": "dark"');
    expect(result).toContain('"reponova"');
  });

  it("prefers opencode.jsonc when both .json and .jsonc exist", () => {
    const configDir = join(sandbox, ".opencode");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "opencode.json"),
      JSON.stringify({ source: "json" }, null, 2),
    );
    writeFileSync(
      join(configDir, "opencode.jsonc"),
      '{\n  // jsonc marker\n  "source": "jsonc"\n}',
    );

    run("opencode", sandbox);

    const jsoncResult = readFileSync(join(configDir, "opencode.jsonc"), "utf-8");
    expect(jsoncResult).toContain("// jsonc marker");
    expect(jsoncResult).toContain('"reponova"');

    // .json should be untouched
    const jsonResult = readJson(join(configDir, "opencode.json"));
    expect(jsonResult.source).toBe("json");
    expect((jsonResult as Record<string, unknown>).mcp).toBeUndefined();
  });

  it("installs reponova-mcp skill (not reponova) with correct frontmatter", () => {
    run("opencode", sandbox);

    // reponova-mcp/SKILL.md must exist
    const mcpSkillPath = join(sandbox, ".opencode", "skills", "reponova-mcp", "SKILL.md");
    expect(existsSync(mcpSkillPath)).toBe(true);

    const content = readFileSync(mcpSkillPath, "utf-8");
    expect(content).toContain("name: reponova-mcp");
    expect(content).toContain("graph_search");
    expect(content).toContain("graph_impact");
    expect(content).toContain("Tool Selection Guide");

    // Old path must NOT exist
    const oldSkillPath = join(sandbox, ".opencode", "skills", "reponova", "SKILL.md");
    expect(existsSync(oldSkillPath)).toBe(false);
  });

  it("installs reponova-enrich command skill", () => {
    run("opencode", sandbox);

    const enrichPath = join(sandbox, ".opencode", "skills", "reponova-enrich", "SKILL.md");
    expect(existsSync(enrichPath)).toBe(true);

    const content = readFileSync(enrichPath, "utf-8");
    expect(content).toContain("name: reponova-enrich");
    expect(content).toContain("enrich:metrics");
    expect(content).toContain("enrich:merge");
    expect(content).toContain("enrich:finalize");
  });

  it("plugin JS references reponova-mcp skill", () => {
    run("opencode", sandbox);

    const pluginPath = join(sandbox, ".opencode", "plugins", "reponova.js");
    expect(existsSync(pluginPath)).toBe(true);

    const content = readFileSync(pluginPath, "utf-8");
    expect(content).toContain("reponova-mcp");
    expect(content).toContain("graph_search");
  });

  it("writes reponova.yml config in .opencode/ directory", () => {
    run("opencode", sandbox);

    const configYml = join(sandbox, ".opencode", "reponova.yml");
    expect(existsSync(configYml)).toBe(true);

    const content = readFileSync(configYml, "utf-8");
    expect(content).toContain("output: ../reponova-out");
    expect(content).toContain("repos:");
  });
});

// ─── E2E: cursor ─────────────────────────────────────────────────────────────

describe("install --target cursor (E2E)", () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = join(
      tmpdir(),
      `reponova-e2e-cur-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(sandbox, { recursive: true });
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("creates mcp.json from scratch", () => {
    run("cursor", sandbox);

    const mcpPath = join(sandbox, ".cursor", "mcp.json");
    expect(existsSync(mcpPath)).toBe(true);

    const config = readJson(mcpPath);
    const servers = config.mcpServers as Record<string, unknown>;
    expect(servers.reponova).toBeDefined();
  });

  it("uses existing mcp.jsonc and preserves comments", () => {
    const cursorDir = join(sandbox, ".cursor");
    mkdirSync(cursorDir, { recursive: true });
    writeFileSync(
      join(cursorDir, "mcp.jsonc"),
      '{\n  // cursor config\n  "mcpServers": {}\n}',
    );

    run("cursor", sandbox);

    expect(existsSync(join(cursorDir, "mcp.json"))).toBe(false);

    const result = readFileSync(join(cursorDir, "mcp.jsonc"), "utf-8");
    expect(result).toContain("// cursor config");
    expect(result).toContain('"reponova"');
  });

  it("preserves existing MCP servers", () => {
    const cursorDir = join(sandbox, ".cursor");
    mkdirSync(cursorDir, { recursive: true });
    writeFileSync(
      join(cursorDir, "mcp.json"),
      JSON.stringify({ mcpServers: { existing: { command: "test" } } }, null, 2),
    );

    run("cursor", sandbox);

    const config = readJson(join(cursorDir, "mcp.json"));
    const servers = config.mcpServers as Record<string, unknown>;
    expect(servers.existing).toEqual({ command: "test" });
    expect(servers.reponova).toBeDefined();
  });

  it("installs reponova-mcp.mdc rule (alwaysApply) and reponova-enrich.mdc rule", () => {
    run("cursor", sandbox);

    // MCP rule
    const mcpRulePath = join(sandbox, ".cursor", "rules", "reponova-mcp.mdc");
    expect(existsSync(mcpRulePath)).toBe(true);

    const mcpContent = readFileSync(mcpRulePath, "utf-8");
    expect(mcpContent).toContain("alwaysApply: true");
    expect(mcpContent).toContain("graph_search");
    expect(mcpContent).toContain("Tool Selection Guide");

    // Enrich rule
    const enrichPath = join(sandbox, ".cursor", "rules", "reponova-enrich.mdc");
    expect(existsSync(enrichPath)).toBe(true);

    const enrichContent = readFileSync(enrichPath, "utf-8");
    expect(enrichContent).not.toContain("alwaysApply: true"); // must NOT be always-on
    expect(enrichContent).toContain("enrich:metrics");

    // Old filename must NOT exist
    const oldRulePath = join(sandbox, ".cursor", "rules", "reponova.mdc");
    expect(existsSync(oldRulePath)).toBe(false);
  });
});

// ─── E2E: claude ─────────────────────────────────────────────────────────────

describe("install --target claude (E2E)", () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = join(
      tmpdir(),
      `reponova-e2e-cl-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(sandbox, { recursive: true });
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("creates settings.json from scratch with hooks", () => {
    run("claude", sandbox);

    const settingsPath = join(sandbox, ".claude", "settings.json");
    expect(existsSync(settingsPath)).toBe(true);

    const settings = readJson(settingsPath);
    const hooks = settings.hooks as Record<string, unknown[]>;
    expect(hooks.PreToolUse).toBeDefined();
    expect(hooks.PreToolUse.length).toBe(1);
  });

  it("uses existing settings.jsonc and preserves comments", () => {
    const claudeDir = join(sandbox, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, "settings.jsonc"),
      '{\n  // claude user settings\n  "allowedTools": ["bash"]\n}',
    );

    run("claude", sandbox);

    expect(existsSync(join(claudeDir, "settings.json"))).toBe(false);

    const result = readFileSync(join(claudeDir, "settings.jsonc"), "utf-8");
    expect(result).toContain("// claude user settings");
    expect(result).toContain('"allowedTools"');
    expect(result).toContain('"PreToolUse"');
  });

  it("preserves existing hooks while adding reponova", () => {
    const claudeDir = join(sandbox, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, "settings.json"),
      JSON.stringify(
        {
          hooks: {
            PreToolUse: [
              { matcher: "Write", hooks: [{ type: "command", command: "echo ok" }] },
            ],
          },
        },
        null,
        2,
      ),
    );

    run("claude", sandbox);

    const settings = readJson(join(claudeDir, "settings.json"));
    const hooks = settings.hooks as Record<string, unknown[]>;
    expect(hooks.PreToolUse.length).toBe(2);
    const matchers = hooks.PreToolUse.map((h: Record<string, unknown>) => h.matcher);
    expect(matchers).toContain("Write");
    expect(matchers).toContain("Bash");
  });

  it("replaces existing reponova hook (idempotent)", () => {
    run("claude", sandbox);
    run("claude", sandbox);

    const settings = readJson(join(sandbox, ".claude", "settings.json"));
    const hooks = settings.hooks as Record<string, unknown[]>;
    // Should only have 1 reponova hook, not 2
    const repnovaHooks = hooks.PreToolUse.filter(
      (h: Record<string, unknown>) =>
        JSON.stringify(h).includes("reponova"),
    );
    expect(repnovaHooks.length).toBe(1);
  });

  it("installs reponova-mcp skill (not reponova) and enrich command", () => {
    run("claude", sandbox);

    // MCP skill
    const mcpSkillPath = join(sandbox, ".claude", "skills", "reponova-mcp", "SKILL.md");
    expect(existsSync(mcpSkillPath)).toBe(true);

    const mcpContent = readFileSync(mcpSkillPath, "utf-8");
    expect(mcpContent).toContain("name: reponova-mcp");
    expect(mcpContent).toContain("graph_search");

    // Enrich command
    const enrichPath = join(sandbox, ".claude", "skills", "reponova-enrich", "SKILL.md");
    expect(existsSync(enrichPath)).toBe(true);

    const enrichContent = readFileSync(enrichPath, "utf-8");
    expect(enrichContent).toContain("name: reponova-enrich");
    expect(enrichContent).toContain("enrich:metrics");

    // Old path must NOT exist
    const oldSkillPath = join(sandbox, ".claude", "skills", "reponova", "SKILL.md");
    expect(existsSync(oldSkillPath)).toBe(false);
  });

  it("hook context references reponova-mcp skill", () => {
    run("claude", sandbox);

    const settings = readJson(join(sandbox, ".claude", "settings.json"));
    const hooks = settings.hooks as Record<string, unknown[]>;
    const hookJson = JSON.stringify(hooks.PreToolUse);
    expect(hookJson).toContain("reponova-mcp");
  });
});

// ─── E2E: vscode ─────────────────────────────────────────────────────────────

describe("install --target vscode (E2E)", () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = join(
      tmpdir(),
      `reponova-e2e-vs-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(sandbox, { recursive: true });
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("creates mcp.json from scratch", () => {
    run("vscode", sandbox);

    const mcpPath = join(sandbox, ".vscode", "mcp.json");
    expect(existsSync(mcpPath)).toBe(true);

    const config = readJson(mcpPath);
    const servers = config.servers as Record<string, unknown>;
    expect(servers.reponova).toBeDefined();
    expect((servers.reponova as Record<string, unknown>).type).toBe("stdio");
  });

  it("uses existing mcp.jsonc and preserves comments", () => {
    const vscodeDir = join(sandbox, ".vscode");
    mkdirSync(vscodeDir, { recursive: true });
    writeFileSync(
      join(vscodeDir, "mcp.jsonc"),
      '{\n  // vscode mcp config\n  "servers": {}\n}',
    );

    run("vscode", sandbox);

    expect(existsSync(join(vscodeDir, "mcp.json"))).toBe(false);

    const result = readFileSync(join(vscodeDir, "mcp.jsonc"), "utf-8");
    expect(result).toContain("// vscode mcp config");
    expect(result).toContain('"reponova"');
  });

  it("preserves existing VS Code servers", () => {
    const vscodeDir = join(sandbox, ".vscode");
    mkdirSync(vscodeDir, { recursive: true });
    writeFileSync(
      join(vscodeDir, "mcp.json"),
      JSON.stringify({ servers: { other: { type: "sse", url: "http://x" } } }, null, 2),
    );

    run("vscode", sandbox);

    const config = readJson(join(vscodeDir, "mcp.json"));
    const servers = config.servers as Record<string, unknown>;
    expect(servers.other).toEqual({ type: "sse", url: "http://x" });
    expect(servers.reponova).toBeDefined();
  });

  it("copilot-instructions has both ## reponova (tool guide) and ## reponova enrich", () => {
    run("vscode", sandbox);

    const instructionsPath = join(sandbox, ".github", "copilot-instructions.md");
    expect(existsSync(instructionsPath)).toBe(true);

    const content = readFileSync(instructionsPath, "utf-8");

    // Has MCP tool guide section
    expect(content).toContain("## reponova");
    expect(content).toContain("Tool Selection Guide");
    expect(content).toContain("graph_search");
    expect(content).toContain("graph_impact");

    // Has enrich workflow section
    expect(content).toContain("## reponova enrich");
    expect(content).toContain("enrich:metrics");
    expect(content).toContain("enrich:finalize");
  });

  it("copilot-instructions is idempotent (skips if section exists)", () => {
    run("vscode", sandbox);
    const out1 = run("vscode", sandbox);

    // Should say "already present"
    expect(out1).toContain("already present");

    const instructionsPath = join(sandbox, ".github", "copilot-instructions.md");
    const content = readFileSync(instructionsPath, "utf-8");

    // Should only have ONE occurrence of the section header
    const matches = content.match(/## reponova\n/g);
    expect(matches).toHaveLength(1);
  });

  it("appends to existing copilot-instructions without overwriting", () => {
    const githubDir = join(sandbox, ".github");
    mkdirSync(githubDir, { recursive: true });
    writeFileSync(join(githubDir, "copilot-instructions.md"), "# Project\n\nExisting instructions.\n");

    run("vscode", sandbox);

    const content = readFileSync(join(githubDir, "copilot-instructions.md"), "utf-8");
    expect(content).toContain("# Project");
    expect(content).toContain("Existing instructions.");
    expect(content).toContain("## reponova");
  });
});
