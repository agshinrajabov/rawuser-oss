import { describe, expect, it } from "vitest";
import {
  CLICK_ID_PARAM_NAMES,
  isPaidClickId,
  isSocialClickId,
  parseClickId,
} from "../../src/signals/click-id.ts";

const u = (q: string) => new URL(`https://edge.test/select?${q}`);

describe("parseClickId", () => {
  it("returns null when no tracked-link parameter is present", () => {
    expect(parseClickId(u("customer_id=x&utm_source=a"))).toBeNull();
  });

  it("reads the snippet's clk list of names", () => {
    expect(parseClickId(u("clk=fbclid"))).toEqual({ platform: "facebook", family: "social-share" });
    expect(parseClickId(u("clk=igshid"))?.platform).toBe("instagram");
    expect(parseClickId(u("clk=twclid"))).toEqual({ platform: "twitter", family: "paid-social" });
    expect(parseClickId(u("clk=li_fat_id"))?.family).toBe("paid-social");
    expect(parseClickId(u("clk=ttclid"))?.platform).toBe("tiktok");
    expect(parseClickId(u("clk=gclid"))).toEqual({ platform: "google-ads", family: "paid-search" });
    expect(parseClickId(u("clk=msclkid"))?.platform).toBe("microsoft-ads");
  });

  it("knows the ChatGPT ad click id, oppref", () => {
    expect(parseClickId(u("clk=oppref"))).toEqual({ platform: "chatgpt-ads", family: "ai-ads" });
    expect(parseClickId(u("oppref=gAAAAAbNotReadByUs"))?.family).toBe("ai-ads");
  });

  it("classifies email tools as email, by name only", () => {
    expect(parseClickId(u("clk=mc_eid"))).toEqual({ platform: "mailchimp", family: "email" });
    expect(parseClickId(u("_hsenc=p2ANqtz-secret"))?.family).toBe("email");
    expect(parseClickId(u("clk=ck_subscriber_id"))?.platform).toBe("convertkit");
  });

  it("classifies affiliate and referral programmes", () => {
    expect(parseClickId(u("clk=irclickid"))).toEqual({ platform: "impact", family: "affiliate" });
    expect(parseClickId(u("clk=ref"))).toEqual({
      platform: "referral-generic",
      family: "affiliate",
    });
  });

  it("accepts ref and via only through clk, never as raw URL params", () => {
    // The snippet uses ?ref= on the /select URL for the referrer.
    expect(parseClickId(u("ref=https://news.ycombinator.com/"))).toBeNull();
    expect(parseClickId(u("via=someone"))).toBeNull();
  });

  it("reads raw parameter names on the URL too (curl parity), never the value", () => {
    expect(parseClickId(u("fbclid=IwAR0abcdefSECRETvalue123"))?.platform).toBe("facebook");
  });

  it("prefers the AI ad, then paid, when several are present", () => {
    expect(parseClickId(u("clk=fbclid,gclid"))?.platform).toBe("google-ads");
    expect(parseClickId(u("clk=gclid,oppref"))?.platform).toBe("chatgpt-ads");
  });

  it("ignores unknown names in clk", () => {
    expect(parseClickId(u("clk=foo,bar"))).toBeNull();
    expect(parseClickId(u("clk=foo,fbclid"))?.platform).toBe("facebook");
  });

  it("classifies paid vs social by family", () => {
    expect(isPaidClickId("paid-search")).toBe(true);
    expect(isPaidClickId("ai-ads")).toBe(true);
    expect(isPaidClickId("social-share")).toBe(false);
    expect(isSocialClickId("social-share")).toBe(true);
    expect(isSocialClickId("paid-social")).toBe(true);
    expect(isSocialClickId("email")).toBe(false);
    expect(isSocialClickId(null)).toBe(false);
  });

  it("exports every name once, lowercase", () => {
    expect(new Set(CLICK_ID_PARAM_NAMES).size).toBe(CLICK_ID_PARAM_NAMES.length);
    for (const n of CLICK_ID_PARAM_NAMES) expect(n).toBe(n.toLowerCase());
  });
});
