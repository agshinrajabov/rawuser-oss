/**
 * Builds what an install on a server serves, for the addresses in its
 * settings. Run by `pnpm server:start` before the listeners open.
 */

import { existsSync } from "node:fs";
import { build } from "./build.ts";
import { settingsFrom } from "./main.ts";

if (existsSync(".env")) process.loadEnvFile(".env");
try {
  build(settingsFrom(process.env));
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
