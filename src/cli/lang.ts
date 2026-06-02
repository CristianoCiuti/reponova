/**
 * CLI: `reponova lang` — manage language plugins.
 *
 * Commands:
 *   reponova lang add <name>      Install @reponova/lang-<name>
 *   reponova lang remove <name>   Uninstall @reponova/lang-<name>
 *   reponova lang list            List installed language plugins
 */
import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveNodeModulesDir } from "../plugin/discovery.js";

export async function langHandler(argv: Record<string, unknown>): Promise<void> {
  const positionals = argv._ as string[];
  // positionals[0] is "lang", [1] is action, [2] is name
  const action = positionals[1] as string | undefined;
  const name = positionals[2] as string | undefined;

  switch (action) {
    case "add":
      if (!name) {
        console.error("Usage: reponova lang add <name>");
        process.exit(1);
      }
      await langAdd(name);
      break;
    case "remove":
      if (!name) {
        console.error("Usage: reponova lang remove <name>");
        process.exit(1);
      }
      await langRemove(name);
      break;
    case "list":
      await langList();
      break;
    default:
      console.error("Usage: reponova lang <add|remove|list> [name]");
      process.exit(1);
  }
}

async function langAdd(name: string): Promise<void> {
  const nodeModulesDir = resolveNodeModulesDir();
  if (!nodeModulesDir) {
    console.error("Could not resolve node_modules directory. Is reponova installed?");
    process.exit(1);
  }

  const pkg = `@reponova/lang-${name}`;
  console.log(`Installing ${pkg}...`);

  try {
    execSync(`npm install ${pkg}`, { cwd: nodeModulesDir, stdio: "inherit" });
  } catch {
    console.error(`Failed to install ${pkg}`);
    process.exit(1);
  }

  // Verify installation
  const pkgDir = join(nodeModulesDir, "@reponova", `lang-${name}`);
  if (!existsSync(pkgDir)) {
    console.error(`Installation succeeded but package not found at ${pkgDir}`);
    process.exit(1);
  }

  const pkgJson = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf-8"));
  const extensions = (pkgJson.reponova?.extensions as string[]) ?? [];
  console.log(`✓ Installed ${pkg} (extensions: ${extensions.join(", ")})`);
}

async function langRemove(name: string): Promise<void> {
  const nodeModulesDir = resolveNodeModulesDir();
  if (!nodeModulesDir) {
    console.error("Could not resolve node_modules directory. Is reponova installed?");
    process.exit(1);
  }

  const pkg = `@reponova/lang-${name}`;
  console.log(`Removing ${pkg}...`);

  try {
    execSync(`npm uninstall ${pkg}`, { cwd: nodeModulesDir, stdio: "inherit" });
  } catch {
    console.error(`Failed to remove ${pkg}`);
    process.exit(1);
  }

  console.log(`✓ Removed ${pkg}`);
}

async function langList(): Promise<void> {
  const nodeModulesDir = resolveNodeModulesDir();
  if (!nodeModulesDir) {
    console.log("No node_modules found. No plugins installed.");
    return;
  }

  const scopeDir = join(nodeModulesDir, "@reponova");
  if (!existsSync(scopeDir)) {
    console.log("No language plugins installed.");
    console.log("\nBuilt-in:");
    console.log("  markdown   .md");
    return;
  }

  const entries = readdirSync(scopeDir).filter((e) => e.startsWith("lang-"));
  const plugins: Array<{ id: string; extensions: string; pkg: string; mode: string }> = [];

  for (const entry of entries) {
    const pkgJsonPath = join(scopeDir, entry, "package.json");
    if (!existsSync(pkgJsonPath)) continue;

    try {
      const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
      const meta = pkgJson.reponova as Record<string, unknown> | undefined;
      if (meta?.type !== "language") continue;

      const id = (meta.id as string) ?? entry.replace("lang-", "");
      const extensions = ((meta.extensions as string[]) ?? []).join(", ");
      const version = (pkgJson.version as string) ?? "?";
      const hasGrammar = !!meta.grammar;

      plugins.push({
        id,
        extensions,
        pkg: `@reponova/${entry}@${version}`,
        mode: hasGrammar ? "tree-sitter" : "regex",
      });
    } catch { /* skip malformed */ }
  }

  if (plugins.length > 0) {
    console.log("Installed languages:");
    const maxId = Math.max(...plugins.map((p) => p.id.length));
    const maxExt = Math.max(...plugins.map((p) => p.extensions.length));
    for (const p of plugins) {
      const idPad = p.id.padEnd(maxId + 2);
      const extPad = p.extensions.padEnd(maxExt + 4);
      console.log(`  ${idPad}${extPad}${p.pkg}    ${p.mode}`);
    }
  } else {
    console.log("No language plugins installed.");
  }

  console.log("\nBuilt-in:");
  console.log("  markdown   .md");
}
