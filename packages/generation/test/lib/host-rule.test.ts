/**
 * The host rule (docs/specs/site-shaped-intents.md §13.2 point 4, the /bot
 * page): every server read of a customer's site follows redirects only on
 * the recorded host, www and the apex counted as one site. A redirect to
 * another host is never fetched. The per-caller tests sit with each caller
 * (quickstart, onboard, apply, apply-render, sweep, snippet-probe,
 * render-page); this file covers the fetcher and the readers without a
 * handler test of their own.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { handleDnaSuggest } from "../../src/admin/dna-suggest.ts";
import { fetchPageHtml } from "../../src/detect-elements.ts";
import {
  OFF_HOST_LINE,
  OffHostRedirectError,
  sameSite,
  siteHost,
} from "../../src/lib/public-url.ts";
import { fetchInstallFacts } from "../../src/lib/read-page.ts";
import { loadPageSamples } from "../../src/page-samples.ts";
import { FETCHER_UA, INSTALL_ENV } from "../install-env.ts";

const PAGE = `<html><body><h1>Northwind</h1><p>${"Northwind keeps your team's notes in one place. ".repeat(4)}</p></body></html>`;

/** The site redirects from its first address to `location`, then serves PAGE anywhere. */
function stubSite(location: string | null) {
  const fetched: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = String(input);
      if (new URL(u).hostname === "cloudflare-dns.com") {
        return Response.json({ Status: 0, Answer: [{ type: 1, data: "93.184.216.34" }] });
      }
      fetched.push(u);
      expect(init?.redirect).toBe("manual");
      if (fetched.length === 1 && location) {
        return new Response(null, { status: 301, headers: { location } });
      }
      return new Response(PAGE, { status: 200 });
    }),
  );
  return fetched;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("siteHost and sameSite", () => {
  it("reduce a recorded domain or a typed address to its host", () => {
    expect(siteHost("Example.com")).toBe("example.com");
    expect(siteHost("https://www.example.com/pricing?x=1")).toBe("www.example.com");
    expect(siteHost("example.com:443/")).toBe("example.com");
    expect(siteHost("  ")).toBe("");
  });

  it("count www and the apex as one site, and nothing else", () => {
    expect(sameSite("www.example.com", "example.com")).toBe(true);
    expect(sameSite("example.com", "https://www.example.com/")).toBe(true);
    expect(sameSite("app.example.com", "example.com")).toBe(false);
    expect(sameSite("example.com.evil.net", "example.com")).toBe(false);
    expect(sameSite("www.www.example.com", "example.com")).toBe(false);
    expect(sameSite("", "")).toBe(false);
  });
});

describe("fetchPageHtml without sameHostAs stays on the URL's own host", () => {
  it("a redirect to another host is never fetched", async () => {
    const fetched = stubSite("https://elsewhere.example.net/");
    await expect(
      fetchPageHtml("https://example.com/", { userAgent: FETCHER_UA }),
    ).rejects.toBeInstanceOf(OffHostRedirectError);
    expect(fetched).toEqual(["https://example.com/"]);
  });

  it("a redirect to its own www is followed", async () => {
    const fetched = stubSite("https://www.example.com/");
    await expect(
      fetchPageHtml("https://example.com/", { userAgent: FETCHER_UA }),
    ).resolves.toContain("Northwind");
    expect(fetched).toEqual(["https://example.com/", "https://www.example.com/"]);
  });

  it("with sameHostAs the first address must be on that host too", async () => {
    const fetched = stubSite(null);
    await expect(
      fetchPageHtml("https://elsewhere.example.net/", {
        userAgent: FETCHER_UA,
        sameHostAs: "example.com",
      }),
    ).rejects.toBeInstanceOf(OffHostRedirectError);
    expect(fetched).toEqual([]);
  });
});

describe("page-samples: the per-run read", () => {
  const env = { VARIANTS: { get: async () => null } as unknown as KVNamespace };

  it("an off-host redirect means no samples and one fetch", async () => {
    const fetched = stubSite("https://elsewhere.example.net/");
    expect(await loadPageSamples("c1", "example.com", env)).toEqual([]);
    expect(fetched).toEqual(["https://example.com/"]);
  });

  it("www of the recorded domain is read", async () => {
    const fetched = stubSite("https://www.example.com/");
    const samples = await loadPageSamples("c1", "https://example.com/", env);
    expect(samples.length).toBeGreaterThan(0);
    expect(fetched).toEqual(["https://example.com/", "https://www.example.com/"]);
  });
});

describe("fetchInstallFacts: the apply submit's facts read", () => {
  it("an off-host redirect gives no facts and is never fetched", async () => {
    const fetched = stubSite("https://elsewhere.example.net/");
    expect(await fetchInstallFacts(new URL("https://example.com/"), "c1", INSTALL_ENV)).toBeNull();
    expect(fetched).toEqual(["https://example.com/"]);
  });

  it("www of the typed host is followed, and the facts are read from it", async () => {
    const fetched = stubSite("https://www.example.com/");
    const facts = await fetchInstallFacts(new URL("https://example.com/"), "c1", INSTALL_ENV);
    expect(facts).not.toBeNull();
    expect(fetched).toEqual(["https://example.com/", "https://www.example.com/"]);
  });
});

describe("dna-suggest: the brief suggestions read", () => {
  function env() {
    return {
      DB: {
        prepare: () => ({
          bind: () => ({ first: async () => ({ domain: "example.com" }) }),
        }),
      },
      VARIANTS: { get: async () => null, put: async () => {} },
      ENVIRONMENT: "test",
      DASHBOARD_ORIGIN: "https://app.example.com",
    } as never;
  }
  const user = { id: "u", email: "a@b.c", role: "superadmin", customer_id: null } as never;

  it("an off-host redirect is not followed and says so", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetched = stubSite("https://elsewhere.example.net/");
    const res = await handleDnaSuggest(
      new Request("https://api.test/admin/dna/suggest?customer_id=c1&refresh=1"),
      env(),
      user,
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Could not read the site", reason: OFF_HOST_LINE });
    expect(fetched).toEqual(["https://example.com/"]);
  });
});
