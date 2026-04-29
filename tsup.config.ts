import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: ["esm"],
    target: "node18",
    platform: "node",
    dts: true,
    sourcemap: true,
    clean: true,
    splitting: false,
    shims: true,
    external: ["sql.js", "web-tree-sitter"],
  },
  {
    entry: { "cli/index": "src/cli/index.ts" },
    format: ["esm"],
    target: "node18",
    platform: "node",
    dts: false,
    sourcemap: true,
    clean: false,
    splitting: false,
    shims: true,
    banner: {
      js: "#!/usr/bin/env node",
    },
    external: ["sql.js", "web-tree-sitter"],
  },
]);
