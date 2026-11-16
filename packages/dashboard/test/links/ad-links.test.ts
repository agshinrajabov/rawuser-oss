/**
 * Ad links, every state the mock draws (design/mock/sales-readiness/
 * ads-platforms.html, approved 2026-10-22; spec docs/specs/ads-platforms.md
 * §2 and §10): Your ads on Campaign links (A1), Copied and X with a word
 * (A2), "What Rawuser reads" open (A3), Running ads? on Connect closed and
 * open (A4, A5), a special-category site on both screens (A6, A7), and the
 * pure rules behind them. Rendered to markup, no network.
 */
import { readFileSync } from "node:fs";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => undefined, push: () => undefined }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/",
}));

import { AD_TEMPLATES, type AdTemplate } from "@rawuser/shared";
import { AdRow, RunningAds, YourAds } from "../../src/components/links/AdLinks";
import { PlatformSteps } from "../../src/components/start/PlatformSteps";
import {
  ALSO_ON_LINKS,
  REDUCED_WHY,
  RULE_NAMES,
  RUNNING_ADS,
  WHAT_WE_READ,
  WHAT_WE_READ_LINES,
  adGroups,
  adsReduced,
  campaignWord,
  canCopy,
  copiedLine,
  lineParams,
  rowNote,
  whereLine,
} from "../../src/lib/ad-links";
import type { ReadinessCheck, ReadinessResponse } from "../../src/lib/readiness";
import { CATEGORY_MARKED, CATEGORY_NO, CATEGORY_YES } from "../readiness/fixtures";

const NO_DASH = /[–—]/;

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;| /g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The template text as shown: the markup's tags gone, nothing in between. */
function joined(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&");
}

const byPlatform = (p: AdTemplate["platform"]): AdTemplate => {
  const t = AD_TEMPLATES.find((x) => x.platform === p);
  if (!t) throw new Error(p);
  return t;
};
const X = byPlatform("x");
const META = byPlatform("meta");
const LINKEDIN = byPlatform("linkedin");

function category(state: ReadinessCheck["state"], line: string, action = false): ReadinessCheck {
  return {
    id: "category",
    state,
    line,
    action: action ? { label: "Change", href: "/start?step=connect" } : null,
    known: "now",
    blocks: state === "red",
    superadmin_only: false,
  };
}

function answer(special: boolean | null, check: ReadinessCheck): ReadinessResponse {
  return {
    ok: true,
    blocks_go_live: false,
    special_category: special,
    tag_withheld: false,
    checks: [check],
  };
}

function row(t: AdTemplate, props: Partial<Parameters<typeof AdRow>[0]> = {}): string {
  return renderToStaticMarkup(
    h(AdRow, {
      t,
      form: "links",
      reduced: false,
      word: "",
      onWord: () => undefined,
      copied: false,
      onCopy: () => undefined,
      ...props,
    }),
  );
}

/** The `<button>` of a row, with its attributes. */
function copyButton(html: string): string {
  const m = /<button[^>]*>.*?<\/button>/s.exec(html);
  if (!m) throw new Error("no button");
  return m[0];
}

describe("adsReduced: who sees the lines without names", () => {
  it("a no: the full lines", () => {
    expect(adsReduced(answer(false, category("green", CATEGORY_NO, true)))).toBe(false);
  });
  it("unanswered and not marked: reduced, as for the keyword lexicon", () => {
    expect(adsReduced(answer(null, category("amber", "Tell us", true)))).toBe(true);
  });
  it("a yes, not yet marked: reduced", () => {
    expect(adsReduced(answer(true, category("red", CATEGORY_YES)))).toBe(true);
  });
  it("marked sensitive (green, no action), whatever the answer: reduced", () => {
    expect(adsReduced(answer(null, category("green", CATEGORY_MARKED)))).toBe(true);
    expect(adsReduced(answer(false, category("green", CATEGORY_MARKED)))).toBe(true);
  });
  it("no answer at all (loading, older worker, failed read): reduced", () => {
    expect(adsReduced(null)).toBe(true);
  });
});

describe("the line", () => {
  it("search first, then social, in the shared order", () => {
    const groups = adGroups();
    expect(groups.map((g) => g.group)).toEqual(["search", "social"]);
    expect(groups.flatMap((g) => g.rows.map((r) => r.platform))).toEqual([
      "google",
      "microsoft",
      "meta",
      "tiktok",
      "linkedin",
      "x",
    ]);
  });

  it("splits at every & and marks only the platform's macros", () => {
    const params = lineParams(META.template);
    expect(params).toHaveLength(4);
    expect(params.map((p) => p.map((r) => r.text).join("")).join("")).toBe(META.template);
    const macros = params
      .flat()
      .filter((r) => r.macro)
      .map((r) => r.text);
    expect(macros).toEqual(["{{site_source_name}}", "{{campaign.name}}", "{{ad.name}}"]);
  });

  it("the campaign word: lower case, spaces become hyphens, no & ? = #", () => {
    expect(campaignWord("Online Booking")).toBe("online-booking");
    expect(campaignWord("a&b=c?d#e")).toBe("abcde");
    expect(campaignWord("Növbə Qeydiyyat")).toBe("növbə-qeydiyyat");
  });

  it("X: Copy off until a word is typed, then the word appended", () => {
    expect(canCopy(X, false, "")).toBe(false);
    expect(canCopy(X, false, "--")).toBe(false);
    expect(canCopy(X, false, "online-booking")).toBe(true);
    expect(copiedLine(X, false, "online-booking-")).toBe(
      "utm_source=x&utm_medium=paid_social&utm_campaign=online-booking",
    );
  });

  it("every other row copies its line as is, with no leading ?", () => {
    for (const t of AD_TEMPLATES.filter((t) => !t.needsWord)) {
      expect(canCopy(t, false, "")).toBe(true);
      expect(copiedLine(t, false, "")).toBe(t.template);
      expect(copiedLine(t, false, "").startsWith("?")).toBe(false);
    }
  });

  it("reduced: X copies without a word, every row its reduced line", () => {
    expect(canCopy(X, true, "")).toBe(true);
    for (const t of AD_TEMPLATES) expect(copiedLine(t, true, "anything")).toBe(t.reduced);
  });

  it("reduced: no notes; full: LinkedIn's syntax line and X's word line", () => {
    for (const t of AD_TEMPLATES) expect(rowNote(t, true)).toBeNull();
    expect(rowNote(LINKEDIN, false)).toBe("Check the syntax in Campaign Manager first.");
    expect(rowNote(X, false)).toBe("X has no campaign macro. Type your own campaign word.");
  });

  it("X's where line keeps its ? with the word before it", () => {
    expect(whereLine(X)).toBe("Website card URL, after a ?");
    expect(whereLine(X, "connect")).toBe("Website card URL");
    expect(whereLine(META, "connect")).toBe(META.where);
  });
});

describe("Your ads on Campaign links (A1)", () => {
  const html = renderToStaticMarkup(h(YourAds, { reduced: false }));
  const t = text(html);

  it("the heading, the subtitle with the shaded word, two groups, six rows", () => {
    expect(t).toContain("Your ads");
    expect(t).toContain(
      "One line per platform. The platform fills in the shaded parts at each click.",
    );
    expect(t).toContain("Search ads");
    expect(t).toContain("Social ads");
    expect(html.match(/data-ad="/g)).toHaveLength(6);
    expect(t).toContain("Meta Facebook, Instagram");
  });

  it("every full template shown whole, its macros shaded", () => {
    for (const tpl of AD_TEMPLATES) expect(joined(html)).toContain(tpl.template);
    expect(html).toContain('data-macro="">{keyword}</span>');
    expect(html).toContain('data-macro="">__CID_NAME__</span>');
    expect(html).toContain('data-macro="">{CAMPAIGN_NAME}</span>');
  });

  it("X: the field empty, Copy off; the other five Copy on", () => {
    expect(html).toContain('aria-label="Your campaign word"');
    expect(html).toContain('placeholder="your-campaign"');
    const disabled = html.match(/<button[^>]*disabled=""[^>]*>/g) ?? [];
    expect(disabled).toHaveLength(1);
    expect(disabled[0]).toContain("Copy: X");
  });

  it("the two rules and What Rawuser reads, closed", () => {
    expect(t).toContain(RULE_NAMES);
    expect(t).toContain("Do not use {QueryString} or search-term parameters.");
    expect(t).toContain(WHAT_WE_READ);
    expect(html).not.toMatch(/<details[^>]*open=""[^>]*data-line="what-we-read"/);
  });

  it("no dashes, nothing about a model or its provider", () => {
    expect(t).not.toMatch(NO_DASH);
    // The names themselves are held by the release check on every file.
    expect(t).not.toMatch(/\bmodels?\b|provider|endpoint/i);
  });
});

describe("row states (A2, A3)", () => {
  it("Copied: the check and the word, in the done colour", () => {
    const btn = copyButton(row(META, { copied: true }));
    expect(text(btn)).toBe("Copied");
    expect(btn).toContain("data-copied");
    expect(btn).toContain("state-success");
  });

  it("X with a word: the word in the field, Copy on", () => {
    const html = row(X, { word: "online-booking" });
    expect(html).toContain('value="online-booking"');
    expect(copyButton(html)).not.toContain('disabled=""');
  });

  it("What Rawuser reads open: the two lines", () => {
    const html = renderToStaticMarkup(h(YourAds, { reduced: false, initial: { readOpen: true } }));
    for (const l of WHAT_WE_READ_LINES) expect(text(html)).toContain(l);
    expect(html).toMatch(/<details[^>]*open=""[^>]*data-line="what-we-read"/);
  });

  it("a row shown as Copied from the list's own state", () => {
    const html = renderToStaticMarkup(
      h(YourAds, { reduced: false, initial: { copied: "meta", words: { x: "online-booking" } } }),
    );
    expect(html.match(/data-copied="true"/g)).toHaveLength(1);
    expect(html).toContain('value="online-booking"');
    expect(html.match(/<button[^>]*disabled=""/g)).toBeNull();
  });
});

describe("a special-category site (A6, A7)", () => {
  const links = renderToStaticMarkup(h(YourAds, { reduced: true }));
  const connect = renderToStaticMarkup(h(RunningAds, { reduced: true, defaultOpen: true }));

  for (const [name, html] of [
    ["Campaign links", links],
    ["Connect", connect],
  ] as const) {
    it(`${name}: the reduced lines, no name macro but Meta's source`, () => {
      for (const t of AD_TEMPLATES) expect(joined(html)).toContain(t.reduced);
      const shaded = [...html.matchAll(/data-macro="">([^<]+)</g)].map((m) => m[1]);
      expect(shaded).toEqual(["{{site_source_name}}"]);
      for (const m of [
        "{keyword}",
        "{Campaign}",
        "{{campaign.name}}",
        "{{ad.name}}",
        "__CAMPAIGN_NAME__",
        "__CID_NAME__",
        "CAMPAIGN_NAME",
        "utm_term",
        "utm_campaign",
        "utm_content",
      ]) {
        expect(html).not.toContain(m);
      }
    });

    it(`${name}: the why line, no rules, no field, no notes, every Copy on`, () => {
      expect(text(html)).toContain(REDUCED_WHY);
      expect(text(html)).not.toContain(RULE_NAMES);
      expect(text(html)).not.toContain("QueryString");
      expect(html).not.toContain("campaign-word");
      expect(html).not.toContain("data-note");
      expect(html).not.toMatch(/<button[^>]*disabled=""/);
      expect(text(html)).not.toMatch(NO_DASH);
    });
  }

  it("Campaign links: no What Rawuser reads; Connect: no foot line", () => {
    expect(text(links)).not.toContain(WHAT_WE_READ);
    expect(text(connect)).not.toContain(ALSO_ON_LINKS);
  });
});

describe("Running ads? on Connect (A4, A5)", () => {
  it("closed by default", () => {
    const html = renderToStaticMarkup(h(RunningAds, { reduced: false }));
    expect(html).toMatch(/<details(?![^>]*open="")[^>]*data-line="running-ads"/);
    expect(text(html).startsWith(RUNNING_ADS)).toBe(true);
  });

  it("open: the subtitle, six rows in order, the rules and the foot", () => {
    const html = renderToStaticMarkup(h(RunningAds, { reduced: false, defaultOpen: true }));
    const t = text(html);
    expect(t).toContain("One line per platform. The platform fills in the shaded parts.");
    expect([...html.matchAll(/data-ad="([a-z]+)"/g)].map((m) => m[1])).toEqual([
      "google",
      "microsoft",
      "meta",
      "tiktok",
      "linkedin",
      "x",
    ]);
    expect(t).toContain(RULE_NAMES);
    expect(t).toContain(ALSO_ON_LINKS);
    expect(t).not.toContain("Search ads");
    expect(t).not.toContain("Facebook, Instagram");
  });

  it("PlatformSteps: Running ads? after the tag's status line, the old line gone", () => {
    const html = renderToStaticMarkup(
      h(
        PlatformSteps,
        { probe: null, tag: "<script></script>", adsReduced: false },
        h("p", { "data-status": "" }, "Tag found on queue.test, first in the head."),
      ),
    );
    expect(html.indexOf("data-status")).toBeLessThan(html.indexOf('data-line="running-ads"'));
    expect(text(html)).not.toContain("Running Google or Microsoft Ads?");
    expect(html).not.toContain("data-reduced");
  });

  it("PlatformSteps: reduced unless told otherwise; nothing while the tag is held", () => {
    const plain = renderToStaticMarkup(h(PlatformSteps, { probe: null, tag: "t" }));
    expect(plain).toContain('data-line="running-ads" data-reduced="true"');
    const held = renderToStaticMarkup(
      h(PlatformSteps, { probe: null, tag: "t", adsReduced: false, held: h("p", null, "held") }),
    );
    expect(held).not.toContain("running-ads");
  });
});

describe("the old keyword sentence is gone from Campaign links", () => {
  it("LinkForm no longer carries it", () => {
    const src = readFileSync(
      new URL("../../src/components/links/LinkForm.tsx", import.meta.url),
      "utf8",
    );
    expect(src).not.toContain("the ad's keyword picks the version");
  });
});
