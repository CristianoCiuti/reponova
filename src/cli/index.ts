import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import type { CommandModule } from "yargs";

/**
 * CLI entry point with lazy-loaded command handlers.
 *
 * Each command defines its yargs options inline (cheap — no I/O, no heavy deps).
 * The actual handler logic is loaded via dynamic import() only when the command
 * is invoked. This eliminates the startup cost of loading ALL dependencies
 * (graphology, sql.js WASM, undici, tree-sitter, etc.) for every CLI invocation.
 */

const mcpCommand: CommandModule = {
  command: "mcp",
  describe: "Start MCP server (stdio)",
  builder: (y) =>
    y.option("graph", {
      type: "string",
      describe: "Path to reponova-out/ directory",
    }),
  handler: async (argv) => {
    const { startMcpServer } = await import("../mcp/server.js");
    await startMcpServer({ graphPath: argv.graph as string | undefined });
  },
};

const buildCommand: CommandModule = {
  command: "build",
  describe: "Build unified graph from configured repos",
  builder: (y) =>
    y
      .option("config", { type: "string", describe: "Path to reponova.yml" })
      .option("force", { type: "boolean", describe: "Force rebuild even if up-to-date" })
      .option("target", { type: "string", describe: "Run only this phase + its transitive dependencies" })
      .option("start-after", { type: "string", describe: "Run only phases downstream of this phase" })
      .option("check", { type: "string", describe: "Check if a phase needs to run (exit 0 = up to date, exit 1 = needs run)" })
      .conflicts("target", "start-after")
      .conflicts("check", "target")
      .conflicts("check", "start-after")
      .conflicts("check", "force"),
  handler: async (argv) => {
    const { buildHandler } = await import("./build.js");
    await buildHandler(argv);
  },
};

const cacheCommand: CommandModule = {
  command: "cache",
  describe: "Inspect and manage phase cache",
  builder: (y) =>
    y
      .option("check", { type: "string", describe: "Check if a phase cache is fresh (exit 0 = fresh, exit 1 = stale)" })
      .option("seal", { type: "string", describe: "Manually seal a phase cache" })
      .option("invalidate", { type: "string", describe: "Invalidate a phase cache" })
      .option("status", { type: "boolean", describe: "Show cache status for all phases", default: false })
      .option("config", { type: "string", describe: "Path to reponova.yml" })
      .check((a) => {
        const ops = [a.check, a.seal, a.invalidate, a.status].filter(Boolean);
        if (ops.length === 0) throw new Error("Specify one of: --check, --seal, --invalidate, or --status");
        if (ops.length > 1) throw new Error("Only one operation at a time: --check, --seal, --invalidate, or --status");
        return true;
      }),
  handler: async (argv) => {
    const { cacheHandler } = await import("./cache.js");
    await cacheHandler(argv);
  },
};

const checkCommand: CommandModule = {
  command: "check",
  describe: "Verify graph status and system capabilities",
  builder: (y) =>
    y.option("graph", {
      type: "string",
      describe: "Path to reponova-out/ directory",
    }),
  handler: async (argv) => {
    const { checkHandler } = await import("./check.js");
    await checkHandler(argv);
  },
};

const installCommand: CommandModule = {
  command: "install",
  describe: "Install reponova MCP server and hooks for your editor",
  builder: (y) =>
    y
      .option("target", {
        type: "string",
        describe: "Editor/tool to configure",
        choices: ["opencode", "cursor", "claude", "vscode"] as const,
        demandOption: true,
      })
      .option("graph", {
        type: "string",
        describe: "Path to reponova-out/ directory (default: ./reponova-out)",
      }),
  handler: async (argv) => {
    const { installHandler } = await import("./install/index.js");
    await installHandler(argv);
  },
};

const modelsCommand: CommandModule = {
  command: "models <action> [name]",
  describe: "Manage downloaded AI models",
  builder: (y) =>
    y
      .positional("action", {
        type: "string",
        choices: ["status", "download", "remove", "clear"] as const,
        describe: "Action: status, download, remove, or clear",
      })
      .positional("name", {
        type: "string",
        describe: "Model name (required for remove)",
      })
      .option("config", { type: "string", describe: "Path to reponova.yml" })
      .option("cache-dir", { type: "string", describe: "Override model cache directory" }),
  handler: async (argv) => {
    const { modelsHandler } = await import("./models.js");
    await modelsHandler(argv);
  },
};

const enrichCommand: CommandModule = {
  command: "enrich",
  describe: "Run full intelligent enrichment (requires enrich.provider configured)",
  builder: (y) =>
    y.option("config", { type: "string", describe: "Path to reponova.yml" }),
  handler: async (argv) => {
    const { enrichHandler } = await import("./enrich.js");
    await enrichHandler(argv);
  },
};

const enrichMetricsCommand: CommandModule = {
  command: "enrich:metrics",
  describe: "Compute graph metrics and classify candidates for enrichment",
  builder: (y) =>
    y.option("config", { type: "string", describe: "Path to reponova.yml" }),
  handler: async (argv) => {
    const { enrichMetricsHandler } = await import("./enrich-metrics.js");
    await enrichMetricsHandler(argv);
  },
};

const enrichPrepareCommand: CommandModule = {
  command: "enrich:prepare <step>",
  describe: "Prepare input batches for an enrichment step (agent reads these)",
  builder: (y) =>
    y
      .positional("step", {
        type: "string",
        choices: ["descriptions", "profiles", "routing", "restructure", "updated-profiles"] as const,
        describe: "Step to prepare input batches for",
        demandOption: true,
      })
      .option("config", { type: "string", describe: "Path to reponova.yml" }),
  handler: async (argv) => {
    const { enrichPrepareHandler } = await import("./enrich-prepare.js");
    await enrichPrepareHandler(argv);
  },
};

const enrichMergeCommand: CommandModule = {
  command: "enrich:merge <step>",
  describe: "Merge batch output files into step's final file",
  builder: (y) =>
    y
      .positional("step", {
        type: "string",
        choices: ["descriptions", "profiles", "routing", "restructure", "updated-profiles"] as const,
        describe: "Step to merge",
        demandOption: true,
      })
      .option("config", { type: "string", describe: "Path to reponova.yml" }),
  handler: async (argv) => {
    const { enrichMergeHandler } = await import("./enrich-merge.js");
    await enrichMergeHandler(argv);
  },
};

const enrichApplyCommand: CommandModule = {
  command: "enrich:apply",
  describe: "Apply routing and restructure decisions to graph",
  builder: (y) =>
    y.option("config", { type: "string", describe: "Path to reponova.yml" }),
  handler: async (argv) => {
    const { enrichApplyHandler } = await import("./enrich-apply.js");
    await enrichApplyHandler(argv);
  },
};

const enrichFinalizeCommand: CommandModule = {
  command: "enrich:finalize",
  describe: "Assemble final output files from .enrich/ intermediates",
  builder: (y) =>
    y.option("config", { type: "string", describe: "Path to reponova.yml" }),
  handler: async (argv) => {
    const { enrichFinalizeHandler } = await import("./enrich-finalize.js");
    await enrichFinalizeHandler(argv);
  },
};

const langCommand: CommandModule = {
  command: "lang",
  describe: "Manage language plugins (add, remove, list)",
  builder: (y) => y.strictCommands(false).strict(false),
  handler: async (argv) => {
    const { langHandler } = await import("./lang.js");
    await langHandler(argv);
  },
};

yargs(hideBin(process.argv))
  .scriptName("reponova")
  .usage("$0 <command> [options]")
  .command(cacheCommand)
  .command(mcpCommand)
  .command(buildCommand)
  .command(checkCommand)
  .command(installCommand)
  .command(modelsCommand)
  .command(enrichCommand)
  .command(enrichMetricsCommand)
  .command(enrichPrepareCommand)
  .command(enrichMergeCommand)
  .command(enrichApplyCommand)
  .command(enrichFinalizeCommand)
  .command(langCommand)
  .demandCommand(1, "Please specify a command")
  .strict()
  .strictCommands()
  .help()
  .version()
  .parse();
