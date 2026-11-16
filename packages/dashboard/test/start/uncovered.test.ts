/**
 * Pages without versions, on the Pages card (mock design/mock/
 * sales-readiness/pilot-gaps.html, screen 07, states A31 and A32, approved
 * 2026-10-12): the count line only, from the breakdown's `pages`
 * (docs/specs/results-data.md section 4). No action button: the feature
 * behind it does not exist.
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

import { PagesCard, UncoveredLine } from "../../src/components/start/PagesCard";
import {
  UNCOVERED_MIN_VISITS,
  UNCOVERED_PERIOD,
  sharedSegment,
  uncoveredLine,
} from "../../src/lib/uncovered";
import type {
  CustomerListItem,
  ManifestResponse,
  PageRow,
  PagesBreakdown,
} from "../../src/types/api";

function page(page_path: string, visits: number, has_versions = false): PageRow {
  return {
    page_path,
    visits,
    signal_visits: Math.round(visits / 3),
    written_visits: 0,
    skipped_visits: 0,
    has_versions,
  };
}

function breakdown(
  pages: PageRow[],
  without: { pages: number; visits: number; signal_visits?: number },
): PagesBreakdown {
  return { pages, without_versions: { signal_visits: 0, ...without } };
}

// The pilot, 12 Oct: 65 product pages got 190 visits; the list holds the home
// page and the few product pages with 5 visits or more.
const MEDORA = breakdown(
  [
    page("/", 79, true),
    page("/product/omega-3", 9),
    page("/product/vitamin-d", 7),
    page("/product/maqnezium", 6),
  ],
  { pages: 65, visits: 190 },
);

const CUSTOMER = {
  id: "medora",
  slug: "medora",
  domain: "www.medora.test",
  plan: "pilot",
  status: "active",
} as CustomerListItem;

const HOME: ManifestResponse = {
  customer_id: "medora",
  page_path: "/",
  manifest: {},
  source_url: "https://www.medora.test/",
  generated_at: 1,
  confirmed_at: 2,
  cost_usd: 0,
  status: "confirmed",
};

function card(visited: PagesBreakdown | null | undefined): string {
  return renderToStaticMarkup(
    h(PagesCard, {
      customer: CUSTOMER,
      pages: [HOME],
      readyByPath: { "/": 20 },
      perPage: 20,
      writing: false,
      onPageAdded: () => undefined,
      visited,
    }),
  );
}

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

describe("uncoveredLine: the count line", () => {
  it("A31, Medora: the two counts the API gives, and the period they cover", () => {
    expect(uncoveredLine(MEDORA)).toEqual({
      text: "65 pages got 190 visits and have no versions.",
      period: "Last 7 days.",
    });
    expect(UNCOVERED_PERIOD).toBe("Last 7 days.");
  });

  it("65 pages with five listed are not called a group: the other sixty are not known", () => {
    expect(sharedSegment(MEDORA)).toBeNull();
    expect(uncoveredLine(MEDORA)?.text).not.toMatch(/under|product/);
  });

  it("the group wording, only when every such page is listed and shares a first segment", () => {
    const all = breakdown(
      [
        page("/", 300, true),
        page("/products/a", 30),
        page("/products/b", 20),
        page("/products/c", 10),
      ],
      { pages: 3, visits: 55 },
    );
    expect(sharedSegment(all)).toBe("products");
    expect(uncoveredLine(all)?.text).toBe(
      "3 pages under /products got 55 visits and have no versions.",
    );
  });

  it("different first segments, or the home page among them: the plain wording", () => {
    const mixed = breakdown([page("/products/a", 30), page("/blog/b", 20)], {
      pages: 2,
      visits: 48,
    });
    expect(uncoveredLine(mixed)?.text).toBe("2 pages got 48 visits and have no versions.");
    const home = breakdown([page("/", 30), page("/products/a", 20)], { pages: 2, visits: 48 });
    expect(uncoveredLine(home)?.text).toBe("2 pages got 48 visits and have no versions.");
    const roots = breakdown([page("/", 30), page("/", 20)], { pages: 2, visits: 48 });
    expect(sharedSegment(roots)).toBeNull();
  });

  it("a page with versions never counts toward the group", () => {
    const b = breakdown(
      [page("/products", 90, true), page("/products/a", 30), page("/products/b", 20)],
      { pages: 2, visits: 45 },
    );
    expect(uncoveredLine(b)?.text).toBe(
      "2 pages under /products got 45 visits and have no versions.",
    );
  });

  it("one page reads in the singular", () => {
    expect(uncoveredLine(breakdown([page("/pricing", 12)], { pages: 1, visits: 12 }))?.text).toBe(
      "1 page got 12 visits and has no versions.",
    );
  });

  it("large counts get their separator", () => {
    expect(uncoveredLine(breakdown([], { pages: 1240, visits: 18300 }))?.text).toBe(
      "1,240 pages got 18,300 visits and have no versions.",
    );
  });

  it("no such page, or under five visits: no line", () => {
    expect(UNCOVERED_MIN_VISITS).toBe(5);
    expect(uncoveredLine(breakdown([page("/", 80, true)], { pages: 0, visits: 0 }))).toBeNull();
    expect(uncoveredLine(breakdown([], { pages: 3, visits: 4 }))).toBeNull();
    expect(uncoveredLine(breakdown([], { pages: 3, visits: 5 }))?.text).toBe(
      "3 pages got 5 visits and have no versions.",
    );
  });

  it("no read (a row from before, an older worker, a failure): no line", () => {
    expect(uncoveredLine(null)).toBeNull();
    expect(uncoveredLine(undefined)).toBeNull();
    expect(uncoveredLine({ pages: [] } as unknown as PagesBreakdown)).toBeNull();
    expect(
      uncoveredLine({ pages: [], without_versions: {} } as unknown as PagesBreakdown),
    ).toBeNull();
  });
});

describe("what renders", () => {
  it("the line and its period, and no button", () => {
    const html = renderToStaticMarkup(h(UncoveredLine, { pages: MEDORA }));
    expect(text(html)).toBe("65 pages got 190 visits and have no versions. Last 7 days.");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("Cover pages like this one");
    expect(html).not.toMatch(/state-warn|state-err/);
  });

  it("never one product beside a visit: no path of the list is printed", () => {
    const html = renderToStaticMarkup(h(UncoveredLine, { pages: MEDORA }));
    expect(html).not.toMatch(/omega|vitamin|maqnezium/);
  });

  it("on the Pages card it sits after the pages and before the add field", () => {
    const html = card(MEDORA);
    const at = html.indexOf('data-line="uncovered"');
    expect(at).toBeGreaterThan(html.indexOf("homepage"));
    expect(at).toBeLessThan(html.indexOf("Add this page"));
  });

  it("the card is as it was without the read", () => {
    expect(card(null)).not.toContain('data-line="uncovered"');
    expect(card(undefined)).toBe(card(null));
    expect(text(card(null))).toContain("Add this page");
  });
});

describe("the Live screen", () => {
  it("reads the breakdown Results already reads, for the last 7 days", () => {
    const src = readFileSync(
      new URL("../../src/components/start/FirstRun.tsx", import.meta.url),
      "utf8",
    );
    expect(src).toContain("visited={visited}");
    expect(src).toContain("setVisited(b.pages ?? null)");
  });
});
