/**
 * The whole of it on one machine (docs/specs/run-anywhere.md): the two
 * workers as they are, over SQLite files, behind plain listeners. Nothing
 * here is Cloudflare's and nothing is stood in for but the model.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../src/d1.ts";
import { type Running, settingsFrom, start, workerVars } from "../src/main.ts";
import { setFirstUser } from "../src/user.ts";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/141.0 Safari/537.36";

describe("an install on a plain server", () => {
  let dir = "";
  let running: Running;
  let edge = "";
  let api = "";
  let site = "";
  const log: string[] = [];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "rawuser-server-"));
    writeFileSync(join(dir, "index.html"), "<h1>dashboard</h1>");
    running = await start(
      {
        DATA_DIR: join(dir, "data"),
        DASHBOARD_DIR: dir,
        HOST: "127.0.0.1",
        EDGE_PORT: "0",
        API_PORT: "0",
        DASHBOARD_PORT: "0",
        DASHBOARD_ORIGIN: "http://dash.site.example",
        EDGE_ORIGIN: "http://edge.site.example",
        // A shell's own names must not reach a worker.
        PATH: "/usr/bin",
        npm_config_user_agent: "pnpm",
      },
      (l) => log.push(l),
    );
    edge = `http://127.0.0.1:${running.ports.edge}`;
    api = `http://127.0.0.1:${running.ports.api}`;
    site = `http://127.0.0.1:${running.ports.dashboard}`;
  }, 60_000);

  afterAll(async () => {
    await running.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("starts: the database made from the migrations, three listeners, the dashboard's files", async () => {
    expect(log.some((l) => /applied \d+ migration/.test(l))).toBe(true);
    expect((await fetch(`${edge}/health`)).status).toBe(200);
    const health = await (await fetch(`${api}/health`)).json();
    expect(health).toMatchObject({ ok: true, env: "production", modelConfigured: false });
    expect(await (await fetch(`${site}/`)).text()).toBe("<h1>dashboard</h1>");
  });

  it("the API refuses a call with no sign-in", async () => {
    expect((await fetch(`${api}/admin/customers/list`)).status).toBe(401);
  });

  let token = "";
  it("the first sign-in works, and a wrong password does not", async () => {
    // As `pnpm server:user` does it: a second connection to the same file.
    const db = openDatabase(join(dir, "data", "main.sqlite"));
    expect(await setFirstUser(db, "owner@site.example", "a-long-password-1")).toBe("created");
    expect(await setFirstUser(db, "owner@site.example", "a-long-password-2")).toBe("updated");
    db.close();

    const wrong = await fetch(`${api}/admin/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@site.example", password: "a-long-password-1" }),
    });
    expect(wrong.status).toBe(401);
    const right = await fetch(`${api}/admin/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@site.example", password: "a-long-password-2" }),
    });
    expect(right.status).toBe(200);
    token = ((await right.json()) as { token: string }).token;
    expect(token.length).toBeGreaterThan(20);
  });

  it("a site is added through the API, and the edge serves its tag", async () => {
    const made = await fetch(`${api}/admin/customers/create`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Rawuser-Admin": token },
      body: JSON.stringify({ slug: "demo", domain: "demo.site.example", plan: "pilot" }),
    });
    expect(made.status, await made.clone().text()).toBeLessThan(300);
    const list = await fetch(`${api}/admin/customers/list`, {
      headers: { "X-Rawuser-Admin": token },
    });
    expect(JSON.stringify(await list.json())).toContain("demo.site.example");

    const tag = await fetch(`${edge}/s/demo.js`, { headers: { "user-agent": UA } });
    expect(tag.status).toBe(200);
    expect(await tag.text()).toContain('"c":"demo"');
  });

  it("a visit is classified at the edge: a ChatGPT link is a problem and an AI source", async () => {
    const res = await fetch(
      `${edge}/select?customer_id=demo&utm_source=chatgpt.com&path=/&lang=en-US&self_host=demo.site.example&visit=${"ab".repeat(16)}`,
      { headers: { "user-agent": UA } },
    );
    expect(res.status).toBe(200);
    const answer = (await res.json()) as { selection?: { intent_dim: string; source_dim: string } };
    expect(answer.selection).toMatchObject({ intent_dim: "problem", source_dim: "ai" });
  });

  it("a crawler gets no version", async () => {
    const res = await fetch(`${edge}/select?customer_id=demo&utm_source=chatgpt.com&path=/`, {
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      },
    });
    const answer = (await res.json()) as { variant: unknown };
    expect(answer.variant).toBeNull();
  });

  it("a page view is written to the file, with no address and no user agent in it", async () => {
    const res = await fetch(`${edge}/event?cid=demo`, {
      method: "POST",
      headers: { "content-type": "text/plain", "user-agent": UA },
      body: JSON.stringify({
        event_type: "no_signal_passthrough",
        page_path: "/pricing?token=abc",
        visit: "cd".repeat(16),
      }),
    });
    expect(res.status).toBe(202);
    // The write happens after the answer, as on Cloudflare.
    const db = openDatabase(join(dir, "data", "main.sqlite"));
    let rows: Record<string, unknown>[] = [];
    for (let i = 0; i < 40 && rows.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
      rows = db.prepare("SELECT * FROM events WHERE customer_id = 'demo'").all() as Record<
        string,
        unknown
      >[];
    }
    db.close();
    expect(rows).toHaveLength(1);
    const row = rows[0] as Record<string, unknown>;
    expect(row.event_type).toBe("no_signal_passthrough");
    expect(row.page_path).toBe("/pricing");
    expect(row.visit).toBe("cd".repeat(16));
    const text = JSON.stringify(row);
    expect(text).not.toContain("127.0.0.1");
    expect(text).not.toContain("Mozilla");
    expect(text).not.toContain("token=abc");
  });

  it("every schedule runs once on its minute, with no model set, and calls nobody but the site it serves", async () => {
    // Every request the process makes while its schedules run, by host.
    const asked: string[] = [];
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const host = new URL(typeof input === "string" || input instanceof URL ? input : input.url)
        .host;
      if (host.startsWith("127.0.0.1")) return real(input, init);
      asked.push(host);
      throw new TypeError("no network in a test");
    });
    try {
      const ran = running.tick(new Date("2026-01-05T06:00:00Z"));
      expect(ran).toHaveLength(4);
      await Promise.all(ran);
    } finally {
      vi.unstubAllGlobals();
    }
    // The hourly run reads the customer's own page for its tag and asks this
    // install's own edge whether it is up. Nothing else is asked.
    const own = ["demo.site.example", "edge.site.example"];
    expect([...new Set(asked)].filter((h) => !own.includes(h))).toEqual([]);
  }, 60_000);

  it("a worker is handed the settings and none of the shell's own names", () => {
    const vars = workerVars({
      MODEL_BASE_URL: "https://models.site.example/v1",
      MODEL_API_KEY: "k",
      PATH: "/usr/bin",
      HOME: "/root",
      npm_config_user_agent: "pnpm",
      DATA_DIR: "/data",
      EDGE_PORT: "1",
      TRUST_PROXY: "on",
      undefinedOne: undefined,
    });
    expect(vars).toEqual({ MODEL_BASE_URL: "https://models.site.example/v1", MODEL_API_KEY: "k" });
  });

  it("this machine's resolver answers for its own name, a made-up one, and one that cannot be asked", async () => {
    const { resolveSite } = await import("../src/resolve.ts");
    expect(await resolveSite("localhost")).toContain("127.0.0.1");
    // .invalid never resolves (RFC 2606): the name does not exist.
    expect(await resolveSite("no-such-host.invalid")).toEqual([]);
  });

  it("reads its settings, with defaults a first run can start on", () => {
    const s = settingsFrom({});
    expect([s.edgePort, s.apiPort, s.dashboardPort]).toEqual([8787, 8788, 8789]);
    expect(s.edgeOrigin).toBe("http://localhost:8787");
    expect(s.trustProxy).toBe(false);
    expect(s.countryHeader).toBeUndefined();
    const t = settingsFrom({
      EDGE_ORIGIN: "https://edge.site.example/",
      TRUST_PROXY: "on",
      COUNTRY_HEADER: "X-Country",
    });
    expect(t.edgeOrigin).toBe("https://edge.site.example");
    expect(t.trustProxy).toBe(true);
    expect(t.countryHeader).toBe("X-Country");
    expect(() => settingsFrom({ EDGE_PORT: "eighty" })).toThrow("EDGE_PORT");
  });
});

describe("the settings file", () => {
  it("sets a name where it is and adds it where it is not, and leaves the rest alone", async () => {
    const { withValues, valueIn } = await import("../src/cli-setup.ts");
    const before = "# mine\nEDGE_ORIGIN=http://old\nOTHER=kept\n";
    const after = withValues(before, { EDGE_ORIGIN: "https://edge.site.example", MODEL_ID: "m 1" });
    expect(after).toBe(
      '# mine\nEDGE_ORIGIN=https://edge.site.example\nOTHER=kept\nMODEL_ID="m 1"\n',
    );
    expect(valueIn(after, "MODEL_ID")).toBe("m 1");
    expect(valueIn(after, "OTHER")).toBe("kept");
    expect(valueIn(after, "MISSING")).toBeUndefined();
    expect(withValues("", { A: "1" })).toBe("A=1\n");
  });

  it("a build is needed when there is none, it was made for other addresses, or from other source", async () => {
    const { needsBuild, sourceHash } = await import("../src/build.ts");
    const dir = mkdtempSync(join(tmpdir(), "rawuser-build-"));
    const origins = {
      edgeOrigin: "https://edge.site.example",
      apiOrigin: "https://api.site.example",
      dashboardOrigin: "https://app.site.example",
    };
    expect(needsBuild(dir, origins, "s1")).toBe(true);
    writeFileSync(join(dir, "index.html"), "x");
    expect(needsBuild(dir, origins, "s1")).toBe(true);
    writeFileSync(join(dir, ".built-for.json"), JSON.stringify({ ...origins, source: "s1" }));
    expect(needsBuild(dir, origins, "s1")).toBe(false);
    expect(needsBuild(dir, { ...origins, apiOrigin: "https://other.site.example" }, "s1")).toBe(
      true,
    );
    // The code was updated: the same addresses, other source.
    expect(needsBuild(dir, origins, "s2")).toBe(true);
    // A mark from before the source was recorded counts as stale.
    writeFileSync(join(dir, ".built-for.json"), JSON.stringify(origins));
    expect(needsBuild(dir, origins, "s1")).toBe(true);
    rmSync(dir, { recursive: true, force: true });

    // The hash follows the source: the same twice, another when a file changes.
    const root = mkdtempSync(join(tmpdir(), "rawuser-src-"));
    mkdirSync(join(root, "packages/dashboard/src"), { recursive: true });
    writeFileSync(join(root, "packages/dashboard/package.json"), "{}");
    writeFileSync(join(root, "packages/dashboard/src/a.tsx"), "one");
    const first = sourceHash(root);
    expect(sourceHash(root)).toBe(first);
    writeFileSync(join(root, "packages/dashboard/src/a.tsx"), "two");
    expect(sourceHash(root)).not.toBe(first);
    rmSync(root, { recursive: true, force: true });
  });
});
