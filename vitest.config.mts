import { defineConfig } from "vitest/config";

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
  },
  resolve: {
    extensions: [".ts", ".js"],
  },
});
