/**
 * Site-shaped intents in the dashboard (mock design/mock/sales-readiness/
 * site-shaped-intents.html, approved 2026-10-05; contract
 * docs/specs/site-shaped-intents.md §18.2): the Look row in its four
 * states, the card title, the Change dialog (tabs, kinds, add, the switch,
 * the off lines), what Save sends, the Pages card's re-read line with its
 * auto date (founder's call 6 as amended), the folded line on Page
 * versions, and the served count the Live screen writes. Privacy review
 * condition 2: a link's text shows only from the API's `label`.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PagesCard } from "../../src/components/start/PagesCard";
import { ReReadLine, SiteMapEditor, YourPagesRow } from "../../src/components/start/SiteMap";
import {
  allTuples,
  missingTuples,
  readyOnPage,
  tuplesPerPage,
  writeOutcome,
} from "../../src/components/start/steps";
import { FoldedLines, VariantGallery } from "../../src/components/variants/VariantGallery";
import {
  FULL_VERSIONS,
  KIND_OPTIONS,
  KIND_WORD,
  NONE_FOUND_LINE,
  OFF_LINE,
  OFF_NOW_LINES,
  OFF_SAVE_LINES,
  ON_AGAIN_LINES,
  PATH_REFUSED,
  apiErrorLine,
  changedRows,
  checkNewPath,
  checksTitle,
  dialogTabs,
  draftFrom,
  foldSummary,
  lookRow,
  pendingLine,
  removedPaths,
  saveBody,
  servedCounts,
  shortDate,
  tabOf,
} from "../../src/lib/site-map";
import type {
  CustomerListItem,
  ManifestResponse,
  SiteMapPath,
  SiteMapView,
  VariantListItem,
} from "../../src/types/api";

// ---------------------------------------------------------------------------
// Fixtures: the mock's two made-up customers
// ---------------------------------------------------------------------------

function row(
  path: string,
  kind: SiteMapPath["kind"],
  over: Partial<SiteMapPath> = {},
): SiteMapPath {
  return {
    path,
    lang: "az",
    kind,
    label: null,
    confidence: "high",
    found_on: "/",
    missing: false,
    ...over,
  };
}

const SIX = ["competitor", "evaluation", "feature", "problem", "brand", "pricing"];

/** A prospect's site: two languages, a price page, no comparison page (mock section 01). */
function novbe(over: Partial<SiteMapView> = {}): SiteMapView {
  return {
    customer_id: "novbe-az",
    on: true,
    paths: [
      row("/imkanlar", "features", { label: "İmkanlar" }),
      row("/musteriler", "proof", { label: "Müştərilər" }),
      row("/hekayeler", "proof", { confidence: "model" }),
      row("/tarifler", "price", { label: "Qiymətlər" }),
      row("/niye-novbe", "how", { label: "Niyə Növbə" }),
      row("/salon-sahibleri-ucun-telimat", "learn"),
      row("/docs", "docs", { label: "Sənədlər" }),
      row("/elaqe", "start", { label: "Əlaqə" }),
      row("/haqqimizda", "about", { label: "Haqqımızda" }),
      row("/en/pricing", "price", { lang: "en", label: "Pricing" }),
      row("/en/features", "features", { lang: "en", label: "Features" }),
      row("/en/customers", "proof", { lang: "en", label: "Customers" }),
      row("/en/why-novbe", "how", { lang: "en", label: "Why Novbe" }),
      row("/en/blog", "none", { lang: null, confidence: "operator", found_on: "" }),
      row("/en/contact", "start", { lang: "en", label: "Contact" }),
    ],
    languages: ["az", "en"],
    served: SIX.filter((d) => d !== "competitor"),
    folded: [{ intent: "competitor", to: "evaluation", reason: "none" }],
    reasons: { pricing: "page /tarifler", competitor: "none" },
    versions_per_page: 30,
    pages: 2,
    pending: null,
    ...over,
  };
}

/** lumen.az: one language, no price and no comparison page. */
function lumen(over: Partial<SiteMapView> = {}): SiteMapView {
  return {
    customer_id: "lumen-az",
    on: true,
    paths: [
      row("/islerimiz", "proof", { label: "İşlərimiz" }),
      row("/yanasmamiz", "how", { label: "Yanaşmamız" }),
      row("/meqaleler", "learn", { label: "Məqalələr" }),
      row("/bank-ux-indeksi", "learn"),
      row("/elaqe", "start"),
      row("/haqqimizda", "about", { label: "Haqqımızda" }),
    ],
    languages: ["az"],
    served: ["evaluation", "feature", "problem", "brand"],
    folded: [
      { intent: "competitor", to: "evaluation", reason: "none" },
      { intent: "pricing", to: "evaluation", reason: "none" },
    ],
    reasons: { pricing: "none", competitor: "none" },
    versions_per_page: 24,
    pages: 1,
    pending: null,
    ...over,
  };
}

/** The lab: no menu links, six served. */
function lab(): SiteMapView {
  return {
    customer_id: "template-lab",
    on: true,
    paths: [],
    languages: [],
    served: SIX,
    folded: [],
    reasons: { pricing: "price in brief", competitor: "competitor hint" },
    versions_per_page: 36,
    pages: 11,
    pending: null,
  };
}

function off(): SiteMapView {
  return { ...lab(), customer_id: "novbe-az", on: false, reasons: null, pages: 2 };
}

const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el);
const text = (h: string) =>
  h
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
const noop = () => {};

// ---------------------------------------------------------------------------
// The Look row
// ---------------------------------------------------------------------------

describe("Your pages, the Look row", () => {
  it("found, one folds: price first, then features, a count in two languages, the served line", () => {
    const r = lookRow(novbe());
    expect(r.kind).toBe("found");
    if (r.kind !== "found") return;
    expect(r.pairs).toEqual([
      { path: "/tarifler", word: "price" },
      { path: "/imkanlar", word: "features" },
    ]);
    expect(r.rest).toBe(", +13 in 2 languages");
    expect(r.fold?.line).toBe("No comparison page, so 30 versions a page, not 36.");
    const t = text(html(createElement(YourPagesRow, { row: r, onChange: noop })));
    expect(t).toBe(
      "Your pages /tarifler → price , /imkanlar → features , +13 in 2 languages No comparison page, so 30 versions a page, not 36. Why Change",
    );
    expect(checksTitle(r)).toBe("Five things to check");
  });

  it("state A, nothing folds: the second line goes", () => {
    const v = novbe({
      paths: [...novbe().paths, row("/muqayise", "compare", { label: "Müqayisə" })],
      served: SIX,
      folded: [],
      versions_per_page: 36,
    });
    const r = lookRow(v);
    if (r.kind !== "found") throw new Error("found");
    expect(r.pairs.map((p) => p.word)).toEqual(["price", "comparison"]);
    expect(r.rest).toBe(", +14 in 2 languages");
    expect(r.fold).toBeNull();
    const t = text(html(createElement(YourPagesRow, { row: r, onChange: noop })));
    expect(t).not.toContain("versions a page");
    expect(t).not.toContain("Why");
  });

  it("state B, one language, two fold, Why open: no language count, the why box, Hide", () => {
    const r = lookRow(lumen());
    if (r.kind !== "found") throw new Error("found");
    expect(r.pairs).toEqual([
      { path: "/islerimiz", word: "proof" },
      { path: "/yanasmamiz", word: "how it works" },
    ]);
    expect(r.rest).toBe(", +4");
    const t = text(html(createElement(YourPagesRow, { row: r, onChange: noop, defaultWhy: true })));
    expect(t).toContain("No price or comparison page, so 24 versions a page, not 36.");
    expect(t).toContain(
      "Visitors who come for a price or a rival see the version for people weighing their options. Add such a page and Rawuser writes theirs.",
    );
    expect(t).toContain("Hide");
    expect(t).not.toContain("Why");
  });

  it("state C, nothing found and nothing folds: hidden, the card says four", () => {
    const r = lookRow(lab());
    expect(r).toEqual({ kind: "hidden" });
    expect(html(createElement(YourPagesRow, { row: r, onChange: noop }))).toBe("");
    expect(checksTitle(r)).toBe("Four things to check");
  });

  it("hidden while the map has not answered or the read failed", () => {
    expect(lookRow(null)).toEqual({ kind: "hidden" });
  });

  it("state D, off: a grey tick and one line, still five rows", () => {
    const r = lookRow(off());
    expect(r).toEqual({ kind: "off", line: OFF_LINE });
    expect(OFF_LINE).toBe("Off. No menus read, 36 versions a page.");
    const h = html(createElement(YourPagesRow, { row: r, onChange: noop }));
    expect(text(h)).toBe("Your pages Off. No menus read, 36 versions a page. Change");
    expect(h).toContain("bg-surface-muted");
    expect(checksTitle(r)).toBe("Five things to check");
  });

  it("nothing found but an intent folds: the cost still gets its line", () => {
    const r = lookRow({
      ...lab(),
      served: SIX.filter((d) => d !== "pricing"),
      folded: [{ intent: "pricing", to: "evaluation", reason: "none" }],
      versions_per_page: 30,
    });
    if (r.kind !== "found") throw new Error("found");
    expect(r.line).toBe(NONE_FOUND_LINE);
    expect(r.fold?.line).toBe("No price page, so 30 versions a page, not 36.");
    expect(r.fold?.why).toBe(
      "Visitors who come for a price see the version for people weighing their options. Add such a page and Rawuser writes theirs.",
    );
  });

  it("every row set aside: no page is named", () => {
    const r = lookRow(
      lumen({ paths: [row("/blog", "none", { lang: null })], folded: [], versions_per_page: 36 }),
    );
    if (r.kind !== "found") throw new Error("found");
    expect(r.pairs).toEqual([]);
    expect(r.line).toBe("None in use, 1 set aside.");
  });

  it("a set-aside row is never one of the two named, but is counted", () => {
    const r = lookRow(
      lumen({ paths: [row("/blog", "none", { lang: null }), row("/islerimiz", "proof")] }),
    );
    if (r.kind !== "found") throw new Error("found");
    expect(r.pairs).toEqual([{ path: "/islerimiz", word: "proof" }]);
    expect(r.rest).toBe(", +1");
  });

  it("a rival alone folds with its own words", () => {
    expect(
      foldSummary({
        folded: [{ intent: "competitor", to: "evaluation", reason: "none" }],
        versions_per_page: 30,
      })?.why,
    ).toBe(
      "Visitors who come for a rival see the version for people weighing their options. Add such a page and Rawuser writes theirs.",
    );
    expect(foldSummary({ folded: [], versions_per_page: 36 })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The Change dialog
// ---------------------------------------------------------------------------

describe("Change dialog", () => {
  it("a tab per language with its count, the Azerbaijani rows first", () => {
    const v = novbe();
    const draft = draftFrom(v);
    expect(dialogTabs(v, draft)).toEqual([
      { lang: "az", label: "Azerbaijani", count: 9 },
      { lang: "en", label: "English", count: 6 },
    ]);
    const h = html(createElement(SiteMapEditor, { view: v, onSaved: noop, onCancel: noop }));
    const t = text(h);
    expect(h).toContain('role="tablist"');
    expect(t).toContain("Azerbaijani 9");
    expect(t).toContain("English 6");
    expect(t).toContain("/tarifler Qiymətlər Remove Price");
    expect(t).not.toContain("/en/pricing");
    expect(t).toContain("Add a page");
    expect(h).toContain('aria-checked="true"');
    expect(t).toContain("Read your menus: On");
    expect(t).toContain("Cancel");
    expect(t).toContain("Save");
  });

  it("condition 2: the path alone when the API gives no label, nothing else as text", () => {
    const v = novbe();
    const t = text(html(createElement(SiteMapEditor, { view: v, onSaved: noop, onCancel: noop })));
    expect(t).toContain("/hekayeler Remove Proof");
    expect(t).toContain("/salon-sahibleri-ucun-telimat Remove Reading");
    // The only words beside the paths are the API's labels and the kind words.
    const labels = v.paths
      .filter((p) => p.lang === "az")
      .map((p) => p.label)
      .filter(Boolean);
    let rest = t;
    for (const p of v.paths) rest = rest.split(p.path).join(" ");
    for (const l of labels) rest = rest.split(l as string).join(" ");
    for (const w of Object.values(KIND_WORD)) rest = rest.split(w).join(" ");
    rest = rest.split("Remove").join(" ");
    expect(rest.replace(/\s+/g, " ").trim()).toBe(
      "Azerbaijani 9 English 6 Add a page Read your menus: On Cancel Save",
    );
  });

  it("the English tab: the operator's /en/blog sits there as Not a page to use", () => {
    const t = text(
      html(
        createElement(SiteMapEditor, {
          view: novbe(),
          onSaved: noop,
          onCancel: noop,
          initial: { tab: "en" },
        }),
      ),
    );
    expect(t).toContain("/en/blog Remove Not a page to use");
    expect(t).toContain("/en/pricing Pricing Remove Price");
    expect(t).not.toContain("/tarifler");
  });

  it("one language: no tabs, the list flush, Add open with /page and Choose", () => {
    const h = html(
      createElement(SiteMapEditor, {
        view: lumen(),
        onSaved: noop,
        onCancel: noop,
        initial: { addOpen: true },
      }),
    );
    expect(h).not.toContain('role="tablist"');
    expect(h).toContain('placeholder="/page"');
    const t = text(h);
    expect(t).toContain("Choose");
    expect(t).toContain("Add");
    expect(t).not.toContain("Add a page");
    expect(t).toContain("/bank-ux-indeksi Remove Reading");
    expect(t).toContain("/elaqe Remove Contact");
  });

  it("a missing row says so in the label's place", () => {
    const v = lumen({ paths: [row("/islerimiz", "proof", { label: "İşlərimiz", missing: true })] });
    const t = text(html(createElement(SiteMapEditor, { view: v, onSaved: noop, onCancel: noop })));
    expect(t).toContain("/islerimiz Not in your menus now Remove Proof");
    expect(t).not.toContain("İşlərimiz");
  });

  it("switched off before Save: the list gives way to two lines", () => {
    const h = html(
      createElement(SiteMapEditor, {
        view: novbe(),
        onSaved: noop,
        onCancel: noop,
        initial: { on: false },
      }),
    );
    const t = text(h);
    expect(t).toContain(OFF_SAVE_LINES.join(" "));
    expect(OFF_SAVE_LINES).toEqual([
      "Saving deletes this list and stops reading your menus.",
      "Every page gets all 36 versions again.",
    ]);
    expect(t).toContain("Read your menus: Off");
    expect(h).toContain('aria-checked="false"');
    expect(t).not.toContain("/tarifler");
    expect(h).not.toContain('role="tablist"');
  });

  it("opened while off, and turned on again", () => {
    const off1 = text(
      html(createElement(SiteMapEditor, { view: off(), onSaved: noop, onCancel: noop })),
    );
    expect(off1).toContain(OFF_NOW_LINES.join(" "));
    const on1 = text(
      html(
        createElement(SiteMapEditor, {
          view: off(),
          onSaved: noop,
          onCancel: noop,
          initial: { on: true },
        }),
      ),
    );
    expect(on1).toContain(ON_AGAIN_LINES.join(" "));
    expect(on1).toContain("Read your menus: On");
  });

  it("the kind list: the spec's order, Not a page to use last", () => {
    expect(KIND_OPTIONS.map((k) => KIND_WORD[k])).toEqual([
      "Price",
      "Versus a rival",
      "Comparison",
      "Proof",
      "Features",
      "Docs",
      "How it works",
      "Reading",
      "Contact",
      "About",
      "Not a page to use",
    ]);
  });

  it("Save sends only the rows whose kind changed and the rows added", () => {
    const v = novbe();
    const draft = draftFrom(v);
    expect(changedRows(v, draft)).toEqual([]);
    const edited = draft.map((r) =>
      r.path === "/hekayeler" ? { ...r, kind: "none" as const } : r,
    );
    edited.push({
      path: "/yay-endirimi",
      kind: "price",
      label: null,
      tab: "az",
      missing: false,
      added: true,
    });
    expect(changedRows(v, edited)).toEqual([
      { path: "/hekayeler", kind: "none" },
      { path: "/yay-endirimi", kind: "price" },
    ]);
  });

  it("an operator's row finds its tab by a language prefix, else the first tab", () => {
    expect(tabOf({ path: "/en/blog", lang: null }, ["az", "en"])).toBe("en");
    expect(tabOf({ path: "/yay-endirimi", lang: null }, ["az", "en"])).toBe("az");
    expect(tabOf({ path: "/x", lang: "en" }, ["az", "en"])).toBe("en");
    expect(tabOf({ path: "/x", lang: null }, [])).toBeNull();
  });

  it("a typed path: normalized as the server does, refused where it would be", () => {
    expect(checkNewPath("/Yay-Endirimi/", [])).toEqual({ path: "/yay-endirimi" });
    expect(checkNewPath("https://queue.test/kampaniya?utm_source=x", [])).toEqual({
      path: "/kampaniya",
    });
    expect(checkNewPath("kampaniya", [])).toEqual({ path: "/kampaniya" });
    expect(checkNewPath("", [])).toEqual({ error: "Type the page's path, like /pricing." });
    expect(checkNewPath("/", [])).toEqual({ error: "The homepage is not a page to add." });
    expect(checkNewPath("/tarifler", ["/tarifler"])).toEqual({
      error: "/tarifler is already in the list.",
    });
    expect(checkNewPath("/u/jane@doe.example", [])).toEqual({ error: PATH_REFUSED });
    expect(checkNewPath(`/${"a".repeat(220)}`, [])).toEqual({ error: "That path is too long." });
  });

  it("a refusal from the server reads as its plain line", () => {
    expect(apiErrorLine(new Error('API error 400: {"error":"A path starts with /"}'))).toBe(
      "A path starts with /.",
    );
    expect(apiErrorLine(new Error('API error 409: {"error":"At most 200 pages","on":true}'))).toBe(
      "At most 200 pages.",
    );
    expect(apiErrorLine(new Error("network"))).toBe("Saving failed. Try again.");
  });
});

// ---------------------------------------------------------------------------
// The Pages card's re-read line
// ---------------------------------------------------------------------------

const NOON_12_OCT = new Date(2026, 9, 12, 12, 0, 0).getTime();
const NOON_5_OCT = new Date(2026, 9, 5, 12, 0, 0).getTime();

describe("Pages card, the re-read line", () => {
  const pending: NonNullable<SiteMapView["pending"]> = {
    intents: ["competitor"],
    paths: [{ path: "/muqayise", kind: "compare" }],
    since: NOON_5_OCT,
    auto_at: NOON_12_OCT,
    versions: 10,
  };

  it("one new page: path, kind, versions, and the date it writes by itself", () => {
    const l = pendingLine(pending, NOON_5_OCT);
    expect(l).not.toBeNull();
    if (!l) return;
    const t = text(html(createElement(ReReadLine, { line: l, onWrite: noop, onChange: noop })));
    expect(t).toBe(
      "New page: /muqayise → comparison. 10 versions to write. Write Change Writes by itself on 12 Oct.",
    );
  });

  it("two pages, one version, a date already past", () => {
    const l = pendingLine(
      {
        ...pending,
        paths: [
          { path: "/muqayise", kind: "compare" },
          { path: "/vs-rival", kind: "vs" },
        ],
        versions: 1,
      },
      NOON_12_OCT + 1,
    );
    if (!l) throw new Error("line");
    const t = text(html(createElement(ReReadLine, { line: l, onWrite: noop, onChange: noop })));
    expect(t).toContain("New pages: /muqayise → comparison , /vs-rival → versus a rival.");
    expect(t).toContain("1 version to write.");
    expect(t).toContain("Writes by itself shortly.");
  });

  it("no line without a pending growth; a growth naming no page says so", () => {
    expect(pendingLine(null)).toBeNull();
    expect(pendingLine({ ...pending, paths: [] }, NOON_5_OCT)?.plain).toBe("Your pages changed.");
  });

  it("shortDate is day and month", () => {
    expect(shortDate(NOON_12_OCT)).toBe("12 Oct");
    expect(shortDate(new Date(2026, 8, 3, 12).getTime())).toBe("3 Sep");
  });

  it("the card counts per served intents and shows the line under the list", () => {
    const customer = { id: "novbe-az", domain: "queue.test" } as CustomerListItem;
    const pages = [
      { page_path: "/", confirmed_at: 1 },
      { page_path: "/en", confirmed_at: 1 },
    ] as ManifestResponse[];
    const l = pendingLine(pending, NOON_5_OCT);
    const h = html(
      createElement(PagesCard, {
        customer,
        pages,
        readyByPath: { "/": 30, "/en": 12 },
        perPage: 30,
        writing: true,
        onPageAdded: noop,
        reread: l ? { line: l, onWrite: noop, onChange: noop } : null,
      }),
    );
    const t = text(h);
    expect(t).toContain("30 of 30 live");
    expect(t).toContain("writing, 12 of 30");
    expect(t).toContain("New page: /muqayise → comparison.");
    expect(t.indexOf("New page")).toBeLessThan(t.indexOf("Add this page"));
  });
});

// ---------------------------------------------------------------------------
// Page versions: the folded line
// ---------------------------------------------------------------------------

describe("Page versions, a folded intent", () => {
  it("one quiet line per folded intent, no empty card", () => {
    expect(text(html(createElement(FoldedLines, { folded: novbe().folded })))).toBe(
      "Comparing you to a rival visitors see Weighing their options. No comparison page.",
    );
    expect(text(html(createElement(FoldedLines, { folded: lumen().folded })))).toBe(
      "Comparing you to a rival visitors see Weighing their options. No comparison page. Price-first visitors see Weighing their options. No price page.",
    );
    expect(html(createElement(FoldedLines, { folded: [] }))).toBe("");
  });

  it("the gallery shows the served cards, the fold line, and counts the versions it writes", () => {
    const v = novbe();
    const t = text(
      html(
        createElement(VariantGallery, {
          items: [],
          loading: false,
          customerId: "novbe-az",
          onOpen: noop,
          canGenerate: true,
          onGenerateAll: noop,
          served: v.served,
          folded: v.folded,
        }),
      ),
    );
    expect(t).toContain(
      "Rawuser writes 30 versions from your brief: five audiences, six tones each.",
    );
    expect(t).toContain("Weighing their options");
    expect(t).toContain("Price-first");
    expect(t.match(/Comparing you to a rival/g)?.length).toBe(1);
    expect(
      t.endsWith(
        "Comparing you to a rival visitors see Weighing their options. No comparison page.",
      ),
    ).toBe(true);
  });

  it("all six cards when the map is not read", () => {
    const t = text(
      html(
        createElement(VariantGallery, {
          items: [],
          loading: false,
          customerId: "x",
          onOpen: noop,
          canGenerate: true,
          onGenerateAll: noop,
        }),
      ),
    );
    expect(t).toContain(
      "Rawuser writes 36 versions from your brief: six audiences, six tones each.",
    );
    expect(t).toContain("Comparing you to a rival");
  });
});

// ---------------------------------------------------------------------------
// The Live screen writes the served intents only
// ---------------------------------------------------------------------------

describe("Live screen, served intents only", () => {
  const item = (intent_dim: string, source_dim: string, page_path = "/", status = "ready") =>
    ({ intent_dim, source_dim, page_path, status }) as VariantListItem;

  it("36, 30 or 24 a page from the served set", () => {
    expect(tuplesPerPage(null)).toBe(FULL_VERSIONS);
    expect(tuplesPerPage(novbe().served)).toBe(30);
    expect(tuplesPerPage(lumen().served)).toBe(24);
    expect(allTuples(lumen().served).some((t) => t.intent_dim === "pricing")).toBe(false);
    expect(
      allTuples(lumen().served)
        .slice(0, 4)
        .every((t) => t.source_dim === "default"),
    ).toBe(true);
  });

  it("never asks for a folded intent, and its old ready versions do not count", () => {
    const items = [
      item("competitor", "default"),
      item("brand", "default"),
      item("brand", "ai", "/en"),
    ];
    const missing = missingTuples(items, "/", novbe().served);
    expect(missing.length).toBe(29);
    expect(missing.some((t) => t.intent_dim === "competitor")).toBe(false);
    expect(readyOnPage(items, "/", novbe().served)).toBe(1);
    expect(readyOnPage(items, "/", null)).toBe(2);
  });

  it("not_served is skipped, never a failure; other errors fail with their reason", () => {
    expect(writeOutcome({ ok: false, error: "not_served" })).toEqual({ kind: "skipped" });
    // The queue is leaving the row alone (J9): still not written, not the service failing.
    expect(writeOutcome({ ok: false, error: "waiting" })).toEqual({ kind: "waiting" });
    expect(writeOutcome({ ok: true })).toEqual({ kind: "ok" });
    expect(writeOutcome(null)).toEqual({ kind: "ok" });
    expect(writeOutcome({ ok: false, error: "lint: hard" })).toEqual({
      kind: "failed",
      reason: "lint: hard",
    });
    expect(writeOutcome({ ok: false })).toEqual({ kind: "failed", reason: "not written" });
  });
});

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

describe("words", () => {
  it("no em or en dash in any line this build shows", () => {
    const lines: string[] = [
      OFF_LINE,
      NONE_FOUND_LINE,
      PATH_REFUSED,
      ...OFF_SAVE_LINES,
      ...OFF_NOW_LINES,
      ...ON_AGAIN_LINES,
      ...Object.values(KIND_WORD),
      foldSummary(lumen())?.line ?? "",
      foldSummary(lumen())?.why ?? "",
      text(html(createElement(SiteMapEditor, { view: novbe(), onSaved: noop, onCancel: noop }))),
      text(html(createElement(FoldedLines, { folded: lumen().folded }))),
    ];
    for (const l of lines) expect(l).not.toMatch(/[–—]/);
  });
});

// ---------------------------------------------------------------------------
// Follow-up: Remove per row (privacy review condition 5), served counts
// ---------------------------------------------------------------------------

describe("Change dialog, Remove (privacy review condition 5)", () => {
  it("every row carries a quiet Remove named for its path", () => {
    const h = html(createElement(SiteMapEditor, { view: lumen(), onSaved: noop, onCancel: noop }));
    expect(h.match(/>Remove</g)?.length).toBe(6);
    expect(h).toContain('aria-label="Remove /bank-ux-indeksi"');
    // Not a page to use stays in the kind list as drawn.
    expect(text(h)).not.toContain("Not a page to use");
    expect(KIND_OPTIONS[KIND_OPTIONS.length - 1]).toBe("none");
  });

  it("a removed found row is sent as delete; nothing else changes", () => {
    const v = novbe();
    const draft = draftFrom(v).filter((r) => r.path !== "/hekayeler");
    expect(removedPaths(v, draft)).toEqual(["/hekayeler"]);
    expect(saveBody(v, draft, true)).toEqual({ customer_id: "novbe-az", delete: ["/hekayeler"] });
  });

  it("a change, an add and a remove go in one request", () => {
    const v = novbe();
    const draft = draftFrom(v)
      .filter((r) => r.path !== "/en/blog")
      .map((r) => (r.path === "/docs" ? { ...r, kind: "features" as const } : r));
    draft.push({
      path: "/yay-endirimi",
      kind: "price",
      label: null,
      tab: "az",
      missing: false,
      added: true,
    });
    expect(saveBody(v, draft, true)).toEqual({
      customer_id: "novbe-az",
      paths: [
        { path: "/docs", kind: "features" },
        { path: "/yay-endirimi", kind: "price" },
      ],
      delete: ["/en/blog"],
    });
  });

  it("a row added and removed before Save sends nothing; no change closes", () => {
    const v = lumen();
    expect(saveBody(v, draftFrom(v), true)).toBeNull();
    const added = [
      ...draftFrom(v),
      {
        path: "/kampaniya",
        kind: "price" as const,
        label: null,
        tab: "az",
        missing: false,
        added: true,
      },
    ];
    const removedAgain = added.filter((r) => r.path !== "/kampaniya");
    expect(saveBody(v, removedAgain, true)).toBeNull();
  });

  it("the switch alone when it moved; nothing while off", () => {
    const v = novbe();
    const draft = draftFrom(v).filter((r) => r.path !== "/docs");
    expect(saveBody(v, draft, false)).toEqual({ customer_id: "novbe-az", on: false });
    expect(saveBody(off(), [], true)).toEqual({ customer_id: "novbe-az", on: true });
    expect(saveBody(off(), [], false)).toBeNull();
  });
});

describe("Page versions, N ready counts served intents only", () => {
  const item = (intent_dim: string, status: VariantListItem["status"]) =>
    ({ intent_dim, source_dim: "default", page_path: "/", status }) as VariantListItem;
  const items = [
    item("competitor", "ready"),
    item("competitor", "stale"),
    item("brand", "ready"),
    item("pricing", "error"),
    item("feature", "stale"),
  ];

  it("a folded intent's old versions are not ready, stale or errored", () => {
    expect(servedCounts(items, novbe().served)).toEqual({ ready: 1, stale: 1, error: 1 });
    expect(servedCounts(items, lumen().served)).toEqual({ ready: 1, stale: 1, error: 0 });
  });

  it("every row counts when the map is not read", () => {
    expect(servedCounts(items, null)).toEqual({ ready: 2, stale: 2, error: 1 });
  });
});
