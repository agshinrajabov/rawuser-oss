/**
 * A button on every page (mock design/mock/sales-readiness/site-wide-and-
 * sensitive.html, sections 01 to 04 and 08, approved 2026-10-22; contract
 * docs/specs/visual-picker.md §9.10): the button list with a switch per
 * row (A1, A8, A9, A11), the entry and its pick in place (A4 to A7), the
 * same rows on the Pages card (A2, A3), the Conversions screen's entry, and
 * the calls with `scope: "site"`. Rendered to markup, no network.
 */
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ButtonList,
  ButtonRow,
  ButtonsBody,
  SiteEntry,
  WhatToCount,
} from "../../src/components/conversions/ButtonList";
import type { SitePick, SitePickPhase } from "../../src/components/conversions/useSitePick";
import {
  PageGroupRows,
  type PageGroupsData,
  SitePickStep,
} from "../../src/components/start/PageGroups";
import { Dialog } from "../../src/components/ui/Dialog";
import { ApiError } from "../../src/lib/api";
import {
  type Api,
  DELETE_PATH,
  LIST_PATH,
  PICK_STATUS_PATH,
  PICK_TOKEN_PATH,
  UPSERT_PATH,
} from "../../src/lib/measure";
import { TEST_RUNNING_LINE, buttonWhere, countedLines } from "../../src/lib/page-groups";
import {
  ENTRY,
  LIST_LEAD,
  LIST_TITLE,
  ONE_PAGE_ONLY,
  PICK_IT,
  SITE_OPEN_LABEL,
  SITE_OPEN_LINE,
  SITE_PICK_TITLE,
  WHAT_TO_COUNT,
  WHAT_TO_COUNT_LINES,
  buttonName,
  canPickAgain,
  mintSitePick,
  pollSitePick,
  setCounted,
  siteCountingLine,
  sitePickedLine,
  undoNewPick,
} from "../../src/lib/site-pick";
import type { ConversionTarget, PageGroupsResponse } from "../../src/types/api";

const noop = () => undefined;

function target(over: Partial<ConversionTarget>): ConversionTarget {
  return {
    id: "ct_1",
    customer_id: "medora",
    section_path: "forms.submit_label",
    label: "Göndər",
    conversion_label: "contact",
    enabled: true,
    css_selectors: ["form button"],
    text_selectors: ["Göndər"],
    structural_selector: "form > button",
    created_at: 1,
    updated_at: 1,
    ...over,
  };
}

const SEND = target({});
const PRODUCTS = target({
  id: "ct_2",
  section_path: "hero.cta.label",
  label: "Məhsullarımız",
  conversion_label: "other",
  enabled: false,
});
const ELAQE = target({
  id: "ct_3",
  section_path: "site:elaqe",
  label: "Əlaqə",
  css_selectors: ["nav a.contact"],
  site: true,
});
const PHONE = target({
  id: "ct_4",
  section_path: "site:phone",
  label: "Phone number",
  css_selectors: ['a[href^="tel:"]'],
  site: true,
});
const GROUP = target({
  id: "ct_5",
  section_path: "count:/products/*",
  label: "Əlaqə",
  page: "/products/*",
  group: true,
  pages: 69,
});
const PRICING = target({ id: "ct_6", section_path: "count:/pricing", label: "Book a call" });

function pick(over: Partial<SitePick> = {}): SitePick {
  return {
    slot: null,
    phase: null,
    said: null,
    begin: noop,
    open: noop,
    cancel: noop,
    use: noop,
    again: noop,
    settle: noop,
    ...over,
  };
}

function inStep(phase: SitePickPhase, slot = "entry"): SitePick {
  return pick({ slot, phase });
}

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function recorder(answer: (path: string) => unknown) {
  const calls: { path: string; body: unknown }[] = [];
  const api: Api = async <T>(path: string, init?: RequestInit) => {
    calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null });
    const a = answer(path);
    if (a instanceof Error) throw a;
    return a as T;
  };
  return { api, calls };
}

function list(items: ConversionTarget[], over: Record<string, unknown> = {}) {
  return renderToStaticMarkup(
    h(ButtonList, {
      customerId: "medora",
      items,
      blocked: false,
      onItems: noop,
      pick: pick(),
      ...over,
    }),
  );
}

// ---------------------------------------------------------------------------
// Where a button counts, and its name
// ---------------------------------------------------------------------------

describe("every list says where a button counts (decision 3)", () => {
  it("homepage, a page, a group, every page; never a selector", () => {
    expect(buttonWhere(SEND).where).toBe("on the homepage");
    expect(buttonWhere(PRICING).where).toBe("on /pricing");
    expect(buttonWhere(GROUP).where).toBe("on 69 pages");
    expect(buttonWhere(ELAQE).where).toBe("on every page");
    const typed = target({ section_path: "a[href$=contact]", label: "Əlaqə" });
    expect(buttonWhere(typed).where).toBe("on every page");
  });

  it("the counted list keeps its words, for enabled buttons only (A13)", () => {
    const lines = countedLines([SEND, PRODUCTS, ELAQE, PHONE]);
    expect(lines.map((l) => `${l.label} ${l.where}`)).toEqual([
      "Göndər on the homepage",
      "Əlaqə on every page",
      "Phone number on every page",
    ]);
  });

  it("the button's own words in quotes; a contact kind the API stored, as it is", () => {
    expect(buttonName(ELAQE)).toBe("“Əlaqə”");
    expect(buttonName(PHONE)).toBe("Phone number");
    expect(buttonName(target({ section_path: "site:email", label: "Email address" }))).toBe(
      "Email address",
    );
    // Only a site row's label can be a kind: a slot named so keeps its quotes.
    expect(buttonName(target({ label: "Phone number" }))).toBe("“Phone number”");
  });

  it("the picked line and the Pages card's row", () => {
    expect(sitePickedLine(ELAQE)).toBe("Contact · Counts on every page");
    expect(sitePickedLine(target({ conversion_label: "other" }))).toBe("Counts on every page");
    expect(siteCountingLine(ELAQE)).toBe('Counting clicks on "Əlaqə"');
    expect(siteCountingLine(PHONE)).toBe("Counting clicks on Phone number");
    expect(siteCountingLine({ ...ELAQE, enabled: false })).toBe('"Əlaqə", not counted');
  });

  it("Pick again is a site row's; every row has Remove", () => {
    expect(canPickAgain(ELAQE)).toBe(true);
    expect(canPickAgain(SEND)).toBe(false);
    expect(canPickAgain(PRICING)).toBe(false);
    expect(canPickAgain(GROUP)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The button list (A1, A8, A9, A11)
// ---------------------------------------------------------------------------

describe("the button list", () => {
  it("A1: one row per button with its switch, the entry row last, the one-page pick under it", () => {
    const html = list([SEND, PRODUCTS]);
    const t = text(html);
    expect(t).toContain("“Göndər” on the homepage On");
    expect(t).toContain("“Məhsullarımız” on the homepage Off");
    expect(t).toContain(`${ENTRY} ${PICK_IT}`);
    expect(t).toContain(`${ONE_PAGE_ONLY} ${PICK_IT}`);
    expect((html.match(/role="switch"/g) ?? []).length).toBe(2);
    expect(html).toMatch(/aria-checked="true"[^>]*aria-label="Count clicks on Göndər"/);
    expect(html).toMatch(/aria-checked="false"[^>]*aria-label="Count clicks on Məhsullarımız"/);
    // The entry comes after every button.
    expect(t.indexOf(ENTRY)).toBeGreaterThan(t.indexOf("Məhsullarımız"));
  });

  it("A8: three counted, one off, the phone row by its kind", () => {
    const t = text(list([SEND, ELAQE, PHONE, PRODUCTS]));
    expect(t).toContain("“Əlaqə” on every page On");
    expect(t).toContain("Phone number on every page On");
    expect(t).not.toContain("“Phone number”");
    expect(t).not.toContain("nav a.contact");
  });

  it("an off row is lighter; an on row is the page's own weight", () => {
    const html = list([SEND, PRODUCTS]);
    expect(html).toContain('<b class="break-words font-medium text-fg">“Göndər”</b>');
    expect(html).toContain('<b class="break-words font-normal text-fg-muted">“Məhsullarımız”</b>');
  });

  it("A9: a site row's menu offers Pick again and Remove; a page row's Remove only", () => {
    const site = text(
      renderToStaticMarkup(
        h(
          "ul",
          null,
          h(ButtonRow, {
            target: ELAQE,
            onToggle: noop,
            onPickAgain: noop,
            onRemove: noop,
            menuOpen: true,
          }),
        ),
      ),
    );
    expect(site).toContain("Pick again Remove");
    const page = text(
      renderToStaticMarkup(
        h(
          "ul",
          null,
          h(ButtonRow, { target: SEND, onToggle: noop, onRemove: noop, menuOpen: true }),
        ),
      ),
    );
    expect(page).not.toContain("Pick again");
    expect(page).toContain("Remove");
  });

  it("A11: while a test runs, switches shown not live, no menus, no entry, one line", () => {
    const html = list([SEND, ELAQE, PHONE, PRODUCTS], { blocked: true });
    const t = text(html);
    expect((html.match(/role="switch"[^>]*disabled=""/g) ?? []).length).toBe(4);
    expect(html).not.toContain('aria-label="More"');
    expect(t).not.toContain(ENTRY);
    expect(t).not.toContain(ONE_PAGE_ONLY);
    expect(t).toContain(`${TEST_RUNNING_LINE} Go to Test`);
    expect((t.match(new RegExp(TEST_RUNNING_LINE, "g")) ?? []).length).toBe(1);
    // Under the last row.
    expect(t.indexOf(TEST_RUNNING_LINE)).toBeGreaterThan(t.indexOf("Məhsullarımız"));
    expect(html).toContain('href="/test?customer_id=medora"');
  });

  it("on Test the line's link closes the dialog instead of leaving", () => {
    const html = list([SEND], { blocked: true, onGoToResults: noop });
    expect(html).not.toContain('href="/test');
    expect(html).toMatch(/<button[^>]*>Go to Test<\/button>/);
  });

  it("a refusal from the pick is shown as the API wrote it", () => {
    const said = "Pick a button from the menu or the footer, or a phone or email link.";
    expect(text(list([SEND], { pick: pick({ said }) }))).toContain(said);
  });

  it("A10: What should I count? opens to two lines", () => {
    const t = text(renderToStaticMarkup(h(WhatToCount, { defaultOpen: true })));
    expect(t).toContain(WHAT_TO_COUNT);
    for (const l of WHAT_TO_COUNT_LINES) expect(t).toContain(l);
  });

  it("the dialog body: title, lead, the list, Done", () => {
    const html = renderToStaticMarkup(
      h(
        Dialog,
        { open: true },
        h(ButtonsBody, {
          customerId: "medora",
          items: [SEND, PRODUCTS],
          blocked: false,
          onItems: noop,
          pick: pick(),
          onDone: noop,
        }),
      ),
    );
    const t = text(html);
    expect(t).toContain(LIST_TITLE);
    expect(t).toContain(LIST_LEAD);
    expect(t).toContain(WHAT_TO_COUNT);
    expect(t.endsWith("Done")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The pick, in place (A4 to A7)
// ---------------------------------------------------------------------------

describe("the site pick in place of the entry", () => {
  it("A4: the link: its title, its line, Open your page to pick, Cancel, the private window", () => {
    const t = text(list([SEND], { pick: inStep({ kind: "link", busy: false }) }));
    expect(t).toContain(`${SITE_PICK_TITLE} ${SITE_OPEN_LINE} ${SITE_OPEN_LABEL} Cancel`);
    expect(t).toContain("Use a private window. The link works once, for 15 minutes.");
    expect(t).not.toContain(ENTRY);
  });

  it("A5: waiting for the pick", () => {
    const t = text(
      renderToStaticMarkup(
        h(SitePickStep, { pick: inStep({ kind: "waiting", pagePath: "/", since: 0 }) }),
      ),
    );
    expect(t).toContain(`${SITE_PICK_TITLE} Waiting for your pick. Cancel`);
    expect(t).toContain("Click the button on the page you opened. This screen moves on by itself.");
  });

  it("A6: picked: the words in quotes, Contact, Counts on every page, two actions", () => {
    const t = text(
      renderToStaticMarkup(
        h(SitePickStep, { pick: inStep({ kind: "picked", target: ELAQE, items: [ELAQE] }) }),
      ),
    );
    expect(t).toBe("“Əlaqə” Contact · Counts on every page Use this button Pick again");
  });

  it("A7: a phone link picked: its kind as the API stored it", () => {
    const t = text(
      renderToStaticMarkup(
        h(SitePickStep, { pick: inStep({ kind: "picked", target: PHONE, items: [PHONE] }) }),
      ),
    );
    expect(t).toBe("Phone number Contact · Counts on every page Use this button Pick again");
  });

  it("Pick again on a row runs the step in that row's place", () => {
    const t = text(list([SEND, ELAQE], { pick: inStep({ kind: "link", busy: false }, ELAQE.id) }));
    expect(t).toContain("“Göndər” on the homepage");
    expect(t).not.toContain("“Əlaqə” on every page");
    expect(t).toContain(SITE_PICK_TITLE);
    expect(t).toContain(`${ENTRY} ${PICK_IT}`);
  });
});

// ---------------------------------------------------------------------------
// The Pages card (A2, A3) and the Conversions screen
// ---------------------------------------------------------------------------

const GROUPS: PageGroupsResponse = {
  groups: [{ pattern: "/products/*", pages: 69, visits: 190, counted: GROUP }],
  proposals: [],
};

function data(over: Partial<PageGroupsData> = {}): PageGroupsData {
  return {
    answer: GROUPS,
    testRunning: false,
    sensitive: false,
    reload: noop,
    apply: noop,
    ...over,
  };
}

describe("the Pages card's group area", () => {
  it("A2: the entry under the groups, lighter, with the button", () => {
    const html = renderToStaticMarkup(
      h(PageGroupRows, { customerId: "medora", data: data(), buttons: [SEND, GROUP] }),
    );
    const t = text(html);
    expect(t).toContain('/products/… 69 pages Counting clicks on "Əlaqə"');
    expect(t).toContain(`${ENTRY} ${PICK_IT}`);
    expect(t.indexOf(ENTRY)).toBeGreaterThan(t.indexOf("/products/…"));
  });

  it("A3: a site row after a pick, its switch and menu, the entry under it", () => {
    const t = text(
      renderToStaticMarkup(
        h(PageGroupRows, { customerId: "medora", data: data(), buttons: [GROUP, ELAQE] }),
      ),
    );
    expect(t).toContain('Counting clicks on "Əlaqə" on every page On');
    expect(t.indexOf(ENTRY)).toBeGreaterThan(t.indexOf("on every page"));
  });

  it("while a test runs: no entry and no menu on the site row", () => {
    const html = renderToStaticMarkup(
      h(PageGroupRows, {
        customerId: "medora",
        data: data({ testRunning: true }),
        buttons: [GROUP, ELAQE],
      }),
    );
    expect(text(html)).not.toContain(ENTRY);
    expect(html).not.toContain('aria-label="More"');
  });

  it("no groups: nothing, as before", () => {
    const html = renderToStaticMarkup(
      h(PageGroupRows, {
        customerId: "medora",
        data: data({ answer: { groups: [], proposals: [] } }),
        buttons: [ELAQE],
      }),
    );
    expect(html).toBe("");
  });
});

describe("the Conversions screen's entry", () => {
  it("one quiet row with the button", () => {
    const t = text(
      renderToStaticMarkup(h(SiteEntry, { customerId: "medora", items: [], onItems: noop })),
    );
    expect(t).toBe(`${ENTRY} ${PICK_IT}`);
  });

  it("while a test runs: no pick, the one line that says why (mock 08)", () => {
    const html = renderToStaticMarkup(
      h(SiteEntry, { customerId: "medora", items: [], onItems: noop, blocked: true }),
    );
    expect(html).toContain('data-line="buttons-blocked"');
    expect(text(html)).toContain(TEST_RUNNING_LINE);
    expect(text(html)).not.toContain(PICK_IT);
  });
});

// ---------------------------------------------------------------------------
// The calls
// ---------------------------------------------------------------------------

const LINK = "https://www.medora.test/#rawuser_pick=abc";

describe("the calls with scope site", () => {
  it("mints a link for the homepage with scope site", async () => {
    const { api, calls } = recorder(() => ({
      token: "abc",
      page_path: "/",
      scope: "site",
      expires_in_s: 900,
      link: LINK,
    }));
    expect(await mintSitePick("medora", api)).toEqual({
      kind: "ok",
      value: { link: LINK, pagePath: "/" },
    });
    expect(calls[0]).toEqual({
      path: PICK_TOKEN_PATH,
      body: { customer_id: "medora", page_path: "/", scope: "site" },
    });
  });

  it("a 409 (a test, five buttons, the tag withheld) comes back as its sentence", async () => {
    const full = "You already count 5 buttons on every page. Remove one first.";
    const { api } = recorder(
      () => new ApiError(409, `API error 409: ${JSON.stringify({ error: full })}`),
    );
    expect(await mintSitePick("medora", api)).toEqual({ kind: "refused", sentence: full });
  });

  it("polls with scope site and the page the link opened", async () => {
    const { api, calls } = recorder(() => ({ landed: false, page_path: "/", scope: "site" }));
    expect(await pollSitePick("medora", "/", api)).toEqual({ kind: "waiting" });
    expect(calls[0]?.path).toBe(`${PICK_STATUS_PATH}?customer_id=medora&scope=site&page_path=%2F`);
  });

  it("landed: the target and the list", async () => {
    const { api } = recorder(() => ({
      landed: true,
      page_path: "/",
      target: ELAQE,
      items: [SEND, ELAQE],
      scope: "site",
    }));
    expect(await pollSitePick("medora", "/", api)).toEqual({
      kind: "landed",
      target: ELAQE,
      items: [SEND, ELAQE],
    });
  });

  it("a page-body pick (400) is said as written", async () => {
    const line = "Pick a button from the menu or the footer, or a phone or email link.";
    const { api } = recorder(
      () => new ApiError(400, `API error 400: ${JSON.stringify({ error: line, scope: "site" })}`),
    );
    expect(await pollSitePick("medora", "/", api)).toEqual({ kind: "refused", sentence: line });
    const net = recorder(() => new TypeError("Failed to fetch"));
    expect((await pollSitePick("medora", "/", net.api)).kind).toBe("waiting");
  });

  it("a switch moves this button only: the upsert with its own selectors, then the list", async () => {
    const { api, calls } = recorder((p) => (p.startsWith(LIST_PATH) ? { items: [SEND] } : {}));
    expect(await setCounted("medora", ELAQE, false, api)).toEqual({ kind: "ok", value: [SEND] });
    expect(calls[0]).toEqual({
      path: UPSERT_PATH,
      body: {
        customer_id: "medora",
        id: "ct_3",
        section_path: "site:elaqe",
        label: "Əlaqə",
        conversion_label: "contact",
        enabled: false,
        css_selectors: ["nav a.contact"],
        text_selectors: ["Göndər"],
        structural_selector: "form > button",
      },
    });
    expect(calls.some((c) => c.path === "/admin/conversions/count")).toBe(false);
    const lock =
      "A test is running, so the buttons it counts cannot change. Stop the test first to change them.";
    const locked = recorder(
      () => new ApiError(409, `API error 409: ${JSON.stringify({ error: lock })}`),
    );
    expect(await setCounted("medora", ELAQE, true, locked.api)).toEqual({
      kind: "refused",
      sentence: lock,
    });
  });

  it("Pick again takes a new row off first; a row that was there stays", async () => {
    const { api, calls } = recorder(() => ({ deleted: true }));
    expect((await undoNewPick(ELAQE, [SEND], api)).kind).toBe("ok");
    expect(calls[0]).toEqual({ path: DELETE_PATH, body: { id: "ct_3" } });
    const kept = recorder(() => ({ deleted: true }));
    expect((await undoNewPick(ELAQE, [SEND, ELAQE], kept.api)).kind).toBe("ok");
    expect(kept.calls).toHaveLength(0);
  });
});
