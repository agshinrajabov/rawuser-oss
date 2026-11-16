/**
 * The tag at the bottom of the page, on the Pages card (mock
 * design/mock/sales-readiness/pilot-gaps.html, screen 06, states A26 to
 * A30, approved 2026-10-12; docs/specs/late-tag.md, "What is counted and
 * shown" and "The Pages card's read"): amber with the share from 30 visits
 * and 5%, grey when the tag sits at the end of the page and the visits are
 * too few, nothing otherwise, and a worker that sends no `late`. Also the
 * older late-tag line, which no longer promises a version afterwards.
 */
import "../identity/example";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => undefined, push: () => undefined }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/",
}));

import { LateTagNote, PagesCard } from "../../src/components/start/PagesCard";
import {
  type HealthIssuesResponse,
  type HealthSite,
  LATE_CAUSE_LINE,
  LATE_SHARE_SAID_FROM,
  LATE_TOO_FEW_LINE,
  type LateTagShare,
  healthLines,
  lateTagLine,
} from "../../src/components/start/health";
import { buildSnippet } from "../../src/lib/snippet-tag";
import type { CustomerListItem, ManifestResponse, TagPosition } from "../../src/types/api";

const TAG = buildSnippet("medora");

function site(tag_position: TagPosition | null): HealthSite {
  return {
    probed_at: 1,
    csp_blocks: false,
    csp_blocks_since: null,
    csp_degrades: false,
    csp_report_only_blocks: false,
    platform: "other",
    tag_position,
    tag_flags: [],
  };
}

function late(exposures: number, late_exposures: number): LateTagShare {
  return {
    exposures,
    late_exposures,
    share: exposures > 0 ? Math.round((late_exposures / exposures) * 10_000) / 10_000 : null,
    enough: exposures >= 30,
  };
}

function health(over: Partial<HealthIssuesResponse> = {}): HealthIssuesResponse {
  return {
    customer_id: "medora",
    hours: 24,
    since: 0,
    loads: 0,
    pages: [],
    site: site("body_late"),
    ...over,
  };
}

const CUSTOMER = {
  id: "medora",
  slug: "medora",
  domain: "www.medora.test",
  plan: "pilot",
  status: "active",
} as CustomerListItem;

function manifestRow(page_path = "/"): ManifestResponse {
  return {
    customer_id: "medora",
    page_path,
    manifest: {},
    source_url: `https://www.medora.test${page_path}`,
    generated_at: 1,
    confirmed_at: 2,
    cost_usd: 0,
    status: "confirmed",
  };
}

function card(h_: HealthIssuesResponse | null, pages: ManifestResponse[] = [manifestRow()]) {
  return renderToStaticMarkup(
    h(PagesCard, {
      customer: CUSTOMER,
      pages,
      readyByPath: { "/": 20, "/pricing": 20 },
      perPage: 20,
      writing: false,
      onPageAdded: () => undefined,
      health: h_,
    }),
  );
}

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

const AMBER = "On about 1 in 10 visits your page appeared before the versions were ready.";

describe("lateTagLine: when the card says anything", () => {
  it("A26, amber: 30 visits or more and a share of 5% or more", () => {
    expect(lateTagLine(health({ late: late(310, 31) }))).toEqual({
      tone: "warn",
      text: AMBER,
      cause: LATE_CAUSE_LINE,
      counted: "About 1 in 10 of the visits that would get a version, in the last 7 days.",
    });
  });

  it("exactly 5% is said, a hair under is not", () => {
    expect(LATE_SHARE_SAID_FROM).toBe(0.05);
    expect(lateTagLine(health({ late: late(100, 5) }))?.text).toBe(
      "On about 1 in 20 visits your page appeared before the versions were ready.",
    );
    expect(lateTagLine(health({ late: late(1000, 49) }))).toBeNull();
  });

  it("N is the share turned over and rounded; near every visit it says most", () => {
    // The pilot's morning of 12 Oct: 17 of 31 cold loads.
    expect(lateTagLine(health({ late: late(31, 17) }))?.text).toBe(
      "On about 1 in 2 visits your page appeared before the versions were ready.",
    );
    expect(lateTagLine(health({ late: late(40, 30) }))).toMatchObject({
      text: "On most visits your page appeared before the versions were ready.",
      counted: "Most of the visits that would get a version, in the last 7 days.",
    });
    expect(lateTagLine(health({ late: late(40, 40) }))?.text).toMatch(/^On most visits/);
  });

  it("A28, grey: the tag at the end of the page and enough: false", () => {
    expect(lateTagLine(health({ late: late(12, 6) }))).toEqual({
      tone: "quiet",
      text: LATE_TOO_FEW_LINE,
      cause: null,
      counted: null,
    });
    // No visit at all yet.
    expect(lateTagLine(health({ late: late(0, 0) }))?.tone).toBe("quiet");
  });

  it("enough: false never says a share, whatever the share is", () => {
    const l = lateTagLine(
      health({ late: { exposures: 29, late_exposures: 29, share: 1, enough: false } }),
    );
    expect(l?.tone).toBe("quiet");
    expect(l?.text).not.toMatch(/1 in|most/);
  });

  it("A29, quiet: the tag in the head or first in the body and a share under 5%: no line", () => {
    for (const position of ["head_first", "head_late", "body_top"] as const) {
      expect(lateTagLine(health({ site: site(position), late: late(400, 4) }))).toBeNull();
      // Too few visits and the tag in its place: nothing to say either.
      expect(lateTagLine(health({ site: site(position), late: late(10, 2) }))).toBeNull();
    }
  });

  it("the tag at the end with a measured share under 5%: no line, and never the too-few words", () => {
    expect(lateTagLine(health({ late: late(400, 4) }))).toBeNull();
  });

  it("a measured cost is said wherever the tag sits, without a cause the probe did not see", () => {
    const l = lateTagLine(health({ site: site("head_first"), late: late(310, 31) }));
    expect(l).toMatchObject({ tone: "warn", text: AMBER, cause: null });
    expect(lateTagLine(health({ site: null, late: late(310, 31) }))?.cause).toBeNull();
  });

  it("an older worker (no `late`), a null, or no share: no line", () => {
    expect(lateTagLine(health())).toBeNull();
    expect(lateTagLine(health({ late: null }))).toBeNull();
    expect(lateTagLine(null)).toBeNull();
    expect(
      lateTagLine(
        health({ late: { exposures: 40, late_exposures: 0, share: null, enough: true } }),
      ),
    ).toBeNull();
  });

  it("the number is of the visits that would get a version, and the disclosure says so", () => {
    expect(lateTagLine(health({ late: late(310, 31) }))?.counted).toContain(
      "of the visits that would get a version",
    );
  });
});

describe("the older late-tag line", () => {
  const page = {
    page_path: "/",
    loads: 212,
    issues: [
      { code: "late_tag" as const, count: 31, share: 0.146, slot: null },
      { code: "lines_changed" as const, count: 12, share: 0.057, slot: "hero.headline" },
      { code: "swap_shift" as const, count: 9, share: 0.042, slot: null },
    ],
  };

  it("says the page stayed as built, never that the version came afterwards", () => {
    const [first] = healthLines(page);
    expect(first?.text).toBe(
      // The window is written with a no-break space, "24\u00a0h".
      "On 15% of visits in the last 24\u00a0h, your tag ran after the page appeared, so those visitors saw your page as you built it.",
    );
    expect(first?.text).not.toMatch(/then the version/);
  });

  it("is left out where the new line shows, and the next problem takes its place", () => {
    expect(healthLines(page, 24, ["late_tag"]).map((l) => l.link)).toEqual(["part", null]);
    expect(healthLines(page, 24, ["late_tag"])[1]?.text).toBe(
      "On 4%, your page moved when the words changed.",
    );
    expect(healthLines(page).map((l) => l.link)).toEqual(["tag", null]);
  });
});

describe("LateTagNote: what renders", () => {
  const amber = lateTagLine(health({ late: late(310, 31) }));
  const grey = lateTagLine(health({ late: late(12, 6) }));
  if (!amber || !grey) throw new Error("fixtures");

  it("A26, amber and closed: the line and What you can do", () => {
    const html = renderToStaticMarkup(h(LateTagNote, { line: amber, tag: TAG }));
    expect(html).toMatch(/<summary[^>]*state-warn/);
    expect(html).not.toMatch(/<details[^>]* open/);
    expect(text(html)).toMatch(new RegExp(`^${AMBER} What you can do Hide`));
  });

  it("A27, open: the cause, then two choices and nothing else", () => {
    const html = renderToStaticMarkup(h(LateTagNote, { line: amber, tag: TAG, defaultOpen: true }));
    const t = text(html);
    expect(html).toMatch(/<details[^>]* open=""/);
    expect(t).toContain("Your tag sits at the end of your page.");
    expect(t).toContain(
      "Move the tag to the top. Then the versions are ready before your page appears.",
    );
    expect(t).toContain("Tag · first in the head, or top of the body");
    expect(t).toContain(TAG);
    expect(t).toContain(
      "Or leave it. Rawuser changes nothing a visitor is already reading. Those visits see your page as you built it.",
    );
    expect(t).toContain(
      "About 1 in 10 of the visits that would get a version, in the last 7 days.",
    );
    // The order of the mock: the cause, move, leave.
    expect(t.indexOf("Your tag sits")).toBeLessThan(t.indexOf("Move the tag"));
    expect(t.indexOf("Move the tag")).toBeLessThan(t.indexOf("Or leave it"));
  });

  it("the tag to copy is the customer's own, with data-cfasync", () => {
    expect(TAG).toContain("/s/medora.js");
    expect(TAG).toContain('data-cfasync="false"');
    const html = renderToStaticMarkup(h(LateTagNote, { line: amber, tag: TAG, defaultOpen: true }));
    expect(html).toMatch(
      /<button[^>]*aria-label="Copy Tag · first in the head, or top of the body"/,
    );
  });

  it("A28, grey: the same disclosure on a quiet ground, no share and no repeated cause", () => {
    const html = renderToStaticMarkup(h(LateTagNote, { line: grey, tag: TAG, defaultOpen: true }));
    const t = text(html);
    expect(html).toMatch(/<summary[^>]*bg-surface-muted/);
    expect(html).not.toContain("state-warn");
    expect(t).toMatch(
      /^Your tag sits at the end of your page\. Too few visits yet to say what that costs\. What you can do/,
    );
    expect(t).toContain("Move the tag to the top.");
    expect(t).toContain("Or leave it.");
    expect(t.match(/Your tag sits at the end of your page\./g)).toHaveLength(1);
    expect(t).not.toMatch(/1 in \d+/);
  });

  it("no dash anywhere", () => {
    const html = renderToStaticMarkup(h(LateTagNote, { line: amber, tag: TAG, defaultOpen: true }));
    expect(text(html)).not.toMatch(/[\u2013\u2014]/);
  });
});

describe("the Pages card", () => {
  const issues = [
    {
      page_path: "/",
      loads: 212,
      issues: [{ code: "late_tag" as const, count: 31, share: 0.146, slot: null }],
    },
  ];

  it("one page: the line sits under it, where the late-tag line sat", () => {
    const html = card(health({ late: late(310, 31), pages: issues, loads: 212 }));
    const t = text(html);
    expect(t).toContain(`20 of 20 live ${AMBER} What you can do`);
    expect(html.indexOf('data-line="late-tag"')).toBeGreaterThan(html.indexOf("homepage"));
    // The same fact is not said twice.
    expect(t).not.toContain("your tag ran after the page appeared");
    expect(t).not.toContain("How to move it");
    expect(html.match(/data-line="late-tag"/g)).toHaveLength(1);
  });

  it("several pages: once, above the list, since the count is the site's", () => {
    const html = card(health({ late: late(310, 31) }), [manifestRow(), manifestRow("/pricing")]);
    expect(html.match(/data-line="late-tag"/g)).toHaveLength(1);
    expect(html.indexOf('data-line="late-tag"')).toBeLessThan(html.indexOf("homepage"));
  });

  it("A28, the grey line on the card", () => {
    const html = card(health({ late: late(12, 6), pages: issues, loads: 212 }));
    expect(text(html)).toContain(`${LATE_TOO_FEW_LINE} What you can do`);
    expect(text(html)).not.toContain("How to move it");
  });

  it("A29, the tag in the head and under 5%: the row as it ships", () => {
    const html = card(health({ site: site("head_first"), late: late(400, 4) }));
    expect(html).not.toContain('data-line="late-tag"');
    expect(text(html)).toContain("20 of 20 live");
    expect(text(html)).not.toMatch(/appeared before|end of your page/);
  });

  it("an older worker (no `late`): the per-page line as before, in its corrected words", () => {
    const html = card(health({ pages: issues, loads: 212 }));
    expect(html).not.toContain('data-line="late-tag"');
    expect(text(html)).toContain(
      "your tag ran after the page appeared, so those visitors saw your page as you built it. How to move it",
    );
  });

  it("no health read at all: nothing breaks, nothing is said", () => {
    const html = card(null);
    expect(html).not.toContain('data-line="late-tag"');
    expect(text(html)).toContain("20 of 20 live");
  });
});
