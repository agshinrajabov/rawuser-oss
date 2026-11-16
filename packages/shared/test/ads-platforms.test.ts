/**
 * Ads platforms, parts 1 to 3 (docs/specs/ads-platforms.md; privacy review
 * CONDITIONAL PASS 2026-10-22, §10):
 * - the link templates hold to the allowlist and never-list (condition 1);
 * - Meta's `{{site_source_name}}` values and `social_paid` land where they
 *   should (condition 5);
 * - a feed ad's paid visit reads the `social` versions, a search ad the
 *   `paid` ones, and the selection keeps `paid` (§4);
 * - a campaign name the special-category screen refuses chooses nothing
 *   (condition 2).
 */

import { describe, expect, it } from "vitest";
import {
  AD_MACRO_ALLOWLIST,
  AD_MACRO_NEVER,
  AD_TEMPLATES,
  adMacros,
} from "../src/ads/templates.ts";
import { campaignRefused, withScreenedCampaign } from "../src/classify/campaign.ts";
import { classify } from "../src/classify/index.ts";
import { selectVariantKey, versionSourceDim } from "../src/select/index.ts";
import { extractSignals } from "../src/signals/extract.ts";
import {
  PAID_SEARCH_MEDIUMS,
  PAID_SOCIAL_MEDIUMS,
  isUnknownUtmSource,
  matchUtmMedium,
  matchUtmSource,
  paidAdKind,
  sourceNameFor,
} from "../src/signals/source-vocabulary.ts";
import type { Signals } from "../src/types.ts";

const NOON = Date.UTC(2026, 9, 22, 12, 0);

/** The signals of a visit to `/` with this query, as the edge builds them. */
function visit(query: string, ua = "Mozilla/5.0 (Macintosh) Safari/605.1.15"): Signals {
  return extractSignals({
    url: new URL(`https://edge.test/select?customer_id=demo&path=%2F&${query}`),
    headers: new Headers({ "user-agent": ua }),
    selfHost: "acme.test",
    entryPath: "/",
  });
}

function selectionOf(query: string) {
  const s = visit(query);
  const sel = selectVariantKey(classify(s, NOON, "UTC"));
  return { ...sel, key_source: versionSourceDim(sel.source_dim, s) };
}

// ---------------------------------------------------------------------------
// Part 1: the templates
// ---------------------------------------------------------------------------

describe("the ad link templates (§2, condition 1)", () => {
  it("are six platforms, search first, in the mock's order and words", () => {
    expect(AD_TEMPLATES.map((t) => [t.platform, t.group, t.label])).toEqual([
      ["google", "search", "Google Ads"],
      ["microsoft", "search", "Microsoft Ads"],
      ["meta", "social", "Meta"],
      ["tiktok", "social", "TikTok"],
      ["linkedin", "social", "LinkedIn"],
      ["x", "social", "X"],
    ]);
    const x = AD_TEMPLATES.find((t) => t.platform === "x");
    expect(x?.needsWord).toBe(true);
    expect(x?.template.endsWith("utm_campaign=")).toBe(true);
    expect(AD_TEMPLATES.filter((t) => t.needsWord)).toHaveLength(1);
    expect(AD_TEMPLATES.find((t) => t.platform === "linkedin")?.note).toBe(
      "Check the syntax in Campaign Manager first.",
    );
  });

  it("carry only allowlisted macros, and none from the never-list", () => {
    for (const t of AD_TEMPLATES) {
      for (const line of [t.template, t.reduced]) {
        for (const m of adMacros(line)) {
          expect(AD_MACRO_ALLOWLIST, `${t.platform}: ${m}`).toContain(m);
          expect(AD_MACRO_NEVER, `${t.platform}: ${m}`).not.toContain(m);
        }
      }
    }
    // The two lists never share a macro.
    for (const m of AD_MACRO_ALLOWLIST) expect(AD_MACRO_NEVER).not.toContain(m);
  });

  it("put utm_term only on a search template", () => {
    for (const t of AD_TEMPLATES.filter((t) => t.group === "social")) {
      expect(t.template, t.platform).not.toMatch(/utm_term/i);
    }
    for (const t of AD_TEMPLATES) expect(t.reduced, t.platform).not.toMatch(/utm_term/i);
  });

  it("reduced: source and medium only, Meta's surface code the one macro left", () => {
    for (const t of AD_TEMPLATES) {
      for (const m of adMacros(t.reduced)) expect(m, t.platform).toBe("{{site_source_name}}");
      const keys = t.reduced.split("&").map((p) => p.split("=")[0]);
      expect(keys, t.platform).toEqual(["utm_source", "utm_medium"]);
      // The reduced line is the full line's own start.
      expect(t.template.startsWith(t.reduced), t.platform).toBe(true);
    }
  });

  it("never carry a search term, a target id, a city, a device, a placement or a click value", () => {
    for (const t of AD_TEMPLATES) {
      for (const line of [t.template, t.reduced]) {
        for (const word of [
          "QueryString",
          "targetid",
          "loc_",
          "device",
          "placement",
          "gclid",
          "random",
        ]) {
          expect(line.toLowerCase(), `${t.platform}: ${word}`).not.toContain(word.toLowerCase());
        }
        expect(line, t.platform).not.toMatch(/adgroup|adset|__AID/i);
      }
    }
  });

  it("adMacros reads every macro form, LinkedIn's bare name included", () => {
    expect(
      adMacros(
        "utm_source={{site_source_name}}&utm_campaign={Campaign}&utm_content=__CID_NAME__&utm_term={keyword}",
      ),
    ).toEqual(["{{site_source_name}}", "{Campaign}", "__CID_NAME__", "{keyword}"]);
    expect(adMacros("utm_campaign=CAMPAIGN_NAME&utm_content=CREATIVE_ID")).toEqual([
      "CAMPAIGN_NAME",
      "CREATIVE_ID",
    ]);
    expect(adMacros("utm_campaign={CAMPAIGN_NAME}")).toEqual(["{CAMPAIGN_NAME}"]);
    expect(adMacros("utm_source=__AID_NAME__&q={QueryString}")).toEqual([
      "__AID_NAME__",
      "{QueryString}",
    ]);
    expect(adMacros("utm_source=x&utm_medium=paid_social&utm_campaign=spring")).toEqual([]);
    // Every never-list entry is seen as a macro, so the test above can catch it.
    for (const m of AD_MACRO_NEVER) expect(adMacros(`a=${m}`)).toEqual([m]);
  });
});

// ---------------------------------------------------------------------------
// The source vocabulary (§2, condition 5)
// ---------------------------------------------------------------------------

describe("Meta's site_source_name values and the paid mediums", () => {
  it("fb, ig and msg name their platform; an is social with no name", () => {
    expect(matchUtmSource("fb")).toMatchObject({ channel: "social", source: "facebook" });
    expect(matchUtmSource("ig")).toMatchObject({ channel: "social", source: "instagram" });
    expect(matchUtmSource("msg")).toEqual({ channel: "social", source: "facebook", by: "exact" });
    expect(matchUtmSource("an")).toEqual({ channel: "social", source: null, by: "exact" });
    expect(isUnknownUtmSource("msg")).toBe(false);
    expect(isUnknownUtmSource("an")).toBe(false);
  });

  it("an organic Audience Network or Messenger tag stores no word that is not on the list", () => {
    expect(sourceNameFor(visit("utm_source=msg"), "social")).toBe("facebook");
    expect(sourceNameFor(visit("utm_source=an"), "social")).toBeNull();
  });

  it("social_paid is paid, as are the other mediums of both sets", () => {
    expect(matchUtmMedium("social_paid")).toMatchObject({ channel: "paid" });
    expect(matchUtmMedium("social-paid")).toMatchObject({ channel: "paid" });
    for (const m of [...PAID_SEARCH_MEDIUMS, ...PAID_SOCIAL_MEDIUMS]) {
      expect(matchUtmMedium(m), m).toMatchObject({ channel: "paid" });
    }
    expect(selectionOf("utm_source=facebook&utm_medium=social_paid").source_dim).toBe("paid");
  });

  it("paidAdKind: a click id first, then the medium; a search medium needs a search engine", () => {
    const kind = (q: string) => paidAdKind(visit(q));
    expect(kind("gclid=x")).toBe("search");
    expect(kind("msclkid=x")).toBe("search");
    expect(kind("ttclid=x")).toBe("social");
    expect(kind("li_fat_id=x")).toBe("social");
    expect(kind("utm_source=google&utm_medium=cpc")).toBe("search");
    expect(kind("utm_source=bing&utm_medium=ppc")).toBe("search");
    expect(kind("utm_source=fb&utm_medium=paid_social")).toBe("social");
    expect(kind("utm_source=an&utm_medium=paid-social")).toBe("social");
    expect(kind("utm_source=tiktok&utm_medium=cpm")).toBe("social");
    // cpc from a social source is not a search ad: it stays as today.
    expect(kind("utm_source=facebook&utm_medium=cpc")).toBeNull();
    expect(kind("utm_source=google&utm_medium=email")).toBeNull();
    // A paid-search click id wins over a medium: the platform built the link.
    expect(kind("gclid=x&utm_medium=paid_social")).toBe("search");
  });
});

// ---------------------------------------------------------------------------
// Part 3: search ads and social ads apart (§4)
// ---------------------------------------------------------------------------

describe("the version a paid visit reads", () => {
  const META =
    "utm_source=ig&utm_medium=paid_social&utm_campaign=spring-sale&utm_content=carousel-1&fbclid=x";

  it("a Meta ad: the selection says paid, the version is social", () => {
    const sel = selectionOf(META);
    expect(sel.source_dim).toBe("paid");
    expect(sel.key_source).toBe("social");
  });

  it("every social template's line, filled, reads the social version", () => {
    for (const q of [
      "utm_source=fb&utm_medium=paid_social&utm_campaign=spring&utm_content=ad-1",
      "utm_source=msg&utm_medium=paid_social&utm_campaign=spring",
      "utm_source=an&utm_medium=paid_social&utm_campaign=spring",
      "utm_source=tiktok&utm_medium=paid_social&utm_campaign=spring&utm_content=ad-1",
      "utm_source=linkedin&utm_medium=paid_social&utm_campaign=spring",
      "utm_source=x&utm_medium=paid_social&utm_campaign=spring",
    ]) {
      const sel = selectionOf(q);
      expect(sel.source_dim, q).toBe("paid");
      expect(sel.key_source, q).toBe("social");
    }
  });

  it("a search ad reads the paid version, with or without a click id", () => {
    for (const q of [
      "utm_source=google&utm_medium=cpc",
      "utm_source=bing&utm_medium=cpc&utm_campaign=spring",
      "gclid=x",
      "msclkid=x&utm_source=bing&utm_medium=cpc",
    ]) {
      const sel = selectionOf(q);
      expect(sel.source_dim, q).toBe("paid");
      expect(sel.key_source, q).toBe("paid");
    }
  });

  it("other paid visits are as today, and no other source is moved", () => {
    expect(selectionOf("utm_source=facebook&utm_medium=cpc").key_source).toBe("paid");
    expect(selectionOf("utm_medium=display").key_source).toBe("paid");
    for (const dim of ["ai", "social", "community", "organic", "direct"] as const) {
      expect(versionSourceDim(dim, visit("utm_medium=paid_social"))).toBe(dim);
    }
  });

  it("a carried page (no signals of its own) reads paid", () => {
    expect(versionSourceDim("paid", visit(""))).toBe("paid");
  });
});

// ---------------------------------------------------------------------------
// The campaign-name screen (§5, condition 2)
// ---------------------------------------------------------------------------

describe("a campaign name the special-category screen refuses chooses nothing", () => {
  it('"diabetes-pricing" picks no pricing intent; "spring-pricing" does', () => {
    const refused = selectionOf("utm_source=google&utm_medium=cpc&utm_campaign=diabetes-pricing");
    expect(refused.intent_dim).not.toBe("pricing");
    const fine = selectionOf("utm_source=google&utm_medium=cpc&utm_campaign=spring-pricing");
    expect(fine.intent_dim).toBe("pricing");
  });

  it("is classified exactly as if the campaign never came", () => {
    const at = (q: string) => classify(visit(q), NOON, "UTC");
    for (const name of ["diabetes-pricing", "hiv-demo", "depression-guide", "church-pricing"]) {
      expect(campaignRefused(name), name).toBe(true);
      expect(at(`utm_source=fb&utm_medium=paid_social&utm_campaign=${name}`), name).toEqual(
        at("utm_source=fb&utm_medium=paid_social"),
      );
    }
  });

  it("a name no rule reads is not screened, and an ordinary name passes", () => {
    expect(campaignRefused("diabetes")).toBe(false);
    expect(campaignRefused("spring-pricing")).toBe(false);
    expect(campaignRefused("salesforce-alternative")).toBe(false);
    expect(campaignRefused(undefined)).toBe(false);
    const s = visit("utm_campaign=spring-pricing");
    expect(withScreenedCampaign(s)).toBe(s);
    const r = withScreenedCampaign(visit("utm_campaign=diabetes-pricing&utm_source=google"));
    expect(r.utm).toEqual({ source: "google" });
  });
});
