/**
 * What direct is made of (ADR 0038, part 1; docs/specs/direct-visitors.md
 * §1, docs/specs/visitors-page.md §2 "direct") on real SQL (node:sqlite,
 * every migration): the no-signal visits are exactly the `none` row of
 * `by_source`, split by landing page, country, device word and in-app bit;
 * visits, not rows; the page's filters and the panel's own; the landing
 * floor; the switch, its clear and its sweep; the statements' bounds.
 */
import type { VisitorsDirectFilters, VisitorsFilters } from "@rawuser/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DIRECT_CLEAR_SQL,
  clearDirectFacts,
  clearSwitchedOffDirect,
  handleDirectInsightsSwitch,
} from "../../src/admin/direct-insights.ts";
import type { AdminEnv } from "../../src/admin/handlers.ts";
import { handleVisitors } from "../../src/admin/visitors.ts";
import { D1_STATEMENT_CHARS_MAX } from "../../src/lib/sensitive-pages.ts";
import {
  NO_DIRECT_FILTERS,
  NO_FILTERS,
  VISITORS_DIRECT_SENSITIVE_SQL,
  VISITORS_DIRECT_SQL,
  VisitorsFloorError,
  computeVisitors,
  parseDirectFilters,
} from "../../src/lib/visitors.ts";
import { DAY, type Harness, harness, vid } from "../proof-harness.ts";

const NOW = Date.parse("2026-11-03T12:00:00Z");
const PLAIN = { sensitive: false, kept: [] };
const superadmin = { id: "u", email: "a@rawuser.example", role: "superadmin", customer_id: null };

let h: Harness;
let n = 0;
beforeEach(() => {
  h = harness();
  h.customer("acme");
  h.customer("other");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  n = 0;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** One visit: its pages, optionally a click; no signal unless `signal`. */
function visit(
  ts: number,
  o: {
    pages?: string[];
    converts?: boolean;
    clickOn?: string;
    country?: string | null;
    device?: string | null;
    webView?: 0 | 1 | null;
    signal?: boolean;
    marker?: boolean;
    customer?: string;
  } = {},
): void {
  const id = ++n;
  const marker = o.marker === false ? null : vid(id);
  const signal = o.signal === true;
  const base = {
    visit: marker,
    cohort: signal ? "personalized" : "no_signal",
    intent: signal ? "problem" : null,
    source: signal ? "ai" : null,
    country: o.country === undefined ? "AZ" : o.country,
    device: o.device === undefined ? "mobile" : o.device,
    webView: o.webView === undefined ? 0 : o.webView,
    customer: o.customer,
  } as const;
  const pages = o.pages ?? ["/"];
  for (const [i, page] of pages.entries()) {
    h.ev({
      ...base,
      ts: ts + i * 1000,
      type: signal ? "variant_shown" : "no_signal_passthrough",
      page,
    });
  }
  if (o.converts) {
    h.ev({ ...base, ts: ts + 30_000, type: "conversion", page: o.clickOn ?? pages.at(-1) });
  }
}

const read = (
  filters: Partial<VisitorsFilters> = {},
  direct: Partial<VisitorsDirectFilters> = {},
  o: { sensitive?: { sensitive: boolean; kept: string[] }; directOff?: boolean } = {},
) =>
  computeVisitors(h.d1, {
    customerId: "acme",
    window: "7d",
    now: NOW,
    sensitive: o.sensitive ?? PLAIN,
    countryOff: false,
    filters: { ...NO_FILTERS, ...filters },
    directOff: o.directOff,
    directFilters: { ...NO_DIRECT_FILTERS, ...direct },
  });

const c = (visits: number, page_views: number, conversions: number) => ({
  visits,
  page_views,
  conversions,
  rate: visits === 0 ? null : conversions / visits,
});

describe("the no-signal visits, split", () => {
  beforeEach(() => {
    // A: no signal, the default country, a phone browser, lands on /, clicks on /pricing.
    visit(NOW - 2 * DAY, { pages: ["/", "/pricing"], converts: true });
    // B: no signal, Türkiye, a desktop, lands on /docs (under the floor).
    visit(NOW - 2 * DAY, { pages: ["/docs"], country: "TR", device: "desktop" });
    // C: no signal, the default country, a phone inside an app, lands on / and clicks.
    visit(NOW - DAY, { webView: 1, converts: true });
    // D to G: no signal, United States, desktops, on /.
    for (let i = 0; i < 4; i++) visit(NOW - DAY, { country: "US", device: "desktop" });
    // H: ChatGPT on a phone: a signal, never in the panel.
    visit(NOW - DAY, { signal: true, converts: true });
    // I: a row from before migration 0050: no device word, no bit.
    visit(NOW - DAY, { device: null, webView: null, country: "US" });
    // Another customer's no-signal visit: never counted here.
    visit(NOW - DAY, { customer: "other" });
  });

  it("the total is the `none` row of by_source, visit for visit", async () => {
    const r = await read();
    const none = r.by_source.find((s) => s.source === "none");
    expect(r.direct.totals).toEqual(c(8, 9, 2));
    expect(none).toMatchObject(r.direct.totals);
    expect(r.direct.recording).toBe("on");
    expect(r.direct.filters).toEqual(NO_DIRECT_FILTERS);
  });

  it("by device word and in-app bit, each visit once; not recorded is null", async () => {
    const r = await read();
    expect(r.direct.by_device).toEqual([
      { device: "desktop", ...c(5, 5, 0) },
      { device: "mobile", ...c(2, 3, 2) },
      { device: null, ...c(1, 1, 0) },
    ]);
    expect(r.direct.by_view).toEqual([
      { view: "browser", ...c(6, 7, 1) },
      { view: "app", ...c(1, 1, 1) },
      { view: null, ...c(1, 1, 0) },
    ]);
    expect(r.direct.by_country).toEqual([
      { country: "US", ...c(5, 5, 0) },
      { country: "AZ", ...c(2, 3, 2) },
      { country: "TR", ...c(1, 1, 0) },
    ]);
  });

  it("by landing page: the first page viewed; a page under the floor folds into other", async () => {
    const r = await read();
    // A landed on / and clicked on /pricing: its landing is /, its click counts there.
    expect(r.direct.by_landing.pages).toEqual([
      { page_path: "/", group: false, has_versions: false, ...c(7, 8, 2) },
    ]);
    expect(r.direct.by_landing.other).toEqual({
      pages: 1,
      visits: 1,
      page_views: 1,
      conversions: 0,
    });
  });

  it("the panel's own filters narrow the panel; each part keeps its own rows", async () => {
    const r = await read({}, { device: "mobile" });
    expect(r.direct.totals).toEqual(c(2, 3, 2));
    expect(r.direct.by_country).toEqual([{ country: "AZ", ...c(2, 3, 2) }]);
    // by_device leaves out the device filter.
    expect(r.direct.by_device.map((d) => d.device)).toEqual(["desktop", "mobile", null]);
    // The other panels ignore it.
    expect(r.totals.visits).toBe(9);
    expect((await read({}, { view: "app" })).direct.totals).toEqual(c(1, 1, 1));
    expect((await read({}, { device: "none" })).direct.totals).toEqual(c(1, 1, 0));
    expect((await read({}, { view: "none" })).direct.totals).toEqual(c(1, 1, 0));
    const landing = await read({}, { landing: "/" });
    expect(landing.direct.totals).toEqual(c(7, 8, 2));
    expect(landing.direct.by_landing.other).toEqual({
      pages: 1,
      visits: 1,
      page_views: 1,
      conversions: 0,
    });
  });

  it("the page's filters: country and page narrow it; source, name and version keep all or none", async () => {
    const az = await read({ country: "AZ" });
    expect(az.direct.totals).toEqual(c(2, 3, 2));
    // by_country leaves out the country filter.
    expect(az.direct.by_country.map((x) => x.country)).toEqual(["US", "AZ", "TR"]);
    // A page: the visits that viewed it, page views and clicks on it.
    const pricing = await read({ page: "/" });
    expect(pricing.direct.totals).toEqual(c(7, 7, 1));
    expect((await read({ source: "none" })).direct.totals).toEqual(c(8, 9, 2));
    expect((await read({ version: "as_built" })).direct.totals).toEqual(c(8, 9, 2));
    for (const f of [{ source: "ai" }, { version: "problem:ai" }, { version: "original" }]) {
      const r = await read(f);
      expect(r.direct.totals, JSON.stringify(f)).toEqual(c(0, 0, 0));
      expect(r.direct.by_device, JSON.stringify(f)).toEqual([]);
    }
  });

  it("a landing under the floor is refused, like a page", async () => {
    await expect(read({}, { landing: "/docs" })).rejects.toBeInstanceOf(VisitorsFloorError);
  });

  it("the switch off says so; the rows it has are read as stored", async () => {
    expect((await read({}, {}, { directOff: true })).direct.recording).toBe("off");
  });
});

describe("visits, not rows", () => {
  it("a visit's pages collapse into one visit; a row without a marker counts one each", async () => {
    visit(NOW - DAY, { pages: ["/", "/a", "/b"], converts: true });
    visit(NOW - DAY, { marker: false });
    visit(NOW - DAY, { marker: false });
    const r = await read();
    expect(r.direct.totals).toEqual(c(3, 5, 1));
    expect(r.direct.by_device).toEqual([{ device: "mobile", ...c(3, 5, 1) }]);
  });

  it("a click whose page view fell before the period counts, with no landing page", async () => {
    h.ev({
      ts: NOW - 30 * DAY,
      type: "no_signal_passthrough",
      visit: vid(99),
      cohort: "no_signal",
      device: "mobile",
    });
    h.ev({
      ts: NOW - DAY,
      type: "conversion",
      visit: vid(99),
      cohort: "no_signal",
      intent: null,
      source: null,
      device: "mobile",
    });
    const r = await read();
    expect(r.direct.totals).toEqual({ visits: 0, page_views: 0, conversions: 1, rate: null });
    expect(r.direct.by_landing).toEqual({
      pages: [],
      other: { pages: 0, visits: 0, page_views: 0, conversions: 1 },
    });
  });

  it("a sensitive customer's landing page is its group", async () => {
    for (let i = 0; i < 5; i++) visit(NOW - DAY, { pages: ["/products/ginseng", "/"] });
    const r = await read({}, {}, { sensitive: { sensitive: true, kept: ["/products"] } });
    expect(r.direct.by_landing.pages).toEqual([
      { page_path: "/products/:item", group: true, has_versions: false, ...c(5, 10, 0) },
    ]);
    expect(JSON.stringify(r.direct)).not.toContain("ginseng");
  });
});

describe("the endpoint and the switch", () => {
  const env = () => ({ ...h.env, DASHBOARD_ORIGIN: "*" }) as unknown as AdminEnv;
  const get = (q: string) => new Request(`https://api.test/admin/analytics/visitors?${q}`);
  const post = (body: unknown, to: "off" | "on" = "off") =>
    new Request(`https://api.test/admin/direct-insights/${to}`, {
      method: "POST",
      body: JSON.stringify(body),
    });

  it("device, view and landing are checked; the answer carries them", async () => {
    for (let i = 0; i < 5; i++) visit(NOW - DAY);
    const q = (s: string) =>
      handleVisitors(get(`customer_id=acme&${s}`), env(), superadmin as never, NOW);
    for (const bad of [
      "device=phone",
      "device=bot",
      "device=Mobile",
      "view=webview",
      "view=1",
      "landing=docs",
      "landing=/nowhere",
    ]) {
      expect((await q(bad)).status, bad).toBe(400);
    }
    const ok = await q("device=mobile&view=browser&landing=/");
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { direct: { filters: unknown; totals: { visits: number } } };
    expect(body.direct.filters).toEqual({ device: "mobile", view: "browser", landing: "/" });
    expect(body.direct.totals.visits).toBe(5);
  });

  it("parseDirectFilters: empty is not set", () => {
    expect(parseDirectFilters({ device: "", view: null })).toEqual({
      ok: true,
      filters: NO_DIRECT_FILTERS,
    });
  });

  it("off: the flag, the bundle's dx, this customer's facts NULLed and no one else's", async () => {
    visit(NOW - DAY, { webView: 1 });
    visit(NOW - DAY, { customer: "other", device: "desktop" });
    const res = await handleDirectInsightsSwitch(
      post({ customer_id: "acme" }),
      env(),
      superadmin as never,
      true,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      customer_id: "acme",
      direct_insights: "off",
      cleared: 1,
      done: true,
    });
    expect(
      h.db
        .prepare("SELECT direct_insights_off, country_off FROM customers WHERE id = 'acme'")
        .get(),
    ).toEqual({ direct_insights_off: 1, country_off: 0 });
    const bundle = JSON.parse(h.kv.get("v1:vm:acme") ?? "{}");
    expect(bundle.dx).toBe(1);
    expect(bundle).not.toHaveProperty("co");
    const left = h.db
      .prepare(
        "SELECT customer_id, device_class, web_view, country FROM events WHERE device_class IS NOT NULL OR web_view IS NOT NULL OR customer_id = 'acme'",
      )
      .all()
      .map((r) => ({ ...r }));
    expect(left).toEqual([
      { customer_id: "acme", device_class: null, web_view: null, country: "AZ" },
      { customer_id: "other", device_class: "desktop", web_view: 0, country: "AZ" },
    ]);
    const r = (await (
      await handleVisitors(get("customer_id=acme"), env(), superadmin as never, NOW)
    ).json()) as { direct: { recording: string; by_device: unknown[] } };
    expect(r.direct.recording).toBe("off");
    expect(r.direct.by_device).toEqual([{ device: null, ...c(1, 1, 0) }]);
    // On again: the bundle loses dx, nothing cleared comes back.
    const on = await handleDirectInsightsSwitch(
      post({ customer_id: "acme" }, "on"),
      env(),
      superadmin as never,
      false,
    );
    expect(await on.json()).toMatchObject({ direct_insights: "on", cleared: 0, done: true });
    expect(JSON.parse(h.kv.get("v1:vm:acme") ?? "{}")).not.toHaveProperty("dx");
  });

  it("a customer user for its own site only; a customer_id is required", async () => {
    const own = { id: "c", email: "c@acme.test", role: "customer", customer_id: "acme" };
    const call = (body: unknown, user: unknown) =>
      handleDirectInsightsSwitch(post(body), env(), user as never, true);
    expect((await call({ customer_id: "other" }, own)).status).toBe(403);
    expect((await call({}, superadmin)).status).toBe(400);
    expect((await call({ customer_id: "ghost" }, superadmin)).status).toBe(404);
    expect((await call({ customer_id: "acme" }, own)).status).toBe(200);
    expect(
      h.db.prepare("SELECT direct_insights_off FROM customers WHERE id = 'other'").get(),
    ).toEqual({ direct_insights_off: 0 });
  });

  it("the clear runs in chunks, by customer, and the 6-hour sweep finishes what a call left", async () => {
    for (let i = 0; i < 7; i++) visit(NOW - DAY);
    visit(NOW - DAY, { customer: "other" });
    expect(await clearDirectFacts(h.d1, "acme", { chunk: 2, maxStatements: 2 })).toEqual({
      cleared: 4,
      done: false,
    });
    h.db.prepare("UPDATE customers SET direct_insights_off = 1 WHERE id = 'acme'").run();
    expect(await clearSwitchedOffDirect(h.d1)).toEqual({ customers: 1, cleared: 3, errors: 0 });
    expect(
      h.db
        .prepare(
          "SELECT customer_id, COUNT(*) AS n FROM events WHERE device_class IS NOT NULL GROUP BY 1",
        )
        .all()
        .map((r) => ({ ...r })),
    ).toEqual([{ customer_id: "other", n: 1 }]);
    expect(DIRECT_CLEAR_SQL).not.toMatch(/\bts\b/);
  });
});

describe("static guards", () => {
  it("the direct statements filter the customer first and stay under the D1 size bound", () => {
    for (const sql of [VISITORS_DIRECT_SQL, VISITORS_DIRECT_SENSITIVE_SQL]) {
      expect(sql.length).toBeLessThanOrEqual(D1_STATEMENT_CHARS_MAX);
      for (const part of sql.split(/FROM events\b/).slice(1)) {
        expect(part).toMatch(/^\s*WHERE\s+customer_id\s*=\s*\?1/);
      }
      expect(sql).not.toMatch(/JOIN\s+(?!(?:l|w)\b)\w+/);
      expect(sql.split("SELECT k.p FROM kept").length - 1).toBeLessThanOrEqual(1);
      expect(sql.split(/SELECT l\.l lv,/)[1]).not.toMatch(/\bvisit\b/);
    }
  });
});
