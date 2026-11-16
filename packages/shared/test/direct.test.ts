/**
 * The shared part of ADR 0038 parts 3 to 5 (docs/specs/direct-visitors.md):
 * the word a page and a counted button name (part 4), and the bundle's
 * direct fields, present only for a customer that answered "no", is not
 * sensitive and not an audit, each behind its own switch.
 */
import { describe, expect, it } from "vitest";
import {
  type ArmWeights,
  WEIGHT_FLOOR,
  bundleDirectFields,
  choiceAllowed,
  chooseMarkets,
  directAllowed,
  drawArm,
  laplace,
  learnedBundle,
  marketOfSource,
  marketSource,
  pageWord,
  parseMarkets,
  pickMarket,
  pooledPrior,
  rememberAllowed,
  rememberOnSensitive,
  sampleBeta,
  sectionWord,
  thompsonWeights,
  validWeights,
  weightsMoved,
  wordCarry,
} from "../src/direct.ts";

describe("pageWord (§4)", () => {
  it("names the path's strongest intent, the map first, folded", () => {
    expect(pageWord("/pricing", null, null)).toBe("pricing");
    expect(pageWord("/docs/api", null, null)).toBe("feature");
    expect(pageWord("/vs-acme", null, null)).toBe("competitor");
    expect(pageWord("/pricing", null, ["evaluation", "feature", "problem", "brand"])).toBe(
      "evaluation",
    );
    expect(pageWord("/plans-and-prices", { kind: "price", w: 1 }, null)).toBe("pricing");
    expect(pageWord("/how", { kind: "learn", w: 1 }, null)).toBe("problem");
  });

  it("names nothing for the root, a start page, about and an operator's none", () => {
    expect(pageWord("/", null, null)).toBeNull();
    expect(pageWord("/demo", null, null)).toBeNull();
    expect(pageWord("/team", { kind: "about", w: 1 }, null)).toBeNull();
    expect(pageWord("/pricing", { kind: "none", w: 1 }, null)).toBeNull();
  });
});

describe("sectionWord (§4)", () => {
  it("maps the four sections that say why, nothing else", () => {
    expect(sectionWord("pricing.cta", null)).toBe("pricing");
    expect(sectionWord("features.cta", null)).toBe("feature");
    expect(sectionWord("comparison.cta", null)).toBe("evaluation");
    expect(sectionWord("social_proof.cta", null)).toBe("evaluation");
    expect(sectionWord("hero.cta", null)).toBeNull();
    expect(sectionWord("cta.button", null)).toBeNull();
    expect(sectionWord("count:/pricing", null)).toBeNull();
    expect(sectionWord("__proto__.x", null)).toBeNull();
    expect(sectionWord("pricing.cta", ["evaluation", "feature", "problem", "brand"])).toBe(
      "evaluation",
    );
  });

  it("the carry is the word and direct", () => {
    expect(wordCarry("pricing")).toBe("pricing:direct");
  });
});

describe("bundleDirectFields (§6)", () => {
  const yes = { special_category: 0, sensitive: 0, plan: "pilot" };
  it("dp only for an explicit no, not sensitive, not an audit, switch on", () => {
    expect(bundleDirectFields(yes)).toEqual({ dp: 1 });
    expect(bundleDirectFields({ ...yes, page_one_off: 1 })).toEqual({});
    expect(bundleDirectFields({ ...yes, special_category: null })).toEqual({});
    expect(bundleDirectFields({ ...yes, special_category: 1 })).toEqual({});
    expect(bundleDirectFields({ ...yes, sensitive: 1 })).toEqual({});
    expect(bundleDirectFields({ ...yes, plan: "audit" })).toEqual({});
    expect(bundleDirectFields(null)).toEqual({});
    expect(directAllowed(undefined)).toBe(false);
  });
});

describe("the visitor memory's rm (ADR 0039)", () => {
  const yes = { special_category: 0, sensitive: 0, plan: "pilot", page_one_off: 1 };
  it("on where the question may run while the column says 0; a row without the column has none", () => {
    expect(bundleDirectFields({ ...yes, remember_off: 0 })).toEqual({ rm: 1 });
    expect(bundleDirectFields({ ...yes, remember_off: 1 })).toEqual({});
    expect(bundleDirectFields(yes)).toEqual({});
    expect(bundleDirectFields({ ...yes, special_category: null, remember_off: 0 })).toEqual({});
    expect(bundleDirectFields({ ...yes, plan: "audit", remember_off: 0 })).toEqual({});
  });

  it("on a site marked sensitive only when the install allows it (REMEMBER_ON_SENSITIVE)", () => {
    const marked = { ...yes, special_category: 1, sensitive: 1, remember_off: 0 };
    // Unset and off: no memory, whatever the column says.
    expect(bundleDirectFields(marked)).toEqual({});
    expect(bundleDirectFields(marked, [], {})).toEqual({});
    expect(bundleDirectFields(marked, [], { onSensitive: false })).toEqual({});
    // On: the column decides, as on any other site.
    expect(bundleDirectFields(marked, [], { onSensitive: true })).toEqual({ rm: 1 });
    expect(bundleDirectFields({ ...marked, remember_off: 1 }, [], { onSensitive: true })).toEqual(
      {},
    );
    // The option opens nothing else: an unmarked yes, an unanswered customer, an audit.
    for (const row of [
      { ...yes, special_category: 1, remember_off: 0 },
      { ...yes, special_category: null, remember_off: 0 },
      { ...marked, plan: "audit" },
    ]) {
      expect(bundleDirectFields(row, [], { onSensitive: true })).toEqual({});
    }
    // A site that is not marked is not narrowed by the option being off.
    expect(bundleDirectFields({ ...yes, remember_off: 0 }, [], { onSensitive: false })).toEqual({
      rm: 1,
    });
  });

  it("the question is not narrowed: allowed on a marked site with the memory off there", () => {
    const marked = { ...yes, special_category: 1, sensitive: 1, remember_off: 0, choice_on: 1 };
    expect(choiceAllowed(marked)).toBe(true);
    expect(rememberAllowed(marked)).toBe(false);
    expect(rememberAllowed(marked, { onSensitive: false })).toBe(false);
    expect(rememberAllowed(marked, { onSensitive: true })).toBe(true);
    // Not marked: allowed either way. Nowhere the question may not run.
    expect(rememberAllowed({ ...yes, remember_off: 0 })).toBe(true);
    expect(rememberAllowed({ ...yes, special_category: null }, { onSensitive: true })).toBe(false);
    expect(rememberAllowed({ ...marked, plan: "audit" }, { onSensitive: true })).toBe(false);
    expect(rememberAllowed(null, { onSensitive: true })).toBe(false);
  });

  it("rememberOnSensitive: only the word on", () => {
    expect(rememberOnSensitive("on")).toBe(true);
    for (const v of [undefined, null, "", "off", "ON", "true", "1", " on"]) {
      expect(rememberOnSensitive(v)).toBe(false);
    }
  });
});

describe("markets (§5)", () => {
  it("a market's source segment and back", () => {
    expect(marketSource("GB")).toBe("mk-gb");
    expect(marketOfSource("mk-gb")).toBe("GB");
    expect(marketOfSource("mk-xx")).toBeNull();
    expect(marketOfSource("social")).toBeNull();
    expect(marketOfSource(null)).toBeNull();
  });

  it("parseMarkets keeps listed codes, once, at most three", () => {
    expect(parseMarkets('["GB","DE","GB","XX","US","FR"]')).toEqual(["GB", "DE", "US"]);
    expect(parseMarkets("not json")).toEqual([]);
    expect(parseMarkets(null)).toEqual([]);
  });

  it("chooseMarkets: 30 visits, 5% to 50%, never other, biggest first, three at most", () => {
    const rows = [
      { country: "AZ", visits: 600 }, // 60%: the page's own market
      { country: "TR", visits: 120 },
      { country: "DE", visits: 90 },
      { country: "GB", visits: 80 },
      { country: "US", visits: 60 },
      { country: "other", visits: 40 },
      { country: "FR", visits: 10 },
    ];
    expect(chooseMarkets(rows)).toEqual(["TR", "DE", "GB"]);
    expect(
      chooseMarkets([
        { country: "GB", visits: 20 },
        { country: "DE", visits: 25 },
      ]),
    ).toEqual([]);
    expect(chooseMarkets([])).toEqual([]);
  });

  it("pickMarket: the connection first, then the language's region", () => {
    expect(pickMarket(["GB", "DE"], "GB", "en-US")).toBe("GB");
    expect(pickMarket(["GB", "DE"], "FR", "de-DE")).toBe("DE");
    expect(pickMarket(["GB"], "FR", "en")).toBeNull();
    expect(pickMarket([], "GB", "en-GB")).toBeNull();
    expect(pickMarket(undefined, "GB", null)).toBeNull();
  });

  it("the bundle's mk: allowed, switched on, a stored list", () => {
    const yes = { special_category: 0, sensitive: 0, plan: "pilot", markets: '["GB"]' };
    expect(bundleDirectFields(yes)).toEqual({ dp: 1, mk: ["GB"] });
    expect(bundleDirectFields({ ...yes, market_versions_off: 1 })).toEqual({ dp: 1 });
    expect(bundleDirectFields({ ...yes, sensitive: 1 })).toEqual({});
    expect(bundleDirectFields({ ...yes, markets: null })).toEqual({ dp: 1 });
  });
});

/** A seeded random source (mulberry32), so the weights are the same on every run. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("the learned default (§3)", () => {
  const flat = () => ({ a: 1, b: 19 });

  it("thompsonWeights: thousandths summing to 1000, every arm at least the floor", () => {
    const w = thompsonWeights(
      [
        { arm: "none", n: 0, k: 0 },
        { arm: "feature", n: 0, k: 0 },
        { arm: "problem", n: 0, k: 0 },
      ],
      flat,
      seeded(1),
    );
    expect(w.map(([a]) => a)).toEqual(["none", "feature", "problem"]);
    expect(w.reduce((s, [, x]) => s + x, 0)).toBe(1000);
    for (const [, x] of w) expect(x).toBeGreaterThanOrEqual(WEIGHT_FLOOR);
    // No data: about even.
    for (const [, x] of w) expect(Math.abs(x - 333)).toBeLessThan(60);
    expect(validWeights(w)).toBe(true);
  });

  it("an arm clicked far more often takes most of the weight; the losers keep the floor", () => {
    const w = thompsonWeights(
      [
        { arm: "none", n: 1000, k: 20 },
        { arm: "feature", n: 1000, k: 80 },
      ],
      flat,
      seeded(2),
    );
    expect(w).toEqual([
      ["none", WEIGHT_FLOOR],
      ["feature", 1000 - WEIGHT_FLOOR],
    ]);
  });

  it("drawArm walks the thousandths and returns the probability", () => {
    const w: ArmWeights = [
      ["none", 400],
      ["feature", 600],
    ];
    expect(drawArm(w, 0)).toEqual({ arm: "none", p: 400 });
    expect(drawArm(w, 0.3999)).toEqual({ arm: "none", p: 400 });
    expect(drawArm(w, 0.4)).toEqual({ arm: "feature", p: 600 });
    expect(drawArm(w, 0.9999999)).toEqual({ arm: "feature", p: 600 });
  });

  it("sampleBeta has the posterior mean; laplace is centred", () => {
    const rng = seeded(3);
    let s = 0;
    for (let i = 0; i < 4000; i++) s += sampleBeta(2, 8, rng);
    expect(s / 4000).toBeCloseTo(0.2, 1);
    let l = 0;
    for (let i = 0; i < 4000; i++) l += laplace(1, rng);
    expect(Math.abs(l / 4000)).toBeLessThan(0.1);
  });

  it("pooledPrior: strength 20 at the noised mean; an empty pool near even", () => {
    const p = pooledPrior({ n: 100000, k: 3000 }, seeded(4));
    expect(p.a + p.b).toBeCloseTo(20, 5);
    expect(p.a / 20).toBeCloseTo(0.03, 2);
    const e = pooledPrior({ n: 0, k: 0 }, seeded(5));
    expect(e.a + e.b).toBeCloseTo(20, 5);
  });

  it("validWeights and learnedBundle keep only drawable sets", () => {
    expect(
      validWeights([
        ["none", 500],
        ["feature", 500],
      ]),
    ).toBe(true);
    expect(
      validWeights([
        ["none", 500],
        ["feature", 400],
      ]),
    ).toBe(false);
    expect(validWeights([["none", 1000]])).toBe(false);
    expect(
      validWeights([
        ["none", 500],
        ["x", 500],
      ]),
    ).toBe(false);
    expect(
      learnedBundle([
        { set_id: "a1", page_path: "/", weights: '[["none",500],["feature",500]]' },
        { set_id: "a1", page_path: "/bad", weights: "nope" },
      ]),
    ).toEqual({
      s: "a1",
      w: {
        "/": [
          ["none", 500],
          ["feature", 500],
        ],
      },
    });
    expect(learnedBundle([])).toBeNull();
  });

  it("weightsMoved: an arm, or 25 thousandths", () => {
    const a: ArmWeights = [
      ["none", 500],
      ["feature", 500],
    ];
    expect(
      weightsMoved(a, [
        ["none", 520],
        ["feature", 480],
      ]),
    ).toBe(false);
    expect(
      weightsMoved(a, [
        ["none", 525],
        ["feature", 475],
      ]),
    ).toBe(true);
    expect(
      weightsMoved(a, [
        ["none", 500],
        ["problem", 500],
      ]),
    ).toBe(true);
    expect(weightsMoved(undefined, a)).toBe(true);
  });

  it("the bundle's dl: allowed and switched on", () => {
    const yes = { special_category: 0, sensitive: 0, plan: "pilot" };
    const rows = [{ set_id: "a1", page_path: "/", weights: '[["none",500],["feature",500]]' }];
    expect(bundleDirectFields(yes, rows).dl).toEqual({
      s: "a1",
      w: {
        "/": [
          ["none", 500],
          ["feature", 500],
        ],
      },
    });
    expect(bundleDirectFields({ ...yes, learned_default_off: 1 }, rows)).not.toHaveProperty("dl");
    expect(bundleDirectFields({ ...yes, sensitive: 1 }, rows)).toEqual({});
  });
});
