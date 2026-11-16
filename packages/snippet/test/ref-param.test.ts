/**
 * The referrer the snippet sends to /select (privacy review condition 1 on
 * Layer G, 2026-10-03): scheme and host only, nothing for this same
 * hostname. A page two after a Klaviyo landing has a referrer carrying
 * ?_kx=<recipient token>; that value must never reach the edge.
 */
import { extractSignals } from "@rawuser/shared";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchVariant, refParam } from "../src/fetch.ts";

const EDGE = "https://edge.test";
const TOKEN = "AAAAbbbb1111CCCC-dddd2222EEEEffff3333GGGGhh";

/** Loads a page and returns the /select URL fetchVariant asks for. */
async function selectUrl(pageUrl: string, referrer?: string): Promise<URL> {
  const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
    url: pageUrl,
    ...(referrer ? { referrer } : {}),
  });
  const w = dom.window;
  vi.stubGlobal("window", w);
  vi.stubGlobal("document", w.document);
  vi.stubGlobal("location", w.location);
  vi.stubGlobal("sessionStorage", w.sessionStorage);
  vi.stubGlobal("navigator", { language: "en" });
  let asked = "";
  vi.stubGlobal("fetch", (url: string) => {
    asked = url;
    return Promise.resolve(
      new Response(JSON.stringify({ source: "original", variant: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  });
  await fetchVariant("acme", EDGE);
  return new URL(asked);
}

afterEach(() => vi.unstubAllGlobals());

describe("refParam", () => {
  it("keeps scheme and host, drops path, query and fragment", () => {
    expect(refParam(`https://news.example/a/b?_kx=${TOKEN}#x`, "shop.example")).toBe(
      "https://news.example",
    );
    expect(refParam("https://news.example:8443/p?q=1", "shop.example")).toBe(
      "https://news.example:8443",
    );
  });

  it("sends nothing for a referrer on this same hostname", () => {
    expect(refParam(`https://shop.example/landing?_kx=${TOKEN}`, "shop.example")).toBeNull();
  });

  it("keeps an android-app package (URL.origin would be 'null')", () => {
    expect(new URL("android-app://com.facebook.katana/").origin).toBe("null");
    const ref = refParam("android-app://com.facebook.katana/", "shop.example");
    expect(ref).toBe("android-app://com.facebook.katana");
    // The edge still reads it as the package.
    const url = new URL("https://edge.test/select");
    url.searchParams.set("ref", ref ?? "");
    const signals = extractSignals({ url, headers: new Headers(), selfHost: "shop.example" });
    expect(signals.referrerHost).toBe("com.facebook.katana");
    expect(signals.referrerIsApp).toBe(true);
  });

  it("returns null for an empty or unparseable referrer", () => {
    expect(refParam("", "shop.example")).toBeNull();
    expect(refParam("not a url", "shop.example")).toBeNull();
  });
});

describe("the /select URL", () => {
  it("a page two whose referrer carries ?_kx=V never puts V in the URL", async () => {
    const u = await selectUrl(
      "https://shop.example/pricing",
      `https://shop.example/?_kx=${TOKEN}&utm_source=klaviyo`,
    );
    expect(u.toString()).not.toContain(TOKEN);
    expect(u.searchParams.has("ref")).toBe(false);
    expect(u.searchParams.get("self_host")).toBe("shop.example");
  });

  it("a cross-site referrer with a query goes as its origin only", async () => {
    const u = await selectUrl(
      "https://shop.example/",
      `https://news.example/item?id=1&_kx=${TOKEN}`,
    );
    expect(u.searchParams.get("ref")).toBe("https://news.example");
    expect(u.toString()).not.toContain(TOKEN);
  });

  it("?_kx=V on the landing page yields clk=_kx and no V", async () => {
    const u = await selectUrl(`https://shop.example/?_kx=${TOKEN}`);
    expect(u.searchParams.get("clk")).toBe("_kx");
    expect(u.toString()).not.toContain(TOKEN);
  });
});

describe("ss=1: a page reached from this same site (results-data §7)", () => {
  it("the site's own hero link with utm: one presence bit, never the referrer", async () => {
    const u = await selectUrl(
      "https://school.lumera.test/start?utm_source=home&utm_medium=hero",
      `https://school.lumera.test/?_kx=${TOKEN}`,
    );
    expect(u.searchParams.get("ss")).toBe("1");
    expect(u.searchParams.has("ref")).toBe(false);
    expect(u.toString()).not.toContain(TOKEN);
    expect(u.toString()).not.toContain("lumera.test%2F");
    // the utm still go: the edge decides what they mean
    expect(u.searchParams.get("utm_source")).toBe("home");
  });

  it("no bit for another site's referrer or none", async () => {
    expect(
      (
        await selectUrl("https://shop.example/?utm_source=x", "https://news.example/")
      ).searchParams.has("ss"),
    ).toBe(false);
    expect((await selectUrl("https://shop.example/?utm_source=x")).searchParams.has("ss")).toBe(
      false,
    );
  });

  it("the tab's copy may be written early: the site's own utm are not a signal", async () => {
    const { ownSignal } = await import("../src/fetch.ts");
    expect(
      ownSignal(
        { search: "?utm_source=home&utm_medium=hero", hostname: "a.com" },
        "https://a.com/",
      ),
    ).toBe(false);
    expect(ownSignal({ search: "?utm_source=home", hostname: "a.com" }, "")).toBe(true);
  });
});
