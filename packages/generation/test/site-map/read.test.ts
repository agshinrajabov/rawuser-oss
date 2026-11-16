/**
 * Site-shaped intents, the offline read (docs/specs/site-shaped-intents.md
 * §4, §5, §9, privacy review conditions 1 to 6): the link reader, the model call,
 * the store, the served set and the off switch, on a real SQLite D1 with
 * every migration applied.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type SiteModelCall,
  buildSiteModelPrompt,
  parseSiteModelAnswer,
} from "../../src/site-map/model.ts";
import { readSiteLinks } from "../../src/site-map/read-links.ts";
import { type SiteEnv, runSiteRead, siteReadKey } from "../../src/site-map/run.ts";
import {
  DAY_MS,
  applyPending,
  loadSiteState,
  setOperatorRows,
  setSiteMapOff,
} from "../../src/site-map/store.ts";
import { makeKv, makeSqliteD1 } from "../admin/sqlite-d1.ts";
import { MODEL_ENV } from "../model-env.ts";

const NOW = Date.UTC(2026, 9, 5, 12);

const PAGE = `<!doctype html><html lang="az"><head><title>Novbe</title></head><body>
<header><a href="/"><img alt=""></a>
  <nav>
    <a href="/tarifler">Qiymətlər</a>
    <a href="/imkanlar">İmkanlar</a>
    <a href="/hekayeler">Hekayələr</a>
    <a href="https://www.queue.test/musteriler/">Müştərilər</a>
    <a href="#how">Necə işləyir</a>
    <a href="https://school.queue.test/kurs">Kurs</a>
    <a href="https://other.com/pricing">Pricing elsewhere</a>
    <a href="mailto:hi@queue.test">Mail</a>
    <a href="/w/acme">Jane's workspace</a>
    <a href="/u/jane@x.test">Jane</a>
    <a href="/daxil-ol">Daxil ol</a>
    <a href="/team">jane@acme.example</a>
    <a href="/bilet/12345678">Bilet</a>
  </nav>
</header>
<main>
  <section class="hero"><h1>Salonunuz üçün onlayn növbə</h1><p class="lead">Müştərilər növbəni saytdan tutur.</p>
    <a class="cta" href="/elaqe">Layihəni danışaq</a></section>
  <article><p>Read <a href="/blog/secret-post">a post</a> in the text.</p></article>
</main>
<footer><a href="/privacy">Məxfilik</a><a href="/careers">Karyera</a><a href="/haqqimizda">Haqqımızda</a>
  <a href="/u/jane-doe">Jane Doe</a><a href="/rss.xml">RSS</a></footer>
</body></html>`;

const MANIFEST = {
  "hero.headline": { css: ["section.hero h1"], text: ["Salonunuz"], structural: "h1" },
  "hero.body": { css: ["section.hero p.lead"], text: ["Müştərilər"], structural: "p" },
  "hero.cta.label": { css: ["section.hero a.cta"], text: ["Layihəni"], structural: "a" },
};

describe("readSiteLinks (§4.2, §4.3)", () => {
  const read = readSiteLinks(PAGE, "https://queue.test/", MANIFEST, "az");
  const paths = read.links.map((l) => l.path);

  it("keeps the menus, the hero and the buttons; not article text", () => {
    expect(paths).toEqual(
      expect.arrayContaining(["/tarifler", "/imkanlar", "/musteriler", "/elaqe", "/haqqimizda"]),
    );
    expect(paths).not.toContain("/blog/secret-post");
  });

  it("same host only (www folded), never a subdomain, no fragment-only link, no mailto", () => {
    expect(paths).not.toContain("/kurs");
    expect(paths).not.toContain("/pricing");
    expect(paths).not.toContain("/");
    expect(read.links.every((l) => l.path.startsWith("/"))).toBe(true);
  });

  it("drops identifiers, account areas and details, legal links and files", () => {
    for (const p of ["/w/acme", "/daxil-ol", "/team", "/privacy", "/careers", "/rss.xml"]) {
      expect(paths).not.toContain(p);
    }
    expect(read.links.some((l) => l.path.includes("jane@") || l.path.includes("12345678"))).toBe(
      false,
    );
    expect(read.dropped).toBeGreaterThanOrEqual(8);
  });

  it("a whole page is complete; a cut one is not", () => {
    expect(read.complete).toBe(true);
    expect(readSiteLinks(PAGE.slice(0, 900), "https://queue.test/", null, "az").complete).toBe(
      false,
    );
  });

  it("at most 60 links from one page", () => {
    const many = `<nav>${Array.from({ length: 90 }, (_, i) => `<a href="/p${"x".repeat(i % 5)}-${String.fromCharCode(97 + (i % 26))}${Math.floor(i / 26)}">L</a>`).join("")}</nav></body>`;
    expect(readSiteLinks(many, "https://a.test/", null, "en").links.length).toBeLessThanOrEqual(60);
  });
});

describe("the model request (privacy review condition 3)", () => {
  it("holds only the screened links and the product line; no dropped link reaches it", () => {
    const read = readSiteLinks(PAGE, "https://queue.test/", MANIFEST, "az");
    const prompt = buildSiteModelPrompt(read.links, "Online queue booking for salons");
    for (const dropped of [
      "workspace",
      "jane@",
      "12345678",
      "daxil",
      "/privacy",
      "/careers",
      "secret-post",
      "other.com",
      "school.queue.test",
      "hi@queue.test",
    ]) {
      expect(prompt).not.toContain(dropped);
    }
    expect(prompt).toContain("Online queue booking for salons");
  });

  it("reads only the closed list back; anything else is none", () => {
    const m = parseSiteModelAnswer(
      '{"kinds":{"/a":"learn","/b":"health","/c":"PRICE","/x":"proof"}}',
      ["/a", "/b", "/c"],
    );
    expect([...m.entries()]).toEqual([
      ["/a", "learn"],
      ["/b", "none"],
      ["/c", "price"],
    ]);
    expect(parseSiteModelAnswer("not json at all {", ["/a"]).size).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------

function setup(opts: { live?: boolean; off?: boolean; brief?: Record<string, string> } = {}) {
  const { d1, db } = makeSqliteD1();
  db.prepare(
    "INSERT INTO customers (id, slug, domain, status, created_at, live_at, site_map_off) VALUES ('novbe', 'novbe', 'queue.test', 'active', 1, ?, ?)",
  ).run(opts.live ? 1 : null, opts.off ? 1 : 0);
  db.prepare(
    `INSERT INTO business_dna (customer_id, product, icp, updated_at, value_props, proof_points, per_intent_hints)
     VALUES ('novbe', 'Online queue booking for salons', 'Salon owners', 1, ?, ?, ?)`,
  ).run(
    opts.brief?.value_props ?? '["Clients book online"]',
    opts.brief?.proof_points ?? '["120 salons"]',
    opts.brief?.hints ?? "{}",
  );
  db.prepare(
    "INSERT INTO element_manifests (customer_id, page_path, manifest, confirmed_at, source_url, generated_at) VALUES ('novbe', '/', ?, 1, 'https://queue.test/', 1)",
  ).run(JSON.stringify(MANIFEST));
  const kv = makeKv();
  const env = { DB: d1, VARIANTS: kv, ...MODEL_ENV } as unknown as SiteEnv;
  return { env, db, kv };
}

function modelSaying(kinds: Record<string, string>) {
  const calls: string[] = [];
  const call: SiteModelCall = vi.fn(async (input) => {
    calls.push(`${input.cachedPreamble}\n${input.prompt}`);
    return {
      ok: true as const,
      value: {
        text: JSON.stringify({ kinds }),
        model: "model-a",
        promptHash: "h",
        costUsd: 0.0002,
        cacheHit: false,
      } as never,
    };
  });
  return { call, calls };
}

const page = (html = PAGE, source: "capture" | "fetch" = "capture", pagePath = "/") => ({
  pagePath,
  pageUrl: `https://queue.test${pagePath}`,
  html,
  manifest: MANIFEST,
  lang: "az",
  source,
});

function rows(db: ReturnType<typeof makeSqliteD1>["db"]) {
  return db
    .prepare("SELECT path, kind, confidence, label, missing_since FROM site_paths ORDER BY path")
    .all() as Array<Record<string, unknown>>;
}

describe("a capture read (conditions 1, 2, 3)", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it("keeps only what the rules name; sends nothing to the model; no none row", async () => {
    const { call } = modelSaying({ "/hekayeler": "proof", "/u/jane-doe": "proof" });
    const r = await runSiteRead(ctx.env, "novbe", [page()], {
      product: "Online queue booking for salons",
      now: NOW,
      call,
    });
    // Privacy review re-review §13.2 point 2: a capture asks the model nothing.
    expect(r.model_asked).toBe(0);
    expect(call).not.toHaveBeenCalled();
    const got = rows(ctx.db);
    expect(got.map((g) => [g.path, g.kind, g.confidence])).toEqual([
      ["/elaqe", "start", "medium"],
      ["/haqqimizda", "about", "high"],
      ["/imkanlar", "features", "high"],
      ["/musteriler", "proof", "high"],
      ["/tarifler", "price", "high"],
    ]);
    // Condition 2: a capture keeps the text only when it named the kind.
    const label = Object.fromEntries(got.map((g) => [g.path, g.label]));
    expect(label["/imkanlar"]).toBe("İmkanlar");
    expect(label["/elaqe"]).toBeNull();
    expect(label["/tarifler"]).toBe("Qiymətlər");
  });

  it('"Jane Doe" on /u/jane-doe in a capture is neither sent nor stored, even if a model would guess', async () => {
    const guess = modelSaying({ "/hekayeler": "proof", "/u/jane-doe": "proof" });
    await runSiteRead(ctx.env, "novbe", [page()], { product: "", now: NOW, call: guess.call });
    const all = JSON.stringify(rows(ctx.db));
    expect(all.toLowerCase()).not.toContain("jane");
    expect(guess.calls.join(" ")).not.toContain("/u/jane-doe");
  });

  it("a deeper path named by its path alone is dropped from a capture, kept from a fetch", async () => {
    const html = `<html lang="en"><body><header><nav>
      <a href="/customers/jane-doe">Jane Doe</a>
      <a href="/projects/acme-redesign">Acme redesign</a>
      <a href="/customers/stories">Customers</a>
      <a href="/pricing">Pricing</a></nav></header></body></html>`;
    const capture = setup();
    const none = modelSaying({});
    await runSiteRead(capture.env, "novbe", [page(html, "capture")], {
      product: "",
      now: NOW,
      call: none.call,
    });
    const kept = rows(capture.db).map((g) => g.path);
    expect(kept).toEqual(["/customers/stories", "/pricing"]);
    expect(JSON.stringify(rows(capture.db)).toLowerCase()).not.toContain("jane");
    expect(none.call).not.toHaveBeenCalled();

    const fetched = setup();
    await runSiteRead(fetched.env, "novbe", [page(html, "fetch")], {
      product: "",
      now: NOW,
      call: modelSaying({}).call,
    });
    expect(rows(fetched.db).map((g) => g.path)).toEqual(
      expect.arrayContaining(["/customers/jane-doe", "/projects/acme-redesign", "/pricing"]),
    );
  });

  it("the same /u/jane-doe link in a cookie-less fetch still goes to the model", async () => {
    const { call, calls } = modelSaying({ "/hekayeler": "proof", "/u/jane-doe": "none" });
    const r = await runSiteRead(ctx.env, "novbe", [page(PAGE, "fetch")], {
      product: "",
      now: NOW,
      call,
    });
    expect(r.model_asked).toBe(2);
    expect(calls.join(" ")).toContain("/u/jane-doe");
    expect(rows(ctx.db).find((g) => g.path === "/hekayeler")).toMatchObject({
      kind: "proof",
      confidence: "model",
    });
  });

  it("a cookie-less server read keeps the screened text", async () => {
    const { call } = modelSaying({ "/hekayeler": "proof", "/u/jane-doe": "none" });
    await runSiteRead(ctx.env, "novbe", [page(PAGE, "fetch")], { product: "", now: NOW, call });
    const label = Object.fromEntries(rows(ctx.db).map((g) => [g.path, g.label]));
    expect(label["/elaqe"]).toBe("Layihəni danışaq");
    expect(label["/hekayeler"]).toBe("Hekayələr");
  });

  it("a page whose own path holds an identifier keeps nothing", async () => {
    const { call } = modelSaying({});
    const r = await runSiteRead(ctx.env, "novbe", [page(PAGE, "capture", "/bilet/12345678")], {
      product: "",
      now: NOW,
      call,
    });
    expect(r.skipped).toBe("no_pages");
    expect(rows(ctx.db)).toEqual([]);
    expect(call).not.toHaveBeenCalled();
  });

  it("a failed model call is not fatal: those paths stay unmapped", async () => {
    const call: SiteModelCall = async () => ({ ok: false, error: "Timeout after 15000ms" });
    const r = await runSiteRead(ctx.env, "novbe", [page(PAGE, "fetch")], {
      product: "",
      now: NOW,
      call,
    });
    expect(r.mapped).toBe(5);
    expect(rows(ctx.db).map((g) => g.path)).not.toContain("/hekayeler");
  });

  it("a read the model could not finish never folds an intent", async () => {
    const live = setup({ live: true });
    const call: SiteModelCall = async () => ({ ok: false, error: "Timeout after 15000ms" });
    const noPrice = PAGE.replace('<a href="/tarifler">Qiymətlər</a>', "");
    await runSiteRead(live.env, "novbe", [page(noPrice, "fetch")], { product: "", now: NOW, call });
    expect((await loadSiteState(live.env.DB, "novbe")).served).toBeNull();
    // The model answers on the next read: now the fold applies.
    const { call: ok } = modelSaying({ "/hekayeler": "proof", "/u/jane-doe": "none" });
    await runSiteRead(live.env, "novbe", [page(noPrice, "fetch")], {
      product: "",
      now: NOW + DAY_MS,
      call: ok,
    });
    expect((await loadSiteState(live.env.DB, "novbe")).served).toEqual([
      "evaluation",
      "feature",
      "problem",
      "brand",
    ]);
  });

  it("writes the bundle with pm (no labels) and sd, and marks the read", async () => {
    const { call } = modelSaying({ "/hekayeler": "proof", "/u/jane-doe": "none" });
    await runSiteRead(ctx.env, "novbe", [page(PAGE, "fetch")], { product: "", now: NOW, call });
    const b = JSON.parse(ctx.kv.store.get("v1:vm:novbe") ?? "{}");
    expect(b.pm["/tarifler"]).toEqual(["price", 1]);
    expect(b.pm["/elaqe"]).toEqual(["start", 0.85]);
    expect(b.pm["/hekayeler"]).toEqual(["proof", 0.75]);
    expect(JSON.stringify(b)).not.toContain("Qiymətlər");
    expect(JSON.stringify(b)).not.toContain("Hekayələr");
    // A price page, no rival page: competitor folds.
    expect(b.sd).toEqual(["evaluation", "feature", "problem", "brand", "pricing"]);
    expect(ctx.kv.store.has(siteReadKey("novbe"))).toBe(true);
  });

  it("never logs a path or a link text (condition 6)", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { call } = modelSaying({ "/hekayeler": "proof" });
    await runSiteRead(ctx.env, "novbe", [page()], { product: "", now: NOW, call });
    await runSiteRead(ctx.env, "novbe", [page(PAGE, "fetch")], { product: "", now: NOW, call });
    const lines = [...log.mock.calls, ...err.mock.calls].flat().join(" ");
    for (const s of ["/tarifler", "Qiymətlər", "/hekayeler", "queue.test"]) {
      expect(lines).not.toContain(s);
    }
    log.mockRestore();
    err.mockRestore();
  });
});

describe("the off switch (condition 5)", () => {
  it("no read, no model call, no bundle field when off", async () => {
    const ctx = setup({ off: true });
    const { call } = modelSaying({});
    const r = await runSiteRead(ctx.env, "novbe", [page()], { product: "", now: NOW, call });
    expect(r.skipped).toBe("off");
    expect(call).not.toHaveBeenCalled();
    expect(rows(ctx.db)).toEqual([]);
    expect(ctx.kv.store.has("v1:vm:novbe")).toBe(false);
  });

  it("switching off deletes every row and serves six intents", async () => {
    const ctx = setup({ live: true });
    const { call } = modelSaying({ "/hekayeler": "proof", "/u/jane-doe": "none" });
    await runSiteRead(ctx.env, "novbe", [page(PAGE, "fetch")], { product: "", now: NOW, call });
    expect(rows(ctx.db).length).toBeGreaterThan(0);
    await setSiteMapOff(ctx.env.DB, "novbe", true, NOW);
    expect(rows(ctx.db)).toEqual([]);
    const s = await loadSiteState(ctx.env.DB, "novbe");
    expect(s.off).toBe(true);
    expect(s.served).toBeNull();
    // Six served again on a live site: the queue writes what is missing.
    expect(s.reasons?.write_at).toBe(NOW);
  });
});

describe("re-reads (§9)", () => {
  it("a link gone from a complete re-read is marked missing, kept 30 days, then removed", async () => {
    const ctx = setup();
    const { call } = modelSaying({ "/hekayeler": "proof" });
    await runSiteRead(ctx.env, "novbe", [page(PAGE, "fetch")], { product: "", now: NOW, call });
    const without = PAGE.replace('<a href="/imkanlar">İmkanlar</a>', "");
    await runSiteRead(ctx.env, "novbe", [page(without, "fetch")], {
      product: "",
      now: NOW + DAY_MS,
      call,
    });
    expect(rows(ctx.db).find((r) => r.path === "/imkanlar")?.missing_since).toBe(NOW + DAY_MS);
    // A cut page never marks anything missing.
    await runSiteRead(ctx.env, "novbe", [page(without.slice(0, 700), "fetch")], {
      product: "",
      now: NOW + 2 * DAY_MS,
      call,
    });
    expect(rows(ctx.db).find((r) => r.path === "/tarifler")?.missing_since).toBeNull();
    await runSiteRead(ctx.env, "novbe", [page(without, "fetch")], {
      product: "",
      now: NOW + 32 * DAY_MS,
      call,
    });
    expect(rows(ctx.db).map((r) => r.path)).not.toContain("/imkanlar");
  });

  it("a path the model mapped before is not asked again", async () => {
    const ctx = setup();
    const first = modelSaying({ "/hekayeler": "proof" });
    await runSiteRead(ctx.env, "novbe", [page(PAGE, "fetch")], {
      product: "",
      now: NOW,
      call: first.call,
    });
    const second = modelSaying({});
    const r = await runSiteRead(ctx.env, "novbe", [page(PAGE, "fetch")], {
      product: "",
      now: NOW + DAY_MS,
      call: second.call,
    });
    expect(r.model_asked).toBe(1); // only /u/jane-doe, which was never stored
    expect(rows(ctx.db).find((g) => g.path === "/hekayeler")?.kind).toBe("proof");
  });

  it("an operator's row is never changed or removed by a read", async () => {
    const ctx = setup();
    await setOperatorRows(ctx.env.DB, "novbe", [{ path: "/tarifler", kind: "none" }], [], NOW);
    const { call } = modelSaying({ "/hekayeler": "proof" });
    const without = PAGE.replace('<a href="/tarifler">Qiymətlər</a>', "");
    await runSiteRead(ctx.env, "novbe", [page(PAGE, "fetch")], { product: "", now: NOW, call });
    await runSiteRead(ctx.env, "novbe", [page(without, "fetch")], {
      product: "",
      now: NOW + 40 * DAY_MS,
      call,
    });
    const t = rows(ctx.db).find((g) => g.path === "/tarifler");
    expect(t).toMatchObject({ kind: "none", confidence: "operator", missing_since: null });
  });
});

describe("the served set (§7, the mock's call 6)", () => {
  it("before go live a fold applies at once", async () => {
    const ctx = setup();
    const { call } = modelSaying({});
    const noPrice = PAGE.replace('<a href="/tarifler">Qiymətlər</a>', "");
    await runSiteRead(ctx.env, "novbe", [page(noPrice)], { product: "", now: NOW, call });
    const s = await loadSiteState(ctx.env.DB, "novbe");
    expect(s.served).toEqual(["evaluation", "feature", "problem", "brand"]);
    expect(s.reasons).toMatchObject({ pricing: "none", competitor: "none" });
  });

  it("on a live site a growth waits for Write; after 7 days it is written by itself", async () => {
    const ctx = setup({ live: true });
    const { call } = modelSaying({});
    const noPrice = PAGE.replace('<a href="/tarifler">Qiymətlər</a>', "");
    await runSiteRead(ctx.env, "novbe", [page(noPrice, "fetch")], { product: "", now: NOW, call });
    let s = await loadSiteState(ctx.env.DB, "novbe");
    // The shrink applied at once.
    expect(s.served).toEqual(["evaluation", "feature", "problem", "brand"]);
    // A price page appears on the next read.
    await runSiteRead(ctx.env, "novbe", [page(PAGE, "fetch")], {
      product: "",
      now: NOW + DAY_MS,
      call,
    });
    s = await loadSiteState(ctx.env.DB, "novbe");
    expect(s.served).toEqual(["evaluation", "feature", "problem", "brand"]);
    expect(s.reasons?.pending).toMatchObject({
      intents: ["pricing"],
      since: NOW + DAY_MS,
      paths: ["/tarifler"],
    });
    const applied = await applyPending(ctx.env.DB, "novbe", NOW + 2 * DAY_MS);
    expect(applied.applied).toEqual(["pricing"]);
    s = await loadSiteState(ctx.env.DB, "novbe");
    expect(s.served).toEqual(["evaluation", "feature", "problem", "brand", "pricing"]);
    expect(s.reasons?.pending).toBeUndefined();
    expect(s.reasons?.write_at).toBe(NOW + 2 * DAY_MS);
  });

  it("a price in the brief serves pricing with no price page", async () => {
    const ctx = setup({ brief: { proof_points: '["From 29 AZN a month"]' } });
    const { call } = modelSaying({});
    const noPrice = PAGE.replace('<a href="/tarifler">Qiymətlər</a>', "");
    await runSiteRead(ctx.env, "novbe", [page(noPrice)], { product: "", now: NOW, call });
    const s = await loadSiteState(ctx.env.DB, "novbe");
    expect(s.served).toContain("pricing");
    expect(s.reasons?.pricing).toBe("price in brief");
  });
});
