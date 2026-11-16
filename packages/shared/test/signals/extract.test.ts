import { describe, expect, it } from "vitest";
import { extractSignals } from "../../src/signals/extract.ts";

function makeHeaders(obj: Record<string, string>): Headers {
  return new Headers(obj);
}

describe("extractSignals", () => {
  it("returns empty utm and nulls for a bare request", () => {
    const signals = extractSignals({
      url: new URL("https://example.com/"),
      headers: makeHeaders({}),
    });
    expect(signals.utm).toEqual({});
    expect(signals.referrerHost).toBeNull();
    expect(signals.aiSource).toBeNull();
    expect(signals.device).toBe("desktop");
    expect(signals.language).toBeNull();
    expect(signals.country).toBeNull();
  });

  it("extracts UTM from URL", () => {
    const signals = extractSignals({
      url: new URL("https://example.com/?utm_source=google&utm_campaign=enterprise"),
      headers: makeHeaders({}),
    });
    expect(signals.utm.source).toBe("google");
    expect(signals.utm.campaign).toBe("enterprise");
  });

  it("extracts referrer host (no path/query)", () => {
    const signals = extractSignals({
      url: new URL("https://example.com/"),
      headers: makeHeaders({ referer: "https://chatgpt.com/c/some-long-path?q=rawuser" }),
    });
    expect(signals.referrerHost).toBe("chatgpt.com");
  });

  it("privacy invariant: referrerHost never contains ? or /", () => {
    const signals = extractSignals({
      url: new URL("https://example.com/"),
      headers: makeHeaders({ referer: "https://example.org/path?email=a@b.test&token=secret" }),
    });
    expect(signals.referrerHost).not.toContain("?");
    expect(signals.referrerHost).not.toContain("/");
  });

  it("same-origin referrer returns null referrerHost", () => {
    const signals = extractSignals({
      url: new URL("https://mysite.com/page"),
      headers: makeHeaders({ referer: "https://mysite.com/other" }),
      selfHost: "mysite.com",
    });
    expect(signals.referrerHost).toBeNull();
  });

  it("detects AI source from referrer", () => {
    const signals = extractSignals({
      url: new URL("https://example.com/"),
      headers: makeHeaders({ referer: "https://chatgpt.com/" }),
    });
    expect(signals.aiSource).toBe("chatgpt");
    expect(signals.device).not.toBe("bot");
  });

  it("falls back to ?ref= URL param when no Referer header (snippet path)", () => {
    const signals = extractSignals({
      url: new URL("https://example.com/select?ref=https%3A%2F%2Fnews.ycombinator.com%2F"),
      headers: makeHeaders({}),
    });
    expect(signals.referrerHost).toBe("news.ycombinator.com");
  });

  it("the snippet's ?ref= wins over its fetch's own Referer, the customer's page", () => {
    // What a real browser sends on the snippet's /select (template-lab, 2026-09-28).
    const signals = extractSignals({
      url: new URL("https://edge.example/select?ref=https%3A%2F%2Fnews.ycombinator.com%2F"),
      headers: makeHeaders({ referer: "https://mysite.com/" }),
      selfHost: "mysite.com",
    });
    expect(signals.referrerHost).toBe("news.ycombinator.com");
  });

  it("?ref= wins when both name an outside host", () => {
    const signals = extractSignals({
      url: new URL("https://example.com/select?ref=https%3A%2F%2Fchatgpt.com%2F"),
      headers: makeHeaders({ referer: "https://reddit.com/" }),
    });
    expect(signals.referrerHost).toBe("chatgpt.com");
  });

  it("the Referer header still counts when there is no ?ref= (a request that is the page itself)", () => {
    const signals = extractSignals({
      url: new URL("https://mysite.com/pricing"),
      headers: makeHeaders({ referer: "https://www.google.com/" }),
      selfHost: "mysite.com",
    });
    expect(signals.referrerHost).toBe("www.google.com");
  });

  it("?ref= still respects selfHost for same-origin detection", () => {
    const signals = extractSignals({
      url: new URL("https://example.com/select?ref=https%3A%2F%2Fmysite.com%2Fother"),
      headers: makeHeaders({}),
      selfHost: "mysite.com",
    });
    expect(signals.referrerHost).toBeNull();
  });

  it("detects bot UA and sets device=bot", () => {
    const signals = extractSignals({
      url: new URL("https://example.com/"),
      headers: makeHeaders({ "user-agent": "GPTBot/1.2" }),
    });
    expect(signals.device).toBe("bot");
    expect(signals.aiSource).toBe("chatgpt");
  });

  it("sets _isCitationClick for citation-click UA", () => {
    const signals = extractSignals({
      url: new URL("https://example.com/"),
      headers: makeHeaders({ "user-agent": "ChatGPT-User/1.0" }),
    });
    expect(signals.aiSource).toBe("chatgpt");
    expect(signals.device).not.toBe("bot");
    expect(signals._isCitationClick).toBe(true);
  });

  it("extracts language from Accept-Language header", () => {
    const signals = extractSignals({
      url: new URL("https://example.com/"),
      headers: makeHeaders({ "accept-language": "en-US,en;q=0.9,fr;q=0.8" }),
    });
    expect(signals.language).toBe("en-US");
  });

  it("prefers ?lang= param over Accept-Language", () => {
    const signals = extractSignals({
      url: new URL("https://example.com/?lang=fr"),
      headers: makeHeaders({ "accept-language": "en-US" }),
    });
    expect(signals.language).toBe("fr");
  });

  it("extracts country from cf properties", () => {
    const signals = extractSignals({
      url: new URL("https://example.com/"),
      headers: makeHeaders({}),
      cf: { country: "US" },
    });
    expect(signals.country).toBe("US");
  });

  it("country is null when cf is absent", () => {
    const signals = extractSignals({
      url: new URL("https://example.com/"),
      headers: makeHeaders({}),
    });
    expect(signals.country).toBeNull();
  });

  it("uses Referrer header (alternative spelling) as fallback", () => {
    const signals = extractSignals({
      url: new URL("https://example.com/"),
      headers: makeHeaders({ referrer: "https://perplexity.ai/search/something" }),
    });
    expect(signals.referrerHost).toBe("perplexity.ai");
    expect(signals.aiSource).toBe("perplexity");
  });
});

describe("extractSignals — L2 source recovery", () => {
  const IG_UA =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/21E236 Instagram 328.0.0.29.85 (iPhone15,2; iOS 17_4_1; en_US; en; scale=3.00; 1179x2556; 583283064)";

  it("recovers the app from an in-app browser UA when the referrer is empty", () => {
    const signals = extractSignals({
      url: new URL("https://edge.test/select?customer_id=x"),
      headers: makeHeaders({ "user-agent": IG_UA }),
    });
    expect(signals.referrerHost).toBeNull();
    expect(signals.appSource).toEqual({ app: "instagram", channel: "social", confidence: "high" });
    expect(signals.device).toBe("mobile");
    expect(signals.aiSource).toBeNull();
  });

  it("reads a click id from the clk names the snippet forwards", () => {
    const signals = extractSignals({
      url: new URL("https://edge.test/select?customer_id=x&clk=fbclid"),
      headers: makeHeaders({}),
    });
    expect(signals.clickId).toBe("facebook");
  });

  it("leaves appSource and clickId null for a plain visit", () => {
    const signals = extractSignals({
      url: new URL("https://edge.test/select?customer_id=x"),
      headers: makeHeaders({}),
    });
    expect(signals.appSource).toBeNull();
    expect(signals.clickId).toBeNull();
  });

  it("an AI crawler is never an app source", () => {
    const signals = extractSignals({
      url: new URL("https://edge.test/select?customer_id=x"),
      headers: makeHeaders({ "user-agent": "GPTBot/1.2 Instagram" }),
    });
    expect(signals.device).toBe("bot");
    expect(signals.appSource).toBeNull();
  });

  it("privacy invariant: the returned object never carries the UA or a click-id value", () => {
    const signals = extractSignals({
      url: new URL("https://edge.test/select?customer_id=x&fbclid=IwAR0SECRETTOKEN"),
      headers: makeHeaders({ "user-agent": IG_UA }),
    });
    const json = JSON.stringify(signals);
    expect(json).not.toContain("SECRETTOKEN");
    expect(json).not.toContain("iPhone15");
    expect(json).not.toContain("328.0.0");
  });
});

describe("extractSignals — L2 Layer B and C", () => {
  it("reads the Android WebView brand from Sec-CH-UA", () => {
    const signals = extractSignals({
      url: new URL("https://edge.test/select?customer_id=x"),
      headers: makeHeaders({
        "user-agent":
          "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36",
        "sec-ch-ua": '"Not)A;Brand";v="8", "Chromium";v="138", "Android WebView";v="138"',
      }),
    });
    expect(signals.appSource).toEqual({ app: "unknown", channel: "app", confidence: "medium" });
  });

  it("an oppref name makes the visit an AI source and a paid link", () => {
    const signals = extractSignals({
      url: new URL("https://edge.test/select?customer_id=x&clk=oppref"),
      headers: makeHeaders({}),
    });
    expect(signals.clickId).toBe("chatgpt-ads");
    expect(signals.linkFamily).toBe("ai-ads");
    expect(signals.aiSource).toBe("chatgpt");
  });

  it("an email click id is a family, never a value", () => {
    const signals = extractSignals({
      url: new URL("https://edge.test/select?customer_id=x&mc_eid=abc123recipient"),
      headers: makeHeaders({}),
    });
    expect(signals.linkFamily).toBe("email");
    expect(JSON.stringify(signals)).not.toContain("abc123recipient");
  });
});
