import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 30000,
    setupFiles: ["tests/setup.ts"],
  },
  resolve: {
    alias: {
      "@reponova/lang-python": resolve("node_modules/@reponova/lang-python/dist/index.js"),
      "@reponova/lang-plantuml": resolve("node_modules/@reponova/lang-plantuml/dist/index.js"),
      "@reponova/lang-svg": resolve("node_modules/@reponova/lang-svg/dist/index.js"),
    },
  },
});
