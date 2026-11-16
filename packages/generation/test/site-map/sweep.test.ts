/**
 * Site-shaped intents: the six-hourly sweep and the weekly fetch (§9,
 * privacy review condition 4), the write queue and the tuples of the served set
 * (§7.3), the endpoints of the Change dialog and the off switch (§8,
 * condition 5), and the re-read hooked on manifest_health.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleSiteMapGet,
  handleSiteMapSet,
  handleSiteMapWrite,
} from "../../src/admin/site-map.ts";
import { intentOfKvKey, queueCustomers } from "../../src/cron/regen-queue.ts";
import { fetchPageHtml } from "../../src/detect-elements.ts";
import { ensureInlineShapes, resetReads } from "../../src/inline-shape-backfill.ts";
import { fetcherUserAgent } from "../../src/install-config.ts";
import { OffHostRedirectError } from "../../src/lib/public-url.ts";
import { buildTuples } from "../../src/orchestrator.ts";
import { type SiteEnv, siteReadKey, siteRereadHook } from "../../src/site-map/run.ts";
import { DAY_MS, loadSiteState } from "../../src/site-map/store.ts";
import { runSiteMapSweep } from "../../src/site-map/weekly.ts";
import { makeKv, makeSqliteD1 } from "../admin/sqlite-d1.ts";
import { FETCHER_UA } from "../install-env.ts";
import { MODEL_ENV } from "../model-env.ts";

const NOW = Date.UTC(2026, 9, 5, 12);
const HOME = `<html lang="en"><body><nav><a href="/pricing">Pricing</a><a href="/work">Work</a></nav></body></html>`;

function setup() {
  const { d1, db } = makeSqliteD1();
  const add = (id: string, live: number | null, off = 0, domain = `${id}.test`) =>
    db
      .prepare(
        "INSERT INTO customers (id, slug, domain, status, created_at, live_at, site_map_off) VALUES (?, ?, ?, 'active', 1, ?, ?)",
      )
      .run(id, id, domain, live, off);
  const kv = makeKv();
  const env = { DB: d1, VARIANTS: kv, ...MODEL_ENV } as unknown as SiteEnv;
  return { env, db, kv, add };
}

describe("the weekly fetch (condition 4)", () => {
  it("fetches the recorded domain's homepage once for a live customer with the map on", async () => {
    const { env, db, kv, add } = setup();
    add("live", 1, 0, "https://www.live.test/some/page");
    add("off", 1, 1);
    add("draft", null);
    add("recent", 1);
    await kv.put(siteReadKey("recent"), "1");
    const fetchHtml = vi.fn(async () => HOME);
    const r = await runSiteMapSweep(env, NOW, fetchHtml);
    expect(fetchHtml).toHaveBeenCalledTimes(1);
    expect(fetchHtml).toHaveBeenCalledWith("https://www.live.test/", "www.live.test");
    expect(r.fetched).toBe(1);
    const paths = db.prepare("SELECT path, label FROM site_paths WHERE customer_id = 'live'").all();
    expect(paths).toEqual([
      { path: "/pricing", label: "Pricing" },
      { path: "/work", label: "Work" },
    ]);
    // The HTML is never kept: not in KV, not in D1.
    for (const v of kv.store.values()) expect(v).not.toContain("<nav>");
    const dump = JSON.stringify(db.prepare("SELECT * FROM customers").all());
    expect(dump).not.toContain("<nav>");
    expect(kv.store.has(siteReadKey("live"))).toBe(true);
  });

  it("a failed fetch waits a week, not six hours", async () => {
    const { env, kv, add } = setup();
    add("live", 1);
    const fetchHtml = vi.fn(async () => {
      throw new OffHostRedirectError();
    });
    const r = await runSiteMapSweep(env, NOW, fetchHtml);
    expect(r.failed).toBe(1);
    expect(kv.store.has(siteReadKey("live"))).toBe(true);
  });

  it("the default fetch is publicOnly, on the recorded host, cut on a redirect elsewhere", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        async () =>
          new Response(null, { status: 301, headers: { location: "https://evil.example/" } }),
      );
    await expect(
      fetchPageHtml("https://8.8.8.8/", {
        userAgent: FETCHER_UA,
        publicOnly: true,
        sameHostAs: "8.8.8.8",
      }),
    ).rejects.toBeInstanceOf(OffHostRedirectError);
    expect(spy).toHaveBeenCalledTimes(1);
    const init = spy.mock.calls[0]?.[1] as RequestInit;
    expect(init.redirect).toBe("manual");
    expect(new Headers(init.headers).get("user-agent")).toMatch(/^Rawuser\//);
    expect(new Headers(init.headers).get("cookie")).toBeNull();
    spy.mockRestore();
  });

  it("the daily re-read never follows a redirect to another host, without a DNS check", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        async () =>
          new Response(null, { status: 302, headers: { location: "https://elsewhere.example/" } }),
      );
    await expect(
      fetchPageHtml("https://live.test/", { userAgent: FETCHER_UA, sameHostAs: "live.test" }),
    ).rejects.toBeInstanceOf(OffHostRedirectError);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0]?.[0])).toBe("https://live.test/");
    spy.mockRestore();
  });

  it("the fetch goes out under the install's user agent, with its bot page", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response("<html><body></body></html>", { status: 200 }));
    await fetchPageHtml("https://8.8.8.8/", {
      userAgent: FETCHER_UA,
      publicOnly: true,
      sameHostAs: "8.8.8.8",
    });
    const init = spy.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get("user-agent")).toBe(
      "Rawuser/1.0 (+https://example.com/bot)",
    );
    expect(fetcherUserAgent({ BOT_INFO_URL: "https://example.com/bot" })).toBe(FETCHER_UA);
    // No page to point at: the agent names the fetcher and nothing else.
    expect(fetcherUserAgent({})).toBe("Rawuser/1.0");
    expect(fetcherUserAgent({ BOT_INFO_URL: "  " })).toBe("Rawuser/1.0");
    spy.mockRestore();
  });

  it("a growth unanswered for 7 days is written by itself", async () => {
    const { env, db, add } = setup();
    add("live", 1);
    db.prepare("UPDATE customers SET served_intents = ?, served_reasons = ? WHERE id = 'live'").run(
      JSON.stringify(["evaluation", "feature", "problem", "brand"]),
      JSON.stringify({
        pricing: "page /pricing",
        competitor: "none",
        pending: { intents: ["pricing"], since: NOW - 8 * DAY_MS, paths: ["/pricing"] },
      }),
    );
    const r = await runSiteMapSweep(env, NOW, async () => HOME);
    expect(r.auto_written).toBe(1);
    const s = await loadSiteState(env.DB, "live");
    expect(s.served).toContain("pricing");
    expect(s.reasons?.write_at).toBe(NOW);
  });
});

describe("the write queue follows the served set (§7.3)", () => {
  it("skips a folded intent's stale rows and picks a grown set", async () => {
    const { env, db, add } = setup();
    add("lumera", 1);
    add("grown", 1);
    db.prepare("UPDATE customers SET served_intents = ? WHERE id = 'lumera'").run(
      JSON.stringify(["evaluation", "feature", "problem", "brand"]),
    );
    db.prepare("UPDATE customers SET served_reasons = ? WHERE id = 'grown'").run(
      JSON.stringify({ pricing: "page /pricing", competitor: "none", write_at: NOW }),
    );
    db.prepare(
      "INSERT INTO intent_profiles (id, customer_id, profile_key, label, trigger_signals, dimensions, structure_plan, lead_prob_base) VALUES ('p', NULL, 'x', 'x', '[]', '{}', '{}', 0.1)",
    ).run();
    db.prepare(
      "INSERT INTO variants (id, customer_id, profile_id, kv_key, model, prompt_hash, generated_at, cost_usd, status) VALUES ('v1', 'lumera', 'p', 'v1:variant:lumera:pricing:ai', 'm', 'h', 1, 0, 'stale')",
    ).run();
    expect(await queueCustomers(env.DB)).toEqual(["grown"]);
    db.prepare(
      "INSERT INTO variants (id, customer_id, profile_id, kv_key, model, prompt_hash, generated_at, cost_usd, status) VALUES ('v2', 'lumera', 'p', 'v1:variant:lumera:p:%2Fapproach:problem:ai', 'm', 'h', 1, 0, 'stale')",
    ).run();
    expect(await queueCustomers(env.DB)).toEqual(["lumera", "grown"]);
    expect(intentOfKvKey("v1:variant:lumera:p:%2Fapproach:problem:ai")).toBe("problem");
  });

  it("writes only the served intents' tuples", () => {
    expect(buildTuples()).toHaveLength(36);
    expect(buildTuples(null)).toHaveLength(36);
    expect(buildTuples(["evaluation", "feature", "problem", "brand", "pricing"])).toHaveLength(30);
    const four = buildTuples(["evaluation", "feature", "problem", "brand"]);
    expect(four).toHaveLength(24);
    expect(four.some((t) => t.intent_dim === "pricing" || t.intent_dim === "competitor")).toBe(
      false,
    );
  });
});

describe("the re-read on a live read (§9)", () => {
  afterEach(() => resetReads());

  it("ensureInlineShapes hands the page it read to the hook; the hook reads once a day", async () => {
    const { env, db, add } = setup();
    add("live", 1, 0, "live.test");
    db.prepare(
      "INSERT INTO element_manifests (customer_id, page_path, manifest, confirmed_at, source_url, generated_at) VALUES ('live', '/', ?, 1, 'https://live.test/', 1)",
    ).run(JSON.stringify({ "hero.headline": { css: ["h1"], text: ["Hi"], structural: "h1" } }));
    const html = `<html lang="en"><body><h1>Hi</h1>${HOME.replace(/<\/?html[^>]*>|<\/?body>/g, "")}</body></html>`;
    const hook = vi.fn(siteRereadHook(env, "live"));
    const manifest = {
      "hero.headline": { css: ["h1"], text: ["Hi"], structural: "h1", inline: { kind: "plain" } },
    } as never;
    await ensureInlineShapes("live", "/", manifest, env.DB, async () => html, "en", hook);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM site_paths").get()).toEqual({ n: 2 });
    db.prepare("DELETE FROM site_paths").run();
    resetReads();
    await ensureInlineShapes("live", "/", manifest, env.DB, async () => html, "en", hook);
    expect(hook).toHaveBeenCalledTimes(2);
    // The second call within a day reads nothing.
    expect(db.prepare("SELECT COUNT(*) AS n FROM site_paths").get()).toEqual({ n: 0 });
  });

  it("asks for the recorded host only; an off-host redirect ends the read, with no second read", async () => {
    const { env, add } = setup();
    add("live", 1, 0, "live.test");
    const asked: Array<unknown> = [];
    const fetchHtml = vi.fn(async (_url: string, opts?: { sameHostAs?: string }) => {
      asked.push(opts);
      throw new OffHostRedirectError();
    });
    const hook = vi.fn(async () => {});
    const manifest = {
      "hero.headline": { css: ["h1"], text: ["Hi"], structural: "h1", inline: { kind: "plain" } },
    } as never;
    const out = await ensureInlineShapes("live", "/", manifest, env.DB, fetchHtml, "en", hook);
    // One read, on the recorded host; the retry without the rule is gone.
    expect(asked).toEqual([{ sameHostAs: "live.test" }]);
    expect(out).toBe(manifest);
    expect(hook).not.toHaveBeenCalled();
    const health = env.DB.prepare("SELECT COUNT(*) AS n FROM manifest_health").bind();
    expect(await health.first()).toEqual({ n: 0 });
  });

  it("without a hook the read still asks for the recorded host", async () => {
    const { env, add } = setup();
    add("live", 1, 0, "live.test");
    const asked: Array<unknown> = [];
    const fetchHtml = vi.fn(async (_url: string, opts?: { sameHostAs?: string }) => {
      asked.push(opts);
      return '<html lang="en"><body><h1>Hi</h1></body></html>';
    });
    const manifest = {
      "hero.headline": { css: ["h1"], text: ["Hi"], structural: "h1", inline: { kind: "plain" } },
    } as never;
    await ensureInlineShapes("live", "/", manifest, env.DB, fetchHtml, "en");
    expect(asked).toEqual([{ sameHostAs: "live.test" }]);
  });
});

// ---------------------------------------------------------------------------

const USER = { id: "u", email: "a@b.c", role: "customer", customer_id: "novbe" };
const ADMIN_ENV = (env: SiteEnv) =>
  ({ ...env, ENVIRONMENT: "test", ALLOWED_ORIGINS: "https://app.test" }) as never;

function post(body: unknown) {
  return new Request("https://gen.test/admin/site-map", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("the endpoints (§8, §16, condition 5)", () => {
  function seeded() {
    const ctx = setup();
    ctx.add("novbe", 1);
    ctx.db
      .prepare(
        "INSERT INTO element_manifests (customer_id, page_path, manifest, confirmed_at, source_url, generated_at) VALUES ('novbe', '/', '{}', 1, 'https://novbe.test/', 1)",
      )
      .run();
    const ins = ctx.db.prepare(
      "INSERT INTO site_paths (customer_id, path, lang, kind, confidence, label, found_on, first_seen_at, last_seen_at) VALUES ('novbe', ?, 'az', ?, ?, ?, '/', 1, 1)",
    );
    ins.run("/imkanlar", "features", "high", "İmkanlar");
    ins.run("/hekayeler", "proof", "model", null);
    ctx.db
      .prepare("UPDATE customers SET served_intents = ?, served_reasons = ? WHERE id = 'novbe'")
      .run(
        JSON.stringify(["evaluation", "feature", "problem", "brand"]),
        JSON.stringify({ pricing: "none", competitor: "none" }),
      );
    return ctx;
  }

  it("GET returns the rows, the served set, the folds and the versions a page", async () => {
    const { env } = seeded();
    const res = await handleSiteMapGet(
      new Request("https://gen.test/admin/site-map?customer_id=novbe"),
      ADMIN_ENV(env),
      USER,
    );
    const v = (await res.json()) as Record<string, unknown>;
    expect(v).toMatchObject({
      on: true,
      served: ["evaluation", "feature", "problem", "brand"],
      folded: [
        { intent: "competitor", to: "evaluation", reason: "none" },
        { intent: "pricing", to: "evaluation", reason: "none" },
      ],
      versions_per_page: 24,
      pages: 1,
      pending: null,
      languages: ["az"],
    });
    expect((v.paths as unknown[]).length).toBe(2);
  });

  it("another customer's account is refused", async () => {
    const { env } = seeded();
    const res = await handleSiteMapGet(
      new Request("https://gen.test/admin/site-map?customer_id=other"),
      ADMIN_ENV(env),
      USER,
    );
    expect(res.status).toBe(403);
  });

  it("the operator's rows apply at once, a growth included, and the bundle follows", async () => {
    const { env, kv } = seeded();
    const res = await handleSiteMapSet(
      post({
        customer_id: "novbe",
        paths: [
          { path: "/Yay-Endirimi", kind: "price" },
          { path: "/hekayeler", kind: "none" },
        ],
      }),
      ADMIN_ENV(env),
      USER,
    );
    const v = (await res.json()) as { served: string[]; paths: Array<Record<string, unknown>> };
    expect(v.served).toContain("pricing");
    expect(v.paths.find((p) => p.path === "/yay-endirimi")).toMatchObject({
      kind: "price",
      confidence: "operator",
    });
    const b = JSON.parse(kv.store.get("v1:vm:novbe") ?? "{}");
    expect(b.pm["/hekayeler"]).toEqual(["none", 1]);
    expect(b.pm["/yay-endirimi"]).toEqual(["price", 1]);
  });

  it("refuses an identifier path, an unknown kind and the homepage", async () => {
    const { env } = seeded();
    for (const row of [
      { path: "/u/jane@x.test", kind: "price" },
      { path: "/students/482", kind: "proof" },
      { path: "/x", kind: "health" },
      { path: "/", kind: "price" },
      { path: "pricing", kind: "price" },
    ]) {
      const res = await handleSiteMapSet(
        post({ customer_id: "novbe", paths: [row] }),
        ADMIN_ENV(env),
        USER,
      );
      expect(res.status).toBe(400);
    }
  });

  it("off deletes every row, drops pm and sd, and serves six intents", async () => {
    const { env, db, kv } = seeded();
    const res = await handleSiteMapSet(
      post({ customer_id: "novbe", on: false }),
      ADMIN_ENV(env),
      USER,
    );
    const v = (await res.json()) as Record<string, unknown>;
    expect(v).toMatchObject({ on: false, paths: [], served: expect.any(Array), folded: [] });
    expect((v.served as string[]).length).toBe(6);
    expect(db.prepare("SELECT COUNT(*) AS n FROM site_paths").get()).toEqual({ n: 0 });
    const b = JSON.parse(kv.store.get("v1:vm:novbe") ?? "{}");
    expect(b).not.toHaveProperty("pm");
    expect(b).not.toHaveProperty("sd");
    // Off means empty: rows are refused until the map is on (§13.2 point 5).
    const refused = await handleSiteMapSet(
      post({ customer_id: "novbe", paths: [{ path: "/tarifler", kind: "price" }] }),
      ADMIN_ENV(env),
      USER,
    );
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toBe("Turn the map on first");
    expect(db.prepare("SELECT COUNT(*) AS n FROM site_paths").get()).toEqual({ n: 0 });
    const delRefused = await handleSiteMapSet(
      post({ customer_id: "novbe", delete: ["/x"] }),
      ADMIN_ENV(env),
      USER,
    );
    expect(delRefused.status).toBe(409);
    // On and rows in one request is fine.
    const onWithRows = await handleSiteMapSet(
      post({ customer_id: "novbe", on: true, paths: [{ path: "/tarifler", kind: "price" }] }),
      ADMIN_ENV(env),
      USER,
    );
    expect(onWithRows.status).toBe(200);
    await handleSiteMapSet(post({ customer_id: "novbe", on: false }), ADMIN_ENV(env), USER);
    // And on again: the flag only; the next read fills the map.
    await handleSiteMapSet(post({ customer_id: "novbe", on: true }), ADMIN_ENV(env), USER);
    expect((await loadSiteState(env.DB, "novbe")).off).toBe(false);
  });

  it("Write applies a waiting growth and says how many versions it starts", async () => {
    const { env, db } = seeded();
    db.prepare("UPDATE customers SET served_reasons = ? WHERE id = 'novbe'").run(
      JSON.stringify({
        pricing: "none",
        competitor: "page /muqayise",
        pending: { intents: ["competitor"], since: NOW, paths: ["/muqayise"] },
      }),
    );
    const view = await handleSiteMapGet(
      new Request("https://gen.test/admin/site-map?customer_id=novbe"),
      ADMIN_ENV(env),
      USER,
    );
    expect(((await view.json()) as { pending: Record<string, unknown> }).pending).toMatchObject({
      intents: ["competitor"],
      versions: 6,
      auto_at: NOW + 7 * DAY_MS,
    });
    const res = await handleSiteMapWrite(
      new Request("https://gen.test/admin/site-map/write", {
        method: "POST",
        body: JSON.stringify({ customer_id: "novbe" }),
      }),
      ADMIN_ENV(env),
      USER,
    );
    const v = (await res.json()) as { applied: string[]; served: string[]; pending: unknown };
    expect(v.applied).toEqual(["competitor"]);
    expect(v.served).toContain("competitor");
    expect(v.pending).toBeNull();
  });
});
