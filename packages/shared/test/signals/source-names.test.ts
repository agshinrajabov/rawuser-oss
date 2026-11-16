/**
 * N1 and N3 (docs/specs/results-data.md §7; privacy review conditional
 * pass 2026-10-04): a source name is always a word from the closed list or
 * null, whatever the host or the utm value; the own-tag bit leaves out the
 * tags platforms write themselves.
 */
import { describe, expect, it } from "vitest";
import { classify } from "../../src/classify/index.ts";
import { selectVariantKey } from "../../src/select/index.ts";
import { extractSignals } from "../../src/signals/extract.ts";
import {
  AUTO_TAG_UTM_SOURCES,
  SOURCE_NAMES,
  SOURCE_NAME_LABELS,
  isOwnTagged,
  isSourceName,
  matchReferrerHost,
  matchUtmSource,
  sourceNameFor,
} from "../../src/signals/source-vocabulary.ts";
import { SOURCE_DIMENSIONS } from "../../src/vector/dimensions.ts";

const NOW = Date.parse("2026-10-14T12:00:00Z");

/** What the edge does: signals from the request, the chosen source dim, then the name. */
function visit(query: string, headers: Record<string, string> = {}) {
  const url = new URL(`https://edge.test/select?cid=acme&path=/${query ? `&${query}` : ""}`);
  const signals = extractSignals({
    url,
    headers: new Headers({ "user-agent": "Mozilla/5.0 (Macintosh) Safari/605.1.15", ...headers }),
    selfHost: "acme.test",
  });
  const dim = selectVariantKey(classify(signals, NOW, null)).source_dim;
  return { dim, name: sourceNameFor(signals, dim), tagged: isOwnTagged(signals.utm) };
}

/** A small deterministic PRNG (mulberry32), so a failure reproduces. */
function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("the closed list", () => {
  it("every name has a label and no duplicates", () => {
    expect(new Set(SOURCE_NAMES).size).toBe(SOURCE_NAMES.length);
    for (const n of SOURCE_NAMES) expect(SOURCE_NAME_LABELS[n]).toBeTruthy();
    expect(isSourceName("linkedin")).toBe(true);
    expect(isSourceName("LinkedIn")).toBe(false);
    expect(isSourceName("mailchimp")).toBe(false); // email platforms never get a name
    expect(isSourceName(undefined)).toBe(false);
  });

  it("the social, community and search hosts now say their platform", () => {
    expect(matchReferrerHost("l.facebook.com")).toEqual({
      channel: "social",
      source: "facebook",
      by: "exact",
    });
    expect(matchReferrerHost("news.ycombinator.com")?.source).toBe("hacker-news");
    expect(matchReferrerHost("www.google.com")?.source).toBe("google");
    expect(matchReferrerHost("google.co.uk")?.source).toBe("google");
    expect(matchReferrerHost("jane.substack.com")?.source).toBe("substack");
    expect(matchReferrerHost("mail.google.com")).toEqual({
      channel: "email",
      source: null,
      by: "pattern",
    });
    // a lookalike is not the platform
    expect(matchReferrerHost("xlinkedin.com")).toBeNull();
  });
});

describe("property: random hosts and utm values only ever yield names on the list", () => {
  const known = [
    "linkedin",
    "google",
    "chatgpt",
    "reddit",
    "facebook",
    "ycombinator",
    "x",
    "t",
    "ads",
    "mail",
    "substack",
  ];
  const tlds = ["com", "net", "org", "co.uk", "ai", "io", "me", "az", "rs", "to", ""];
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789-._";

  function randomToken(r: () => number): string {
    const kind = r();
    if (kind < 0.4) {
      const len = 1 + Math.floor(r() * 24);
      let out = "";
      for (let i = 0; i < len; i++) out += chars[Math.floor(r() * chars.length)];
      return out;
    }
    // Lookalikes and real fragments glued to random parts.
    const pre = r() < 0.5 ? "" : `${randomToken(() => r() * 0.39)}.`;
    const mid = known[Math.floor(r() * known.length)] ?? "";
    const glue = ["", "-", "_", ".", "x"][Math.floor(r() * 5)] ?? "";
    const post = r() < 0.5 ? "" : `${glue}${Math.floor(r() * 1000)}`;
    const tld = tlds[Math.floor(r() * tlds.length)];
    return `${pre}${mid}${post}${tld ? `.${tld}` : ""}`;
  }

  it("5,000 random requests", () => {
    const r = rng(20261004);
    for (let i = 0; i < 5000; i++) {
      const host = randomToken(r);
      const utmSource = randomToken(r);
      const utmMedium = r() < 0.5 ? randomToken(r) : "cpc";
      const signals = extractSignals({
        url: new URL(
          `https://edge.test/select?ref=${encodeURIComponent(`https://${host}/p`)}&utm_source=${encodeURIComponent(utmSource)}&utm_medium=${encodeURIComponent(utmMedium)}`,
        ),
        headers: new Headers({ "user-agent": "Mozilla/5.0 (Linux; Android 14; wv)" }),
      });
      for (const dim of SOURCE_DIMENSIONS) {
        const n = sourceNameFor(signals, dim);
        if (n !== null) expect(SOURCE_NAMES, `${host} ${utmSource} ${dim}`).toContain(n);
      }
      const ref = matchReferrerHost(host)?.source;
      if (ref) expect(SOURCE_NAMES).toContain(ref);
      const utm = matchUtmSource(utmSource)?.source;
      if (utm) expect(SOURCE_NAMES).toContain(utm);
      // a name is never the raw value itself unless that value is a list word
      for (const dim of SOURCE_DIMENSIONS) {
        const n = sourceNameFor(signals, dim);
        if (n === utmSource || n === host) expect(isSourceName(n)).toBe(true);
      }
    }
  });
});

describe("sourceNameFor, end to end through classify", () => {
  it("names the platform behind the chosen dimension", () => {
    expect(visit("ref=https%3A%2F%2Fwww.linkedin.com%2Ffeed")).toMatchObject({
      dim: "social",
      name: "linkedin",
    });
    expect(visit("ref=https%3A%2F%2Fnews.ycombinator.com%2Fitem")).toMatchObject({
      dim: "community",
      name: "hacker-news",
    });
    expect(visit("ref=https%3A%2F%2Fwww.google.com%2F")).toMatchObject({
      dim: "organic",
      name: "google",
    });
    expect(visit("utm_source=chatgpt.com")).toMatchObject({ dim: "ai", name: "chatgpt" });
    expect(visit("gclid=x")).toMatchObject({ dim: "paid", name: "google-ads" });
    expect(visit("", { "user-agent": "Mozilla/5.0 (iPhone) Instagram 300.0" })).toMatchObject({
      dim: "social",
      name: "instagram",
    });
  });

  it("NULL for what the list cannot name", () => {
    // unknown host
    expect(visit("ref=https%3A%2F%2Fsome-blog.example%2Fpost").name).toBeNull();
    // unrecognised utm_source with a social medium
    expect(visit("utm_source=myposse&utm_medium=social")).toMatchObject({
      dim: "social",
      name: null,
    });
    // plain paid without a platform
    expect(visit("utm_source=spring&utm_medium=cpc")).toMatchObject({ dim: "paid", name: null });
    // email, even with the platform's click id
    expect(visit("utm_medium=email&mc_cid=abc").name).toBeNull();
    // an unnamed webview
    expect(
      visit("", { "user-agent": "Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) Chrome/120" }).name,
    ).toBeNull();
    // unknown Android package
    expect(visit("ref=android-app%3A%2F%2Fcom.example.unknown").name).toBeNull();
    // direct never has a name
    expect(visit("").name).toBeNull();
  });
});

describe("isOwnTagged (N3): the customer's own tagged links", () => {
  it("any utm parameter the customer set", () => {
    expect(isOwnTagged({ source: "linkedin", medium: "social", campaign: "launch" })).toBe(true);
    expect(isOwnTagged({ campaign: "launch" })).toBe(true);
    expect(isOwnTagged({})).toBe(false);
  });

  it("ChatGPT's own utm_source=chatgpt.com is not a tagged link, and still counts under ChatGPT", () => {
    expect([...AUTO_TAG_UTM_SOURCES]).toEqual(["chatgpt.com"]);
    expect(visit("utm_source=chatgpt.com")).toEqual({ dim: "ai", name: "chatgpt", tagged: false });
    // the customer tagging a link with the same value plus a campaign is their own
    expect(visit("utm_source=chatgpt.com&utm_campaign=docs").tagged).toBe(true);
    // a value the customer typed, not the platform's tag
    expect(visit("utm_source=chatgpt").tagged).toBe(true);
  });

  it("click ids are not campaign tags", () => {
    expect(visit("gclid=x").tagged).toBe(false);
    expect(visit("fbclid=x").tagged).toBe(false);
  });
});

describe("sameSite: the site's own links are not a landing source (results-data §7)", () => {
  const url = new URL(
    "https://edge.test/select?utm_source=home&utm_medium=hero&gclid=x&path=/start",
  );
  const headers = new Headers({ "user-agent": "Mozilla/5.0 (Macintosh) Safari/605.1.15" });

  it("leaves out the page's utm and click-id names, so it is neither tagged nor a new source", () => {
    const s = extractSignals({ url, headers, selfHost: "school.lumera.test", sameSite: true });
    expect(s.utm).toEqual({});
    expect(s.clickId).toBeNull();
    expect(isOwnTagged(s.utm)).toBe(false);
  });

  it("without the bit the same URL is a tagged landing, as before", () => {
    const s = extractSignals({ url, headers, selfHost: "school.lumera.test" });
    expect(s.utm).toMatchObject({ source: "home", medium: "hero" });
    expect(isOwnTagged(s.utm)).toBe(true);
  });
});
