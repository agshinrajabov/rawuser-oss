/**
 * Page groups on the Pages card (mock design/mock/sales-readiness/
 * page-groups.html, sections 01 to 04 and 06, approved 2026-10-12 as drawn;
 * contract docs/specs/page-groups.md, API): a proposal row and the lighter
 * second one, "What is this?", the pick step in place (the link, waiting,
 * picked), a counting row with its switch and menu, Off, the amber line
 * only from the API's own field, blocked while a test runs with the API's
 * 409 sentence, the sensitive tag, and nothing at all without the field.
 */
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => undefined, push: () => undefined }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/",
}));

import {
  type GroupPickPhase,
  GroupPickStep,
  GroupRowView,
  PageGroupRows,
  type PageGroupsData,
  RowMenu,
} from "../../src/components/start/PageGroups";
import { PagesCard } from "../../src/components/start/PagesCard";
import { ApiError } from "../../src/lib/api";
import type { Api } from "../../src/lib/measure";
import {
  COUNT_ON_THESE,
  GROUPS_DELETE_PATH,
  GROUPS_PATH,
  type GroupRow,
  OPEN_LINE,
  PASTE_PAGE_LINE,
  PRIVATE_WINDOW_LINE,
  SENSITIVE_TAG,
  TEST_RUNNING_LINE,
  UPSERT_PATH,
  WAITING_SUB,
  WHAT_LINES,
  acceptGroup,
  countingLine,
  countsOn,
  groupRows,
  kindWord,
  knownPageOf,
  mintGroupPick,
  missingLine,
  openToPick,
  pageToSend,
  pagesLine,
  pastedPagePath,
  patternLabel,
  pickTitle,
  pickedLine,
  pollGroupPick,
  readGroups,
  removeGroup,
  setGroupCounted,
  visitsLine,
} from "../../src/lib/page-groups";
import type {
  ConversionTarget,
  CustomerListItem,
  ManifestResponse,
  PageGroupsResponse,
  PagesBreakdown,
} from "../../src/types/api";

/** The sentence the API gives for a counted button during a test (conversions.ts). */
const TEST_LOCK =
  "A test is running, so the buttons it counts cannot change. Stop the test first to change them.";

const ELAQE: ConversionTarget = {
  id: "ct_1",
  customer_id: "medora",
  section_path: "count:/products/*",
  label: "Əlaqə",
  conversion_label: "contact",
  enabled: true,
  css_selectors: ["nav a.contact"],
  text_selectors: [],
  structural_selector: "",
  created_at: 1,
  updated_at: 1,
  page: "/products/*",
  group: true,
};

const PRODUCTS = { pattern: "/products/*", pages: 69, visits: 190 };
const BLOG = { pattern: "/blog/*", pages: 12, visits: 23 };

const PROPOSED: PageGroupsResponse = { groups: [], proposals: [PRODUCTS, BLOG], max: 5 };
const COUNTING: PageGroupsResponse = {
  groups: [{ ...PRODUCTS, counted: ELAQE }],
  proposals: [BLOG],
  max: 5,
};

function data(
  answer: PageGroupsResponse | null,
  over: Partial<PageGroupsData> = {},
): PageGroupsData {
  return {
    answer,
    testRunning: false,
    sensitive: false,
    reload: () => undefined,
    apply: () => undefined,
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

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function rows(d: PageGroupsData, over: Record<string, unknown> = {}) {
  return renderToStaticMarkup(h(PageGroupRows, { customerId: "medora", data: d, ...over }));
}

function row(r: GroupRow, target: ConversionTarget | null, over: Record<string, unknown> = {}) {
  return renderToStaticMarkup(
    h(
      "ul",
      null,
      h(GroupRowView, {
        row: r,
        target,
        customerId: "medora",
        onCount: () => undefined,
        onToggle: () => undefined,
        onPickAgain: () => undefined,
        onRemove: () => undefined,
        ...over,
      }),
    ),
  );
}

const PRODUCTS_ROW: GroupRow = {
  ...PRODUCTS,
  accepted: false,
  counted: null,
  missing: null,
  lite: false,
};

describe("the words", () => {
  it("the path with its free segment, and the pages and visits as the API counts them", () => {
    expect(patternLabel("/products/*")).toBe("/products/…");
    expect(patternLabel("/shop/items/*")).toBe("/shop/items/…");
    expect(pagesLine(69, true)).toBe("69 pages share this layout");
    expect(pagesLine(12, false)).toBe("12 pages");
    expect(pagesLine(1, false)).toBe("1 page");
    expect(visitsLine(190)).toBe("190 visits, no versions");
    expect(visitsLine(1240)).toBe("1,240 visits, no versions");
  });

  it("never a number the API did not give", () => {
    expect(pagesLine(null, true)).toBeNull();
    expect(pagesLine(undefined, false)).toBeNull();
    expect(visitsLine(null)).toBeNull();
    expect(pickTitle(null)).toBe("The button to count on these pages");
    expect(countsOn(undefined)).toBe("Counts on these pages");
  });

  it("the pick's lines", () => {
    expect(pickTitle(69)).toBe("The button to count on 69 pages");
    expect(openToPick("/products/*")).toBe("Open /products/… to pick");
    expect(OPEN_LINE).toBe("Open any of these pages and click the button to count.");
    expect(PRIVATE_WINDOW_LINE).toBe("Use a private window. The link works once, for 15 minutes.");
    expect(WAITING_SUB).toBe(
      "Click the button on the page you opened. This screen moves on by itself.",
    );
    expect(pickedLine(ELAQE, 69)).toBe("Contact · Counts on 69 pages");
    expect(pickedLine({ conversion_label: "other" }, 69)).toBe("Counts on 69 pages");
    expect(kindWord("signup")).toBe("Sign up");
    expect(kindWord("nonsense")).toBeNull();
  });

  it("the counting row's line, on and off", () => {
    expect(countingLine("Əlaqə", true)).toBe('Counting clicks on "Əlaqə"');
    expect(countingLine("Əlaqə", false)).toBe('"Əlaqə", not counted');
  });

  it("the amber line: the API's count, 'some' on a sensitive site, nothing without the field", () => {
    expect(missingLine({ pages: 4 }, false)).toBe("Not found on 4 of these pages.");
    expect(missingLine({ pages: 4 }, true)).toBe("Not found on some of these pages.");
    expect(missingLine(null, false)).toBeNull();
    expect(missingLine(undefined, false)).toBeNull();
    expect(missingLine({ pages: 0 }, false)).toBeNull();
  });

  it("no dash anywhere in the words", () => {
    for (const w of [COUNT_ON_THESE, TEST_RUNNING_LINE, SENSITIVE_TAG, ...WHAT_LINES]) {
      expect(w).not.toMatch(/[–—]/);
    }
  });
});

describe("groupRows: the card's order", () => {
  it("accepted groups first, then the proposals by visits, the first plain and the rest lighter", () => {
    const r = groupRows({
      groups: [{ ...PRODUCTS, counted: ELAQE }],
      proposals: [BLOG, { pattern: "/docs/*", pages: 7, visits: 40 }],
    });
    expect(r.map((x) => [x.pattern, x.accepted, x.lite])).toEqual([
      ["/products/*", true, false],
      ["/docs/*", false, true],
      ["/blog/*", false, true],
    ]);
    expect(r[0]?.counted).toBe(ELAQE);
  });

  it("a proposal the list already holds is not shown twice", () => {
    const r = groupRows({ groups: [{ ...PRODUCTS, counted: null }], proposals: [PRODUCTS] });
    expect(r).toHaveLength(1);
    expect(r[0]?.accepted).toBe(true);
  });

  it("a null count stays null; an answer without the fields gives no rows", () => {
    expect(
      groupRows({ groups: [{ pattern: "/products/*", pages: null, visits: null }] })[0],
    ).toMatchObject({
      pages: null,
      visits: null,
    });
    expect(groupRows(null)).toEqual([]);
    expect(groupRows(undefined)).toEqual([]);
    expect(groupRows({})).toEqual([]);
    expect(groupRows({ groups: [], proposals: [] })).toEqual([]);
  });
});

describe("A1: a group proposed", () => {
  it("the path, how many pages, the visits with no versions, one button; the second group lighter", () => {
    const html = rows(data(PROPOSED));
    const t = text(html);
    expect(t).toContain(
      "/products/… 69 pages share this layout 190 visits, no versions Count a button on these pages",
    );
    expect(t).toContain("/blog/… 12 pages 23 visits, no versions Count a button on these pages");
    expect(html).toContain('data-group="/blog/*"');
    // The lighter row: muted text; the first row's path in the full colour.
    const blog = html.slice(html.indexOf('data-group="/blog/*"'));
    expect(blog).toContain("text-fg-muted");
    expect(html.match(/Count a button on these pages/g)).toHaveLength(2);
    expect(html).not.toContain('role="switch"');
  });

  it("A2: 'What is this?' holds two lines, closed by default", () => {
    const closed = rows(data(PROPOSED));
    expect(closed).toContain('data-line="what-is-this"');
    expect(closed).not.toContain("<details open");
    const open = rows(data(PROPOSED), { defaultOpen: true });
    expect(text(open)).toContain(
      "These pages get no versions yet. Counting a button here lets your test see clicks on them.",
    );
  });

  it("nothing without a group or a proposal (an older worker, a failed read, an empty answer)", () => {
    expect(rows(data(null))).toBe("");
    expect(rows(data({}))).toBe("");
    expect(rows(data({ groups: [], proposals: [] }))).toBe("");
  });
});

describe("A4 to A6: the pick step in place", () => {
  function step(phase: GroupPickPhase, pages: number | null = 69) {
    return renderToStaticMarkup(
      h(GroupPickStep, {
        pattern: "/products/*",
        pages,
        phase,
        onOpen: () => undefined,
        onCancel: () => undefined,
        onUse: () => undefined,
        onPickAgain: () => undefined,
      }),
    );
  }

  it("A4, the link: the title, the line, Open to pick, Cancel, the private-window line", () => {
    const html = step({ kind: "link" });
    expect(text(html)).toBe(
      "The button to count on 69 pages Open any of these pages and click the button to count. Open /products/… to pick Cancel Use a private window. The link works once, for 15 minutes.",
    );
    expect(html).toContain('data-pick="link"');
  });

  it("A5, waiting: the spinner, Cancel, and the line that it moves on by itself", () => {
    const html = step({ kind: "waiting" });
    expect(text(html)).toBe(
      "The button to count on 69 pages Waiting for your pick. Cancel Click the button on the page you opened. This screen moves on by itself.",
    );
    expect(html).toContain("animate-spin");
  });

  it("the page input shows only when the worker asked for one, with its line as the label", () => {
    const asked = step({ kind: "link", needed: PASTE_PAGE_LINE });
    expect(asked).toContain("<input");
    expect(asked).toContain('data-line="group-page-needed"');
    expect(text(asked)).toContain(`Cancel ${PASTE_PAGE_LINE} ${PRIVATE_WINDOW_LINE}`);
    expect(asked).toContain('placeholder="/products/…"');
    for (const html of [
      step({ kind: "link" }),
      step({ kind: "link", busy: true }),
      step({ kind: "waiting" }),
      step({ kind: "picked", target: ELAQE }),
    ]) {
      expect(html).not.toContain("<input");
      expect(html).not.toContain(PASTE_PAGE_LINE);
    }
  });

  it("A6, picked: the button's own words, its kind, where it counts, two actions", () => {
    const html = step({ kind: "picked", target: ELAQE });
    expect(text(html)).toBe("“Əlaqə” Contact · Counts on 69 pages Use this button Pick again");
    expect(html).toContain("state-success");
  });

  it("without a page count the step says 'these pages'", () => {
    expect(text(step({ kind: "link" }, null))).toContain("The button to count on these pages");
    expect(text(step({ kind: "picked", target: ELAQE }, null))).toContain(
      "Contact · Counts on these pages",
    );
  });
});

describe("A8 to A10: a group counting", () => {
  const counting: GroupRow = { ...PRODUCTS_ROW, accepted: true, counted: ELAQE };

  it("A8: the row names the button, the switch is On, the menu is there", () => {
    const html = row(counting, ELAQE);
    expect(text(html)).toBe('/products/… 69 pages Counting clicks on "Əlaqə" On');
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('aria-label="More"');
    expect(html).not.toContain("Count a button on these pages");
  });

  it("A9: the menu holds Pick again and Remove", () => {
    const html = row(counting, ELAQE, { menuOpen: true });
    expect(text(html)).toContain("On Pick again Remove");
    expect(html).toContain('role="menu"');
    expect(html.match(/role="menuitem"/g)).toHaveLength(2);
    const closed = renderToStaticMarkup(
      h(RowMenu, { items: [{ label: "Remove", onSelect: () => undefined }] }),
    );
    expect(closed).not.toContain('role="menu"');
  });

  it("A10: switched off, the button stays picked and nothing is counted", () => {
    const html = row(counting, { ...ELAQE, enabled: false });
    expect(text(html)).toBe('/products/… 69 pages "Əlaqə", not counted Off');
    expect(html).toContain('aria-checked="false"');
  });

  it("A11 and A12: the amber line only when the API sends the field, with its pages behind Show pages", () => {
    expect(row(counting, ELAQE)).not.toContain('data-line="group-missing"');
    const withCount = row({ ...counting, missing: { pages: 4 } }, ELAQE);
    expect(text(withCount)).toContain("Not found on 4 of these pages.");
    expect(withCount).not.toContain("Show pages");
    const withPaths = row(
      { ...counting, missing: { pages: 2, paths: ["/products/gift-card", "/products/sale"] } },
      ELAQE,
    );
    expect(text(withPaths)).toContain(
      "Not found on 2 of these pages. Show pages Hide /products/gift-card /products/sale",
    );
    expect(withPaths).toContain("state-warn");
  });

  it("the whole list: the counting row, then the blog proposal lighter (A8)", () => {
    const t = text(rows(data(COUNTING)));
    expect(t).toContain(
      '/products/… 69 pages Counting clicks on "Əlaqə" On /blog/… 12 pages 23 visits, no versions Count a button on these pages',
    );
  });
});

describe("A14 and A15: blocked while a test runs", () => {
  it("the proposal's button is off and one quiet line says why, with the way to Test", () => {
    const html = row(PRODUCTS_ROW, null, { blocked: true });
    expect(html).toMatch(/<button[^>]*disabled[^>]*>[\s\S]*?Count a button on these pages/);
    expect(text(html)).toContain(
      "A test is running. Stop it to change what is counted. Go to Test",
    );
    expect(html).toContain('href="/test?customer_id=medora"');
    expect(html).toContain('data-line="group-blocked"');
    expect(html).not.toContain("state-warn");
  });

  it("the counting row's switch is shown but not live, and the menu is gone", () => {
    const html = row({ ...PRODUCTS_ROW, accepted: true, counted: ELAQE }, ELAQE, { blocked: true });
    expect(html).toMatch(/<button[^>]*role="switch"[^>]*disabled/);
    expect(html).not.toContain('aria-label="More"');
    expect(text(html)).toContain(TEST_RUNNING_LINE);
  });

  it("the API's own 409 sentence renders as written", () => {
    const html = row(PRODUCTS_ROW, null, { said: TEST_LOCK });
    expect(text(html)).toContain(TEST_LOCK);
    expect(html).toContain('role="alert"');
  });

  it("the rows take the test from the read", () => {
    expect(
      rows(data(PROPOSED, { testRunning: true })).match(/data-line="group-blocked"/g),
    ).toHaveLength(2);
    expect(rows(data(PROPOSED))).not.toContain('data-line="group-blocked"');
  });
});

describe("A20 and A21: a sensitive site", () => {
  it("the tag in the superadmin's view, on a proposal and on a counting row", () => {
    const html = rows(data(COUNTING, { sensitive: true }), { superadmin: true });
    expect(html.match(/Pages are recorded as a group/g)).toHaveLength(2);
    expect(text(html)).toContain('Counting clicks on "Əlaqə" Pages are recorded as a group On');
  });

  it("the customer's view is the same minus the tag", () => {
    expect(rows(data(COUNTING, { sensitive: true }))).not.toContain(SENSITIVE_TAG);
    expect(rows(data(COUNTING), { superadmin: true })).not.toContain(SENSITIVE_TAG);
  });

  it("the amber line names no count and lists no page", () => {
    const html = row(
      {
        ...PRODUCTS_ROW,
        accepted: true,
        counted: ELAQE,
        missing: { pages: 4, paths: ["/products/sale"] },
      },
      ELAQE,
      { sensitive: true },
    );
    expect(text(html)).toContain("Not found on some of these pages.");
    expect(html).not.toContain("Show pages");
    expect(html).not.toContain("/products/sale");
    expect(text(html)).not.toMatch(/\b4\b/);
  });
});

describe("the Pages card", () => {
  function card(
    groups: { data: PageGroupsData; superadmin: boolean } | null,
    visited: PagesBreakdown | null = null,
  ) {
    return renderToStaticMarkup(
      h(PagesCard, {
        customer: CUSTOMER,
        pages: [HOME],
        readyByPath: { "/": 20 },
        perPage: 20,
        writing: false,
        onPageAdded: () => undefined,
        groups,
        visited,
      }),
    );
  }

  const VISITED: PagesBreakdown = {
    pages: [],
    without_versions: { pages: 65, visits: 190, signal_visits: 60 },
  };

  it("the group rows sit under the confirmed pages and before Add this page", () => {
    const html = card({ data: data(PROPOSED), superadmin: false });
    const at = html.indexOf('data-group="/products/*"');
    expect(at).toBeGreaterThan(html.indexOf("homepage"));
    expect(at).toBeLessThan(html.indexOf("Add this page"));
    expect(html.indexOf('data-line="what-is-this"')).toBeLessThan(html.indexOf("Add this page"));
  });

  it("the rows say the visits per group, so the one summary line gives way to them", () => {
    expect(card({ data: data(PROPOSED), superadmin: false }, VISITED)).not.toContain(
      'data-line="uncovered"',
    );
    expect(card({ data: data({}), superadmin: false }, VISITED)).toContain('data-line="uncovered"');
  });

  it("the card is as it was without the read", () => {
    const without = card(null);
    expect(without).not.toContain("data-groups");
    expect(card({ data: data(null), superadmin: false })).toBe(without);
    expect(text(without)).toContain("Add this page");
  });
});

describe("the calls", () => {
  function api(handler: (path: string, init?: RequestInit) => unknown): Api {
    return (async (path: string, init?: RequestInit) => handler(path, init)) as Api;
  }
  const refuse = (status: number, error: string) => {
    throw new ApiError(status, `API error ${status}: ${JSON.stringify({ error })}`);
  };

  it("readGroups: the answer; a worker without the endpoint is none; any other failure is failed", async () => {
    expect(
      await readGroups(
        "medora",
        api(() => PROPOSED),
      ),
    ).toEqual({ kind: "ok", answer: PROPOSED });
    expect(
      await readGroups(
        "medora",
        api(() => refuse(404, "Not found")),
      ),
    ).toEqual({ kind: "none" });
    expect(
      await readGroups(
        "medora",
        api(() => refuse(500, "x")),
      ),
    ).toEqual({ kind: "failed" });
    expect(
      await readGroups(
        "medora",
        api(() => {
          throw new TypeError("fetch failed");
        }),
      ),
    ).toEqual({ kind: "failed" });
  });

  it("acceptGroup posts the pattern and takes the group; a 409 comes back as its sentence", async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const out = await acceptGroup(
      "medora",
      "/products/*",
      api((path, init) => {
        calls.push({ path, body: JSON.parse(String(init?.body)) });
        return { group: { ...PRODUCTS, counted: null } };
      }),
    );
    expect(calls).toEqual([
      { path: GROUPS_PATH, body: { customer_id: "medora", pattern: "/products/*" } },
    ]);
    expect(out).toEqual({ kind: "ok", value: { ...PRODUCTS, counted: null } });
    const five = "You can have at most 5 page groups. Remove one first.";
    expect(
      await acceptGroup(
        "medora",
        "/x/*",
        api(() => refuse(409, five)),
      ),
    ).toEqual({
      kind: "refused",
      sentence: five,
    });
    const bad = "Write the pattern as /section/* or /section/part/*, with one * at the end.";
    expect(
      await acceptGroup(
        "medora",
        "/*",
        api(() => refuse(400, bad)),
      ),
    ).toEqual({
      kind: "refused",
      sentence: bad,
    });
  });

  it("removeGroup posts to delete; the test lock comes back as written", async () => {
    const calls: string[] = [];
    expect(
      await removeGroup(
        "medora",
        "/products/*",
        api((path) => {
          calls.push(path);
          return { ok: true };
        }),
      ),
    ).toEqual({ kind: "ok", value: true });
    expect(calls).toEqual([GROUPS_DELETE_PATH]);
    expect(
      await removeGroup(
        "medora",
        "/products/*",
        api(() => refuse(409, TEST_LOCK)),
      ),
    ).toEqual({
      kind: "refused",
      sentence: TEST_LOCK,
    });
  });

  it("setGroupCounted: the same upsert the button list uses, the selectors riding along, then the list", async () => {
    const calls: Array<{ path: string; body?: unknown }> = [];
    const out = await setGroupCounted(
      "medora",
      ELAQE,
      false,
      api((path, init) => {
        calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return path === UPSERT_PATH ? { ok: true } : { items: [{ ...ELAQE, enabled: false }] };
      }),
    );
    expect(calls[0]).toEqual({
      path: UPSERT_PATH,
      body: {
        customer_id: "medora",
        id: "ct_1",
        section_path: "count:/products/*",
        label: "Əlaqə",
        conversion_label: "contact",
        enabled: false,
        css_selectors: ["nav a.contact"],
        text_selectors: [],
        structural_selector: "",
      },
    });
    expect(calls[1]?.path).toContain("/admin/conversions/list?customer_id=medora");
    expect(out).toEqual({ kind: "ok", value: { ...ELAQE, enabled: false } });
    expect(
      await setGroupCounted(
        "medora",
        ELAQE,
        false,
        api(() => refuse(409, TEST_LOCK)),
      ),
    ).toEqual({
      kind: "refused",
      sentence: TEST_LOCK,
    });
  });

  it("mintGroupPick carries the group and a known page; the 409 as its sentence", async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const out = await mintGroupPick(
      "medora",
      "/products/*",
      "/products/omega-3",
      api((path, init) => {
        calls.push({ path, body: JSON.parse(String(init?.body)) });
        return {
          token: "t",
          page_path: "/products/omega-3",
          expires_in_s: 900,
          link: "https://www.medora.test/products/omega-3#rawuser_pick=t",
        };
      }),
    );
    expect(calls).toEqual([
      {
        path: "/admin/conversions/pick-token",
        body: { customer_id: "medora", group: "/products/*", page_path: "/products/omega-3" },
      },
    ]);
    expect(out).toEqual({
      kind: "ok",
      value: {
        link: "https://www.medora.test/products/omega-3#rawuser_pick=t",
        pagePath: "/products/omega-3",
      },
    });
    // Without a known page the worker chooses: no page_path in the body.
    const bodies: unknown[] = [];
    await mintGroupPick(
      "medora",
      "/products/*",
      null,
      api((_p, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return { token: "t", page_path: "/products/a", expires_in_s: 900, link: "l" };
      }),
    );
    expect(bodies).toEqual([{ customer_id: "medora", group: "/products/*" }]);
    expect(
      await mintGroupPick(
        "medora",
        "/products/*",
        null,
        api(() => refuse(409, TEST_LOCK)),
      ),
    ).toEqual({
      kind: "refused",
      sentence: TEST_LOCK,
    });
  });

  it("mintGroupPick: the 409 group_page_needed is page_needed with its line; another 409 stays refused", async () => {
    const needed = () => {
      throw new ApiError(
        409,
        `API error 409: ${JSON.stringify({ error: PASTE_PAGE_LINE, code: "group_page_needed" })}`,
      );
    };
    expect(await mintGroupPick("medora", "/products/*", null, api(needed))).toEqual({
      kind: "page_needed",
      sentence: PASTE_PAGE_LINE,
    });
    expect(
      await mintGroupPick(
        "medora",
        "/products/*",
        null,
        api(() => {
          throw new ApiError(
            409,
            `API error 409: ${JSON.stringify({ error: "Other.", code: "sensitive_page" })}`,
          );
        }),
      ),
    ).toEqual({ kind: "refused", sentence: "Other." });
  });

  it("pastedPagePath: the path of a full address, a host form or a path; query and fragment dropped", () => {
    expect(pastedPagePath("https://www.medora.test/products/omega-3?utm_source=x#top")).toBe(
      "/products/omega-3",
    );
    expect(pastedPagePath("  www.medora.test/products/omega-3  ")).toBe("/products/omega-3");
    expect(pastedPagePath("/products/omega-3?x=1")).toBe("/products/omega-3");
    expect(pastedPagePath("")).toBeNull();
    expect(pastedPagePath("   ")).toBeNull();
  });

  it("pageToSend: the pasted page rides on the next mint, before one the breakdown knows", async () => {
    const pages: PagesBreakdown = {
      pages: [{ page_path: "/products/known", visits: 3, has_versions: false }],
      without_versions: { pages: 1, visits: 3, signal_visits: 0 },
    } as unknown as PagesBreakdown;
    expect(pageToSend(null, "/products/*", pages)).toBe("/products/known");
    expect(pageToSend(null, "/products/*", null)).toBeNull();
    const pasted = pageToSend("https://www.medora.test/products/omega-3#top", "/products/*", pages);
    expect(pasted).toBe("/products/omega-3");
    // Nothing usable pasted: back to what the breakdown knows.
    expect(pageToSend("   ", "/products/*", pages)).toBe("/products/known");
    const bodies: unknown[] = [];
    await mintGroupPick(
      "medora",
      "/products/*",
      pasted,
      api((_p, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return { token: "t", page_path: "/products/omega-3", expires_in_s: 900, link: "l" };
      }),
    );
    expect(bodies).toEqual([
      { customer_id: "medora", group: "/products/*", page_path: "/products/omega-3" },
    ]);
  });

  it("pollGroupPick asks by group; landed carries the target; a hiccup keeps waiting", async () => {
    const paths: string[] = [];
    const landed = await pollGroupPick(
      "medora",
      "/products/*",
      api((path) => {
        paths.push(path);
        return { landed: true, page_path: "/products/a", target: ELAQE, items: [ELAQE] };
      }),
    );
    expect(paths).toEqual([
      "/admin/conversions/pick-status?customer_id=medora&group=%2Fproducts%2F*",
    ]);
    expect(landed).toEqual({ kind: "landed", target: ELAQE, items: [ELAQE] });
    expect(
      await pollGroupPick(
        "medora",
        "/products/*",
        api(() => ({ landed: false })),
      ),
    ).toEqual({
      kind: "waiting",
    });
    expect(
      await pollGroupPick(
        "medora",
        "/products/*",
        api(() => {
          throw new TypeError("fetch failed");
        }),
      ),
    ).toEqual({ kind: "waiting" });
    const outside = "The page you opened is not one of these pages.";
    expect(
      await pollGroupPick(
        "medora",
        "/products/*",
        api(() => refuse(409, outside)),
      ),
    ).toEqual({
      kind: "refused",
      sentence: outside,
    });
  });

  it("knownPageOf: one page of the group from the breakdown, never a group row or a masked one", () => {
    const pages: PagesBreakdown = {
      pages: [
        {
          page_path: "/",
          visits: 79,
          signal_visits: 20,
          written_visits: 10,
          skipped_visits: 0,
          has_versions: true,
        },
        {
          page_path: "/products",
          visits: 30,
          signal_visits: 9,
          written_visits: 0,
          skipped_visits: 0,
          has_versions: false,
        },
        {
          page_path: "/products/:id",
          visits: 12,
          signal_visits: 4,
          written_visits: 0,
          skipped_visits: 0,
          has_versions: false,
        },
        {
          page_path: "/products/omega-3",
          visits: 9,
          signal_visits: 3,
          written_visits: 0,
          skipped_visits: 0,
          has_versions: false,
        },
      ],
      without_versions: { pages: 65, visits: 190, signal_visits: 60 },
    };
    expect(knownPageOf("/products/*", pages)).toBe("/products/omega-3");
    expect(knownPageOf("/blog/*", pages)).toBeNull();
    expect(knownPageOf("/products/*", null)).toBeNull();
    const grouped: PagesBreakdown = {
      pages: [
        {
          page_path: "/products/:item",
          visits: 190,
          signal_visits: 60,
          written_visits: 0,
          skipped_visits: 0,
          has_versions: false,
          group: true,
        },
      ],
      without_versions: { pages: 0, visits: 190, signal_visits: 60 },
    };
    expect(knownPageOf("/products/*", grouped)).toBeNull();
  });
});
