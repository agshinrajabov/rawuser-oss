import { resolve } from "node:path";
import { defineWorkspace } from "vitest/config";

/**
 * Two runs of the repo's tests:
 * - `default`: every package, as vitest.config.ts says;
 * - `snippet-split`: the snippet's tests again against the split build
 *   (docs/specs/faster-tag.md step 4): wherever a test boots the snippet
 *   with `import("../src/index.ts")`, the boot runs first and the core comes
 *   in as its own module, through the handoff (packages/snippet/test/split-entry.ts).
 */
export default defineWorkspace([
  { extends: "./vitest.config.ts", test: { name: "default" } },
  {
    // Not `extends`: a merged config adds the root's `include` to this one,
    // and the alias must never reach another package's `../src/index.ts`.
    test: {
      name: "snippet-split",
      include: ["packages/snippet/test/**/*.test.ts"],
      exclude: ["**/node_modules/**", "**/dist/**"],
      environment: "node",
      testTimeout: 30_000,
      setupFiles: ["./packages/snippet/test/setup-rich.ts"],
    },
    resolve: {
      alias: [
        {
          find: /^\.\.\/src\/index\.ts$/,
          replacement: resolve(__dirname, "packages/snippet/test/split-entry.ts"),
        },
      ],
    },
  },
]);
