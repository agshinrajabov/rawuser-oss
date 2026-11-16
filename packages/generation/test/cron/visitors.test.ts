/**
 * The Visitors read (docs/specs/visitors-page.md) on real SQL (node:sqlite,
 * every migration): visits not rows, each group distinct inside itself, the
 * country with no floor, the versions with `original` and `as_built`, the
 * crosses, the windows and their series, the page and name floors, a
 * sensitive customer's groups, the country switch, the export, and static
 * guards (statement size, customer first, no country in an alert or a
 * prompt).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { VisitorsFilters, VisitorsVersionBy } from "@rawuser/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearCountry,
  clearSwitchedOffCountries,
  handleCountrySwitch,
} from "../../src/admin/country.ts";
import { exportLines } from "../../src/admin/customer-data.ts";
import type { AdminEnv } from "../../src/admin/handlers.ts";
import { handleVisitors } from "../../src/admin/visitors.ts";
import { D1_STATEMENT_CHARS_MAX } from "../../src/lib/sensitive-pages.ts";
import {
  NO_FILTERS,
  VISITORS_EVENT_QUERIES,
  VisitorsFloorError,
  computeVisitors,
  parseVisitorsFilters,
  visitorsPeriod,
} from "../../src/lib/visitors.ts";
import { makeKv } from "../admin/sqlite-d1.ts";
import { DAY, HOUR, type Harness, harness, vid } from "../proof-harness.ts";

const NOW = Date.parse("2026-11-02T12:00:00Z");
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

type Cohort = "personalized" | "holdout" | "skipped" | "no_signal";

/** One visit: its pages (each a page view), optionally a click on its last page. */
function visit(
  ts: number,
  o: {
    cohort?: Cohort;
    intent?: string;
    source?: string;
    pages?: string[];
    converts?: boolean;
    country?: string | null;
    marker?: boolean;
    customer?: string;
    name?: string | null;
    /** The page of the click (default: the last page). */
    clickOn?: string;
    label?: string;
  } = {},
): string | null {
  const id = ++n;
  const cohort = o.cohort ?? "personalized";
  const type =
    cohort === "no_signal"
      ? "no_signal_passthrough"
      : cohort === "skipped"
        ? "personalization_skipped"
        : "variant_shown";
  const source = cohort === "no_signal" ? null : (o.source ?? "ai");
  const intent = cohort === "no_signal" ? null : (o.intent ?? "problem");
  const marker = o.marker === false ? null : vid(id);
  const country = o.country === undefined ? "AZ" : o.country;
  const pages = o.pages ?? ["/"];
  for (const [i, page] of pages.entries()) {
    h.ev({
      ts: ts + i * 1000,
      type,
      visit: marker,
      cohort,
      intent,
      source,
      page,
      country,
      customer: o.customer,
      name: o.name ?? null,
    });
  }
  if (o.converts) {
    h.ev({
      ts: ts + 30_000,
      type: "conversion",
      visit: marker,
      cohort,
      intent,
      source,
      page: o.clickOn ?? pages.at(-1),
      country,
      customer: o.customer,
      label: o.label,
    });
  }
  return marker;
}

const read = (
  window: "24h" | "7d" | "30d" | "90d" = "7d",
  sensitive = PLAIN,
  countryOff = false,
  filters: Partial<VisitorsFilters> = {},
  versionBy: VisitorsVersionBy = "version",
) =>
  computeVisitors(h.d1, {
    customerId: "acme",
    window,
    now: NOW,
    sensitive,
    countryOff,
    filters: { ...NO_FILTERS, ...filters },
    versionBy,
  });

describe("visits, not rows; each group distinct inside itself", () => {
  beforeEach(() => {
    // A: ChatGPT from the default country, two versioned pages, clicks on /pricing.
    visit(NOW - 2 * DAY, { pages: ["/", "/pricing"], converts: true });
    // The second page of A carries pricing:ai (the path page keeps the source).
    h.db.prepare("UPDATE events SET intent_dim = 'pricing' WHERE page_path = '/pricing'").run();
    // B: the test's comparison group, Türkiye.
    visit(NOW - 2 * DAY, { cohort: "holdout", country: "TR" });
    // C: no signal, the default country, clicks.
    visit(NOW - 3 * DAY, { cohort: "no_signal", converts: true });
    // D: kept as built, a row from before the country was recorded.
    visit(NOW - 3 * DAY, { cohort: "skipped", country: null });
    // Another customer's visit with A's marker: never counted here.
    h.ev({ ts: NOW - DAY, type: "variant_shown", visit: vid(1), customer: "other", country: "US" });
  });

  it("totals: 4 visits, 5 page views, 2 converting visits", async () => {
    const r = await read();
    expect(r.totals).toEqual({ visits: 4, page_views: 5, conversions: 2, rate: 0.5 });
    expect(r.markerless_page_views).toBe(0);
    expect(r.country_recording).toBe("on");
  });

  it("by country, with no floor: one visit from Türkiye shows; not recorded is null", async () => {
    const r = await read();
    expect(r.by_country).toEqual([
      { country: "AZ", visits: 2, page_views: 3, conversions: 2, rate: 1 },
      { country: "TR", visits: 1, page_views: 1, conversions: 0, rate: 0 },
      { country: null, visits: 1, page_views: 1, conversions: 0, rate: 0 },
    ]);
  });

  it("by version: intent:source, original for the comparison group, as_built for the rest", async () => {
    const r = await read();
    expect(r.by_version).toEqual([
      {
        version: "as_built",
        kind: "as_built",
        intent_dim: null,
        source_dim: null,
        visits: 2,
        page_views: 2,
        conversions: 1,
        rate: 0.5,
      },
      {
        version: "original",
        kind: "original",
        intent_dim: null,
        source_dim: null,
        visits: 1,
        page_views: 1,
        conversions: 0,
        rate: 0,
      },
      {
        version: "pricing:ai",
        kind: "version",
        intent_dim: "pricing",
        source_dim: "ai",
        visits: 1,
        page_views: 1,
        conversions: 1,
        rate: 1,
      },
      // The visit clicked on /pricing: its clicks count in every version it saw.
      {
        version: "problem:ai",
        kind: "version",
        intent_dim: "problem",
        source_dim: "ai",
        visits: 1,
        page_views: 1,
        conversions: 1,
        rate: 1,
      },
    ]);
  });

  it("by source: a visit across two versions is one ai visit; no signal is none", async () => {
    const r = await read();
    expect(
      r.by_source.map(({ source, visits, conversions }) => ({ source, visits, conversions })),
    ).toEqual([
      { source: "ai", visits: 3, conversions: 1 },
      { source: "none", visits: 1, conversions: 1 },
    ]);
  });

  it("the crosses: country by version and by source", async () => {
    const r = await read();
    const cv = r.country_by_version.map((x) => [x.country, x.version, x.visits, x.conversions]);
    expect(cv).toEqual([
      ["AZ", "as_built", 1, 1],
      ["AZ", "pricing:ai", 1, 1],
      ["AZ", "problem:ai", 1, 1],
      ["TR", "original", 1, 0],
      [null, "as_built", 1, 0],
    ]);
    const cs = r.country_by_source.map((x) => [x.country, x.source, x.visits, x.conversions]);
    expect(cs).toEqual([
      ["AZ", "ai", 1, 1],
      ["AZ", "none", 1, 1],
      ["TR", "ai", 1, 0],
      [null, "ai", 1, 0],
    ]);
  });

  it("by_version with version_by=source: the families, a visit across two intents once", async () => {
    const r = await read("7d", PLAIN, false, {}, "source");
    expect(r.version_by).toBe("source");
    expect(
      r.by_version.map((x) => [x.version, x.kind, x.intent_dim, x.source_dim, x.visits]),
    ).toEqual(
      [
        ["*:ai", "version", null, "ai", 1],
        ["as_built", "as_built", null, null, 2],
        ["original", "original", null, null, 1],
      ].sort((a, b) => Number(b[4]) - Number(a[4])),
    );
    expect(r.by_version.find((x) => x.version === "*:ai")).toMatchObject({
      page_views: 2,
      conversions: 1,
    });
  });

  it("pages: every page viewed, a click only on the page where it happened", async () => {
    const r = await read();
    // Under the floor here; the floor is lifted for the check below.
    expect(r.by_page.pages).toEqual([]);
    for (let i = 0; i < 5; i++) visit(NOW - DAY, { pages: ["/pricing"] });
    const after = await read();
    const pricing = after.by_page.pages.find((p) => p.page_path === "/pricing");
    // A viewed / and /pricing and clicked on /pricing: one visit on each page,
    // the click on /pricing only.
    expect(pricing).toMatchObject({ visits: 6, page_views: 6, conversions: 1 });
    expect(after.by_page.other).toEqual({ pages: 1, visits: 4, page_views: 4, conversions: 1 });
  });

  it("pages under 5 visits fold into other, and never leave with a country beside them", async () => {
    const r = await read();
    expect(r.by_page.pages).toEqual([]);
    expect(r.by_page.other).toEqual({ pages: 2, visits: 5, page_views: 5, conversions: 2 });
    expect(r.country_by_page).toEqual([]);
  });

  it("a page with 5 visits is listed, with has_versions from the confirmed manifest", async () => {
    for (let i = 0; i < 2; i++) visit(NOW - DAY, { country: "DE" });
    h.db
      .prepare(
        "INSERT INTO element_manifests (customer_id, page_path, manifest, source_url, generated_at, confirmed_at, language) VALUES ('acme', '/', '{}', 'https://acme.test/', 1, 1, 'en')",
      )
      .run();
    const r = await read();
    expect(r.by_page.pages).toEqual([
      {
        page_path: "/",
        group: false,
        has_versions: true,
        visits: 6,
        page_views: 6,
        conversions: 1,
        rate: 1 / 6,
      },
    ]);
    expect(r.by_page.other).toMatchObject({ pages: 1, visits: 1 });
    expect(r.country_by_page.map((x) => [x.country, x.page_path, x.visits])).toEqual([
      ["AZ", "/", 2],
      ["DE", "/", 2],
      ["TR", "/", 1],
      [null, "/", 1],
    ]);
  });
});

describe("filters: one row of a breakdown filters the page (the mock's click)", () => {
  beforeEach(() => {
    // GB: three ChatGPT visits on / then /fees; two click Book a call on /,
    // one clicks Send on /fees.
    for (let i = 0; i < 3; i++) {
      visit(NOW - DAY, {
        pages: ["/", "/fees"],
        country: "GB",
        name: "chatgpt",
        converts: i < 3,
        clickOn: i < 2 ? "/" : "/fees",
        label: i < 2 ? "book_call" : "send",
      });
    }
    // GB: two LinkedIn visits kept for the test, no click.
    for (let i = 0; i < 2; i++) {
      visit(NOW - DAY, { cohort: "holdout", source: "social", country: "GB", pages: ["/fees"] });
    }
    // US: four no-signal visits on /, one clicks Book a call.
    for (let i = 0; i < 4; i++) {
      visit(NOW - DAY, {
        cohort: "no_signal",
        country: "US",
        converts: i === 0,
        label: "book_call",
      });
    }
    // DE: one ChatGPT visit on /.
    visit(NOW - DAY, { country: "DE", name: "chatgpt", pages: ["/"] });
  });

  it("no filter: the totals, and the buttons with where their clicks came from", async () => {
    const r = await read();
    expect(r.filters).toEqual(NO_FILTERS);
    // 3 x 2 + 2 + 4 + 1 page views.
    expect(r.totals).toEqual({ visits: 10, page_views: 13, conversions: 4, rate: 0.4 });
    expect(r.by_button).toEqual([
      {
        label: "book_call",
        clicks: 3,
        top_source: { source: "ai", clicks: 2 },
        top_country: { country: "GB", clicks: 2 },
        top_version: { version: "problem:ai", kind: "version", clicks: 2 },
      },
      {
        label: "send",
        clicks: 1,
        top_source: { source: "ai", clicks: 1 },
        top_country: { country: "GB", clicks: 1 },
        top_version: { version: "problem:ai", kind: "version", clicks: 1 },
      },
    ]);
  });

  it("country=GB filters every panel but its own", async () => {
    const r = await read("7d", PLAIN, false, { country: "GB" });
    expect(r.filters.country).toBe("GB");
    expect(r.totals).toEqual({ visits: 5, page_views: 8, conversions: 3, rate: 0.6 });
    // The country panel keeps every country, to click another.
    expect(r.by_country.map((x) => [x.country, x.visits])).toEqual([
      ["GB", 5],
      ["US", 4],
      ["DE", 1],
    ]);
    expect(r.by_source.map((x) => [x.source, x.visits, x.conversions])).toEqual([
      ["ai", 3, 3],
      ["social", 2, 0],
    ]);
    expect(r.by_version.map((x) => [x.version, x.visits, x.conversions])).toEqual([
      ["problem:ai", 3, 3],
      ["original", 2, 0],
    ]);
    // The cross leaves out its own two dimensions: every country.
    expect(r.country_by_version.map((x) => x.country)).toContain("US");
    expect(r.by_button.map((b) => [b.label, b.clicks])).toEqual([
      ["book_call", 2],
      ["send", 1],
    ]);
  });

  it("a page filter counts that page's views and clicks only", async () => {
    const r = await read("7d", PLAIN, false, { page: "/fees" });
    // Five visits viewed /fees (three ChatGPT, two in the test); one clicked there.
    expect(r.totals).toEqual({ visits: 5, page_views: 5, conversions: 1, rate: 0.2 });
    expect(r.by_country.map((x) => [x.country, x.visits, x.conversions])).toEqual([["GB", 5, 1]]);
    // The page panel leaves its own filter out: both pages, clicks where they happened.
    expect(r.by_page.pages.map((p) => [p.page_path, p.visits, p.conversions])).toEqual([
      ["/", 8, 3],
      ["/fees", 5, 1],
    ]);
    expect(r.by_button).toEqual([expect.objectContaining({ label: "send", clicks: 1 })]);
  });

  it("source=none, version=as_built and country=none select the visits with none", async () => {
    expect((await read("7d", PLAIN, false, { source: "none" })).totals.visits).toBe(4);
    expect((await read("7d", PLAIN, false, { version: "as_built" })).totals.visits).toBe(4);
    expect((await read("7d", PLAIN, false, { version: "original" })).totals.visits).toBe(2);
    expect((await read("7d", PLAIN, false, { country: "none" })).totals.visits).toBe(0);
    const both = await read("7d", PLAIN, false, { country: "GB", version: "original" });
    expect(both.totals).toMatchObject({ visits: 2, conversions: 0 });
  });

  it("a name filter needs the name over its floor without filters", async () => {
    // ChatGPT: 4 visits, under 5.
    await expect(read("7d", PLAIN, false, { name: "chatgpt" })).rejects.toBeInstanceOf(
      VisitorsFloorError,
    );
    visit(NOW - DAY, { country: "FR", name: "chatgpt" });
    const r = await read("7d", PLAIN, false, { name: "chatgpt" });
    expect(r.totals.visits).toBe(5);
    // A name over the floor keeps its filtered numbers, however small.
    const gb = await read("7d", PLAIN, false, { country: "DE" });
    expect(gb.by_source[0]?.names).toEqual([
      { name: "chatgpt", label: "ChatGPT", visits: 1, conversions: 0 },
    ]);
  });

  it("a page filter under the floor is refused; nothing is read out", async () => {
    visit(NOW - DAY, { pages: ["/rare"] });
    await expect(read("7d", PLAIN, false, { page: "/rare" })).rejects.toBeInstanceOf(
      VisitorsFloorError,
    );
  });

  it("parseVisitorsFilters: the lists", () => {
    expect(parseVisitorsFilters({ country: "GB", page: "" }, "version")).toEqual({
      ok: true,
      filters: { ...NO_FILTERS, country: "GB" },
    });
    expect(parseVisitorsFilters({ country: "other" }, "version").ok).toBe(true);
    expect(parseVisitorsFilters({ version: "*:social" }, "source").ok).toBe(true);
    expect(parseVisitorsFilters({ version: "brand:paid" }, "version").ok).toBe(true);
    expect(parseVisitorsFilters({ version: "brand:paid:x" }, "version").ok).toBe(false);
  });
});

describe("the windows and the series", () => {
  it("the period starts at a UTC midnight (days) or hour (24h); the last bucket is now's", () => {
    expect(visitorsPeriod("7d", NOW)).toEqual({
      start: Date.parse("2026-10-27T00:00:00Z"),
      end: NOW,
    });
    expect(visitorsPeriod("24h", NOW)).toEqual({
      start: Date.parse("2026-11-01T13:00:00Z"),
      end: NOW,
    });
    expect(visitorsPeriod("90d", NOW).start).toBe(Date.parse("2026-08-05T00:00:00Z"));
  });

  it("90d reaches a 60-day-old visit that 30d does not; its marker is still there", async () => {
    visit(NOW - 60 * DAY);
    visit(NOW - DAY);
    expect((await read("30d")).totals.visits).toBe(1);
    expect((await read("90d")).totals.visits).toBe(2);
    expect((await read("90d")).markerless_page_views).toBe(0);
  });

  it("a row with no marker counts as a visit of its own, and is reported", async () => {
    visit(NOW - 40 * DAY, { pages: ["/", "/a", "/b"], marker: false });
    const r = await read("90d");
    expect(r.totals.visits).toBe(3);
    expect(r.markerless_page_views).toBe(3);
  });

  it("7 day buckets, empty ones as zeros, a visit across midnight in both days", async () => {
    const midnight = Date.parse("2026-10-31T00:00:00Z");
    visit(midnight - 500, { pages: ["/", "/a"] }); // 23:59:59.5 and 00:00:00.5
    visit(NOW - HOUR, { converts: true });
    const r = await read("7d");
    expect(r.series.bucket).toBe("day");
    expect(r.series.points).toHaveLength(7);
    expect(r.series.points[0]?.start).toBe(Date.parse("2026-10-27T00:00:00Z"));
    const by = Object.fromEntries(
      r.series.points.map((p) => [new Date(p.start).toISOString().slice(0, 10), p.visits]),
    );
    expect(by).toEqual({
      "2026-10-27": 0,
      "2026-10-28": 0,
      "2026-10-29": 0,
      "2026-10-30": 1,
      "2026-10-31": 1,
      "2026-11-01": 0,
      "2026-11-02": 1,
    });
    // The total counts the crossing visit once; the days count it on each.
    expect(r.totals.visits).toBe(2);
    expect(r.series.points.at(-1)).toMatchObject({ conversions: 1, rate: 1 });
  });

  it("24 hour buckets for 24h", async () => {
    visit(NOW - 30 * 60 * 1000);
    visit(NOW - 25 * HOUR);
    const r = await read("24h");
    expect(r.series.bucket).toBe("hour");
    expect(r.series.points).toHaveLength(24);
    // 11:30 falls in the 11:00 bucket; 12:00 (now) opens the last one.
    expect(r.series.points.at(-1)).toMatchObject({ start: NOW, visits: 0 });
    expect(r.series.points.at(-2)).toMatchObject({ start: NOW - HOUR, visits: 1 });
    expect(r.totals.visits).toBe(1);
  });
});

describe("names, countries off the list, a sensitive customer", () => {
  it("a platform name shows inside its source with 5 visits, not with 4", async () => {
    for (let i = 0; i < 5; i++) visit(NOW - DAY, { name: "chatgpt" });
    for (let i = 0; i < 4; i++) visit(NOW - DAY, { name: "perplexity" });
    const ai = (await read()).by_source.find((s) => s.source === "ai");
    expect(ai?.names).toEqual([{ name: "chatgpt", label: "ChatGPT", visits: 5, conversions: 0 }]);
    expect(ai?.visits).toBe(9);
  });

  it("a stored value off the closed list is read as not recorded", async () => {
    visit(NOW - DAY, { country: "Lisbon" });
    visit(NOW - DAY, { country: null });
    expect((await read()).by_country).toEqual([
      { country: null, visits: 2, page_views: 2, conversions: 0, rate: 0 },
    ]);
  });

  it("a sensitive customer's product page is its group, even on a row stored before the mark", async () => {
    for (let i = 0; i < 5; i++) visit(NOW - DAY, { pages: ["/products/ginseng"], country: "GE" });
    const r = await read("7d", { sensitive: true, kept: ["/products"] });
    expect(r.by_page.pages.map((p) => [p.page_path, p.group, p.visits])).toEqual([
      ["/products/:item", true, 5],
    ]);
    expect(JSON.stringify(r)).not.toContain("ginseng");
    expect(r.country_by_page).toMatchObject([{ country: "GE", page_path: "/products/:item" }]);
  });
});

describe("the endpoint and the switch", () => {
  const env = () => ({ ...h.env, DASHBOARD_ORIGIN: "*" }) as unknown as AdminEnv;
  const get = (q: string) => new Request(`https://api.test/admin/analytics/visitors?${q}`);
  const post = (body: unknown, to: "off" | "on" = "off") =>
    new Request(`https://api.test/admin/country/${to}`, {
      method: "POST",
      body: JSON.stringify(body),
    });

  it("customer-scoped; a bad window is 400", async () => {
    const own = { id: "c", email: "c@acme.test", role: "customer", customer_id: "acme" };
    expect((await handleVisitors(get("customer_id=acme"), env(), own as never, NOW)).status).toBe(
      200,
    );
    expect((await handleVisitors(get("customer_id=other"), env(), own as never, NOW)).status).toBe(
      403,
    );
    expect(
      (await handleVisitors(get("customer_id=acme&window=1y"), env(), superadmin as never, NOW))
        .status,
    ).toBe(400);
    expect(
      (await handleVisitors(get("customer_id=ghost"), env(), superadmin as never, NOW)).status,
    ).toBe(404);
  });

  it("off: the flag, the bundle's co, this customer's countries NULLed and no one else's", async () => {
    visit(NOW - DAY, { country: "AZ" });
    visit(NOW - DAY, { country: "US", customer: "other" });
    const res = await handleCountrySwitch(
      post({ customer_id: "acme" }),
      env(),
      superadmin as never,
      true,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      customer_id: "acme",
      country_recording: "off",
      cleared: 1,
      done: true,
    });
    expect(h.db.prepare("SELECT country_off FROM customers WHERE id = 'acme'").get()).toEqual({
      country_off: 1,
    });
    expect(JSON.parse(h.kv.get("v1:vm:acme") ?? "{}").co).toBe(1);
    const left = h.db
      .prepare("SELECT customer_id, country FROM events WHERE country IS NOT NULL")
      .all()
      .map((r) => ({ ...r }));
    expect(left).toEqual([{ customer_id: "other", country: "US" }]);
    // The read says so.
    const r = (await (
      await handleVisitors(get("customer_id=acme"), env(), superadmin as never, NOW)
    ).json()) as { country_recording: string; by_country: unknown[] };
    expect(r.country_recording).toBe("off");
    expect(r.by_country).toEqual([
      { country: null, visits: 1, page_views: 1, conversions: 0, rate: 0 },
    ]);
    // On again: the bundle loses co, nothing cleared comes back.
    const on = await handleCountrySwitch(
      post({ customer_id: "acme" }, "on"),
      env(),
      superadmin as never,
      false,
    );
    expect(await on.json()).toMatchObject({ country_recording: "on", cleared: 0, done: true });
    expect(h.db.prepare("SELECT country_off FROM customers WHERE id = 'acme'").get()).toEqual({
      country_off: 0,
    });
    expect(JSON.parse(h.kv.get("v1:vm:acme") ?? "{}")).not.toHaveProperty("co");
  });

  it("the switch: a customer user for its own site only; a customer_id is required", async () => {
    const own = { id: "c", email: "c@acme.test", role: "customer", customer_id: "acme" };
    const call = (body: unknown, user: unknown) =>
      handleCountrySwitch(post(body), env(), user as never, true);
    expect((await call({ customer_id: "other" }, own)).status).toBe(403);
    expect((await call({}, superadmin)).status).toBe(400);
    expect((await call({ customer_id: "ghost" }, superadmin)).status).toBe(404);
    expect((await call({ customer_id: "acme" }, own)).status).toBe(200);
    expect(h.db.prepare("SELECT country_off FROM customers WHERE id = 'other'").get()).toEqual({
      country_off: 0,
    });
  });

  it("the routes: POST /admin/country/off and /on reach the switch", () => {
    const routes = readFileSync(resolve(__dirname, "../../src/admin/routes.ts"), "utf8");
    expect(routes).toContain('pathname === "/admin/country/off" && method === "POST"');
    expect(routes).toContain('pathname === "/admin/country/on" && method === "POST"');
    expect(routes).toContain('pathname === "/admin/analytics/visitors" && method === "GET"');
  });

  it("filters: a bad value or a page under the floor is 400; version_by is checked", async () => {
    const q = (s: string) =>
      handleVisitors(get(`customer_id=acme&${s}`), env(), superadmin as never, NOW);
    for (const bad of [
      "country=Lisbon",
      "country=gb",
      "source=google",
      "name=example.com",
      "version=problem",
      "version=problem:google",
      "version=*:ai",
      "page=fees",
      "version_by=intent",
    ]) {
      const res = await q(bad);
      expect(res.status, bad).toBe(400);
    }
    expect((await q("version_by=source&version=*:ai")).status).toBe(200);
    expect((await q("version_by=source&version=problem:ai")).status).toBe(400);
    // A page with no visits, and a name with none: never shown, so refused.
    expect((await q("page=/nowhere")).status).toBe(400);
    expect((await q("name=chatgpt")).status).toBe(400);
    expect((await q("country=none&source=none&version=as_built")).status).toBe(200);
  });

  it("the clear runs in chunks and the 6-hour sweep finishes what a call left", async () => {
    for (let i = 0; i < 7; i++) visit(NOW - DAY);
    const first = await clearCountry(h.d1, "acme", { chunk: 2, maxStatements: 2 });
    expect(first).toEqual({ cleared: 4, done: false });
    h.db.prepare("UPDATE customers SET country_off = 1 WHERE id = 'acme'").run();
    expect(await clearSwitchedOffCountries(h.d1)).toEqual({ customers: 1, cleared: 3, errors: 0 });
    expect(
      h.db.prepare("SELECT COUNT(*) AS n FROM events WHERE country IS NOT NULL").get(),
    ).toEqual({ n: 0 });
  });
});

describe("the export never carries the country (ADR 0036; ruling condition 4)", () => {
  it("events.country is redacted on every row", async () => {
    visit(NOW - DAY, { country: "AZ", converts: true });
    const lines: string[] = [];
    const env = { DB: h.d1, VARIANTS: makeKv() };
    for await (const l of exportLines(env as never, "acme", new Date(NOW))) lines.push(l);
    const events = lines.map((l) => JSON.parse(l)).filter((l) => l.table === "events");
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      const row = e.row ?? e;
      expect(row.country).not.toBe("AZ");
    }
    expect(lines.join("\n")).not.toContain('"AZ"');
    expect(JSON.parse(lines[0] ?? "{}").redacted).toContain("events.country");
  });
});

describe("static guards", () => {
  it("every statement filters the customer first and stays under the D1 size bound", () => {
    for (const sql of VISITORS_EVENT_QUERIES) {
      expect(sql.length).toBeLessThanOrEqual(D1_STATEMENT_CHARS_MAX);
      for (const part of sql.split(/FROM events\b/).slice(1)) {
        expect(part, sql.slice(0, 60)).toMatch(/^\s*WHERE\s+customer_id\s*=\s*\?1/);
      }
      // Only the window's own CTEs are joined: no other table.
      expect(sql).not.toMatch(/JOIN\s+(?!(?:l|w)\b)\w+/);
      // The stored-path CASE at most once, over the base column.
      expect(sql.split("SELECT k.p FROM kept").length - 1).toBeLessThanOrEqual(1);
      // The marker is in no result column.
      expect(sql.split(/SELECT l\.l lv,/)[1]).not.toMatch(/\bvisit\b/);
    }
  });

  it("no alert and no model call is in a file that names the country", () => {
    const SRC = resolve(__dirname, "../../src");
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((f) => {
        const p = join(dir, f);
        return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
      });
    const sends = /callModel\(|generateVariant\(|sendOpsAlert\(|sendAlert\(|ALERT_WEBHOOK_URL/;
    const naming = files(SRC)
      .filter((f) => /\bcountry\b/i.test(readFileSync(f, "utf8")))
      .map((f) => relative(SRC, f))
      .sort();
    expect(naming).toEqual([
      "admin/apply-brief.ts", // a language tag's region, in a comment
      "admin/country.ts",
      "admin/customer-data.ts",
      "admin/onboard.ts",
      "admin/routes.ts",
      "admin/visitors.ts",
      // Market versions (docs/specs/direct-visitors.md §5): the customer's
      // visit totals by country choose its markets; no row, no send.
      "cron/direct-answers.ts",
      "index.ts",
      "inline-shape-backfill.ts", // a site that redirects by country, in a comment
      "lib/visitors.ts",
      // A market version's lint and prompt name a market (a customer-level
      // choice, never a visitor's country); neither sends anything itself.
      "lint/market-addressed.ts",
      "prompts/market.ts",
    ]);
    for (const f of naming) {
      if (f === "index.ts") continue; // the cron entry: checked below
      const src = readFileSync(join(SRC, f), "utf8");
      expect(src, f).not.toMatch(sends);
    }
    // index.ts names it only for the switch's sweep, whose log line holds counts.
    const index = readFileSync(join(SRC, "index.ts"), "utf8");
    const lines = index.split("\n").filter((l) => /\bcountry\b/i.test(l));
    for (const l of lines) expect(l).not.toMatch(sends);
  });
});
