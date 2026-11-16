/**
 * Rawuser on one machine (docs/specs/run-anywhere.md).
 *
 *   pnpm server:start
 *
 * One process: the edge worker, the generation worker and the dashboard,
 * each on its own port, over one folder of SQLite files. The settings are
 * the ones the Cloudflare configs carry, read from the environment or from
 * a `.env` file beside where you start it.
 */

import { existsSync, mkdirSync } from "node:fs";
import type { Server } from "node:http";
import { join, resolve } from "node:path";
import edge from "../../edge/src/index.ts";
import generation from "../../generation/src/index.ts";
import { SCHEDULES, startCron } from "./cron.ts";
import { d1Over, openDatabase } from "./d1.ts";
import { kvOver } from "./kv.ts";
import { fixedWindow } from "./limit.ts";
import { migrate } from "./migrate.ts";
import { resolveSite } from "./resolve.ts";
import { type WorkerLike, makeContext, staticServer, workerServer } from "./serve.ts";

export interface Settings {
  dataDir: string;
  migrationsDir: string;
  dashboardDir: string;
  host: string;
  edgePort: number;
  apiPort: number;
  dashboardPort: number;
  edgeOrigin: string;
  apiOrigin: string;
  dashboardOrigin: string;
  trustProxy: boolean;
  countryHeader?: string;
}

const ROOT = resolve(import.meta.dirname, "../../..");

export function settingsFrom(env: Record<string, string | undefined>): Settings {
  const port = (name: string, fallback: number) => {
    const n = Number(env[name] ?? fallback);
    if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`${name} is not a port`);
    return n;
  };
  const edgePort = port("EDGE_PORT", 8787);
  const apiPort = port("API_PORT", 8788);
  const dashboardPort = port("DASHBOARD_PORT", 8789);
  const origin = (name: string, p: number) =>
    (env[name] ?? `http://localhost:${p}`).replace(/\/+$/, "");
  return {
    dataDir: resolve(env.DATA_DIR ?? join(ROOT, "data")),
    migrationsDir: resolve(env.MIGRATIONS_DIR ?? join(ROOT, "migrations")),
    dashboardDir: resolve(env.DASHBOARD_DIR ?? join(ROOT, "packages/dashboard/out")),
    host: env.HOST ?? "0.0.0.0",
    edgePort,
    apiPort,
    dashboardPort,
    edgeOrigin: origin("EDGE_ORIGIN", edgePort),
    apiOrigin: origin("API_ORIGIN", apiPort),
    dashboardOrigin: origin("DASHBOARD_ORIGIN", dashboardPort),
    trustProxy: (env.TRUST_PROXY ?? "").toLowerCase() === "on",
    ...(env.COUNTRY_HEADER ? { countryHeader: env.COUNTRY_HEADER } : {}),
  };
}

/** Settings that belong to this file alone and are not handed to a worker. */
const NOT_FOR_WORKERS = new Set([
  "DATA_DIR",
  "MIGRATIONS_DIR",
  "DASHBOARD_DIR",
  "HOST",
  "EDGE_PORT",
  "API_PORT",
  "DASHBOARD_PORT",
  "TRUST_PROXY",
  "COUNTRY_HEADER",
]);

/** The names a worker may read from the environment: the configs' own, in capitals. */
export function workerVars(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || NOT_FOR_WORKERS.has(name)) continue;
    // The shell's own names (PATH, HOME, npm_config_...) are not settings.
    if (
      !/^[A-Z][A-Z0-9_]*$/.test(name) ||
      /^(PATH|HOME|PWD|SHELL|USER|LANG|TERM|TMPDIR|OLDPWD|SHLVL|LOGNAME)$/.test(name)
    )
      continue;
    out[name] = value;
  }
  return out;
}

export interface Running {
  settings: Settings;
  ports: { edge: number; api: number; dashboard: number | null };
  /** One minute of the schedule, for a test or a hand run. */
  tick: (at: Date) => Promise<void>[];
  stop: () => Promise<void>;
}

const listen = (server: Server, port: number, host: string): Promise<number> =>
  new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(port, host, () => {
      const at = server.address();
      done(typeof at === "object" && at ? at.port : port);
    });
  });

const close = (server: Server): Promise<void> =>
  new Promise((done) => {
    server.close(() => done());
    server.closeAllConnections?.();
  });

export async function start(
  env: Record<string, string | undefined> = process.env,
  log: (line: string) => void = console.log,
): Promise<Running> {
  const settings = settingsFrom(env);
  mkdirSync(settings.dataDir, { recursive: true });

  const db = openDatabase(join(settings.dataDir, "main.sqlite"));
  const applied = migrate(db, settings.migrationsDir);
  if (applied.length > 0) log(`database: applied ${applied.length} migration(s)`);
  const kvDb = openDatabase(join(settings.dataDir, "kv.sqlite"));
  const kv = kvOver(kvDb);
  const d1 = d1Over(db);

  const vars = workerVars(env);
  const shared = {
    ENVIRONMENT: "production",
    ...vars,
    VARIANTS: kv,
    DB: d1,
  };
  // The same limits the Cloudflare configs set for the two bindings.
  const edgeEnv = {
    HOLDOUT_PERCENT: "0",
    PREVIEW_TOKEN: "",
    ...shared,
    EVENT_LIMITER: fixedWindow(600, 60),
  };
  const apiEnv = {
    MFA_REQUIRED_ROLES: "",
    AUDIT_INVITES: "off",
    ...shared,
    DASHBOARD_ORIGIN: settings.dashboardOrigin,
    EDGE_ORIGIN: settings.edgeOrigin,
    API_ORIGIN: settings.apiOrigin,
    OWN_HOSTS:
      vars.OWN_HOSTS ??
      [settings.edgeOrigin, settings.apiOrigin].map((u) => new URL(u).host).join(","),
    LOGIN_LIMITER: fixedWindow(10, 60),
    // The public-address check asks this machine's resolver, not one outside.
    SITE_RESOLVER: resolveSite,
  };

  const { ctx, idle } = makeContext();
  const request = {
    trustProxy: settings.trustProxy,
    ...(settings.countryHeader ? { countryHeader: settings.countryHeader } : {}),
  };
  const edgeServer = workerServer(edge as unknown as WorkerLike<typeof edgeEnv>, edgeEnv, ctx, {
    ...request,
    origin: settings.edgeOrigin,
  });
  const apiServer = workerServer(generation as unknown as WorkerLike<typeof apiEnv>, apiEnv, ctx, {
    ...request,
    origin: settings.apiOrigin,
  });
  const servers = [edgeServer, apiServer];
  const ports = {
    edge: await listen(edgeServer, settings.edgePort, settings.host),
    api: await listen(apiServer, settings.apiPort, settings.host),
    dashboard: null as number | null,
  };
  if (existsSync(join(settings.dashboardDir, "index.html"))) {
    const site = staticServer(settings.dashboardDir);
    servers.push(site);
    ports.dashboard = await listen(site, settings.dashboardPort, settings.host);
  } else {
    log(`dashboard: no build in ${settings.dashboardDir}; run pnpm server:setup`);
  }

  const scheduled = (
    generation as unknown as {
      scheduled: (e: unknown, env: unknown, ctx: ExecutionContext) => Promise<void>;
    }
  ).scheduled;
  const cron = startCron(
    (line, scheduledTime) => scheduled({ cron: line, scheduledTime }, apiEnv, ctx),
    SCHEDULES,
  );
  const sweep = setInterval(() => kv.sweep(), 10 * 60_000);
  sweep.unref();

  log(`edge       ${settings.edgeOrigin}  (port ${ports.edge})`);
  log(`api        ${settings.apiOrigin}  (port ${ports.api})`);
  if (ports.dashboard !== null)
    log(`dashboard  ${settings.dashboardOrigin}  (port ${ports.dashboard})`);
  log(`data       ${settings.dataDir}`);

  return {
    settings,
    ports,
    tick: cron.tick,
    stop: async () => {
      cron.stop();
      clearInterval(sweep);
      await Promise.all(servers.map(close));
      await idle();
      db.close();
      kvDb.close();
    },
  };
}

// Started as a program, not imported by a test.
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  if (existsSync(".env")) process.loadEnvFile(".env");
  start()
    .then((running) => {
      const stop = () => running.stop().then(() => process.exit(0));
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    })
    .catch((e) => {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    });
}
