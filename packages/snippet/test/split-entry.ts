/**
 * The split build in the tests (docs/specs/faster-tag.md step 4). In the
 * `snippet-split` project (vitest.workspace.ts) a test's
 * `import("../src/index.ts")` lands here instead: the boot runs as a
 * customer's tag runs it (entry-boot.ts), and the core then arrives as the
 * script the boot inserted (`document.currentScript` is that element), a
 * separate module run that knows the boot only through the handoff. The
 * core's import takes a few turns, so an answer the test's fetch gives at
 * once comes in before the core, the order a slow phone sees; the single
 * file (the default project) covers the other order.
 */

await import("../src/entry-boot.ts");
const core = document.querySelector<HTMLScriptElement>('script[src*="/s/_core/"]');
if (core) {
  Object.defineProperty(document, "currentScript", { value: core, configurable: true });
  try {
    // Another specifier for the same file: the alias catches "../src/index.ts" only.
    await import("../src/./index.ts");
  } finally {
    Reflect.deleteProperty(document, "currentScript");
  }
}
export {};
