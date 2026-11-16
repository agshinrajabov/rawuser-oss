/**
 * The rich writers registered for every snippet test (2026-09-30). The
 * template and lines writers moved to `/rich.js`; the core reaches them
 * through rich-api.ts only when rich.js has run, so the tests load it the
 * way a rich page does. Tests of the core without the writers delete
 * `globalThis.__rwx` themselves. Other packages' tests are left alone.
 */
import { expect } from "vitest";

const file = expect.getState().testPath ?? "";
if (/[\\/]packages[\\/]snippet[\\/]/.test(file)) await import("../src/rich.ts");
