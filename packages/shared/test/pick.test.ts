import { describe, expect, it } from "vitest";
import {
  COUNT_REFUSALS,
  COUNT_SLOT,
  PICK_TTL_S,
  type PickStore,
  contactKindOf,
  conversionTargetsForPage,
  countPickRefusal,
  countTargetPage,
  countTargetPath,
  freeSiteTargetPath,
  holdsAccountDetail,
  isSiteTarget,
  isSiteWideTarget,
  maskPath,
  pagePathRefusal,
  pathHoldsIdentifier,
  pickCountKey,
  pickKey,
  pickTokenKey,
  readPickSeed,
  receivePick,
  siteSlugOf,
  validateCountPick,
  validateInline,
  validateMetrics,
  validatePickedManifest,
} from "../src/pick.ts";

function memoryStore(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  const puts: { key: string; ttl?: number }[] = [];
  const store: PickStore = {
    get: async (k) => data.get(k) ?? null,
    put: async (k, v, o) => {
      data.set(k, v);
      puts.push({ key: k, ttl: o?.expirationTtl });
    },
    delete: async (k) => {
      data.delete(k);
    },
  };
  return { store, data, puts };
}

const TOKEN = "abcdef1234567890abcdef1234567890";
const SEED = { "hero.headline": { css: ["h1"], text: ["Salam"], structural: "first h1" } };
const META = JSON.stringify({ customer_id: "lumera", page_path: "/", manifest: SEED });

describe("validatePickedManifest", () => {
  it("accepts a well-formed manifest and keeps the optional fields", () => {
    const m = validatePickedManifest({
      "hero.headline": {
        css: ["#title", "h1.hero"],
        text: ["Dizaynı sıfırdan"],
        structural: "first h1 in main",
        original_char_length: 24,
        original_word_count: 3,
        conversion_candidate: false,
      },
    });
    expect(m).not.toBeNull();
    expect(m?.["hero.headline"]?.css).toEqual(["#title", "h1.hero"]);
    expect(m?.["hero.headline"]?.original_word_count).toBe(3);
  });

  it("caps the text signature at one string of forty characters", () => {
    expect(
      validatePickedManifest({
        "hero.headline": { css: ["h1"], text: ["a".repeat(41)], structural: "x" },
      }),
    ).toBeNull();
    expect(
      validatePickedManifest({
        "hero.headline": { css: ["h1"], text: ["a", "b"], structural: "x" },
      }),
    ).toBeNull();
  });

  it("rejects unknown slots, empty css, long strings, non-integer counts", () => {
    expect(
      validatePickedManifest({ "nav.logo": { css: ["a"], text: [], structural: "x" } }),
    ).toBeNull();
    expect(
      validatePickedManifest({ "hero.headline": { css: [], text: [], structural: "x" } }),
    ).toBeNull();
    expect(
      validatePickedManifest({
        "hero.headline": { css: ["a".repeat(301)], text: [], structural: "x" },
      }),
    ).toBeNull();
    expect(
      validatePickedManifest({
        "hero.headline": { css: ["h1"], text: [], structural: "x", original_char_length: 1.5 },
      }),
    ).toBeNull();
    expect(validatePickedManifest([])).toBeNull();
    expect(validatePickedManifest(null)).toBeNull();
  });
});

describe("readPickSeed", () => {
  it("returns the seed for a live token, counts the read, refuses after the third", async () => {
    const { store, data } = memoryStore({ [pickTokenKey(TOKEN)]: META });
    const out = await readPickSeed(TOKEN, store);
    expect(out.status).toBe(200);
    if (out.status !== 200) return;
    expect(out.body.manifest).toEqual(SEED);
    expect(out.body.slots.map((s) => s.path)).toContain("hero.cta.label");
    expect(data.has(pickTokenKey(TOKEN))).toBe(true);
    expect((await readPickSeed(TOKEN, store)).status).toBe(200);
    expect((await readPickSeed(TOKEN, store)).status).toBe(200);
    expect((await readPickSeed(TOKEN, store)).status).toBe(403);
    expect(data.has(pickTokenKey(TOKEN))).toBe(false);
  });

  it("403 for an unknown token", async () => {
    const { store } = memoryStore();
    expect((await readPickSeed(TOKEN, store)).status).toBe(403);
  });
});

describe("receivePick", () => {
  it("stores the validated manifest under the customer/path key and burns the token", async () => {
    const { store, data, puts } = memoryStore({ [pickTokenKey(TOKEN)]: META });
    const out = await receivePick(
      {
        token: TOKEN,
        manifest: {
          "hero.cta.label": {
            css: ["a.btn"],
            text: ["Başla"],
            structural: "primary CTA in the hero section",
            conversion_candidate: true,
          },
        },
      },
      store,
    );
    expect(out.status).toBe(200);
    expect(JSON.parse(data.get(pickKey("lumera", "/")) ?? "{}")).toHaveProperty("hero.cta.label");
    expect(puts.find((p) => p.key === pickKey("lumera", "/"))?.ttl).toBe(PICK_TTL_S);
    expect(data.has(pickTokenKey(TOKEN))).toBe(false);
  });

  it("rejects a malformed manifest before touching the store", async () => {
    const { store, data } = memoryStore({ [pickTokenKey(TOKEN)]: META });
    const out = await receivePick({ token: TOKEN, manifest: { "x.y": {} } }, store);
    expect(out.status).toBe(400);
    expect(data.has(pickTokenKey(TOKEN))).toBe(true);
  });
});

describe("validateInline: lines the page cut (docs/specs/interactive-text.md §3.2)", () => {
  const base = { icons: "none", emphasis: 0, split: true, animated_text: false };
  it("keeps a line count from 2 to 8", () => {
    expect(validateInline({ ...base, lines: 3 })?.lines).toBe(3);
  });
  it("rejects a count outside 2 to 8 or not an integer", () => {
    expect(validateInline({ ...base, lines: 1 })).toBeNull();
    expect(validateInline({ ...base, lines: 9 })).toBeNull();
    expect(validateInline({ ...base, lines: 2.5 })).toBeNull();
    expect(validateInline({ ...base, lines: "3" })).toBeNull();
  });
});

describe("validateMetrics: the picker's wrap measurement (interactive-text §3.4)", () => {
  const good = {
    v: 1,
    kind: "template",
    chars: { a: 55.12, " ": 25 },
    widths: [
      {
        w: 1280,
        size: 68,
        box: 960,
        ls: -1.4,
        k: 0.998,
        lines: 3,
        glyphs: [49],
        tl: [1, 1, 1],
        lw: [636.8],
        ra: 0,
      },
      { w: 390, size: 36, box: 342, ls: -0.7, k: 1.01, lines: 6 },
    ],
  };
  it("keeps a measurement in bounds, rounded", () => {
    const m = validateMetrics(good);
    expect(m?.chars.a).toBe(55.1);
    expect(m?.widths).toHaveLength(2);
    expect(m?.widths[0]?.lw).toEqual([636.8]);
  });
  it("refuses a width other than 1280, 768, 390, a repeated one, a long table, a bad kind", () => {
    expect(validateMetrics({ ...good, widths: [{ ...good.widths[1], w: 400 }] })).toBeNull();
    expect(validateMetrics({ ...good, widths: [good.widths[1], good.widths[1]] })).toBeNull();
    const big: Record<string, number> = {};
    for (let i = 0; i < 201; i++) big[String.fromCharCode(0x4e00 + i)] = 50;
    expect(validateMetrics({ ...good, chars: big })).toBeNull();
    expect(validateMetrics({ ...good, kind: "canvas" })).toBeNull();
    expect(validateMetrics({ ...good, chars: { ab: 50 } })).toBeNull();
  });
  it("a picked entry keeps good metrics and loses bad ones without failing the pick", () => {
    const entry = { css: ["h1"], text: ["x"], structural: "h1" };
    const ok = validatePickedManifest({ "hero.headline": { ...entry, metrics: good } });
    expect(ok?.["hero.headline"]?.metrics?.kind).toBe("template");
    const bad = validatePickedManifest({ "hero.headline": { ...entry, metrics: { v: 2 } } });
    expect(bad?.["hero.headline"]).toBeDefined();
    expect(bad?.["hero.headline"]?.metrics).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Count-only pick (docs/specs/visual-picker.md §9)
// ---------------------------------------------------------------------------

describe("count-only pick", () => {
  const COUNT_META = JSON.stringify({
    customer_id: "lumera",
    page_path: "/pricing",
    manifest: {},
    mode: "count",
  });
  const BUTTON = { css: ["#signup"], text: ["Start free"], structural: "first a in nav" };

  it("the seed of a count link offers one slot, the button to count", async () => {
    const { store } = memoryStore({ [pickTokenKey(TOKEN)]: COUNT_META });
    const out = await readPickSeed(TOKEN, store);
    expect(out.status).toBe(200);
    if (out.status !== 200) return;
    expect(out.body.mode).toBe("count");
    expect(out.body.slots).toEqual([COUNT_SLOT]);
    expect(out.body.page_path).toBe("/pricing");
  });

  it("a manifest link's seed is unchanged: eight slots, no mode", async () => {
    const { store } = memoryStore({ [pickTokenKey(TOKEN)]: META });
    const out = await readPickSeed(TOKEN, store);
    if (out.status !== 200) throw new Error("expected 200");
    expect(out.body.slots).toHaveLength(8);
    expect(out.body).not.toHaveProperty("mode");
  });

  it("stores the button under pick-count for the link's page and burns the token", async () => {
    const { store, data, puts } = memoryStore({ [pickTokenKey(TOKEN)]: COUNT_META });
    const out = await receivePick({ token: TOKEN, button: BUTTON, page_path: "/Pricing/" }, store);
    expect(out).toEqual({
      status: 200,
      body: { ok: true, page_path: "/pricing", customer_id: "lumera", elements: 1 },
    });
    expect(data.has(pickTokenKey(TOKEN))).toBe(false);
    expect(JSON.parse(data.get(pickCountKey("lumera", "/pricing")) ?? "{}")).toEqual({
      page_path: "/pricing",
      ...BUTTON,
    });
    expect(puts.find((p) => p.key.startsWith("pick-count:"))?.ttl).toBe(PICK_TTL_S);
    // Never a manifest pick key: the page's versions are not touched.
    expect([...data.keys()].some((k) => k.startsWith("pick:"))).toBe(false);
  });

  it("keeps the page the button was picked on when it differs from the link's", async () => {
    const { store, data } = memoryStore({ [pickTokenKey(TOKEN)]: COUNT_META });
    await receivePick({ token: TOKEN, button: BUTTON, page_path: "/en/pricing" }, store);
    const stored = JSON.parse(data.get(pickCountKey("lumera", "/pricing")) ?? "{}");
    expect(stored.page_path).toBe("/en/pricing");
  });

  it("a count link refuses a manifest, and a manifest link refuses a button", async () => {
    const a = memoryStore({ [pickTokenKey(TOKEN)]: COUNT_META });
    const m = await receivePick({ token: TOKEN, manifest: SEED }, a.store);
    expect(m.status).toBe(403);
    expect(a.data.has(pickKey("lumera", "/pricing"))).toBe(false);
    expect(a.data.has(pickTokenKey(TOKEN))).toBe(true);

    const b = memoryStore({ [pickTokenKey(TOKEN)]: META });
    const c = await receivePick({ token: TOKEN, button: BUTTON, page_path: "/" }, b.store);
    expect(c.status).toBe(403);
    expect(b.data.has(pickCountKey("lumera", "/"))).toBe(false);
    expect(b.data.has(pickTokenKey(TOKEN))).toBe(true);
  });

  it("validateCountPick copies the three selector fields only, with the manifest caps", () => {
    const ok = validateCountPick(
      { ...BUTTON, inline: { icons: "none" }, metrics: { v: 1 }, html: "<a>x</a>" },
      "/pricing?x=1".split("?")[0],
    );
    expect(ok).toEqual({ page_path: "/pricing", ...BUTTON });
    expect(validateCountPick({ ...BUTTON, text: ["a".repeat(41)] }, "/")).toBeNull();
    expect(validateCountPick({ ...BUTTON, text: ["a", "b"] }, "/")).toBeNull();
    expect(validateCountPick({ ...BUTTON, css: [] }, "/")).toBeNull();
    expect(validateCountPick({ ...BUTTON, css: ["a", "b", "c", "d"] }, "/")).toBeNull();
    expect(validateCountPick({ ...BUTTON, structural: "x".repeat(121) }, "/")).toBeNull();
    expect(validateCountPick({ ...BUTTON, text: [] }, "/")).not.toBeNull();
  });

  it("validateCountPick takes a bare path: no query, fragment, host or space", () => {
    expect(validateCountPick(BUTTON, "/pricing?email=a@b.c")).toBeNull();
    expect(validateCountPick(BUTTON, "/pricing#top")).toBeNull();
    expect(validateCountPick(BUTTON, "https://lumera.test/")).toBeNull();
    expect(validateCountPick(BUTTON, "/a b")).toBeNull();
    expect(validateCountPick(BUTTON, `/${"a".repeat(200)}`)).toBeNull();
    expect(validateCountPick(BUTTON, 3)).toBeNull();
  });

  it("section paths: count:{page}, and a page only for count targets", () => {
    expect(countTargetPath("/Pricing/")).toBe("count:/pricing");
    expect(countTargetPage("count:/pricing")).toBe("/pricing");
    expect(countTargetPage("hero.cta.label")).toBeNull();
  });

  it("conversionTargetsForPage: slot targets on every page, a picked one only on its page", () => {
    const conv = [
      { section_path: "hero.cta.label" },
      { section_path: "count:/pricing" },
      { section_path: "count:/" },
    ];
    expect(conversionTargetsForPage(conv, "/").map((t) => t.section_path)).toEqual([
      "hero.cta.label",
      "count:/",
    ]);
    expect(conversionTargetsForPage(conv, "/pricing").map((t) => t.section_path)).toEqual([
      "hero.cta.label",
      "count:/pricing",
    ]);
    expect(conversionTargetsForPage(conv, "/about").map((t) => t.section_path)).toEqual([
      "hero.cta.label",
    ]);
  });

  describe("conversionTargetsForPage: a group's button (docs/specs/page-groups.md, phase 1)", () => {
    const SLOT = { section_path: "hero.cta.label" };
    const GROUP = { section_path: "count:/products/*" };
    const DEEP = { section_path: "count:/docs/api/*" };
    const conv = [SLOT, GROUP, DEEP];
    const paths = (page: string, confirmed?: Record<string, unknown>) =>
      conversionTargetsForPage(conv, page, confirmed).map((t) => t.section_path);

    it("offered on a path with exactly one segment more than the fixed part, the masked one too", () => {
      expect(paths("/products/ginseng")).toEqual(["hero.cta.label", "count:/products/*"]);
      expect(paths("/products/:id")).toEqual(["hero.cta.label", "count:/products/*"]);
      expect(paths("/docs/api/select")).toEqual(["hero.cta.label", "count:/docs/api/*"]);
    });

    it("never on /, the fixed part, a deeper path, a longer sibling, or the pattern's own text", () => {
      for (const page of [
        "/",
        "/products",
        "/products/x/reviews",
        "/productsale",
        "/docs",
        "/docs/api",
        "/docs/api/x/y",
      ]) {
        expect(paths(page), page).toEqual(["hero.cta.label"]);
      }
    });

    it("a confirmed page inside the pattern gets nothing from the group", () => {
      const confirmed = { "/": {}, "/products/featured": {} };
      expect(paths("/products/featured", confirmed)).toEqual(["hero.cta.label"]);
      expect(paths("/products/ginseng", confirmed)).toEqual([
        "hero.cta.label",
        "count:/products/*",
      ]);
      // The record's prototype never confirms a page.
      expect(paths("/products/constructor", confirmed)).toEqual([
        "hero.cta.label",
        "count:/products/*",
      ]);
    });

    it("an exact page's own count target comes first, the group's second; both in the answer", () => {
      const both = [GROUP, SLOT, { section_path: "count:/products/ginseng" }];
      expect(
        conversionTargetsForPage(both, "/products/ginseng").map((t) => t.section_path),
      ).toEqual(["hero.cta.label", "count:/products/ginseng", "count:/products/*"]);
      expect(conversionTargetsForPage(both, "/products/omega").map((t) => t.section_path)).toEqual([
        "hero.cta.label",
        "count:/products/*",
      ]);
    });

    it("without the confirmed pages (an old bundle, no g) the target alone decides", () => {
      expect(conversionTargetsForPage([GROUP], "/products/ginseng")).toEqual([GROUP]);
      expect(conversionTargetsForPage([GROUP], "/products")).toEqual([]);
    });

    it("a count page that is not a valid pattern is offered nowhere but its own exact text", () => {
      const odd = [{ section_path: "count:/*" }, { section_path: "count:/a/b/c/*" }];
      expect(conversionTargetsForPage(odd, "/anything")).toEqual([]);
      expect(conversionTargetsForPage(odd, "/a/b/c/d")).toEqual([]);
    });

    it("the list is returned as it was when no group matches (no copy, no reorder)", () => {
      expect(conversionTargetsForPage(conv, "/about")).toEqual([SLOT]);
      expect(conversionTargetsForPage([SLOT], "/about")).toEqual([SLOT]);
    });
  });

  describe("a button on every page (visual-picker.md §9, 2026-10-13)", () => {
    it("a site: target is offered on any path, like a slot target, before a page's own", () => {
      const conv = [
        { section_path: "site:elaqe" },
        { section_path: "count:/pricing" },
        { section_path: "a[href^=tel]" },
      ];
      for (const page of ["/", "/pricing", "/products/:id", "/a/b/c/d"]) {
        const got = conversionTargetsForPage(conv, page).map((t) => t.section_path);
        expect(got).toContain("site:elaqe");
        expect(got).toContain("a[href^=tel]");
        expect(got.includes("count:/pricing")).toBe(page === "/pricing");
      }
      expect(conversionTargetsForPage(conv, "/about").map((t) => t.section_path)).toEqual([
        "site:elaqe",
        "a[href^=tel]",
      ]);
    });

    it("a site-wide target is a site: path or a hand-typed selector, never a slot or a count: page", () => {
      expect(isSiteWideTarget("site:contact")).toBe(true);
      expect(isSiteWideTarget("a[href$=contact]")).toBe(true);
      expect(isSiteWideTarget("hero.cta.label")).toBe(false);
      expect(isSiteWideTarget("forms.submit_label")).toBe(false);
      expect(isSiteWideTarget("count:/")).toBe(false);
      expect(isSiteWideTarget("count:/products/*")).toBe(false);
      expect(isSiteTarget("site:contact")).toBe(true);
      expect(isSiteTarget("a[href$=contact]")).toBe(false);
    });

    it("the slug: short, ascii, stable, from the button's words; never a selector or a path", () => {
      expect(siteSlugOf("Əlaqə")).toBe("elaqe");
      expect(siteSlugOf("Telefon nömrəsi")).toBe("telefon-nomresi");
      expect(siteSlugOf("Contact us")).toBe("contact-us");
      expect(siteSlugOf("Связаться с нами")).toBe("svyazatsya-s-nami");
      expect(siteSlugOf("Bize ulaşın")).toBe("bize-ulasin");
      expect(siteSlugOf("  Crème brûlée! ")).toBe("creme-brulee");
      expect(siteSlugOf("→")).toBe("button");
      expect(siteSlugOf("")).toBe("button");
      expect(siteSlugOf("a very long button label that goes on and on").length).toBeLessThanOrEqual(
        24,
      );
      expect(siteSlugOf("a very long button label that goes on and on")).not.toMatch(/-$/);
      // A phone number or an address is its kind word, never the digits or the address.
      expect(siteSlugOf("+000 12 345 67 89")).toBe("phone");
      expect(siteSlugOf("(012) 345-67-89")).toBe("phone");
      expect(siteSlugOf("info@medora.test")).toBe("email");
      expect(siteSlugOf("Zəng et", ['a[href^="tel:+000"]'])).toBe("phone");
      expect(siteSlugOf("Yazın", ["a[href^=mailto]"])).toBe("email");
      expect(contactKindOf("Contact us")).toBeNull();
      expect(contactKindOf("2024")).toBeNull();
      expect(contactKindOf("Əlaqə", ["a[href$=contact]"])).toBeNull();
      expect(freeSiteTargetPath("elaqe", new Set())).toBe("site:elaqe");
      expect(freeSiteTargetPath("elaqe", new Set(["site:elaqe"]))).toBe("site:elaqe-2");
      expect(freeSiteTargetPath("elaqe", new Set(["site:elaqe", "site:elaqe-2"]))).toBe(
        "site:elaqe-3",
      );
    });
  });
});

describe("count-only pick: the privacy review's screens (§9.8, conditions 2 and 3)", () => {
  const COUNT_META = JSON.stringify({
    customer_id: "lumera",
    page_path: "/",
    manifest: {},
    mode: "count",
  });
  const OK = { css: ["#signup"], text: ["Start free"], structural: "first a in nav" };

  async function post(button: unknown, pagePath: string) {
    const { store, data } = memoryStore({ [pickTokenKey(TOKEN)]: COUNT_META });
    const out = await receivePick({ token: TOKEN, button, page_path: pagePath }, store);
    return { out, data };
  }

  it("400 for a button whose words or selectors carry an email or a long number", async () => {
    for (const button of [
      { ...OK, text: ["jane@acme.example"] },
      { ...OK, text: ["Order 4821337"] },
      { ...OK, css: ['a[aria-label="Menu for jane@acme.example"]'] },
      { ...OK, css: ["#user-48213377"] },
      { ...OK, css: ["#signup", 'a[name="acct-123456"]'] },
    ]) {
      const { out, data } = await post(button, "/");
      expect(out.status, JSON.stringify(button)).toBe(400);
      expect(out.body).toEqual({ error: COUNT_REFUSALS.account });
      expect(data.has(pickCountKey("lumera", "/"))).toBe(false);
      expect(data.has(pickTokenKey(TOKEN))).toBe(true);
    }
  });

  it("400 for a page path with an @, a long number, a UUID or a token-like run", async () => {
    for (const path of [
      "/u/jane@acme.example",
      "/u/jane%40acme.com",
      "/account/48213377",
      "/orders/123456/receipt",
      "/i/123e4567-e89b-12d3-a456-426614174000",
      "/reset/aB3dE5fG7hJ9kL1mN3pQ5",
      "/invite/k_29dkq83jd0s9ak2mdl1",
    ]) {
      const { out, data } = await post(OK, path);
      expect(out.status, path).toBe(400);
      expect(out.body).toEqual({ error: COUNT_REFUSALS.path });
      expect(data.has(pickCountKey("lumera", "/"))).toBe(false);
    }
  });

  it("ordinary buttons and pages pass", async () => {
    for (const [button, path] of [
      [OK, "/"],
      [{ ...OK, text: ["Call 12345"] }, "/pricing"],
      [OK, "/en/pricing"],
      [OK, "/v2/start"],
      [OK, "/features/customer-onboarding-flow"],
      [{ ...OK, css: ["main > section:nth-of-type(2) > a:nth-of-type(1)"] }, "/"],
    ] as const) {
      const { out } = await post(button, path);
      expect(out.status, path).toBe(200);
    }
  });

  it("validateCountPick applies the same screens, so generation refuses a stored one too", () => {
    expect(validateCountPick({ ...OK, text: ["jane@acme.example"] }, "/")).toBeNull();
    expect(validateCountPick(OK, "/account/48213377")).toBeNull();
    expect(validateCountPick(OK, "/pricing")).not.toBeNull();
    expect(countPickRefusal(OK, "/pricing")).toBeNull();
    expect(holdsAccountDetail("Contact us @ the office.")).toBe(false);
    expect(pathHoldsIdentifier("/bad%E0%A4%A")).toBe(false);
  });
});

describe("maskPath (docs/specs/event-paths.md)", () => {
  it("masks each identifier shape, keeps the other segments", () => {
    for (const [path, want] of [
      // UUID, either case
      ["/admin/students/550e8400-e29b-41d4-a716-446655440000", "/admin/students/:id"],
      ["/admin/students/550E8400-E29B-41D4-A716-446655440000/edit", "/admin/students/:id/edit"],
      // six or more digits in a row
      ["/account/48213377", "/account/:id"],
      ["/agreement/123456", "/agreement/:id"],
      ["/order/inv-2024-000123", "/order/:id"],
      // an @, written or percent-encoded
      ["/u/jane@acme.example", "/u/:id"],
      ["/u/jane%40acme.com", "/u/:id"],
      ["/@jane", "/:id"],
      // a token: 20 or more of [A-Za-z0-9_-] mixing letters and digits
      ["/reset/4f9Kq2xZ8mN1pR7tB3vW", "/reset/:id"],
      ["/certificate/verify/V1StGXR8_Z5jdHi6B-myT", "/certificate/verify/:id"],
      // several in one path, each on its own
      ["/a/48213377/b/jane@acme.example/c", "/a/:id/b/:id/c"],
    ] as const) {
      expect(maskPath(path), path).toBe(want);
    }
  });

  it("drops the query and the fragment, masked or not", () => {
    expect(maskPath("/pricing?utm_source=x&token=abcd")).toBe("/pricing");
    expect(maskPath("/u/48213377#tab")).toBe("/u/:id");
    expect(maskPath("?q=1")).toBe("/");
    expect(maskPath("")).toBe("/");
  });

  it("leaves ordinary paths as written", () => {
    for (const p of [
      "/",
      "/pricing",
      "/az/approach",
      "/en/pricing",
      "/v2/start",
      "/features/customer-onboarding-flow",
      "/blog/what-we-learned",
      "/GettingStarted",
      "/Pricing/",
      "/vs-hotjar",
      "/release-12345",
      "/bad%E0%A4%A",
    ]) {
      expect(maskPath(p), p).toBe(p);
    }
  });

  it("masks a long dated slug, the same false positive the count pick has (§3)", () => {
    // One rule with pathHoldsIdentifier: a slug of 20 or more characters
    // mixing words and a number reads as a token. Kept on purpose.
    expect(maskPath("/blog/what-we-learned-in-2024")).toBe("/blog/:id");
    expect(pathHoldsIdentifier("/blog/what-we-learned-in-2024")).toBe(true);
    // A short one is not.
    expect(maskPath("/blog/recap-2024")).toBe("/blog/recap-2024");
  });

  it("is the same rule as the count pick's path screen", () => {
    for (const p of [
      "/",
      "/pricing",
      "/account/48213377",
      "/u/jane%40acme.com",
      "/reset/4f9Kq2xZ8mN1pR7tB3vW",
      "/blog/what-we-learned-in-2024",
      "/admin/students/550e8400-e29b-41d4-a716-446655440000",
    ]) {
      expect(maskPath(p) !== p, p).toBe(pathHoldsIdentifier(p));
      expect(pathHoldsIdentifier(maskPath(p)), p).toBe(false);
    }
  });

  it("masks every all-digit segment, of any length (§8, condition 1)", () => {
    expect(maskPath("/students/482")).toBe("/students/:id");
    expect(maskPath("/orders/91234")).toBe("/orders/:id");
    expect(maskPath("/blog/2024/10")).toBe("/blog/:id/:id");
    expect(maskPath("/page/2")).toBe("/page/:id");
    expect(maskPath("/v2/start")).toBe("/v2/start");
  });

  it("masks a 20+ run mixing upper and lower case, a token without digits (§8, condition 2)", () => {
    expect(maskPath("/invite/aBcDeFgHiJkLmNoPqRsTuV")).toBe("/invite/:id");
    expect(maskPath("/blog/what-we-learned")).toBe("/blog/what-we-learned");
    expect(maskPath("/blog/what-we-learned-about-everything")).toBe(
      "/blog/what-we-learned-about-everything",
    );
    // Lowercased first, the case is gone: mask before normalizing.
    expect(maskPath("/invite/abcdefghijklmnopqrstuv")).toBe("/invite/abcdefghijklmnopqrstuv");
  });

  it("is idempotent", () => {
    const once = maskPath("/a/48213377/b/jane@acme.example");
    expect(maskPath(once)).toBe(once);
  });
});

describe("pagePathRefusal (event-paths.md §8, condition 3)", () => {
  it("gives the count pick's line for an identifier path, null otherwise", () => {
    for (const p of [
      "/students/482",
      "/admin/students/550e8400-e29b-41d4-a716-446655440000",
      "/u/jane%40acme.com",
      "/invite/aBcDeFgHiJkLmNoPqRsTuV",
    ]) {
      expect(pagePathRefusal(p), p).toBe(COUNT_REFUSALS.path);
    }
    for (const p of ["/", "/pricing", "/az/approach", "/pricing?ref=48213377", undefined, null]) {
      expect(pagePathRefusal(p), String(p)).toBeNull();
    }
  });

  it("a manifest token minted for such a path stores nothing", async () => {
    const { store, data } = memoryStore({
      [pickTokenKey("t1")]: JSON.stringify({
        customer_id: "acme",
        page_path: "/students/482",
        manifest: {},
      }),
    });
    const out = await receivePick(
      { token: "t1", manifest: { "hero.headline": { css: ["h1"], text: [], structural: "h1" } } },
      store,
    );
    expect(out).toEqual({ status: 400, body: { error: COUNT_REFUSALS.path } });
    expect(data.has(pickKey("acme", "/students/482"))).toBe(false);
  });
});
