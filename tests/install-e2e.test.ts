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

  it("installs reponova-enrich as a COMMAND (not a skill)", () => {
    run("opencode", sandbox);

    // Command must be in .opencode/commands/, NOT .opencode/skills/
    const enrichCommandPath = join(sandbox, ".opencode", "commands", "reponova-enrich.md");
    expect(existsSync(enrichCommandPath)).toBe(true);

    const content = readFileSync(enrichCommandPath, "utf-8");
    expect(content).toContain("description:");
    expect(content).toContain("enrich:metrics");
    expect(content).toContain("enrich:merge");
    expect(content).toContain("enrich:finalize");

    // Old wrong path must NOT exist
    const oldSkillPath = join(sandbox, ".opencode", "skills", "reponova-enrich", "SKILL.md");
    expect(existsSync(oldSkillPath)).toBe(false);
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

  it("installs reponova-mcp.mdc rule (alwaysApply) and reponova-enrich COMMAND", () => {
    run("cursor", sandbox);

    // MCP rule
    const mcpRulePath = join(sandbox, ".cursor", "rules", "reponova-mcp.mdc");
    expect(existsSync(mcpRulePath)).toBe(true);

    const mcpContent = readFileSync(mcpRulePath, "utf-8");
    expect(mcpContent).toContain("alwaysApply: true");
    expect(mcpContent).toContain("graph_search");
    expect(mcpContent).toContain("Tool Selection Guide");

    // Enrich COMMAND (in .cursor/commands/, NOT .cursor/rules/)
    const enrichCommandPath = join(sandbox, ".cursor", "commands", "reponova-enrich.md");
    expect(existsSync(enrichCommandPath)).toBe(true);

    const enrichContent = readFileSync(enrichCommandPath, "utf-8");
    expect(enrichContent).toContain("enrich:metrics");

    // Old wrong path must NOT exist
    const oldEnrichRule = join(sandbox, ".cursor", "rules", "reponova-enrich.mdc");
    expect(existsSync(oldEnrichRule)).toBe(false);

    // Old filename must NOT exist
    const oldRulePath = join(sandbox, ".cursor", "rules", "reponova.mdc");
    expect(existsSync(oldRulePath)).toBe(false);
  });

  it("cursor command has NO frontmatter (plain markdown)", () => {
    run("cursor", sandbox);

    const enrichCommandPath = join(sandbox, ".cursor", "commands", "reponova-enrich.md");
    const content = readFileSync(enrichCommandPath, "utf-8");

    // Cursor commands are plain markdown — no YAML frontmatter
    expect(content).not.toMatch(/^---/);
    expect(content).toContain("# reponova enrich");
  });

  it("writes reponova.yml config in .cursor/ directory", () => {
    run("cursor", sandbox);

    const configYml = join(sandbox, ".cursor", "reponova.yml");
    expect(existsSync(configYml)).toBe(true);

    const content = readFileSync(configYml, "utf-8");
    expect(content).toContain("output: ../reponova-out");
    expect(content).toContain("repos:");
  });

  it("is idempotent (re-run does not duplicate)", () => {
    run("cursor", sandbox);
    run("cursor", sandbox);

    // MCP config should still have only one reponova entry
    const mcpPath = join(sandbox, ".cursor", "mcp.json");
    const config = readJson(mcpPath);
    const servers = config.mcpServers as Record<string, unknown>;
    expect(servers.reponova).toBeDefined();

    // Rule should still exist and be valid
    const mcpRulePath = join(sandbox, ".cursor", "rules", "reponova-mcp.mdc");
    const content = readFileSync(mcpRulePath, "utf-8");
    expect(content).toContain("alwaysApply: true");
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

  it("writes reponova.yml config in .claude/ directory", () => {
    run("claude", sandbox);

    const configYml = join(sandbox, ".claude", "reponova.yml");
    expect(existsSync(configYml)).toBe(true);

    const content = readFileSync(configYml, "utf-8");
    expect(content).toContain("output: ../reponova-out");
    expect(content).toContain("repos:");
  });

  it("enrich skill has correct description for behavioral activation", () => {
    run("claude", sandbox);

    const enrichPath = join(sandbox, ".claude", "skills", "reponova-enrich", "SKILL.md");
    const content = readFileSync(enrichPath, "utf-8");

    // Description must mention invocation — this controls behavioral activation in Claude Code
    expect(content).toContain('Invoke with "/reponova-enrich"');
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

  it("installs MCP skill (auto-loaded) and enrich skill (command-only) in .github/skills/", () => {
    run("vscode", sandbox);

    // MCP skill — passive, auto-loaded
    const mcpSkillPath = join(sandbox, ".github", "skills", "reponova-mcp", "SKILL.md");
    expect(existsSync(mcpSkillPath)).toBe(true);

    const mcpContent = readFileSync(mcpSkillPath, "utf-8");
    expect(mcpContent).toContain("name: reponova-mcp");
    expect(mcpContent).toContain("user-invocable: false");
    expect(mcpContent).toContain("Tool Selection Guide");
    expect(mcpContent).toContain("graph_search");
    expect(mcpContent).toContain("graph_impact");

    // Enrich skill — command-only, NOT auto-loaded
    const enrichSkillPath = join(sandbox, ".github", "skills", "reponova-enrich", "SKILL.md");
    expect(existsSync(enrichSkillPath)).toBe(true);

    const enrichContent = readFileSync(enrichSkillPath, "utf-8");
    expect(enrichContent).toContain("name: reponova-enrich");
    expect(enrichContent).toContain("disable-model-invocation: true");
    expect(enrichContent).toContain("enrich:metrics");
    expect(enrichContent).toContain("enrich:finalize");

    // copilot-instructions.md must NOT be created
    const instructionsPath = join(sandbox, ".github", "copilot-instructions.md");
    expect(existsSync(instructionsPath)).toBe(false);
  });

  it("skill files are idempotent (overwritten on re-run)", () => {
    run("vscode", sandbox);
    run("vscode", sandbox);

    // Skills should still exist and be valid
    const mcpSkillPath = join(sandbox, ".github", "skills", "reponova-mcp", "SKILL.md");
    expect(existsSync(mcpSkillPath)).toBe(true);

    const content = readFileSync(mcpSkillPath, "utf-8");
    expect(content).toContain("name: reponova-mcp");
    expect(content).toContain("Tool Selection Guide");
  });

  it("does not touch existing copilot-instructions.md", () => {
    const githubDir = join(sandbox, ".github");
    mkdirSync(githubDir, { recursive: true });
    writeFileSync(join(githubDir, "copilot-instructions.md"), "# Project\n\nExisting instructions.\n");

    run("vscode", sandbox);

    // copilot-instructions should be untouched
    const content = readFileSync(join(githubDir, "copilot-instructions.md"), "utf-8");
    expect(content).toBe("# Project\n\nExisting instructions.\n");

    // Skills should exist separately
    const mcpSkillPath = join(sandbox, ".github", "skills", "reponova-mcp", "SKILL.md");
    expect(existsSync(mcpSkillPath)).toBe(true);
  });

  it("writes reponova.yml config in .vscode/ directory", () => {
    run("vscode", sandbox);

    const configYml = join(sandbox, ".vscode", "reponova.yml");
    expect(existsSync(configYml)).toBe(true);

    const content = readFileSync(configYml, "utf-8");
    expect(content).toContain("output: ../reponova-out");
    expect(content).toContain("repos:");
  });

  it("MCP skill does NOT have disable-model-invocation (should be auto-loaded)", () => {
    run("vscode", sandbox);

    const mcpSkillPath = join(sandbox, ".github", "skills", "reponova-mcp", "SKILL.md");
    const content = readFileSync(mcpSkillPath, "utf-8");

    // MCP skill must be auto-loadable — no disable-model-invocation
    expect(content).not.toContain("disable-model-invocation");
    // But not user-invocable (hidden from / menu)
    expect(content).toContain("user-invocable: false");
  });

  it("enrich skill is NOT auto-loaded (disable-model-invocation: true)", () => {
    run("vscode", sandbox);

    const enrichSkillPath = join(sandbox, ".github", "skills", "reponova-enrich", "SKILL.md");
    const content = readFileSync(enrichSkillPath, "utf-8");

    // Enrich skill is command-only — agent won't load it autonomously
    expect(content).toContain("disable-model-invocation: true");
    // But should NOT have user-invocable: false (it IS a slash command)
    expect(content).not.toContain("user-invocable: false");
  });
});
