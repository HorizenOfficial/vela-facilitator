import { defineConfig } from "vitest/config";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    globalSetup: "./test/setup.ts",
    testTimeout: 60000,
    hookTimeout: 120000,
    globals: true,
    include: ["test/**/*.test.ts"],
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true, // All tests share the same Anvil instance
      },
    },
    reporters: ["verbose"],
    server: {
      deps: {
        // Inline the x402 package so vite bundler handles it (enables alias resolution)
        inline: ["@horizen/x402-private-vela-fixed"],
      },
    },
  },
  resolve: {
    extensions: [".ts", ".js"],
    alias: {
      // Replace browser-only vela-common-ts with a Node.js-compatible stub for tests
      "@horizen/vela-common-ts": path.resolve(
        __dirname,
        "test/__mocks__/vela-common-ts.ts"
      ),
    },
  },
});
