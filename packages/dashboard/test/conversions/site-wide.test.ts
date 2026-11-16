/**
 * The Conversions screen with a button on every page (2026-10-13): a pilot
 * added its navbar "Əlaqə" and its phone link by hand with a CSS selector,
 * and the list called them "on the homepage". A site-wide row now says
 * "Counts on every page" where a slot row says its element, and shows the
 * hand-typed selector as its small detail, never as its name.
 */
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ConversionsList } from "../../src/components/conversions/ConversionsList";
import { elementCell, humanizeSectionPath } from "../../src/components/conversions/humanize";
import { isSiteWideTarget, siteSelectorOf } from "../../src/lib/site-wide";
import type { ConversionTarget } from "../../src/types/api";

function target(over: Partial<ConversionTarget>): ConversionTarget {
  return {
    id: "ct_1",
    customer_id: "medora",
    section_path: "hero.cta.label",
    label: "Explore our products",
    conversion_label: "other",
    enabled: true,
    css_selectors: [".btn"],
    text_selectors: [],
    structural_selector: "",
    created_at: 1,
    updated_at: 1,
    ...over,
  };
}

const SLOT = target({});
const PICKED = target({ id: "ct_2", section_path: "count:/pricing", label: "Book a call" });
const SITE = target({
  id: "ct_3",
  section_path: "a[href$=contact]",
  label: "Əlaqə",
  conversion_label: "contact",
  css_selectors: ["a[href$=contact]"],
});
const PHONE = target({
  id: "ct_4",
  section_path: 'a[href^="tel:"]',
  label: "+000 70 555 01 66",
  conversion_label: "contact",
});

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

describe("elementCell: the Element column", () => {
  it("a slot row shows its element, a picked row its page, neither with a detail", () => {
    expect(elementCell(SLOT)).toEqual({ name: "Hero button", detail: null });
    expect(elementCell(PICKED)).toEqual({ name: "Picked on /pricing", detail: null });
    expect(humanizeSectionPath("forms.submit_label")).toBe("Form submit button");
  });

  it("a site-wide row says Counts on every page, the selector as its detail", () => {
    expect(elementCell(SITE)).toEqual({
      name: "Counts on every page",
      detail: "a[href$=contact]",
    });
    expect(elementCell(PHONE)).toEqual({
      name: "Counts on every page",
      detail: 'a[href^="tel:"]',
    });
    // A `site:` path shows what follows the prefix; the API's mark wins over the shape.
    expect(elementCell({ section_path: "site:a[href$=contact]" })).toEqual({
      name: "Counts on every page",
      detail: "a[href$=contact]",
    });
    expect(elementCell({ section_path: "hero.cta.label", site: true })).toEqual({
      name: "Counts on every page",
      detail: "hero.cta.label",
    });
    expect(elementCell({ section_path: "a[href$=contact]", site: false })).toEqual({
      name: "a[href$=contact]",
      detail: null,
    });
  });

  it("the rule and the selector helper", () => {
    expect(isSiteWideTarget(SITE)).toBe(true);
    expect(isSiteWideTarget(SLOT)).toBe(false);
    expect(isSiteWideTarget(PICKED)).toBe(false);
    expect(siteSelectorOf("site:")).toBeNull();
    expect(siteSelectorOf("site:.nav a")).toBe(".nav a");
    expect(siteSelectorOf(".nav a")).toBe(".nav a");
  });
});

describe("ConversionsList with the pilot's rows", () => {
  const html = renderToStaticMarkup(
    h(ConversionsList, {
      customerId: "medora",
      items: [SLOT, SITE, PHONE],
      onMutated: () => {},
    }),
  );

  it("the site-wide rows read Counts on every page, the slot row its element", () => {
    const t = text(html);
    expect(t).toContain("Explore our products Hero button");
    expect(t).toContain("Əlaqə Counts on every page a[href$=contact]");
    expect(t).toContain('+000 70 555 01 66 Counts on every page a[href^="tel:"]');
    expect(t).not.toContain("homepage");
  });

  it("the selector is the row's small detail, not its name", () => {
    expect((html.match(/data-detail="selector"/g) ?? []).length).toBe(2);
    expect(html).toContain('data-detail="selector">a[href$=contact]</span>');
    // The slot row carries no detail.
    expect(html).not.toContain('data-detail="selector">hero.cta.label');
  });

  it("the read-only view says the same", () => {
    const ro = renderToStaticMarkup(
      h(ConversionsList, {
        customerId: "medora",
        items: [SITE],
        onMutated: () => {},
        readOnly: true,
      }),
    );
    expect(text(ro)).toContain("Əlaqə Counts on every page a[href$=contact]");
  });
});
