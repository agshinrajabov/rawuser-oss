import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  D1_NAME,
  DEFAULT_PAGES_PROJECT,
  EDGE_WORKER,
  GENERATION_WORKER,
  type Io,
  KV_TITLE,
  type RunOptions,
  findPagesHost,
  idsIn,
  jsonIn,
  modelProblem,
  pickAccount,
  selfHost,
  siblingUrl,
  tiedElsewhere,
  withIds,
  withProductionVars,
  workersDevUrl,
} from "./self-host.ts";

const ROOT = resolve(__dirname, "../..");
/**
 * The configs a fresh checkout starts with. Where this repository is the
 * one the public one is cut from, they sit in the folder the cut copies
 * them out of.
 */
const template = (worker: string) => {
  const beside = resolve(ROOT, `ops/public/overlay/packages/${worker}/wrangler.toml`);
  const own = resolve(ROOT, `packages/${worker}/wrangler.toml`);
  return readFileSync(existsSync(beside) ? beside : own, "utf8");
};

const KV_ID = "0123456789abcdef0123456789abcdef";
const D1_ID = "11111111-2222-3333-4444-555555555555";
const SUB = "my-team";
const BANNER = " ⛅️ wrangler 4.93.1\n──────────────\n";

/** A pretend Cloudflare account and terminal. */
function world(over: { accounts?: Array<{ id: string; name: string }>; answers?: string[] } = {}) {
  const state = {
    kv: [] as Array<{ id: string; title: string }>,
    d1: [] as Array<{ uuid: string; name: string }>,
    pages: [] as Array<Record<string, string>>,
    secrets: {} as Record<string, string>,
    deployed: [] as string[],
    migrated: 0,
    superadmin: 0,
    dashboardEnv: null as Record<string, string> | null,
    pagesDeploys: 0,
  };
  const files: Record<string, string> = {
    "packages/edge/wrangler.toml": template("edge"),
    "packages/generation/wrangler.toml": template("generation"),
  };
  const calls: string[] = [];
  const logs: string[] = [];
  const asked: string[] = [];
  const answers = [...(over.answers ?? [])];
  const next = (q: string) => {
    asked.push(q);
    if (answers.length === 0) throw new Error(`no answer left for: ${q}`);
    return answers.shift() as string;
  };

  const io: Io = {
    async run(command: string, args: readonly string[], o: RunOptions = {}) {
      const line = `${command} ${args.join(" ")}${o.cwd ? ` @${o.cwd}` : ""}`;
      calls.push(line);
      const a = args.join(" ");
      if (a === "wrangler whoami --json")
        return `${BANNER}${JSON.stringify({ loggedIn: true, accounts: over.accounts ?? [{ id: "acc1", name: "My account" }] })}`;
      if (a === "wrangler kv namespace list") return JSON.stringify(state.kv);
      if (a === `wrangler kv namespace create ${KV_TITLE}`) {
        state.kv.push({ id: KV_ID, title: KV_TITLE });
        return "created";
      }
      if (a === "wrangler d1 list --json") return JSON.stringify(state.d1);
      if (a.startsWith(`wrangler d1 create ${D1_NAME}`)) {
        state.d1.push({ uuid: D1_ID, name: D1_NAME });
        return "created";
      }
      if (a === "wrangler pages project list --json") return JSON.stringify(state.pages);
      if (a.startsWith("wrangler pages project create ")) {
        const name = args[4] as string;
        state.pages.push({ "Project Name": name, "Project Domains": `${name}-x1y.pages.dev` });
        return "created";
      }
      if (a === "wrangler deploy --env production") {
        const worker = o.cwd === "packages/edge" ? EDGE_WORKER : GENERATION_WORKER;
        state.deployed.push(worker);
        return `Uploaded ${worker}\nDeployed ${worker} triggers\n  https://${worker}.${SUB}.workers.dev\nCurrent Version ID: abc`;
      }
      if (a.startsWith("wrangler d1 migrations apply")) {
        state.migrated++;
        return "applied";
      }
      if (a === "wrangler secret list --env production")
        return JSON.stringify(
          Object.keys(state.secrets).map((name) => ({ name, type: "secret_text" })),
        );
      if (a.startsWith("wrangler secret put ")) {
        state.secrets[args[3] as string] = o.input as string;
        return "ok";
      }
      if (a.startsWith("wrangler pages deploy out")) {
        state.pagesDeploys++;
        return "deployed";
      }
      if (command === "pnpm" && a === "build:snippet:inline") return "built";
      if (command === "pnpm" && a === "--filter @rawuser/dashboard build") {
        state.dashboardEnv = o.env ?? null;
        return "built";
      }
      if (a === "tsx scripts/create-superadmin.ts") {
        expect(o.env?.D1_TARGET).toBe("remote");
        state.superadmin++;
        return "";
      }
      throw new Error(`the pretend account does not know: ${line}`);
    },
    ask: async (q, fallback) => {
      const v = next(q);
      return v === "" ? (fallback ?? "") : v;
    },
    askSecret: async (q) => next(q),
    confirm: async (q) => next(q) === "y",
    log: (l) => logs.push(l),
    readFile: (p) => files[p] as string,
    writeFile: (p, t) => {
      files[p] = t;
    },
    randomKey: () => "cmFuZG9tLWtleS1mb3ItdGhlLXR3by1zdGVwLXN0b3JlIQ==",
    fetchText: async (url) => ({
      status: 200,
      body: url.includes(GENERATION_WORKER) ? '{"ok":true,"modelConfigured":true}' : '{"ok":true}',
    }),
  };
  return { io, state, files, calls, logs, asked };
}

/** Answers for an install with one's own endpoint: yes, not EU, project name, not Workers AI, the four model values. */
const ENDPOINT = [
  "y",
  "n",
  "",
  "n",
  "https://models.example.com/v1/",
  "writer-1",
  "writer-2",
  "the-key-value-that-is-never-shown",
];

/** Where the pretend account serves the project of the default name. */
const DASHBOARD = `https://${DEFAULT_PAGES_PROJECT}-x1y.pages.dev`;

const productionVar = (toml: string, key: string): string | undefined =>
  new RegExp(`^${key} = ["'](.*)["']$`, "m").exec(
    toml.split("[env.production.vars]")[1] ?? "",
  )?.[1];

describe("reading wrangler", () => {
  it("finds the JSON under a banner", () => {
    expect(jsonIn(`${BANNER}[{"id":"a"}]\n`)).toEqual([{ id: "a" }]);
    expect(jsonIn(`${BANNER}{"loggedIn":true}`)).toEqual({ loggedIn: true });
    expect(() => jsonIn("no json here")).toThrow();
  });

  it("takes the only account, the named one among several, and says how to choose", () => {
    const two = {
      loggedIn: true,
      accounts: [
        { id: "a", name: "A" },
        { id: "b", name: "B" },
      ],
    };
    expect(pickAccount({ loggedIn: true, accounts: [{ id: "a", name: "A" }] }, undefined).id).toBe(
      "a",
    );
    expect(pickAccount(two, "b").name).toBe("B");
    expect(() => pickAccount(two, undefined)).toThrow(/CLOUDFLARE_ACCOUNT_ID=<id> pnpm self-host/);
    expect(() => pickAccount(two, "zzz")).toThrow(/cannot reach/);
    expect(() => pickAccount({ loggedIn: false }, undefined)).toThrow(/wrangler login/);
  });

  it("reads a worker's address from a deploy, and its sibling's from that", () => {
    const out = `Deployed ${EDGE_WORKER} triggers\n  https://${EDGE_WORKER}.${SUB}.workers.dev\n  edge.example.com (custom domain)`;
    const edge = workersDevUrl(out, EDGE_WORKER) as string;
    expect(edge).toBe(`https://${EDGE_WORKER}.${SUB}.workers.dev`);
    expect(siblingUrl(edge, EDGE_WORKER, GENERATION_WORKER)).toBe(
      `https://${GENERATION_WORKER}.${SUB}.workers.dev`,
    );
    expect(workersDevUrl("no address", EDGE_WORKER)).toBeNull();
  });

  it("finds a Pages project's own host among its domains", () => {
    const list = [
      { "Project Name": "dash", "Project Domains": "app.example.com, dash-7k2.pages.dev" },
    ];
    expect(findPagesHost(list, "dash")).toBe("dash-7k2.pages.dev");
    expect(findPagesHost(list, "other")).toBeNull();
  });
});

describe("writing the configs", () => {
  it.each(["edge", "generation"])("puts both ids in every place of the %s config", (worker) => {
    const out = withIds(template(worker), KV_ID, D1_ID);
    expect(out).not.toContain("REPLACE_WITH_");
    expect(out.match(new RegExp(`id = "${KV_ID}"`, "g"))).toHaveLength(2);
    expect(out.match(new RegExp(`database_id = "${D1_ID}"`, "g"))).toHaveLength(2);
    // Nothing else moved: the same lines, and a second pass changes nothing.
    expect(out.split("\n")).toHaveLength(template(worker).split("\n").length);
    expect(withIds(out, KV_ID, D1_ID)).toBe(out);
    // A rate limit's namespace_id is not a KV id.
    expect(out).toContain('namespace_id = "410');
  });

  it("sets a var over its line, over its comment, or at the section's end, once", () => {
    const toml = template("generation");
    const out = withProductionVars(toml, {
      DASHBOARD_ORIGIN: "https://dash.example.com",
      EDGE_ORIGIN: "https://edge.example.net",
      MODEL_EXTRA_BODY: '{"a":{"b":"c"}}',
    });
    expect(productionVar(out, "DASHBOARD_ORIGIN")).toBe("https://dash.example.com");
    expect(out.match(/^DASHBOARD_ORIGIN = /gm)).toHaveLength(2); // the dev one and production's
    expect(productionVar(out, "EDGE_ORIGIN")).toBe("https://edge.example.net");
    expect(out).not.toMatch(/^# EDGE_ORIGIN/m);
    expect(out).toContain(`MODEL_EXTRA_BODY = '{"a":{"b":"c"}}'`);
    // The comments around them stay, and the top-level vars are not touched.
    expect(out).toContain("# This install (src/install-config.ts).");
    expect(out.split("[env.production.vars]")[0]).toBe(toml.split("[env.production.vars]")[0]);
    expect(withProductionVars(out, { EDGE_ORIGIN: "https://edge.example.net" })).toBe(out);
    expect(() => withProductionVars("name = 1", { A: "b" })).toThrow();
  });
});

describe("the model answers", () => {
  it("wants an https endpoint without the path, a model id and a key", () => {
    const ok = {
      route: "endpoint",
      baseUrl: "https://m.example.com/v1",
      modelId: "w",
      fallbackId: "",
      key: "k",
    } as const;
    expect(modelProblem(ok)).toBeNull();
    expect(modelProblem({ ...ok, baseUrl: "m.example.com" })).toMatch(/full address/);
    expect(modelProblem({ ...ok, baseUrl: "http://m.example.com" })).toMatch(/https/);
    expect(modelProblem({ ...ok, baseUrl: "https://m.example.com/v1/chat/completions" })).toMatch(
      /without/,
    );
    expect(modelProblem({ ...ok, key: " " })).toMatch(/key/);
    expect(modelProblem({ ...ok, modelId: "" })).toMatch(/model id/);
    expect(modelProblem({ route: "workers-ai", modelId: "some-model" })).toBeNull();
  });
});

describe("an install into an empty account", () => {
  it("makes the storage, the project, both workers, the secrets and the first sign-in, in order", async () => {
    const w = world({ answers: ENDPOINT });
    const result = await selfHost(w.io, { dryRun: false }, {});
    expect(result).toEqual({
      account: { id: "acc1", name: "My account" },
      kvId: KV_ID,
      d1Id: D1_ID,
      edgeOrigin: `https://${EDGE_WORKER}.${SUB}.workers.dev`,
      apiOrigin: `https://${GENERATION_WORKER}.${SUB}.workers.dev`,
      dashboardOrigin: DASHBOARD,
      modelRoute: "endpoint",
    });
    const order = (needle: string) => w.calls.findIndex((c) => c.includes(needle));
    const steps = [
      "whoami --json",
      `kv namespace create ${KV_TITLE}`,
      `d1 create ${D1_NAME}`,
      `pages project create ${DEFAULT_PAGES_PROJECT}`,
      "build:snippet:inline",
      "deploy --env production @packages/edge",
      "d1 migrations apply",
      "deploy --env production @packages/generation",
      "secret put MODEL_API_KEY",
      "secret put MFA_ENCRYPTION_KEY",
      "@rawuser/dashboard build",
      `pages deploy out --project-name ${DEFAULT_PAGES_PROJECT} --branch main @packages/dashboard`,
      "tsx scripts/create-superadmin.ts",
    ].map(order);
    expect(steps.every((i) => i !== -1)).toBe(true);
    expect([...steps].sort((a, b) => a - b)).toEqual(steps);
    expect(w.state.deployed).toEqual([EDGE_WORKER, GENERATION_WORKER]);
    expect(w.state.migrated).toBe(1);
    expect(w.state.superadmin).toBe(1);
  });

  it("writes the ids into both configs and this install's own addresses into generation's", async () => {
    const w = world({ answers: ENDPOINT });
    await selfHost(w.io, { dryRun: false }, {});
    const edge = w.files["packages/edge/wrangler.toml"] as string;
    const gen = w.files["packages/generation/wrangler.toml"] as string;
    for (const f of [edge, gen]) expect(f).not.toContain("REPLACE_WITH_");
    expect(productionVar(gen, "EDGE_ORIGIN")).toBe(`https://${EDGE_WORKER}.${SUB}.workers.dev`);
    expect(productionVar(gen, "API_ORIGIN")).toBe(
      `https://${GENERATION_WORKER}.${SUB}.workers.dev`,
    );
    expect(productionVar(gen, "DASHBOARD_ORIGIN")).toBe(DASHBOARD);
    expect(productionVar(gen, "OWN_HOSTS")).toBe(
      `${EDGE_WORKER}.${SUB}.workers.dev,${GENERATION_WORKER}.${SUB}.workers.dev`,
    );
    expect(productionVar(gen, "MODEL_BASE_URL")).toBe("https://models.example.com/v1");
    expect(productionVar(gen, "MODEL_ID")).toBe("writer-1");
    expect(productionVar(gen, "MODEL_FALLBACK_ID")).toBe("writer-2");
    expect(productionVar(gen, "MODEL_ROUTE")).toBe("");
    // The dashboard is built against the same three addresses.
    expect(w.state.dashboardEnv).toEqual({
      NEXT_PUBLIC_ADMIN_API_ORIGIN: productionVar(gen, "API_ORIGIN"),
      NEXT_PUBLIC_EDGE_ORIGIN: productionVar(gen, "EDGE_ORIGIN"),
      NEXT_PUBLIC_APP_ORIGIN: productionVar(gen, "DASHBOARD_ORIGIN"),
    });
  });

  it("keeps the key as a secret and nowhere else", async () => {
    const w = world({ answers: ENDPOINT });
    await selfHost(w.io, { dryRun: false }, {});
    const KEY = "the-key-value-that-is-never-shown";
    expect(w.state.secrets.MODEL_API_KEY).toBe(KEY);
    expect(w.state.secrets.MFA_ENCRYPTION_KEY).toBe(w.io.randomKey());
    const everywhereElse = [...w.calls, ...w.logs, ...Object.values(w.files)].join("\n");
    expect(everywhereElse).not.toContain(KEY);
    expect(everywhereElse).not.toContain(w.io.randomKey());
  });

  it("ends by naming the three addresses and that it talks to nobody else", async () => {
    const w = world({ answers: ENDPOINT });
    await selfHost(w.io, { dryRun: false }, {});
    const end = w.logs.join("\n");
    expect(end).toContain(DASHBOARD);
    expect(end).toContain(`https://${GENERATION_WORKER}.${SUB}.workers.dev`);
    expect(end).toContain(`https://${EDGE_WORKER}.${SUB}.workers.dev`);
    expect(end).toContain("and to nobody else");
    expect(end).toContain('generation /health: 200 {"ok":true,"modelConfigured":true}');
  });
});

describe("the same install, run again", () => {
  it("makes nothing twice and does not replace the key that seals stored secrets", async () => {
    const w = world({
      answers: [
        ...ENDPOINT,
        "y",
        "",
        "n",
        "https://models.example.com/v1",
        "writer-1",
        "",
        "new-key",
      ],
    });
    await selfHost(w.io, { dryRun: false }, {});
    const first = { ...w.files };
    w.state.secrets.MFA_ENCRYPTION_KEY = "the-key-already-in-use";
    const before = w.calls.length;
    await selfHost(w.io, { dryRun: false }, {});
    const again = w.calls.slice(before).join("\n");
    expect(again).not.toMatch(/namespace create|d1 create|project create/);
    expect(again).not.toContain("secret put MFA_ENCRYPTION_KEY");
    expect(w.state.secrets.MFA_ENCRYPTION_KEY).toBe("the-key-already-in-use");
    expect(w.state.secrets.MODEL_API_KEY).toBe("new-key");
    expect(w.state.kv).toHaveLength(1);
    expect(w.state.d1).toHaveLength(1);
    expect(w.state.pages).toHaveLength(1);
    // The second run was not asked about the database's place: it exists.
    expect(w.asked.filter((q) => q.includes("European Union"))).toHaveLength(1);
    // The ids did not move, and the fallback the second run left out is gone.
    expect(w.files["packages/edge/wrangler.toml"]).toBe(first["packages/edge/wrangler.toml"]);
    const gen = w.files["packages/generation/wrangler.toml"] as string;
    expect(productionVar(gen, "MODEL_FALLBACK_ID")).toBe("");
    expect(gen.match(/^MODEL_FALLBACK_ID = /gm)).toHaveLength(1);
  });
});

describe("a checkout that already runs another install", () => {
  const OTHER = (toml: string) =>
    withIds(toml, "ffffffffffffffffffffffffffffffff", "99999999-0000-0000-0000-000000000000");

  it("is not touched: nothing is made, written or deployed", async () => {
    const w = world({ answers: ["y"] });
    w.files["packages/edge/wrangler.toml"] = OTHER(template("edge"));
    w.files["packages/generation/wrangler.toml"] = OTHER(template("generation"));
    const before = { ...w.files };
    await expect(selfHost(w.io, { dryRun: false }, {})).rejects.toThrow(/runs another install/);
    expect(w.files).toEqual(before);
    expect(w.calls.join("\n")).not.toMatch(/create|deploy|secret|migrations/);
  });

  it("nor on a dry run, and nor when only one of the two ids differs", async () => {
    const w = world();
    w.files["packages/generation/wrangler.toml"] = OTHER(template("generation"));
    await expect(selfHost(w.io, { dryRun: true }, {})).rejects.toThrow(/runs another install/);
    const half = world();
    half.state.kv.push({ id: KV_ID, title: KV_TITLE });
    half.files["packages/edge/wrangler.toml"] = withIds(
      template("edge"),
      KV_ID,
      "99999999-0000-0000-0000-000000000000",
    );
    await expect(selfHost(half.io, { dryRun: true }, {})).rejects.toThrow(/a D1 database/);
  });

  it("the same install's own ids are a second run, not another install", () => {
    const mine = withIds(template("edge"), KV_ID, D1_ID);
    expect(idsIn(template("edge"))).toEqual({ kvId: null, d1Id: null });
    expect(idsIn(mine)).toEqual({ kvId: KV_ID, d1Id: D1_ID });
    expect(tiedElsewhere([mine], { kvId: KV_ID, d1Id: D1_ID })).toBeNull();
    expect(tiedElsewhere([template("edge")], { kvId: null, d1Id: null })).toBeNull();
    expect(tiedElsewhere([mine], { kvId: null, d1Id: null })).toBe("a KV namespace");
  });
});

describe("a new checkout in an account that already holds an install", () => {
  it("stops before it makes or deploys anything, and says how to take the install over", async () => {
    const w = world({ answers: ["y"] });
    w.state.d1.push({ uuid: D1_ID, name: D1_NAME });
    await expect(selfHost(w.io, { dryRun: false }, {})).rejects.toThrow(/pnpm self-host --adopt/);
    expect(w.calls.join("\n")).not.toMatch(/create|deploy|secret|migrations/);
    expect(w.files["packages/edge/wrangler.toml"]).toBe(template("edge"));
    await expect(selfHost(world().io, { dryRun: true }, {})).resolves.toBeNull();
    const dry = world();
    dry.state.kv.push({ id: KV_ID, title: KV_TITLE });
    await expect(selfHost(dry.io, { dryRun: true }, {})).rejects.toThrow(
      /already holds the KV namespace/,
    );
  });

  it("with --adopt it binds to what is there and makes only what is missing", async () => {
    const w = world({ answers: ENDPOINT.filter((_, i) => i !== 1) });
    w.state.d1.push({ uuid: D1_ID, name: D1_NAME });
    const result = await selfHost(w.io, { dryRun: false, adopt: true }, {});
    expect(result?.d1Id).toBe(D1_ID);
    expect(w.calls.join("\n")).not.toContain("d1 create");
    expect(w.calls.join("\n")).toContain(`kv namespace create ${KV_TITLE}`);
  });
});

describe("the other ways through", () => {
  it("a dry run reads, says what it would do, and changes nothing", async () => {
    const w = world();
    expect(await selfHost(w.io, { dryRun: true }, {})).toBeNull();
    expect(w.calls.every((c) => /whoami|namespace list|d1 list|project list/.test(c))).toBe(true);
    expect(w.asked).toEqual([]);
    expect(w.files["packages/edge/wrangler.toml"]).toBe(template("edge"));
    const said = w.logs.join("\n");
    expect(said).toContain(`would create the KV namespace ${KV_TITLE}`);
    expect(said).toContain("would build the snippet and deploy the edge worker");
    expect(said).toContain("Nothing was changed.");
  });

  it("a no at the account changes nothing", async () => {
    const w = world({ answers: ["n"] });
    expect(await selfHost(w.io, { dryRun: false }, {})).toBeNull();
    expect(w.calls).toEqual(["npx wrangler whoami --json"]);
  });

  it("with several accounts it wants one named, and passes it to every command", async () => {
    const accounts = [
      { id: "acc1", name: "One" },
      { id: "acc2", name: "Two" },
    ];
    await expect(selfHost(world({ accounts }).io, { dryRun: true }, {})).rejects.toThrow(
      /Choose one/,
    );
    const w = world({ accounts });
    const seen: Array<string | undefined> = [];
    const run = w.io.run;
    w.io.run = (c, a, o) => {
      if (!a.includes("whoami")) seen.push(o?.env?.CLOUDFLARE_ACCOUNT_ID);
      return run(c, a, o);
    };
    await selfHost(w.io, { dryRun: true }, { CLOUDFLARE_ACCOUNT_ID: "acc2" });
    expect(seen.length).toBeGreaterThan(2);
    expect(new Set(seen)).toEqual(new Set(["acc2"]));
  });

  it("Workers AI needs no key: the route and the model, and no key secret", async () => {
    const w = world({ answers: ["y", "y", "my-dash", "y", "some-model-id"] });
    const result = await selfHost(w.io, { dryRun: false }, {});
    expect(result?.modelRoute).toBe("workers-ai");
    expect(result?.dashboardOrigin).toBe("https://my-dash-x1y.pages.dev");
    const gen = w.files["packages/generation/wrangler.toml"] as string;
    expect(productionVar(gen, "MODEL_ROUTE")).toBe("workers-ai");
    expect(productionVar(gen, "WORKERS_AI_MODEL")).toBe("some-model-id");
    expect(Object.keys(w.state.secrets)).toEqual(["MFA_ENCRYPTION_KEY"]);
    expect(w.calls.join("\n")).toContain("d1 create rawuser_db --jurisdiction eu");
  });

  it("asks for the model again until the answers can work", async () => {
    const w = world({
      answers: [
        "y",
        "n",
        "",
        "n",
        "http://plain.example.com",
        "m",
        "",
        "k",
        "n",
        "https://ok.example.com",
        "m",
        "",
        "k",
      ],
    });
    await selfHost(w.io, { dryRun: false }, {});
    expect(w.logs).toContain("   The endpoint must use https.");
    expect(
      productionVar(w.files["packages/generation/wrangler.toml"] as string, "MODEL_BASE_URL"),
    ).toBe("https://ok.example.com");
  });

  it("stops with what went wrong when a deploy prints no address", async () => {
    const w = world({ answers: ENDPOINT });
    const run = w.io.run;
    w.io.run = async (c, a, o) =>
      a.includes("deploy") && o?.cwd === "packages/edge" ? "Uploaded" : run(c, a, o);
    await expect(selfHost(w.io, { dryRun: false }, {})).rejects.toThrow(/workers\.dev address/);
  });
});
