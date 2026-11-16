/**
 * The free AI-traffic audit in the snippet (docs/specs/ai-traffic-audit.md
 * §3.4, §3.8; privacy review conditions 1 and 2 of 2026-10-06):
 *
 * - the customer script carries `ad` and `ae`; the snippet compares
 *   `location.hostname` and the clock before it draws a visit marker or
 *   sends anything, so a copied tag on another site, or a tag past the
 *   audit's end, writes no key, makes no request and leaves the page as
 *   built, and removes what an earlier load of ours kept in the tab;
 * - on its own host the audit runs as for any customer, and `found_by`
 *   rides on every event of the page, conversions included.
 */
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parsing } from "./helpers.ts";

const EDGE = "https://edge.test";
const NOW = Date.parse("2026-10-10T12:00:00Z");
const DAY = 24 * 3600 * 1000;
const CONV = [
  {
    section_path: "hero.cta",
    conversion_label: "signup",
    css: ["a.cta"],
    text: [],
    structural: "",
  },
];
const treat = {
  source: "kv",
  cohort: "personalized",
  variant_key: "v1:variant:audit-co:problem:ai",
  selection: { intent_dim: "problem", source_dim: "ai", confidence: 0.8 },
  variant: {
    customer_id: "audit-co",
    profile_key: "intent:problem",
    sections: { hero: { kind: "hero", headline: "New headline" } },
    generated_at: 0,
    prompt_hash: "h",
  },
  targets: { "hero.headline": { css: ["h1.hero"], text: [], structural: "" } },
  source_name: "chatgpt",
  found_by: "auto_tag",
  conversion_targets: CONV,
};

let requests: string[];
let sent: Record<string, unknown>[];
let inits: { url: string; init: RequestInit }[];

let beacons: string[];

function page(url: string, cfg: Record<string, unknown>, seedKeys = false, head = "") {
  const dom = new JSDOM(
    `<!doctype html><html><head>${head}</head><body><h1 class="hero">Old headline</h1><a class="cta" href="#">Start</a></body></html>`,
    { url },
  );
  const w = dom.window;
  parsing(w.document);
  for (const [k, v] of [
    ["window", w],
    ["document", w.document],
    ["location", w.location],
    ["history", w.history],
    ["sessionStorage", w.sessionStorage],
    [
      "navigator",
      {
        language: "en",
        sendBeacon: (u: string) => {
          beacons.push(u);
          return true;
        },
      },
    ],
    ["MutationObserver", w.MutationObserver],
    ["Element", w.Element],
    ["Node", w.Node],
    ["HTMLElement", w.HTMLElement],
    ["HTMLAnchorElement", w.HTMLAnchorElement],
    ["HTMLButtonElement", w.HTMLButtonElement],
    ["getComputedStyle", w.getComputedStyle.bind(w)],
    ["PerformanceObserver", undefined],
  ] as const) {
    vi.stubGlobal(k, v);
  }
  (w as unknown as { __rw: unknown }).__rw = cfg;
  if (seedKeys) {
    w.sessionStorage.setItem("__rw_visit", JSON.stringify({ v: "a".repeat(32), t: NOW }));
    w.sessionStorage.setItem("__rw_carry", JSON.stringify({ i: "problem", s: "ai", t: NOW }));
    w.sessionStorage.setItem("__rw_body", JSON.stringify({ t: NOW, p: {} }));
  }
  vi.stubGlobal("fetch", (u: string, init?: RequestInit) => {
    requests.push(u);
    if (u.startsWith(`${EDGE}/select`)) {
      return Promise.resolve(
        new Response(JSON.stringify(treat), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    if (u.startsWith(`${EDGE}/event`)) {
      sent.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      inits.push({ url: u, init: init ?? {} });
    }
    return Promise.resolve(new Response(null, { status: 202 }));
  });
  return w;
}

const keys = (w: Window) =>
  ["__rw_visit", "__rw_carry", "__rw_body"].filter((k) => w.sessionStorage.getItem(k) !== null);

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(NOW);
  requests = [];
  sent = [];
  inits = [];
  beacons = [];
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function boot() {
  await import("../src/index.ts");
  await vi.advanceTimersByTimeAsync(8000);
}

const AUDIT = { c: "audit-co", e: EDGE, h: { "/": ["h1.hero"] }, ad: "example.com", ae: NOW + DAY };

describe("a copied tag on another host", () => {
  for (const url of [
    "https://copycat.test/",
    "https://badexample.com/",
    "https://example.com.evil.test/",
  ]) {
    it(`writes no visit marker, asks nothing, hides nothing (${url})`, async () => {
      const w = page(url, AUDIT);
      await boot();
      expect(requests).toEqual([]);
      expect(keys(w as unknown as Window)).toEqual([]);
      expect(w.sessionStorage.length).toBe(0);
      expect(document.getElementById("__rawuser-hide")).toBeNull();
      expect(document.querySelector("h1")?.textContent).toBe("Old headline");
      history.pushState({}, "", "/pricing");
      await vi.advanceTimersByTimeAsync(5000);
      expect(requests).toEqual([]);
    });
  }

  it("a malformed audit (ad '') matches no host", async () => {
    const w = page("https://example.com/", { ...AUDIT, ad: "" });
    await boot();
    expect(requests).toEqual([]);
    expect(w.sessionStorage.length).toBe(0);
  });
});

describe("an audit past its end", () => {
  it("on its own host: no request, no marker, and the tab's keys removed", async () => {
    const w = page("https://example.com/", { ...AUDIT, ae: NOW }, true);
    await boot();
    expect(requests).toEqual([]);
    expect(keys(w as unknown as Window)).toEqual([]);
    expect(document.getElementById("__rawuser-hide")).toBeNull();
    expect(document.querySelector("h1")?.textContent).toBe("Old headline");
  });
});

describe("an audit on its own host", () => {
  for (const url of ["https://example.com/", "https://www.example.com/"]) {
    it(`runs as for any customer and repeats found_by on every event (${url})`, async () => {
      const w = page(url, AUDIT);
      await boot();
      expect(requests.filter((u) => u.startsWith(`${EDGE}/select`))).toHaveLength(1);
      expect(document.querySelector("h1")?.textContent).toBe("New headline");
      expect(keys(w as unknown as Window)).toContain("__rw_visit");
      const shown = sent.filter((e) => e.event_type === "variant_shown");
      expect(shown).toHaveLength(1);
      expect(shown[0]).toMatchObject({ source_name: "chatgpt", found_by: "auto_tag" });
      (document.querySelector("a.cta") as HTMLElement).dispatchEvent(
        new w.MouseEvent("click", { bubbles: true }),
      );
      const conv = sent.filter((e) => e.event_type === "conversion");
      expect(conv).toHaveLength(1);
      expect(conv[0]).toMatchObject({ conversion_label: "signup", found_by: "auto_tag" });
    });
  }

  it("a customer not under audit is unchanged (no ad, no ae)", async () => {
    page("https://anything.test/", { c: "acme", e: EDGE, h: { "/": ["h1.hero"] } });
    await boot();
    expect(requests.filter((u) => u.startsWith(`${EDGE}/select`))).toHaveLength(1);
  });
});

describe("conversions under a strict Referrer-Policy (no-referrer, same-origin)", () => {
  // A beacon is a no-cors request: under these policies its Origin is
  // "null" and the edge drops an audit customer's row. The conversion now
  // leaves by a keepalive fetch in CORS mode, text/plain (no preflight), no
  // credentials, whose Origin is the page's whatever the policy.
  const cases: [string, Record<string, unknown>, string][] = [
    ["an audit customer", AUDIT, "https://example.com/"],
    ["a pilot", { c: "acme", e: EDGE, h: { "/": ["h1.hero"] } }, "https://pilot.test/"],
  ];
  for (const policy of ["no-referrer", "same-origin"]) {
    for (const [who, cfg, url] of cases) {
      it(`${who}: the click goes as a CORS keepalive fetch, never a beacon (${policy})`, async () => {
        const w = page(url, cfg, false, `<meta name="referrer" content="${policy}">`);
        await boot();
        (document.querySelector("a.cta") as HTMLElement).dispatchEvent(
          new w.MouseEvent("click", { bubbles: true }),
        );
        expect(beacons).toEqual([]);
        const conv = inits.filter(
          (r) =>
            (JSON.parse(String(r.init.body)) as { event_type?: string }).event_type ===
            "conversion",
        );
        expect(conv).toHaveLength(1);
        const init = conv[0]?.init ?? {};
        expect(init.keepalive).toBe(true);
        expect(init.mode).toBeUndefined();
        expect(init.credentials).toBe("omit");
        expect((init.headers as Record<string, string>)["content-type"]).toBe(
          "text/plain;charset=UTF-8",
        );
        expect(JSON.parse(String(init.body))).toMatchObject({ conversion_label: "signup" });
      });
    }
  }
});
