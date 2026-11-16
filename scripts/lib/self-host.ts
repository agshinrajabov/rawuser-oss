/**
 * The installer's logic (`pnpm self-host`, scripts/self-host.ts): what to
 * make in a Cloudflare account, in which order, and what to write into the
 * two worker configs. Everything that touches the world comes in through
 * `Io`, so the whole install can be run in a test against a pretend
 * account.
 *
 * Safe to run again: each step first looks for what it would make.
 */

export const KV_TITLE = "rawuser-variants";
export const D1_NAME = "rawuser_db";
export const EDGE_WORKER = "rawuser-edge-production";
export const GENERATION_WORKER = "rawuser-generation-production";
export const DEFAULT_PAGES_PROJECT = "rawuser-dashboard";

export interface RunOptions {
  /** Folder to run in, from the repository root. */
  cwd?: string;
  /** Sent to the command's standard input (a secret's value). */
  input?: string;
  /** Extra environment for this command. */
  env?: Record<string, string>;
  /** The command talks to the person at the terminal itself. */
  interactive?: boolean;
}

export interface Io {
  /** Runs a command and gives back what it printed. Throws when it fails. */
  run(command: string, args: readonly string[], options?: RunOptions): Promise<string>;
  ask(question: string, fallback?: string): Promise<string>;
  /** A value that must not be shown or kept: typed without echo. */
  askSecret(question: string): Promise<string>;
  confirm(question: string): Promise<boolean>;
  log(line: string): void;
  readFile(path: string): string;
  writeFile(path: string, text: string): void;
  /** 32 random bytes, base64. */
  randomKey(): string;
  /** GET an address; the status and the body. */
  fetchText(url: string): Promise<{ status: number; body: string }>;
}

export interface Options {
  /** Print every step and change nothing. */
  dryRun: boolean;
  /**
   * A fresh checkout may take over storage it finds in the account under
   * the installer's names. Off by default: that storage may be a running
   * install's, and this checkout's workers would be deployed over it.
   */
  adopt?: boolean;
}

export interface Result {
  account: { id: string; name: string };
  kvId: string;
  d1Id: string;
  edgeOrigin: string;
  apiOrigin: string;
  dashboardOrigin: string;
  modelRoute: "endpoint" | "workers-ai";
}

// ---------------------------------------------------------------------------
// Reading wrangler's answers
// ---------------------------------------------------------------------------

/** The JSON a command printed, wherever its banner or warnings sit around it. */
export function jsonIn<T>(text: string): T {
  const starts = [text.indexOf("["), text.indexOf("{")].filter((i) => i !== -1);
  if (starts.length === 0) throw new Error("the command printed no JSON");
  const from = Math.min(...starts);
  const to = Math.max(text.lastIndexOf("]"), text.lastIndexOf("}"));
  return JSON.parse(text.slice(from, to + 1)) as T;
}

export interface Whoami {
  loggedIn: boolean;
  accounts?: Array<{ id: string; name: string }>;
}

/**
 * The account to install into: the only one, or the one CLOUDFLARE_ACCOUNT_ID
 * names. More than one and none named is an error that says how to choose.
 */
export function pickAccount(who: Whoami, wanted: string | undefined): { id: string; name: string } {
  if (!who.loggedIn) throw new Error("wrangler is not logged in. Run: npx wrangler login");
  const accounts = who.accounts ?? [];
  if (accounts.length === 0) throw new Error("this login can reach no Cloudflare account");
  if (wanted) {
    const named = accounts.find((a) => a.id === wanted);
    if (!named) throw new Error("CLOUDFLARE_ACCOUNT_ID names an account this login cannot reach");
    return named;
  }
  if (accounts.length > 1) {
    throw new Error(
      `this login reaches ${accounts.length} accounts. Choose one: CLOUDFLARE_ACCOUNT_ID=<id> pnpm self-host\n${accounts
        .map((a) => `  ${a.id}  ${a.name}`)
        .join("\n")}`,
    );
  }
  return accounts[0] as { id: string; name: string };
}

export const findKv = (list: Array<{ id: string; title: string }>): string | null =>
  list.find((n) => n.title === KV_TITLE)?.id ?? null;

export const findD1 = (list: Array<{ uuid: string; name: string }>): string | null =>
  list.find((d) => d.name === D1_NAME)?.uuid ?? null;

/** The project's own pages.dev host, as `wrangler pages project list --json` gives it. */
export function findPagesHost(list: Array<Record<string, string>>, project: string): string | null {
  const row = list.find((p) => p["Project Name"] === project);
  if (!row) return null;
  const hosts = (row["Project Domains"] ?? "").split(",").map((h) => h.trim());
  return hosts.find((h) => h.endsWith(".pages.dev")) ?? null;
}

/** The workers.dev address `wrangler deploy` printed for this worker. */
export function workersDevUrl(deployOutput: string, worker: string): string | null {
  const m = new RegExp(`https://${worker}\\.[a-z0-9-]+\\.workers\\.dev`).exec(deployOutput);
  return m ? m[0] : null;
}

/** The same account's address for another worker. */
export function siblingUrl(url: string, from: string, to: string): string {
  return url.replace(`https://${from}.`, `https://${to}.`);
}

// ---------------------------------------------------------------------------
// Writing the two configs
// ---------------------------------------------------------------------------

/** Both ids, wherever the file names them (the top level and production). */
export function withIds(toml: string, kvId: string, d1Id: string): string {
  let inKv = false;
  return toml
    .split("\n")
    .map((line) => {
      const head = /^\s*\[\[?([^\]]+)\]\]?\s*$/.exec(line);
      if (head) inKv = (head[1] as string).endsWith("kv_namespaces");
      if (inKv && /^\s*id\s*=/.test(line)) return `id = "${kvId}"`;
      if (/^\s*database_id\s*=/.test(line)) return `database_id = "${d1Id}"`;
      return line;
    })
    .join("\n");
}

/** The two ids a config names now; null for one that is still the template's placeholder. */
export function idsIn(toml: string): { kvId: string | null; d1Id: string | null } {
  let inKv = false;
  let kvId: string | null = null;
  let d1Id: string | null = null;
  for (const line of toml.split("\n")) {
    const head = /^\s*\[\[?([^\]]+)\]\]?\s*$/.exec(line);
    if (head) inKv = (head[1] as string).endsWith("kv_namespaces");
    const kv = inKv ? /^\s*id\s*=\s*"([^"]*)"/.exec(line) : null;
    const d1 = /^\s*database_id\s*=\s*"([^"]*)"/.exec(line);
    if (kv && !(kv[1] as string).startsWith("REPLACE_WITH_")) kvId = kv[1] as string;
    if (d1 && !(d1[1] as string).startsWith("REPLACE_WITH_")) d1Id = d1[1] as string;
  }
  return { kvId, d1Id };
}

/**
 * A checkout whose configs already name storage belongs to an install. The
 * installer goes on only when that storage is the one it finds under its
 * own names in this account: a second run of the same install. Anything
 * else (another account, or storage made by hand) it must not touch, or the
 * workers of a running install would be pointed at empty storage.
 */
export function tiedElsewhere(
  configs: readonly string[],
  found: { kvId: string | null; d1Id: string | null },
): string | null {
  for (const toml of configs) {
    const has = idsIn(toml);
    if (has.kvId && has.kvId !== found.kvId) return "a KV namespace";
    if (has.d1Id && has.d1Id !== found.d1Id) return "a D1 database";
  }
  return null;
}

/** A TOML string: single quotes when the value holds a double quote (a JSON value). */
function tomlString(value: string): string {
  if (value.includes("\n")) throw new Error("a var cannot hold a line break");
  if (!value.includes('"') && !value.includes("\\")) return `"${value}"`;
  if (!value.includes("'")) return `'${value}'`;
  return JSON.stringify(value);
}

/**
 * Sets vars in `[env.production.vars]`: over the line that sets it, else
 * over the comment that offers it, else at the section's end. Other lines
 * and every comment stay as they are.
 */
export function withProductionVars(toml: string, vars: Record<string, string>): string {
  const lines = toml.split("\n");
  const start = lines.findIndex((l) => l.trim() === "[env.production.vars]");
  if (start === -1) throw new Error("the config has no [env.production.vars] section");
  let end = lines.findIndex((l, i) => i > start && /^\s*\[/.test(l));
  if (end === -1) end = lines.length;
  const section = lines.slice(start + 1, end);
  for (const [key, value] of Object.entries(vars)) {
    const line = `${key} = ${tomlString(value)}`;
    const set = section.findIndex((l) => new RegExp(`^\\s*${key}\\s*=`).test(l));
    const offered = section.findIndex((l) => new RegExp(`^\\s*#\\s*${key}\\s*=`).test(l));
    if (set !== -1) section[set] = line;
    else if (offered !== -1) section[offered] = line;
    else {
      // Before the blank lines that close the section.
      let at = section.length;
      while (at > 0 && (section[at - 1] as string).trim() === "") at--;
      section.splice(at, 0, line);
    }
  }
  return [...lines.slice(0, start + 1), ...section, ...lines.slice(end)].join("\n");
}

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

export type ModelAnswers =
  | { route: "endpoint"; baseUrl: string; modelId: string; fallbackId: string; key: string }
  | { route: "workers-ai"; modelId: string };

/** What is wrong with the answers, as a sentence; null when nothing is. */
export function modelProblem(a: ModelAnswers): string | null {
  if (a.modelId.trim() === "") return "A model id is needed.";
  if (a.route === "workers-ai") return null;
  let url: URL;
  try {
    url = new URL(a.baseUrl);
  } catch {
    return "The endpoint must be a full address, for example https://models.example.com/v1";
  }
  if (url.protocol !== "https:") return "The endpoint must use https.";
  if (/\/chat\/completions\/?$/.test(url.pathname))
    return "Give the endpoint without /chat/completions at its end.";
  if (a.key.trim() === "") return "The endpoint needs its key.";
  return null;
}

/**
 * The vars of the chosen route. An empty value counts as unset in the
 * worker, so a second run that drops the fallback or changes the route
 * leaves nothing of the first behind.
 */
export function modelVars(a: ModelAnswers): Record<string, string> {
  if (a.route === "workers-ai")
    return { MODEL_ROUTE: "workers-ai", WORKERS_AI_MODEL: a.modelId.trim() };
  return {
    MODEL_ROUTE: "",
    MODEL_BASE_URL: a.baseUrl.trim().replace(/\/+$/, ""),
    MODEL_ID: a.modelId.trim(),
    MODEL_FALLBACK_ID: a.fallbackId.trim(),
  };
}

// ---------------------------------------------------------------------------
// The install
// ---------------------------------------------------------------------------

const EDGE_DIR = "packages/edge";
const GENERATION_DIR = "packages/generation";
const DASHBOARD_DIR = "packages/dashboard";
const WRANGLER = ["wrangler"] as const;

/** Runs the whole install, or prints it. Returns what it made, or null on a dry run or a "no". */
export async function selfHost(
  io: Io,
  options: Options,
  env: Record<string, string | undefined>,
): Promise<Result | null> {
  const dry = options.dryRun;
  const step = (n: number, text: string) => io.log(`\n${n}. ${text}`);
  const would = (text: string) => io.log(`   would ${text}`);
  const wrangler = (args: readonly string[], o: RunOptions = {}) =>
    io.run("npx", [...WRANGLER, ...args], { ...o, env: { ...accountEnv, ...o.env } });
  let accountEnv: Record<string, string> = {};

  step(1, "The Cloudflare account");
  const who = jsonIn<Whoami>(await io.run("npx", [...WRANGLER, "whoami", "--json"]));
  const account = pickAccount(who, env.CLOUDFLARE_ACCOUNT_ID);
  accountEnv = { CLOUDFLARE_ACCOUNT_ID: account.id };
  io.log(`   ${account.name} (${account.id})`);
  if (!dry && !(await io.confirm("   Install Rawuser into this account?"))) {
    io.log("   Nothing was changed.");
    return null;
  }

  step(2, "Storage: one KV namespace and one D1 database");
  let kvId = findKv(jsonIn(await wrangler(["kv", "namespace", "list"])));
  let d1Id = findD1(jsonIn(await wrangler(["d1", "list", "--json"])));
  const tied = tiedElsewhere(
    [EDGE_DIR, GENERATION_DIR].map((dir) => io.readFile(`${dir}/wrangler.toml`)),
    { kvId, d1Id },
  );
  if (tied) {
    throw new Error(
      `The two wrangler.toml files already name ${tied} that is not this account's ${KV_TITLE} or ${D1_NAME}.\nThis checkout runs another install, and the installer will not touch it. Use a fresh checkout, or put the REPLACE_WITH_ placeholders back.`,
    );
  }
  const fresh = [EDGE_DIR, GENERATION_DIR].every((dir) => {
    const has = idsIn(io.readFile(`${dir}/wrangler.toml`));
    return has.kvId === null && has.d1Id === null;
  });
  if (fresh && (kvId || d1Id) && !options.adopt) {
    throw new Error(
      `This account already holds ${[kvId ? `the KV namespace ${KV_TITLE}` : "", d1Id ? `the D1 database ${D1_NAME}` : ""].filter(Boolean).join(" and ")}, and this checkout was not installed from it.\nGoing on would deploy this checkout's workers over an install that may be running. If it is yours and you mean to take it over: pnpm self-host --adopt`,
    );
  }
  if (kvId) io.log(`   the KV namespace ${KV_TITLE} is there`);
  else if (dry) would(`create the KV namespace ${KV_TITLE}`);
  else {
    await wrangler(["kv", "namespace", "create", KV_TITLE]);
    kvId = findKv(jsonIn(await wrangler(["kv", "namespace", "list"])));
    if (!kvId) throw new Error("the KV namespace was not made");
    io.log(`   made the KV namespace ${KV_TITLE}`);
  }
  if (d1Id) io.log(`   the D1 database ${D1_NAME} is there`);
  else if (dry) would(`create the D1 database ${D1_NAME}`);
  else {
    const eu = await io.confirm("   Keep the database inside the European Union?");
    await wrangler(["d1", "create", D1_NAME, ...(eu ? ["--jurisdiction", "eu"] : [])]);
    d1Id = findD1(jsonIn(await wrangler(["d1", "list", "--json"])));
    if (!d1Id) throw new Error("the D1 database was not made");
    io.log(`   made the D1 database ${D1_NAME}`);
  }

  step(3, "The dashboard's Pages project");
  const project = dry
    ? DEFAULT_PAGES_PROJECT
    : (await io.ask("   Its name", DEFAULT_PAGES_PROJECT)).trim() || DEFAULT_PAGES_PROJECT;
  if (!/^[a-z0-9][a-z0-9-]{0,56}$/.test(project))
    throw new Error("a Pages project name is lower-case letters, digits and dashes");
  const pagesList = () =>
    wrangler(["pages", "project", "list", "--json"]).then((t) =>
      findPagesHost(jsonIn<Array<Record<string, string>>>(t), project),
    );
  let pagesHost = await pagesList();
  if (pagesHost) io.log(`   the project ${project} is there`);
  else if (dry) would(`create the Pages project ${project}`);
  else {
    await wrangler(["pages", "project", "create", project, "--production-branch", "main"]);
    pagesHost = await pagesList();
    if (!pagesHost) throw new Error("the Pages project was not made");
    io.log(`   made the Pages project ${project}`);
  }

  step(4, "The model that writes the versions");
  let answers: ModelAnswers | null = null;
  if (dry) would("ask for the model route, its address and its key, and keep the key as a secret");
  else {
    for (;;) {
      const useBinding = await io.confirm(
        "   Use Workers AI in this account? (No: your own OpenAI-compatible endpoint)",
      );
      answers = useBinding
        ? { route: "workers-ai", modelId: await io.ask("   The Workers AI model id") }
        : {
            route: "endpoint",
            baseUrl: await io.ask("   The endpoint, without /chat/completions"),
            modelId: await io.ask("   The model id"),
            fallbackId: await io.ask("   A second model on the same endpoint, or nothing", ""),
            key: await io.askSecret(
              "   The endpoint's key (not shown, kept as a Cloudflare secret)",
            ),
          };
      const problem = modelProblem(answers);
      if (!problem) break;
      io.log(`   ${problem}`);
    }
  }

  if (dry) {
    step(5, "The configs, the database and the two workers");
    would("write both ids into packages/edge/wrangler.toml and packages/generation/wrangler.toml");
    would("build the snippet and deploy the edge worker");
    would("apply the migrations to the database");
    would("write this install's addresses and the model into the generation config and deploy it");
    would("keep the model key and a new two-step key as secrets of the generation worker");
    step(6, "The dashboard");
    would("build it against the two workers and deploy it to Pages");
    step(7, "The first sign-in");
    would("ask for an email and a password and make the first account");
    io.log("\nNothing was changed.");
    return null;
  }
  if (!kvId || !d1Id || !pagesHost || !answers) throw new Error("the install lost a step");
  const dashboardOrigin = `https://${pagesHost}`;

  step(5, "The configs, the database and the two workers");
  for (const dir of [EDGE_DIR, GENERATION_DIR]) {
    const path = `${dir}/wrangler.toml`;
    io.writeFile(path, withIds(io.readFile(path), kvId, d1Id));
  }
  io.log("   wrote both ids into the two configs");
  await io.run("pnpm", ["build:snippet:inline"]);
  const edgeOut = await wrangler(["deploy", "--env", "production"], {
    cwd: EDGE_DIR,
    interactive: true,
  });
  const edgeOrigin = workersDevUrl(edgeOut, EDGE_WORKER);
  if (!edgeOrigin)
    throw new Error("the edge worker deployed, but its workers.dev address was not printed");
  io.log(`   the edge worker answers at ${edgeOrigin}`);
  const apiOrigin = siblingUrl(edgeOrigin, EDGE_WORKER, GENERATION_WORKER);

  await wrangler(["d1", "migrations", "apply", D1_NAME, "--remote", "--env", "production"], {
    cwd: GENERATION_DIR,
    interactive: true,
  });
  io.log("   the database has its tables");

  const generationToml = `${GENERATION_DIR}/wrangler.toml`;
  io.writeFile(
    generationToml,
    withProductionVars(io.readFile(generationToml), {
      DASHBOARD_ORIGIN: dashboardOrigin,
      EDGE_ORIGIN: edgeOrigin,
      API_ORIGIN: apiOrigin,
      OWN_HOSTS: [edgeOrigin, apiOrigin].map((u) => new URL(u).host).join(","),
      ...modelVars(answers),
    }),
  );
  await wrangler(["deploy", "--env", "production"], { cwd: GENERATION_DIR, interactive: true });
  io.log(`   the generation worker answers at ${apiOrigin}`);

  const secret = (name: string, value: string) =>
    wrangler(["secret", "put", name, "--env", "production"], { cwd: GENERATION_DIR, input: value });
  if (answers.route === "endpoint") await secret("MODEL_API_KEY", answers.key);
  // A second run must not replace the key that already seals stored secrets.
  const have = jsonIn<Array<{ name: string }>>(
    await wrangler(["secret", "list", "--env", "production"], { cwd: GENERATION_DIR }),
  ).map((s) => s.name);
  if (!have.includes("MFA_ENCRYPTION_KEY")) await secret("MFA_ENCRYPTION_KEY", io.randomKey());
  io.log("   the secrets are in place");

  step(6, "The dashboard");
  await io.run("pnpm", ["--filter", "@rawuser/dashboard", "build"], {
    env: {
      NEXT_PUBLIC_ADMIN_API_ORIGIN: apiOrigin,
      NEXT_PUBLIC_EDGE_ORIGIN: edgeOrigin,
      NEXT_PUBLIC_APP_ORIGIN: dashboardOrigin,
    },
  });
  await wrangler(["pages", "deploy", "out", "--project-name", project, "--branch", "main"], {
    cwd: DASHBOARD_DIR,
  });
  io.log(`   the dashboard is at ${dashboardOrigin}`);

  step(7, "The first sign-in");
  await io.run("npx", ["tsx", "scripts/create-superadmin.ts"], {
    env: { ...accountEnv, D1_TARGET: "remote" },
    interactive: true,
  });

  step(8, "A look at what is running");
  const edge = await io.fetchText(`${edgeOrigin}/health`);
  const api = await io.fetchText(`${apiOrigin}/health`);
  io.log(`   edge /health: ${edge.status}`);
  io.log(`   generation /health: ${api.status} ${api.body.trim()}`);
  if (edge.status !== 200 || api.status !== 200)
    io.log(
      "   A worker did not answer 200 yet. A first deploy can take a minute; open the address again.",
    );
  else if (!api.body.includes('"modelConfigured":true'))
    io.log(
      "   The generation worker does not see its model yet. Check the model values in its config.",
    );

  io.log(`
Done.
  Dashboard   ${dashboardOrigin}
  API         ${apiOrigin}
  Visitors    ${edgeOrigin}

Sign in to the dashboard, add your site, and it gives you the tag to paste.
This install talks to your Cloudflare account and your model, and to nobody else.`);
  return { account, kvId, d1Id, edgeOrigin, apiOrigin, dashboardOrigin, modelRoute: answers.route };
}
