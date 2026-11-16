import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(__dirname, "packages/dashboard/src"),
    },
  },
  // Components are .tsx with the automatic runtime (Next and React 17+): a
  // test that renders one needs no `import React`.
  esbuild: { jsx: "automatic" },
  test: {
    include: ["packages/**/*.test.ts", "scripts/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.wrangler/**", "**/.bundle/**"],
    environment: "node",
    testTimeout: 30_000,
    // The snippet's rich writers (/rich.js) for the snippet's tests only.
    setupFiles: ["./packages/snippet/test/setup-rich.ts"],
  },
});
