/**
 * The ad keyword in the snippet (docs/specs/keyword-intent.md; privacy review
 * section 9, answer 3): with the script's `nt: 1` (the customer's edge does
 * not read the keyword) utm_term stays on the page; every other utm_* still
 * goes. Without `nt` (a customer with a lexicon, or the generic tag) it is
 * forwarded as before.
 */
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parsing } from "./helpers.ts";

const EDGE = "https://edge.test";
const PAGE =
  "https://site.test/?utm_source=google&utm_medium=cpc&utm_term=crm%20pricing&UTM_Term=other&gclid=abc";
let requests: string[];
let inits: (RequestInit | undefined)[];
let bodies: string[];

function page(cfg: Record<string, unknown>) {
  const dom = new JSDOM(
    `<!doctype html><html><head></head><body><h1 class="hero">Old headline</h1></body></html>`,
    { url: PAGE },
  );
  const w = dom.window;
  parsing(w.document);
  for (const [k, v] of [
    ["window", w],
    ["document", w.document],
    ["location", w.location],
    ["history", w.history],
    ["sessionStorage", w.sessionStorage],
    ["navigator", { language: "en", sendBeacon: undefined }],
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
  vi.stubGlobal("fetch", (u: string, init?: RequestInit) => {
    requests.push(u);
    inits.push(init);
    if (typeof init?.body === "string") bodies.push(init.body);
    if (u.startsWith(`${EDGE}/select`)) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            source: "original",
            variant_key: "",
            variant: null,
            cohort: "no_signal",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }
    return Promise.resolve(new Response(null, { status: 202 }));
  });
  return w;
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  requests = [];
  inits = [];
  bodies = [];
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function selectUrl(cfg: Record<string, unknown>): Promise<URL> {
  page(cfg);
  await import("../src/index.ts");
  await vi.advanceTimersByTimeAsync(3000);
  const asked = requests.find((u) => u.startsWith(`${EDGE}/select`));
  expect(asked).toBeDefined();
  return new URL(asked as string);
}

const termKeys = (u: URL) =>
  [...u.searchParams.keys()].filter((k) => k.toLowerCase() === "utm_term");

describe("utm_term and the script's nt", () => {
  it("nt 1: no utm_term in any case, the other utm and the click-id name still go", async () => {
    const u = await selectUrl({ c: "acme", e: EDGE, h: {}, nt: 1 });
    expect(termKeys(u)).toEqual([]);
    expect(u.search).not.toContain("crm");
    expect(u.searchParams.get("utm_source")).toBe("google");
    expect(u.searchParams.get("utm_medium")).toBe("cpc");
    expect(u.searchParams.get("clk")).toBe("gclid");
  });

  it("without nt: utm_term forwarded as before", async () => {
    const u = await selectUrl({ c: "acme", e: EDGE, h: {} });
    expect(u.searchParams.get("utm_term")).toBe("crm pricing");
    expect(u.searchParams.get("utm_source")).toBe("google");
  });

  it("nt of any other value is not nt", async () => {
    const u = await selectUrl({ c: "acme", e: EDGE, h: {}, nt: 0 });
    expect(u.searchParams.get("utm_term")).toBe("crm pricing");
  });
});

describe("the keyword leaves the page only on /select, and only without nt", () => {
  it("the /select fetch sends no Referer, so the page's URL never rides along", async () => {
    await selectUrl({ c: "acme", e: EDGE, h: {}, nt: 1 });
    const i = requests.findIndex((u) => u.startsWith(`${EDGE}/select`));
    expect(inits[i]?.referrerPolicy).toBe("no-referrer");
  });

  it.each([
    ["nt 1", { c: "acme", e: EDGE, h: {}, nt: 1 }],
    ["without nt", { c: "acme", e: EDGE, h: {} }],
  ] as const)("%s: no other request, body or tab storage holds the keyword", async (_n, cfg) => {
    const w = page(cfg);
    await import("../src/index.ts");
    await vi.advanceTimersByTimeAsync(3000);
    const others = requests.filter((u) => !u.startsWith(`${EDGE}/select`));
    for (const u of others) expect(decodeURIComponent(u)).not.toContain("crm pricing");
    for (const b of bodies) expect(b).not.toContain("crm");
    const stored: string[] = [];
    for (let k = 0; k < w.sessionStorage.length; k++) {
      const key = w.sessionStorage.key(k) as string;
      stored.push(`${key}=${w.sessionStorage.getItem(key)}`);
    }
    expect(stored.join("\n")).not.toContain("crm");
  });
});
