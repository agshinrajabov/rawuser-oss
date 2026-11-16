/**
 * The versions card on the Live screen after the write (mock
 * design/mock/sales-readiness/pilot-gaps.html, screen 01, states A3 to A8,
 * approved 2026-10-12; contract docs/specs/refused-versions.md): all
 * written, some keep a part as on the page, one not written yet with what
 * its visitors see, a write in progress, and a worker that answers the list
 * without `summary`. Pure functions and markup, no network.
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

import { PagesCard } from "../../src/components/start/PagesCard";
import { VersionLines } from "../../src/components/start/VersionLines";
import {
  KEPT_FOOT,
  keptLine,
  nextTryLine,
  readVersionList,
  refusalLine,
  seesLine,
  versionLines,
  versionName,
} from "../../src/lib/versions";
import type {
  CustomerListItem,
  ManifestResponse,
  PartAsBuilt,
  RefusedVersion,
  VariantListItem,
  VariantSummary,
  VersionServing,
} from "../../src/types/api";

const INTENTS = ["evaluation", "feature", "problem", "brand"];
const SOURCES = ["default", "ai", "social", "community", "organic"];

function key(intent: string, source: string, page = "/"): string {
  return page === "/"
    ? `v1:variant:medora:${intent}:${source}`
    : `v1:variant:medora:p:${encodeURIComponent(page)}:${intent}:${source}`;
}

function item(
  intent: string,
  source: string,
  over: Partial<VariantListItem> = {},
): VariantListItem {
  const page_path = over.page_path ?? "/";
  return {
    intent_dim: intent,
    source_dim: source,
    page_path,
    model: "model-a",
    generated_at: 1_760_000_000_000,
    cost_usd: 0.0007,
    status: "ready",
    kv_key: key(intent, source, page_path),
    lint_flags: [],
    parts_as_built: [],
    ...over,
  };
}

/** The pilot's 20: four served intents by five sources, all ready. */
function twenty(over: Record<string, Partial<VariantListItem>> = {}): VariantListItem[] {
  return SOURCES.flatMap((s) => INTENTS.map((i) => item(i, s, over[`${i}:${s}`] ?? {})));
}

function kept(path: string, rule = "length-drift"): Partial<VariantListItem> {
  const parts: PartAsBuilt[] = [{ path, rule }];
  return { parts_as_built: parts, lint_flags: [`part-as-built:${path}:${rule}`] };
}

function refused(
  intent: string,
  source: string,
  serving: VersionServing,
  error_reason = "lint: 3 of 5 parts could not be written; hero.body length-drift (80 for 64)",
  page_path = "/",
): RefusedVersion {
  return {
    intent_dim: intent,
    source_dim: source,
    page_path,
    kv_key: key(intent, source, page_path),
    error_reason,
    serving,
  };
}

function summary(over: Partial<VariantSummary> = {}): VariantSummary {
  return { written: 20, with_parts_as_built: 0, refused: 0, failed: 0, refused_rows: [], ...over };
}

const BASE = { paths: ["/"], served: INTENTS, total: 20, running: false } as const;

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

// The pilot's two rows of 2026-10-12 (refused-versions.md): a paragraph of 80
// characters for 64, a section heading of 38 for 27.
const MEDORA_TWO = twenty({
  "problem:community": kept("hero.body"),
  "brand:community": kept("features.headline"),
});

describe("readVersionList: both shapes of the list", () => {
  it("reads { items, summary } from a worker that knows summary=1", () => {
    const s = summary({ refused: 1, refused_rows: [refused("feature", "ai", "nearest")] });
    const r = readVersionList({ items: twenty(), summary: s });
    expect(r.items).toHaveLength(20);
    expect(r.summary).toBe(s);
  });

  it("reads the array alone from a worker that does not", () => {
    const r = readVersionList(twenty());
    expect(r.items).toHaveLength(20);
    expect(r.summary).toBeNull();
  });

  it("takes a missing or broken summary as none, and anything else as an empty list", () => {
    expect(readVersionList({ items: twenty() }).summary).toBeNull();
    expect(readVersionList({ items: twenty(), summary: null }).summary).toBeNull();
    expect(
      readVersionList({ items: twenty(), summary: { written: 20 } as VariantSummary }).summary,
    ).toBeNull();
    expect(readVersionList(null)).toEqual({ items: [], summary: null });
    expect(readVersionList({ empty: true } as never)).toEqual({ items: [], summary: null });
  });
});

describe("the words", () => {
  it("names a version as Results does", () => {
    expect(versionName("problem", "community")).toBe("Problem first, from communities");
    expect(versionName("brand", "community")).toBe("Knows you already, from communities");
    expect(versionName("feature", "ai")).toBe("Features, from AI assistants");
    // The default version has no source to name.
    expect(versionName("evaluation", "default")).toBe("Choosing a tool");
  });

  it("names a kept part in the mock's words", () => {
    expect(keptLine(["hero.body"])).toBe("The opening paragraph stays as on your page.");
    expect(keptLine(["features.headline"])).toBe("The section headline stays as on your page.");
    expect(keptLine(["hero.headline"])).toBe("The headline stays as on your page.");
    expect(keptLine(["hero.cta.label"])).toBe("The main button stays as on your page.");
    expect(keptLine(["features.body"])).toBe("The section paragraph stays as on your page.");
    expect(keptLine(["forms.submit_label"])).toBe("The form button stays as on your page.");
  });

  it("joins two parts into one sentence and never spells a path", () => {
    expect(keptLine(["hero.body", "features.headline"])).toBe(
      "The opening paragraph and the section headline stay as on your page.",
    );
    expect(keptLine(["proof.quote"])).toBe("One part stays as on your page.");
    expect(keptLine(["hero.body", "proof.quote"])).toBe("2 parts stay as on your page.");
  });

  it("says what visitors see meanwhile", () => {
    expect(seesLine("nearest")).toBe("Visitors with this reason see the closest version.");
    expect(seesLine("older")).toBe("Visitors with this reason keep the version written before.");
    expect(seesLine("original")).toBe("Visitors with this reason see your page as it is.");
    expect(seesLine("nearest", true)).toBe("Visitors with these reasons see the closest version.");
  });

  it("turns the stored reason into the mock's three sentences, never the stored text", () => {
    expect(refusalLine("lint: 3 of 5 parts could not be written; hero.body length-drift")).toBe(
      "Most of its parts did not fit your page.",
    );
    expect(refusalLine("lint: no part is left to write")).toBe(
      "Most of its parts did not fit your page.",
    );
    expect(refusalLine("lint: two parts still say the same thing; hero.body duplicate")).toBe(
      "Two of its parts came out with the same words.",
    );
    expect(refusalLine("lint: the page's only headline lost its structure")).toBe(
      "Its headline did not fit how your page animates it.",
    );
    // A cause the mock has no sentence for gives none.
    expect(refusalLine("lint: a part still fails its check; hero.body length-drift")).toBeNull();
    expect(refusalLine(null)).toBeNull();
  });
});

describe("versionLines: the states of the card", () => {
  it("A3, all 20 written: no line under the count", () => {
    expect(versionLines({ ...BASE, items: twenty(), summary: summary(), ready: 20 })).toEqual({
      kept: null,
      unwritten: null,
    });
  });

  it("A4, two keep one part: the count splits them and the list names version and part", () => {
    const lines = versionLines({
      ...BASE,
      items: MEDORA_TWO,
      summary: summary({ with_parts_as_built: 2 }),
      ready: 20,
    });
    expect(lines.unwritten).toBeNull();
    expect(lines.kept?.line).toBe("18 in full. 2 keep one part as on your page.");
    expect(lines.kept?.items.map((v) => [v.name, v.line, v.page])).toEqual([
      ["Problem first, from communities", "The opening paragraph stays as on your page.", null],
      ["Knows you already, from communities", "The section headline stays as on your page.", null],
    ]);
  });

  it("one version that keeps a part reads in the singular", () => {
    const lines = versionLines({
      ...BASE,
      items: twenty({ "problem:community": kept("hero.body") }),
      summary: summary({ with_parts_as_built: 1 }),
      ready: 20,
    });
    expect(lines.kept?.line).toBe("19 in full. 1 keeps one part as on your page.");
  });

  it("a version that keeps two parts changes the count line's words", () => {
    const two: Partial<VariantListItem> = {
      parts_as_built: [
        { path: "hero.body", rule: "length-drift" },
        { path: "features.headline", rule: "length-drift" },
      ],
    };
    const lines = versionLines({
      ...BASE,
      items: twenty({ "problem:community": two, "brand:community": kept("hero.body") }),
      summary: summary({ with_parts_as_built: 2 }),
      ready: 20,
    });
    expect(lines.kept?.line).toBe("18 in full. 2 keep some parts as on your page.");
    expect(lines.kept?.items[0]?.line).toBe(
      "The opening paragraph and the section headline stay as on your page.",
    );
  });

  it("A5, one not written yet: what its visitors see, and the reason behind Details", () => {
    const items = twenty().filter((i) => !(i.intent_dim === "feature" && i.source_dim === "ai"));
    const lines = versionLines({
      ...BASE,
      items,
      summary: summary({
        written: 19,
        refused: 1,
        refused_rows: [refused("feature", "ai", "nearest")],
      }),
      ready: 19,
    });
    expect(lines.kept).toBeNull();
    expect(lines.unwritten).toEqual({
      line: "1 not written yet.",
      sees: "Visitors with this reason see the closest version.",
      items: [
        {
          key: key("feature", "ai"),
          name: "Features, from AI assistants",
          page: null,
          reason: "Most of its parts did not fit your page.",
          sees: null,
        },
      ],
    });
  });

  it("after a rewrite the older version serves, and with none the page as it is", () => {
    const one = (serving: VersionServing) =>
      versionLines({
        ...BASE,
        items: twenty().slice(1),
        summary: summary({ refused: 1, refused_rows: [refused("feature", "ai", serving)] }),
        ready: 19,
      }).unwritten?.sees;
    expect(one("older")).toBe("Visitors with this reason keep the version written before.");
    expect(one("original")).toBe("Visitors with this reason see your page as it is.");
  });

  it("A8, both lines at once, counted against the number the card shows", () => {
    const items = MEDORA_TWO.filter((i) => !(i.intent_dim === "feature" && i.source_dim === "ai"));
    const lines = versionLines({
      ...BASE,
      items,
      summary: summary({
        written: 19,
        with_parts_as_built: 2,
        refused: 1,
        refused_rows: [refused("feature", "ai", "nearest")],
      }),
      ready: 19,
    });
    expect(lines.kept?.line).toBe("17 in full. 2 keep one part as on your page.");
    expect(lines.unwritten?.line).toBe("1 not written yet.");
  });

  it("A7, a write in progress, and a list still loading: no lines", () => {
    const input = {
      ...BASE,
      items: MEDORA_TWO.slice(0, 12),
      summary: summary({ refused: 1, refused_rows: [refused("feature", "ai", "nearest")] }),
    };
    expect(versionLines({ ...input, ready: 12, running: true })).toEqual({
      kept: null,
      unwritten: null,
    });
    expect(versionLines({ ...input, ready: null })).toEqual({ kept: null, unwritten: null });
  });

  it("two refused versions served the same way share one sentence in the plural", () => {
    const lines = versionLines({
      ...BASE,
      items: twenty().slice(2),
      summary: summary({
        refused: 2,
        refused_rows: [
          refused("feature", "ai", "nearest"),
          refused("problem", "social", "nearest", "lint: two parts still say the same thing"),
        ],
      }),
      ready: 18,
    });
    expect(lines.unwritten?.line).toBe("2 not written yet.");
    expect(lines.unwritten?.sees).toBe("Visitors with these reasons see the closest version.");
    expect(lines.unwritten?.items.map((v) => v.reason)).toEqual([
      "Most of its parts did not fit your page.",
      "Two of its parts came out with the same words.",
    ]);
  });

  it("versions served in different ways each say their own, inside Details", () => {
    const lines = versionLines({
      ...BASE,
      items: twenty().slice(2),
      summary: summary({
        refused: 2,
        refused_rows: [refused("feature", "ai", "nearest"), refused("brand", "social", "older")],
      }),
      ready: 18,
    });
    expect(lines.unwritten?.sees).toBeNull();
    expect(lines.unwritten?.items.map((v) => v.sees)).toEqual([
      "Visitors with this reason see the closest version.",
      "Visitors with this reason keep the version written before.",
    ]);
  });

  it("more unwritten than the rows that say why: no shared sentence about the others", () => {
    // Two missing: one refused by the checks, one the writing service left (summary.failed).
    const lines = versionLines({
      ...BASE,
      items: twenty().slice(2),
      summary: summary({
        refused: 1,
        failed: 1,
        refused_rows: [refused("feature", "ai", "nearest")],
      }),
      ready: 18,
    });
    expect(lines.unwritten?.line).toBe("2 not written yet.");
    expect(lines.unwritten?.sees).toBeNull();
    expect(lines.unwritten?.items).toHaveLength(1);
    expect(lines.unwritten?.items[0]?.sees).toBe(
      "Visitors with this reason see the closest version.",
    );
  });

  it("with several pages each version says its page; another page's rows are left out", () => {
    const home = twenty({ "problem:community": kept("hero.body") });
    const pricing = twenty().map((i) =>
      item(i.intent_dim, i.source_dim, {
        page_path: "/pricing",
        ...(i.intent_dim === "brand" && i.source_dim === "ai" ? kept("hero.headline") : {}),
      }),
    );
    const lines = versionLines({
      ...BASE,
      paths: ["/", "/pricing"],
      total: 40,
      items: [
        ...home,
        ...pricing,
        item("problem", "ai", { page_path: "/old", ...kept("hero.body") }),
      ],
      summary: summary({
        refused: 1,
        refused_rows: [refused("feature", "ai", "nearest", undefined, "/old")],
      }),
      ready: 40,
    });
    expect(lines.kept?.line).toBe("38 in full. 2 keep one part as on your page.");
    expect(lines.kept?.items.map((v) => v.page)).toEqual(["/", "/pricing"]);
    expect(lines.unwritten).toBeNull();
  });

  it("an intent the site does not serve is in no line", () => {
    const lines = versionLines({
      ...BASE,
      items: [...twenty(), item("pricing", "ai", kept("hero.body"))],
      summary: summary({ refused: 1, refused_rows: [refused("competitor", "ai", "nearest")] }),
      ready: 20,
    });
    expect(lines).toEqual({ kept: null, unwritten: null });
  });

  it("a stale version is not counted as kept: the card counts ready ones", () => {
    const lines = versionLines({
      ...BASE,
      items: twenty({ "problem:community": { ...kept("hero.body"), status: "stale" } }),
      summary: summary({ with_parts_as_built: 1 }),
      ready: 19,
    });
    expect(lines.kept).toBeNull();
    expect(lines.unwritten?.line).toBe("1 not written yet.");
  });

  it("an older worker (the array alone, no parts): the count line only, nothing breaks", () => {
    const old = twenty()
      .slice(1)
      .map(({ lint_flags: _f, parts_as_built: _p, ...rest }) => rest as VariantListItem);
    const { items, summary: none } = readVersionList(old);
    const lines = versionLines({ ...BASE, items, summary: none, ready: 19 });
    expect(lines.kept).toBeNull();
    expect(lines.unwritten).toEqual({ line: "1 not written yet.", sees: null, items: [] });
    expect(versionLines({ ...BASE, items: twenty(), summary: none, ready: 20 })).toEqual({
      kept: null,
      unwritten: null,
    });
  });
});

describe("the time of the next try (J8)", () => {
  // Local times, so the words are the same in every time zone.
  const NOW = new Date(2026, 9, 12, 8, 5).getTime();
  const AT_14_05 = new Date(2026, 9, 12, 14, 5).getTime();
  const AT_02_05_NEXT = new Date(2026, 9, 13, 2, 5).getTime();

  it("says the time in the mock's words, and tomorrow past midnight", () => {
    expect(nextTryLine(AT_14_05, NOW)).toBe("Next try at 14:05.");
    expect(nextTryLine(AT_02_05_NEXT, new Date(2026, 9, 12, 20, 10).getTime())).toBe(
      "Next try at 02:05 tomorrow.",
    );
  });

  it("a time already passed, or none, gives nothing", () => {
    expect(nextTryLine(NOW - 60_000, NOW)).toBeNull();
    expect(nextTryLine(NOW, NOW)).toBeNull();
    expect(nextTryLine(Number.NaN, NOW)).toBeNull();
  });

  it("the unwritten line carries the time when the API gives it", () => {
    const lines = versionLines({
      ...BASE,
      items: twenty().slice(1),
      summary: summary({
        refused: 1,
        refused_rows: [{ ...refused("feature", "ai", "nearest"), next_try: AT_14_05 }],
      }),
      ready: 19,
      now: NOW,
    });
    expect(lines.unwritten?.line).toBe("1 not written yet. Next try at 14:05.");
    expect(lines.unwritten?.sees).toBe("Visitors with this reason see the closest version.");
  });

  it("and nothing when the field is absent (a worker from before)", () => {
    const lines = versionLines({
      ...BASE,
      items: twenty().slice(1),
      summary: summary({ refused: 1, refused_rows: [refused("feature", "ai", "nearest")] }),
      ready: 19,
      now: NOW,
    });
    expect(lines.unwritten?.line).toBe("1 not written yet.");
  });

  it("several refused rows: the earliest time", () => {
    const lines = versionLines({
      ...BASE,
      items: twenty().slice(2),
      summary: summary({
        refused: 2,
        refused_rows: [
          { ...refused("feature", "ai", "nearest"), next_try: AT_02_05_NEXT },
          { ...refused("problem", "social", "nearest"), next_try: AT_14_05 },
        ],
      }),
      ready: 18,
      now: NOW,
    });
    expect(lines.unwritten?.line).toBe("2 not written yet. Next try at 14:05.");
  });

  it("renders the time on the card, with no new disclosure", () => {
    const lines = versionLines({
      ...BASE,
      items: twenty().slice(1),
      summary: summary({
        refused: 1,
        refused_rows: [{ ...refused("feature", "ai", "nearest"), next_try: AT_14_05 }],
      }),
      ready: 19,
      now: NOW,
    });
    const html = renderToStaticMarkup(h(VersionLines, { lines }));
    expect(text(html)).toContain(
      "1 not written yet. Next try at 14:05. Visitors with this reason see the closest version. Details",
    );
    expect(html.match(/<details/g)).toHaveLength(1);
  });
});

describe("the Live screen's own loop tells the worker it is automatic (J9)", () => {
  const src = readFileSync(
    new URL("../../src/components/start/useWriteVersions.ts", import.meta.url),
    "utf8",
  );

  it("sends auto: true from the missing-only loop and from nothing else", () => {
    expect(src.match(/auto: true/g)).toHaveLength(1);
    // The explicit Rewrite everything stays an explicit call.
    const rewrite = src.slice(src.indexOf("const rewriteAll"));
    expect(rewrite).not.toContain("auto: true");
  });

  it("no other caller of the endpoint sends it", () => {
    for (const file of [
      "../../src/components/variants/DetailPane.tsx",
      "../../src/app/variants/page.tsx",
      "../../src/components/audit/VisitorVersions.tsx",
    ]) {
      expect(readFileSync(new URL(file, import.meta.url), "utf8")).not.toContain("auto: true");
    }
  });
});

describe("VersionLines: what renders", () => {
  const both = versionLines({
    ...BASE,
    items: MEDORA_TWO.filter((i) => !(i.intent_dim === "feature" && i.source_dim === "ai")),
    summary: summary({
      written: 19,
      with_parts_as_built: 2,
      refused: 1,
      refused_rows: [refused("feature", "ai", "nearest")],
    }),
    ready: 19,
  });

  it("renders nothing when there is nothing to say", () => {
    expect(renderToStaticMarkup(h(VersionLines, { lines: { kept: null, unwritten: null } }))).toBe(
      "",
    );
  });

  it("A8: both lines in the mock's words, closed, each with its opening word", () => {
    const html = renderToStaticMarkup(h(VersionLines, { lines: both }));
    const t = text(html);
    expect(t).toContain("17 in full. 2 keep one part as on your page. Which ones");
    expect(t).toContain(
      "1 not written yet. Visitors with this reason see the closest version. Details",
    );
    expect(html.match(/<details/g)).toHaveLength(2);
    expect(html).not.toMatch(/<details[^>]* open/);
  });

  it("A4 open: version and part in plain words, then the foot", () => {
    const t = text(renderToStaticMarkup(h(VersionLines, { lines: both, open: "kept" })));
    expect(t).toContain(
      "Problem first, from communities The opening paragraph stays as on your page.",
    );
    expect(t).toContain(
      "Knows you already, from communities The section headline stays as on your page.",
    );
    expect(t).toContain(KEPT_FOOT);
  });

  it("A6 open: the version and why, in plain words", () => {
    const html = renderToStaticMarkup(h(VersionLines, { lines: both, open: "unwritten" }));
    expect(text(html)).toContain(
      "Features, from AI assistants Most of its parts did not fit your page.",
    );
    expect(html).toMatch(/<details[^>]* open=""/);
  });

  it("both lines are quiet: no amber, no red", () => {
    const html = renderToStaticMarkup(h(VersionLines, { lines: both, open: "both" }));
    expect(html).not.toMatch(/state-warn|state-err/);
  });

  it("no machine word, key or stored reason reaches the screen", () => {
    const html = renderToStaticMarkup(h(VersionLines, { lines: both, open: "both" }));
    const t = text(html);
    expect(t).not.toMatch(/lint|flag|\brow\b|\bKV\b|manifest|v1:variant|length-drift|hero\.body/i);
    expect(t).not.toMatch(/[\u2013\u2014]/);
  });

  it("an unwritten version with no row to explain it is a plain line, nothing to open", () => {
    const html = renderToStaticMarkup(
      h(VersionLines, {
        lines: { kept: null, unwritten: { line: "1 not written yet.", sees: null, items: [] } },
      }),
    );
    expect(text(html)).toBe("1 not written yet.");
    expect(html).not.toContain("<details");
  });

  it("a page is shown beside the version only when the site has several", () => {
    const html = renderToStaticMarkup(
      h(VersionLines, {
        open: "kept",
        lines: {
          unwritten: null,
          kept: {
            line: "38 in full. 2 keep one part as on your page.",
            items: [
              {
                key: "a",
                name: "Problem first, from communities",
                page: "/pricing",
                line: "The headline stays as on your page.",
              },
            ],
          },
        },
      }),
    );
    expect(text(html)).toContain("Problem first, from communities /pricing The headline stays");
  });
});

describe("the Live screen no longer counts failures aloud", () => {
  const src = readFileSync(
    new URL("../../src/components/start/FirstRun.tsx", import.meta.url),
    "utf8",
  );

  it('"N to retry later" is gone', () => {
    expect(src).not.toContain("to retry later");
  });

  it("asks for the summary once the write has ended, and reads either shape", () => {
    expect(src).toContain("&summary=1");
    expect(src).toContain("readVersionList(raw)");
  });
});

describe("the Pages card beside it", () => {
  function row(ready: number, writing: boolean): string {
    return text(
      renderToStaticMarkup(
        h(PagesCard, {
          customer: { id: "medora", domain: "www.medora.test" } as CustomerListItem,
          pages: [{ page_path: "/", confirmed_at: 1, manifest: {} }] as ManifestResponse[],
          readyByPath: { "/": ready },
          perPage: 20,
          writing,
          onPageAdded: () => undefined,
        }),
      ),
    );
  }

  it("a version that waits is not called writing once the write has ended", () => {
    expect(row(19, false)).toContain("19 of 20 live from the first version");
    expect(row(19, false)).not.toContain("writing");
  });

  it("while a write runs the row still says so", () => {
    expect(row(12, true)).toContain("writing, 12 of 20");
  });

  it("all written reads as before", () => {
    expect(row(20, false)).toContain("20 of 20 live");
  });
});
