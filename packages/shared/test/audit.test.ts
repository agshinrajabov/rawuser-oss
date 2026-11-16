/**
 * The free AI-traffic audit's shared contract (docs/specs/ai-traffic-audit.md
 * §3.4, §4.2, §14 "Shared"): the found_by precedence, one case per row and
 * every overlapping pair; the closed list; the host and end rule; the
 * bundle's `a`, `ad`, `ae`.
 */
import { describe, expect, it } from "vitest";
import {
  FOUND_BY,
  auditHostAllowed,
  auditRefusal,
  foundBy,
  isFoundBy,
  normalizeAuditDomain,
} from "../src/audit.ts";
import { extractSignals } from "../src/signals/extract.ts";
import { BUNDLE_CUSTOMER_SQL, bundleAuditFrom, visitorBundleFrom } from "../src/visitor-bundle.ts";

const SAFARI =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15";
const INSTAGRAM =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 339.0.3.12.91";

/** The signals the edge reads for one /select request. */
function req(query: string, ua = SAFARI, headers: Record<string, string> = {}) {
  const url = new URL(`https://edge.test/select?cid=acme&path=/${query ? `&${query}` : ""}`);
  return extractSignals({
    url,
    headers: new Headers({ "user-agent": ua, ...headers }),
    selfHost: "acme.test",
  });
}

describe("found_by, one row of the table each", () => {
  it("tag: the customer's own utm tags", () => {
    expect(foundBy(req("utm_source=newsletter&utm_medium=email"))).toBe("tag");
  });
  it("auto_tag: ChatGPT's own utm_source", () => {
    expect(foundBy(req("utm_source=chatgpt.com"))).toBe("auto_tag");
  });
  it("click_id: a click-id name, no utm", () => {
    expect(foundBy(req("clk=fbclid"))).toBe("click_id");
  });
  it("referrer: a web referrer host", () => {
    expect(foundBy(req(`ref=${encodeURIComponent("https://news.ycombinator.com/")}`))).toBe(
      "referrer",
    );
  });
  it("app_package: an android-app:// referrer", () => {
    expect(foundBy(req(`ref=${encodeURIComponent("android-app://com.google.android.gm/")}`))).toBe(
      "app_package",
    );
  });
  it("app_marker: only an in-app browser marker", () => {
    expect(foundBy(req("", INSTAGRAM))).toBe("app_marker");
  });
  it("app_marker: the Android WebView brand", () => {
    expect(
      foundBy(
        req("", "Mozilla/5.0 (Linux; Android 14) Chrome/128.0 Mobile Safari/537.36", {
          "sec-ch-ua": '"Android WebView";v="128", "Chromium";v="128"',
        }),
      ),
    ).toBe("app_marker");
  });
  it("null: no signal, a path only", () => {
    expect(foundBy(req(""))).toBeNull();
    const pricing = extractSignals({
      url: new URL("https://edge.test/select?cid=acme&path=/pricing"),
      headers: new Headers({ "user-agent": SAFARI }),
      selfHost: "acme.test",
    });
    expect(foundBy(pricing)).toBeNull();
  });
  it("null: a carried page sends no signal of its own", () => {
    expect(foundBy(req("carry=problem.ai"))).toBeNull();
  });
});

describe("found_by, the overlapping pairs", () => {
  it("ChatGPT utm with a chatgpt.com referrer is auto_tag", () => {
    expect(
      foundBy(req(`utm_source=chatgpt.com&ref=${encodeURIComponent("https://chatgpt.com/")}`)),
    ).toBe("auto_tag");
  });
  it("ChatGPT utm plus another utm is the customer's tag", () => {
    expect(foundBy(req("utm_source=chatgpt.com&utm_campaign=spring"))).toBe("tag");
  });
  it("an Instagram UA with a referrer is referrer", () => {
    expect(foundBy(req(`ref=${encodeURIComponent("https://l.instagram.com/")}`, INSTAGRAM))).toBe(
      "referrer",
    );
  });
  it("a click id with a referrer is click_id; a tag with a click id is tag", () => {
    expect(foundBy(req(`clk=gclid&ref=${encodeURIComponent("https://www.google.com/")}`))).toBe(
      "click_id",
    );
    expect(foundBy(req("clk=gclid&utm_source=google&utm_medium=cpc"))).toBe("tag");
  });
  it("an app package beats an in-app marker", () => {
    expect(
      foundBy(req(`ref=${encodeURIComponent("android-app://com.google.android.gm/")}`, INSTAGRAM)),
    ).toBe("app_package");
  });
  it("the low-confidence iOS guess is not a marker", () => {
    expect(
      foundBy({
        utm: {},
        referrerHost: null,
        appSource: { app: "unknown", channel: "app", confidence: "low" } as never,
        clickId: null,
      }),
    ).toBeNull();
  });
});

describe("found_by, the closed list", () => {
  it("has the six words, no duplicates", () => {
    expect([...FOUND_BY]).toEqual([
      "tag",
      "auto_tag",
      "click_id",
      "referrer",
      "app_package",
      "app_marker",
    ]);
  });
  it("is always on the list or null, for any mix of signals (property)", () => {
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const parts = [
      "utm_source=chatgpt.com",
      "utm_source=x",
      "utm_medium=email",
      "clk=fbclid",
      "clk=gclid",
      `ref=${encodeURIComponent("https://reddit.com/")}`,
      `ref=${encodeURIComponent("android-app://org.telegram.messenger/")}`,
      "carry=problem.ai",
    ];
    for (let i = 0; i < 300; i++) {
      const q = parts.filter(() => rnd() < 0.3).join("&");
      const ua = rnd() < 0.3 ? INSTAGRAM : SAFARI;
      const w = foundBy(req(q, ua));
      expect(w === null || isFoundBy(w)).toBe(true);
    }
  });
  it("isFoundBy refuses anything else", () => {
    for (const v of ["", "TAG", "utm", "chatgpt.com", null, 1, {}]) {
      expect(isFoundBy(v)).toBe(false);
    }
  });
});

describe("the audit domain and the host check", () => {
  it("normalizes a domain to a plain host", () => {
    expect(normalizeAuditDomain("https://WWW.Quoteloom.example:443/path?q#f")).toBe(
      "quoteloom.example",
    );
    expect(normalizeAuditDomain("app.quoteloom.example.")).toBe("app.quoteloom.example");
    for (const bad of ["", null, "localhost", "10.0.0.1", "a b.com", "http://"]) {
      expect(normalizeAuditDomain(bad)).toBeNull();
    }
  });
  it("allows the domain and its subdomains, nothing that only looks like it", () => {
    const ad = "quoteloom.example";
    expect(auditHostAllowed("quoteloom.example", ad)).toBe(true);
    expect(auditHostAllowed("www.quoteloom.example", ad)).toBe(true);
    expect(auditHostAllowed("Docs.Quoteloom.Example.", ad)).toBe(true);
    expect(auditHostAllowed("badquoteloom.example", ad)).toBe(false);
    expect(auditHostAllowed("quoteloom.example.evil.test", ad)).toBe(false);
    expect(auditHostAllowed(null, ad)).toBe(false);
    expect(auditHostAllowed("", ad)).toBe(false);
  });
  it("refuses a foreign host, a missing host, after ae, and an audit bundle without ad", () => {
    const b = { a: 1 as const, ad: "quoteloom.example", ae: 1_000 };
    expect(auditRefusal(b, "quoteloom.example", 999)).toBeNull();
    expect(auditRefusal(b, "other.example", 999)).toBe("host");
    expect(auditRefusal(b, null, 999)).toBe("host");
    expect(auditRefusal(b, "quoteloom.example", 1_000)).toBe("ended");
    expect(auditRefusal({ a: 1 }, "quoteloom.example", 0)).toBe("host");
    expect(auditRefusal({ a: 1, ad: "quoteloom.example" }, "quoteloom.example", 9e12)).toBeNull();
  });
  it("never refuses a bundle that is not an audit", () => {
    expect(auditRefusal({}, "anything.example", 9e12)).toBeNull();
    expect(auditRefusal(null, null, 0)).toBeNull();
  });
});

describe("the bundle's a, ad and ae", () => {
  it("are read by the shared customers query", () => {
    expect(BUNDLE_CUSTOMER_SQL).toMatch(/plan, domain, audit_ends_at/);
  });
  it("ride only for an audit customer", () => {
    const audit = visitorBundleFrom(
      [],
      [],
      20,
      null,
      bundleAuditFrom({
        holdout_percent: 20,
        served_intents: null,
        site_map_off: 0,
        plan: "audit",
        domain: "www.quoteloom.example",
        audit_ends_at: 1_700_000_000_000,
      }),
    );
    expect(audit).toMatchObject({ h: 20, a: 1, ad: "quoteloom.example", ae: 1_700_000_000_000 });

    const noEnd = visitorBundleFrom(
      [],
      [],
      null,
      null,
      bundleAuditFrom({
        holdout_percent: null,
        served_intents: null,
        site_map_off: 0,
        plan: "audit",
        domain: "quoteloom.example",
        audit_ends_at: null,
      }),
    );
    expect(noEnd.a).toBe(1);
    expect("ae" in noEnd).toBe(false);

    const pilot = visitorBundleFrom(
      [],
      [],
      null,
      null,
      bundleAuditFrom({
        holdout_percent: null,
        served_intents: null,
        site_map_off: 0,
        plan: "pilot",
        domain: "quoteloom.example",
        audit_ends_at: 5,
      }),
    );
    expect("a" in pilot || "ad" in pilot || "ae" in pilot).toBe(false);
    // An older caller without the fifth argument builds the bundle as before.
    expect(Object.keys(visitorBundleFrom([], [], null))).toEqual(["v", "pages", "conv"]);
  });
});
