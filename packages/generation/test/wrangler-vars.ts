/**
 * The two workers' wrangler.toml files, as the tests read them: the
 * production routes, the worker names and the production vars. Text only,
 * so a file with no production section reads as empty lists.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(__dirname, "../..");

export const EDGE_TOML = readFileSync(resolve(root, "edge/wrangler.toml"), "utf8");
export const GENERATION_TOML = readFileSync(resolve(root, "generation/wrangler.toml"), "utf8");

/** The custom domains a file routes to its worker. */
export function routes(toml: string): string[] {
  return [...toml.matchAll(/^\s*pattern\s*=\s*"([^"]+)"/gm)].map((m) =>
    (m[1] as string).replace(/\/\*$/, "").replace(/^\*\./, ""),
  );
}

/** The worker's name, and its name in each environment the file declares. */
export function workerNames(toml: string): string[] {
  const name = /^name\s*=\s*"([^"]+)"/m.exec(toml)?.[1] as string;
  const envs = [...toml.matchAll(/^\[env\.([a-z0-9_-]+)\]/gm)].map((m) => m[1] as string);
  return [name, ...envs.map((e) => `${name}-${e}`)];
}

/** `[env.production.vars]` as an env object: the string values, quoted either way. */
export function productionVars(toml: string): Record<string, string> {
  // The header on its own line: a comment may name the section too.
  const header = /^\[env\.production\.vars\]\s*$/m.exec(toml);
  if (!header) return {};
  const rest = toml.slice(header.index + header[0].length);
  const end = rest.search(/^\[/m);
  const section = end < 0 ? rest : rest.slice(0, end);
  const vars: Record<string, string> = {};
  for (const m of section.matchAll(/^([A-Z][A-Z0-9_]*)\s*=\s*(?:"([^"]*)"|'([^']*)')\s*$/gm)) {
    vars[m[1] as string] = m[2] ?? m[3] ?? "";
  }
  return vars;
}
