/**
 * The dashboard is a static site that names the API and the edge by their
 * public addresses, so it is built for one install's addresses. This builds
 * it when it is not there, was built for other addresses, or was built from
 * other source (an update), and marks the build with both.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { Settings } from "./main.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const DASHBOARD = join(ROOT, "packages/dashboard");
const MARK = ".built-for.json";

export type Origins = Pick<Settings, "edgeOrigin" | "apiOrigin" | "dashboardOrigin">;

interface Mark extends Origins {
  /** A hash of the source the build was made from. */
  source: string;
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** One hash for what the dashboard is built from: its own source and the shared code it imports. */
export function sourceHash(root: string = ROOT): string {
  const dashboard = join(root, "packages/dashboard");
  const files = [
    ...walk(join(dashboard, "src")),
    ...walk(join(dashboard, "public")),
    ...walk(join(root, "packages/shared/src")),
    join(dashboard, "package.json"),
  ]
    .filter((p) => existsSync(p))
    .sort();
  const hash = createHash("sha256");
  for (const p of files) {
    hash.update(relative(root, p));
    hash.update("\0");
    hash.update(readFileSync(p));
  }
  return hash.digest("hex");
}

const markOf = (origins: Origins, source: string): Mark => ({
  edgeOrigin: origins.edgeOrigin,
  apiOrigin: origins.apiOrigin,
  dashboardOrigin: origins.dashboardOrigin,
  source,
});

/** Whether the build in `dir` is missing, was made for other addresses, or from other source. */
export function needsBuild(dir: string, origins: Origins, source: string): boolean {
  if (!existsSync(join(dir, "index.html")) || !existsSync(join(dir, MARK))) return true;
  try {
    return (
      JSON.stringify(JSON.parse(readFileSync(join(dir, MARK), "utf8"))) !==
      JSON.stringify(markOf(origins, source))
    );
  } catch {
    return true;
  }
}

function run(args: string[], env: Record<string, string> = {}): void {
  const r = spawnSync("pnpm", args, {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  if (r.status !== 0) throw new Error(`pnpm ${args.join(" ")} failed`);
}

/** Builds the script the edge serves and, if needed, the dashboard. */
export function build(settings: Settings, log: (line: string) => void = console.log): boolean {
  run(["build:snippet:inline"]);
  const source = existsSync(DASHBOARD) ? sourceHash() : "";
  if (!needsBuild(settings.dashboardDir, settings, source)) {
    log("dashboard: already built for these addresses");
    return false;
  }
  log("dashboard: building for these addresses (a minute or so)");
  run(["--filter", "@rawuser/dashboard", "build"], {
    NEXT_PUBLIC_ADMIN_API_ORIGIN: settings.apiOrigin,
    NEXT_PUBLIC_EDGE_ORIGIN: settings.edgeOrigin,
    NEXT_PUBLIC_APP_ORIGIN: settings.dashboardOrigin,
  });
  writeFileSync(join(settings.dashboardDir, MARK), `${JSON.stringify(markOf(settings, source))}\n`);
  return true;
}
