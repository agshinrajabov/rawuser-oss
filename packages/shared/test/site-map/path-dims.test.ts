/**
 * Site-shaped intents §6, §7: one path helper for the gate and the
 * classifier, the customer's map before the global table, decision 2's gate,
 * the served set and the fold.
 */
import { describe, expect, it } from "vitest";
import {
  ALWAYS_SERVED,
  PATH_INTENT_TABLE,
  type Signals,
  briefHasPrice,
  classify,
  foldIntentDim,
  foldVector,
  hasMeaningfulSignal,
  hasSourceSignal,
  parseServed,
  pathCarriesIntent,
  pathDims,
  selectVariantKey,
  servedIntents,
  siteEntryFor,
  sitePathMap,
  textHasPrice,
  visitorBundleFrom,
  withSiteMap,
} from "../../src/index.ts";

const NOON = Date.UTC(2026, 9, 5, 12);

function direct(path: string, extra: Partial<Signals> = {}): Signals {
  return {
    utm: {},
    referrerHost: null,
    device: "desktop",
    language: "en",
    country: "AZ",
    aiSource: null,
    entryPath: path,
    ...extra,
  };
}

describe("pathDims with no map gives the global table's result", () => {
  const PATHS = [
    "/pricing",
    "/plans",
    "/price/team",
    "/cost",
    "/vs-notion",
    "/vs/notion",
    "/compare",
    "/alternatives",
    "/features",
    "/integrations",
    "/product",
    "/docs",
    "/api",
    "/developers",
    "/sdk",
    "/how-it-works",
    "/why",
    "/use-cases",
    "/solutions",
    "/demo",
    "/trial",
    "/signup",
    "/contact",
    "/",
    "/about",
    "/work",
  ];
  it.each(PATHS)("%s", (path) => {
    const want: { intent: Record<string, number>; context: Record<string, number> } = {
      intent: {},
      context: {},
    };
    for (const e of PATH_INTENT_TABLE) {
      if (path === "/" || !e.test.test(path)) continue;
      for (const [d, w] of Object.entries(e.intent ?? {}))
        want.intent[d] = (want.intent[d] ?? 0) + (w ?? 0);
      for (const [d, w] of Object.entries(e.context ?? {}))
        want.context[d] = (want.context[d] ?? 0) + (w ?? 0);
    }
    expect(pathDims(path)).toEqual(want);
    expect(pathDims(path, null)).toEqual(want);
  });
});

describe("the customer's map first", () => {
  const pm = sitePathMap([
    { path: "/work", kind: "proof", confidence: "high" },
    { path: "/tarifler", kind: "price", confidence: "medium" },
    { path: "/pricing", kind: "none", confidence: "operator" },
    { path: "/insights", kind: "learn", confidence: "model" },
  ]);

  it("a kind's weights times its confidence", () => {
    expect(pathDims("/work", siteEntryFor(pm, "/work")).intent).toEqual({ evaluation: 0.5 });
    expect(pathDims("/tarifler", siteEntryFor(pm, "/tarifler"))).toEqual({
      intent: { pricing: 0.51 },
      context: { price_sensitivity: 0.425 },
    });
    expect(pathDims("/insights", siteEntryFor(pm, "/insights")).intent).toEqual({
      problem: 0.3375,
    });
  });

  it("an entry covers its children, the longest entry wins", () => {
    expect(siteEntryFor(pm, "/work/portal")).toEqual({ kind: "proof", w: 1 });
    const pm2 = { ...pm, "/work/portal": ["learn", 1] as [string, number] };
    expect(siteEntryFor(pm2, "/work/portal")).toEqual({ kind: "learn", w: 1 });
    expect(siteEntryFor(pm, "/workshop")).toBeNull();
    expect(siteEntryFor(pm, "/")).toBeNull();
  });

  it("an operator's none beats the global table", () => {
    const entry = siteEntryFor(pm, "/pricing");
    expect(entry).toEqual({ kind: "none", w: 1 });
    expect(pathDims("/pricing", entry)).toEqual({ intent: {}, context: {} });
    expect(pathCarriesIntent("/pricing", entry)).toBe(false);
    expect(pathCarriesIntent("/pricing")).toBe(true);
  });

  it("the weights stay below the UTM rules", () => {
    for (const k of ["price", "vs", "compare", "proof", "features", "docs", "how", "learn"]) {
      const d = pathDims("/x", { kind: k as never, w: 1 });
      for (const w of Object.values(d.intent)) expect(w).toBeLessThanOrEqual(0.65);
    }
  });
});

describe("the gate (decision 2) and the classifier", () => {
  const entry = { kind: "proof" as const, w: 1 };

  it("a mapped path opens the gate on a page with its own versions", () => {
    expect(hasMeaningfulSignal(direct("/work", { sitePath: entry, pageHasVersions: true }))).toBe(
      true,
    );
  });

  it("never on a page without them, from the map or the global table", () => {
    expect(hasMeaningfulSignal(direct("/work", { sitePath: entry, pageHasVersions: false }))).toBe(
      false,
    );
    expect(hasMeaningfulSignal(direct("/pricing", { pageHasVersions: false }))).toBe(false);
    // Unknown (no bundle, the dashboard's simulator): as before.
    expect(hasMeaningfulSignal(direct("/pricing"))).toBe(true);
  });

  it("a mapped path is a path, never a source", () => {
    expect(hasSourceSignal(direct("/work", { sitePath: entry, pageHasVersions: true }))).toBe(
      false,
    );
  });

  it("it still adds to the vector when a source opened the gate", () => {
    const s = direct("/work", {
      sitePath: entry,
      pageHasVersions: false,
      referrerHost: "linkedin.com",
    });
    expect(hasMeaningfulSignal(s)).toBe(true);
    expect(classify(s, NOON).intent.evaluation).toBeGreaterThanOrEqual(0.5);
  });

  it("a mapped page selects its kind's intent and suppresses brand", () => {
    const v = classify(direct("/approach", { sitePath: { kind: "how", w: 1 } }), NOON);
    expect(v.intent.brand).toBe(0);
    expect(selectVariantKey(v).intent_dim).toBe("problem");
  });

  it("withSiteMap reads the entry and the page's own versions from the bundle", () => {
    const bundle = {
      ...visitorBundleFrom([{ page_path: "/approach", manifest: {} }], [], null, {
        off: false,
        rows: [{ path: "/approach", kind: "how", confidence: "high" }],
        served: null,
      }),
    };
    const s = withSiteMap(direct("/approach"), bundle, "/approach");
    expect(s.sitePath).toEqual({ kind: "how", w: 1 });
    expect(s.pageHasVersions).toBe(true);
    expect(withSiteMap(direct("/work"), bundle, "/work").pageHasVersions).toBe(false);
    expect(withSiteMap(direct("/work"), null, "/work")).toEqual(direct("/work"));
  });
});

describe("the fold (§7.2, decision 3)", () => {
  it("a pricing campaign's direct visit on a site without pricing gets evaluation", () => {
    const v = classify(direct("/", { utm: { campaign: "pricing" } }), NOON);
    expect(selectVariantKey(v).intent_dim).toBe("pricing");
    const served = ["evaluation", "feature", "problem", "brand"] as const;
    const folded = foldVector(v, [...served]);
    expect(folded.intent.pricing).toBe(0);
    expect(folded.intent.evaluation).toBeCloseTo(v.intent.evaluation + v.intent.pricing);
    expect(selectVariantKey(folded).intent_dim).toBe("evaluation");
  });

  it("competitor folds to evaluation too; no set changes nothing", () => {
    const v = classify(direct("/", { utm: { campaign: "vs-notion" } }), NOON);
    expect(
      selectVariantKey(foldVector(v, ["evaluation", "feature", "problem", "brand"])).intent_dim,
    ).toBe("evaluation");
    expect(foldVector(v, null)).toBe(v);
    expect(foldIntentDim("pricing", ["evaluation", "feature", "problem", "brand"])).toBe(
      "evaluation",
    );
    expect(foldIntentDim("pricing", null)).toBe("pricing");
    expect(foldIntentDim("problem", ["evaluation", "feature", "problem", "brand"])).toBe("problem");
  });
});

describe("the served set (§7.1)", () => {
  const noPrice = { value_props: ["Design studio"], proof_points: ["12 people", "40 launches"] };

  it("lumera: no price page, no price in the brief, no hint: pricing and competitor fold", () => {
    const r = servedIntents({
      paths: [
        { path: "/work", kind: "proof" },
        { path: "/approach", kind: "how" },
      ],
      briefs: [noPrice],
      pricePages: [],
    });
    expect(r.served).toEqual(["evaluation", "feature", "problem", "brand"]);
    expect(r.reasons).toEqual({ pricing: "none", competitor: "none" });
  });

  it("measure-lab: a pricing page serves pricing; no rival page folds competitor", () => {
    const r = servedIntents({
      paths: [{ path: "/pricing", kind: "price" }],
      briefs: [noPrice],
      pricePages: [],
    });
    expect(r.served).toEqual(["evaluation", "feature", "problem", "brand", "pricing"]);
    expect(r.reasons.pricing).toBe("page /pricing");
  });

  it("the lab: a price in the brief and both hints serve all six", () => {
    const r = servedIntents({
      paths: [],
      briefs: [
        {
          proof_points: ["About $0.45 to generate 30 versions"],
          per_intent_hints: { pricing: "cost", competitor: "vs builders" },
        },
      ],
      pricePages: [],
    });
    expect(r.served).toHaveLength(6);
    expect(r.reasons).toEqual({ pricing: "price in brief", competitor: "competitor hint" });
  });

  it("a price on a read page, a vs or compare page, an operator none counts for nothing", () => {
    expect(servedIntents({ paths: [], briefs: [], pricePages: ["/"] }).reasons.pricing).toBe(
      "price on page /",
    );
    expect(
      servedIntents({ paths: [{ path: "/muqayise", kind: "compare" }], briefs: [], pricePages: [] })
        .reasons.competitor,
    ).toBe("page /muqayise");
    expect(
      servedIntents({ paths: [{ path: "/pricing", kind: "none" }], briefs: [], pricePages: [] })
        .served,
    ).toEqual([...ALWAYS_SERVED].sort((a, b) => order(a) - order(b)));
  });

  it("reads prices in four languages and refuses counts", () => {
    for (const t of [
      "$12/mo",
      "From €9",
      "29 AZN",
      "15 ₼",
      "500 руб",
      "99 TL",
      "12 per month",
      "1 500 ₽ в месяц",
      "USD 40",
    ]) {
      expect([t, textHasPrice(t)]).toEqual([t, true]);
    }
    for (const t of [
      "12 people",
      "40 launches",
      "a 5 man team",
      "Try 14 days free",
      "3 months",
      "2024",
      "Engageable at 40 or 80 hours per month",
      "",
    ]) {
      expect([t, textHasPrice(t)]).toEqual([t, false]);
    }
    expect(briefHasPrice({ proof_points: ["About $0.45 to generate 30 versions"] })).toBe(true);
    expect(briefHasPrice(noPrice)).toBe(false);
  });

  it("a stored served list is read back in order; all six is null", () => {
    expect(parseServed('["pricing","brand","evaluation","feature","problem"]')).toEqual([
      "evaluation",
      "feature",
      "problem",
      "brand",
      "pricing",
    ]);
    expect(
      parseServed(
        JSON.stringify(["competitor", "evaluation", "feature", "problem", "brand", "pricing"]),
      ),
    ).toBeNull();
    expect(parseServed(null)).toBeNull();
    expect(parseServed("nope")).toBeNull();
  });
});

function order(d: string): number {
  return ["competitor", "evaluation", "feature", "problem", "brand", "pricing"].indexOf(d);
}

describe("the bundle fields (§5)", () => {
  const rows = [
    { path: "/work", kind: "proof", confidence: "high" },
    { path: "/pricing", kind: "none", confidence: "operator" },
  ] as const;

  it("pm holds paths and kinds with their weights, sd the served set, never a label", () => {
    const b = visitorBundleFrom([], [], null, {
      off: false,
      rows: [...rows],
      served: ["evaluation", "feature", "problem", "brand"],
    });
    expect(b.pm).toEqual({ "/work": ["proof", 1], "/pricing": ["none", 1] });
    expect(b.sd).toEqual(["evaluation", "feature", "problem", "brand"]);
  });

  it("off drops pm and sd; an old bundle has neither", () => {
    const off = visitorBundleFrom([], [], null, { off: true, rows: [...rows], served: null });
    expect(off).not.toHaveProperty("pm");
    expect(off).not.toHaveProperty("sd");
    const old = visitorBundleFrom([], [], null);
    expect(old).not.toHaveProperty("pm");
    expect(old).not.toHaveProperty("sd");
  });

  it("a rules none never reaches pm", () => {
    expect(sitePathMap([{ path: "/x", kind: "none", confidence: "model" }])).toEqual({});
  });
});
