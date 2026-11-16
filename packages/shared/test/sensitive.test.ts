/**
 * The contract of docs/specs/sensitive-customers.md: what a page path and a
 * variant key are stored as for a sensitive customer, which pages are kept,
 * the list a superadmin may set and the daily counter's fold. The privacy review's
 * own cases first.
 */
import { describe, expect, it } from "vitest";
import { variantKey, variantKeyForPath, variantKeyParts } from "../src/kv-keys.ts";
import { maskPath } from "../src/pick.ts";
import {
  FAIL_CLOSED_PATH,
  FOLD_MIN_PATHS,
  FOLD_MIN_VISITS,
  MAX_KEPT_SECTIONS,
  MAX_KEPT_SECTION_DEPTH,
  MAX_KEPT_SECTION_LENGTH,
  NOT_SENSITIVE,
  PAGE_DAYS_UPSERT_SQL,
  PAGE_DAY_EVENT_TYPES,
  SENSITIVE_CUSTOMER_SQL,
  bundleSensitive,
  bundleSensitiveFields,
  foldDay,
  foldPlan,
  isGroupPath,
  isKeptPage,
  pageDayOf,
  pageDayPath,
  parseKeptSections,
  sensitiveSettingsFrom,
  storedPath,
  storedVariantKey,
  validKeptSections,
} from "../src/sensitive.ts";

const MEDORA = ["/products", "/about", "/contact", "/blog", "/verify"];

describe("storedPath: the privacy review's cases", () => {
  it("a top-level product page is /:item, whatever the list", () => {
    expect(storedPath("/ginseng", [])).toBe("/:item");
    expect(storedPath("/ginseng", MEDORA)).toBe("/:item");
  });

  it("a page under a kept section is that section's group, at any depth", () => {
    expect(storedPath("/products/ginseng", ["/products"])).toBe("/products/:item");
    expect(storedPath("/products/ginseng/reviews", ["/products"])).toBe("/products/:item");
  });

  it("/ and a kept section stay as they are", () => {
    expect(storedPath("/", ["/products"])).toBe("/");
    expect(storedPath("/", [])).toBe("/");
    expect(storedPath("/products", ["/products"])).toBe("/products");
  });

  it("a path with no listed prefix is /:item", () => {
    expect(storedPath("/category/liver", [])).toBe("/:item");
    expect(storedPath("/category/liver", ["/products"])).toBe("/:item");
  });

  it("nested listed prefixes take the longest", () => {
    const kept = ["/products", "/products/new"];
    expect(storedPath("/products/new", kept)).toBe("/products/new");
    expect(storedPath("/products/new/ginseng", kept)).toBe("/products/new/:item");
    expect(storedPath("/products/ginseng", kept)).toBe("/products/:item");
    // The order of the list does not matter.
    expect(storedPath("/products/new/ginseng", [...kept].reverse())).toBe("/products/new/:item");
  });
});

describe("storedPath: the rest of the rule", () => {
  it("a prefix is whole segments only", () => {
    expect(storedPath("/productsale", ["/products"])).toBe("/:item");
    expect(storedPath("/products-new/x", ["/products"])).toBe("/:item");
    expect(storedPath("/productsale/x", ["/products"])).toBe("/:item");
  });

  it("reads the path as the rest of the code does: lowercase, slashes collapsed, no trailing slash", () => {
    expect(storedPath("/Products/", ["/products"])).toBe("/products");
    expect(storedPath("/Products/Ginseng/", ["/products"])).toBe("/products/:item");
    expect(storedPath("//products//ginseng", ["/products"])).toBe("/products/:item");
    expect(storedPath("", ["/products"])).toBe("/");
    expect(storedPath("/?x=1", [])).toBe("/");
  });

  it("takes maskPath's output: a masked segment is one more page of its group", () => {
    expect(storedPath(maskPath("/products/482"), ["/products"])).toBe("/products/:item");
    expect(storedPath(maskPath("/orders/91234"), ["/products"])).toBe("/:item");
    expect(storedPath(maskPath("/Products/Ginseng?ref=x#top"), ["/products"])).toBe(
      "/products/:item",
    );
  });

  it("is the same when applied twice: a group maps to itself", () => {
    for (const p of ["/", "/products", "/products/ginseng", "/ginseng", "/a/b/c", "/about/team"]) {
      const once = storedPath(p, MEDORA);
      expect(storedPath(once, MEDORA), p).toBe(once);
    }
  });

  it("the result is always /, a kept section, its group, or /:item", () => {
    const closed = new Set(["/", "/:item", ...MEDORA, ...MEDORA.map((k) => `${k}/:item`)]);
    const paths = [
      "/",
      "/ginseng",
      "/products",
      "/products/ginseng",
      "/products/ginseng/reviews",
      "/about",
      "/about/team",
      "/blog/liver-health",
      "/verify/abc",
      "/category/liver/x",
      "/PRODUCTS/Omega-3",
      "/contact/",
      "/x/:id",
    ];
    for (const p of paths) expect(closed.has(storedPath(p, MEDORA)), p).toBe(true);
  });

  it("an empty, missing or unreadable list keeps nothing but /", () => {
    expect(storedPath("/products", [])).toBe("/:item");
    expect(storedPath("/products", null)).toBe("/:item");
    expect(storedPath("/products", undefined)).toBe("/:item");
    expect(storedPath("/products", [42, null, ""] as unknown as string[])).toBe("/:item");
    expect(FAIL_CLOSED_PATH).toBe("/:item");
  });

  it("a list entry given unnormalized still matches, and / on the list changes nothing", () => {
    expect(storedPath("/products/x", ["/Products/"])).toBe("/products/:item");
    expect(storedPath("/ginseng", ["/"])).toBe("/:item");
  });
});

describe("isKeptPage and isGroupPath", () => {
  it("/ and the listed sections are kept pages, nothing else", () => {
    expect(isKeptPage("/", [])).toBe(true);
    expect(isKeptPage("/products", ["/products"])).toBe(true);
    expect(isKeptPage("/Products/", ["/products"])).toBe(true);
    expect(isKeptPage("/products/ginseng", ["/products"])).toBe(false);
    expect(isKeptPage("/products/:item", ["/products"])).toBe(false);
    expect(isKeptPage("/ginseng", ["/products"])).toBe(false);
    expect(isKeptPage("/products", [])).toBe(false);
    expect(isKeptPage("/products", null)).toBe(false);
  });

  it("a group path ends with /:item", () => {
    expect(isGroupPath("/:item")).toBe(true);
    expect(isGroupPath("/products/:item")).toBe(true);
    expect(isGroupPath("/products")).toBe(false);
    expect(isGroupPath("/")).toBe(false);
    expect(isGroupPath("/products/:id")).toBe(false);
  });
});

describe("variantKeyParts: how a key carries its page", () => {
  it("reads back what the builders build", () => {
    expect(variantKeyParts(variantKey("medora", "problem", "ai"))).toEqual({
      customerId: "medora",
      pagePath: "/",
      intentDim: "problem",
      sourceDim: "ai",
    });
    expect(variantKeyParts(variantKeyForPath("medora", "/products", "brand", "default"))).toEqual({
      customerId: "medora",
      pagePath: "/products",
      intentDim: "brand",
      sourceDim: "default",
    });
    expect(variantKeyParts(variantKeyForPath("a-b", "/a/b", "pricing", "paid"))?.pagePath).toBe(
      "/a/b",
    );
  });

  it("refuses anything the builders do not build", () => {
    for (const key of [
      "",
      "hello",
      "v1:variant:medora",
      "v1:variant:medora:problem",
      "v1:variant:medora:problem:ai:extra",
      "v1:variant:medora:x:%2Fproducts:problem:ai",
      "v1:variant:medora:p:%2F:problem:ai",
      "v1:variant:medora:p:%2fproducts:problem:ai",
      "v1:variant:medora:p:products:problem:ai",
      "v1:variant:medora:p:%E0%A4%A:problem:ai",
      "v1:variant::problem:ai",
      "v2:variant:medora:problem:ai",
      "v1:manifest:medora",
    ]) {
      expect(variantKeyParts(key), key).toBeNull();
    }
  });
});

describe("storedVariantKey", () => {
  const root = variantKey("medora", "problem", "ai");
  const products = variantKeyForPath("medora", "/products", "problem", "ai");
  const product = variantKeyForPath("medora", "/products/ginseng", "problem", "ai");
  const top = variantKeyForPath("medora", "/ginseng", "problem", "ai");

  it("keeps a key whose page is / or a kept section", () => {
    expect(storedVariantKey(root, MEDORA)).toBe(root);
    expect(storedVariantKey(root, [])).toBe(root);
    expect(storedVariantKey(products, MEDORA)).toBe(products);
    expect(storedVariantKey(variantKey("medora", "brand", "default"), [])).toBe(
      "v1:variant:medora:brand:default",
    );
  });

  it("stores NULL for a key whose page is anything else", () => {
    expect(storedVariantKey(product, MEDORA)).toBeNull();
    expect(storedVariantKey(top, MEDORA)).toBeNull();
    expect(storedVariantKey(products, [])).toBeNull();
    expect(
      storedVariantKey(variantKeyForPath("medora", "/products/:item", "problem", "ai"), MEDORA),
    ).toBeNull();
  });

  it("stores NULL for a string that is not a variant key: a client's free text names nothing", () => {
    for (const key of [
      "",
      null,
      undefined,
      "ginseng",
      "v1:variant:medora:ginseng:ai",
      "v1:variant:medora:problem:ginseng",
      "v1:variant:medora:p:%2FProducts:problem:ai",
      "v1:variant:medora:problem:ai:ginseng",
    ]) {
      expect(storedVariantKey(key, MEDORA), String(key)).toBeNull();
    }
  });

  it("with the customer id, the key must be that customer's", () => {
    expect(storedVariantKey(root, MEDORA, "medora")).toBe(root);
    expect(storedVariantKey(products, MEDORA, "medora")).toBe(products);
    expect(storedVariantKey(variantKey("ginseng", "problem", "ai"), MEDORA, "medora")).toBeNull();
    // Without the id the customer part is the one free part left.
    expect(storedVariantKey(variantKey("ginseng", "problem", "ai"), MEDORA)).toBe(
      "v1:variant:ginseng:problem:ai",
    );
  });
});

describe("validKeptSections", () => {
  it("accepts plain sections, normalized, sorted, without duplicates or /", () => {
    expect(validKeptSections(MEDORA)).toEqual([
      "/about",
      "/blog",
      "/contact",
      "/products",
      "/verify",
    ]);
    expect(validKeptSections(["/Products/", "/products", "/", "/blog/news"])).toEqual([
      "/blog/news",
      "/products",
    ]);
    expect(validKeptSections([])).toEqual([]);
    expect(validKeptSections(["/m%C9%99hsullar"])).toEqual(["/m%c9%99hsullar"]);
  });

  it("is null for anything that is not a list of plain paths", () => {
    for (const input of [
      null,
      undefined,
      "/products",
      { 0: "/products" },
      [42],
      [""],
      ["products"],
      ["/products?x=1"],
      ["/products#top"],
      ["/products/:item"],
      ["/products/:id"],
      ["/a//b"],
      ["/a/./b"],
      ["/a/../b"],
      ["/a b"],
      ["/a'b"],
      ["/a*"],
      ["//"],
    ]) {
      expect(validKeptSections(input), JSON.stringify(input)).toBeNull();
    }
  });

  it("refuses a section the count pick's segment rule flags", () => {
    for (const p of [
      "/students/482",
      "/u/jane%40acme.com",
      "/u/jane@acme.example",
      "/orders/550e8400-e29b-41d4-a716-446655440000",
      "/invite/aBcDeFgHiJkLmNoPqRsTuV",
      "/blog/what-we-learned-in-2024",
    ]) {
      expect(validKeptSections([p]), p).toBeNull();
    }
  });

  it("holds the caps on count, length and depth", () => {
    const sections = (n: number) => Array.from({ length: n }, (_, i) => `/sec${i}`);
    expect(validKeptSections(sections(MAX_KEPT_SECTIONS))).toHaveLength(MAX_KEPT_SECTIONS);
    expect(validKeptSections(sections(MAX_KEPT_SECTIONS + 1))).toBeNull();
    expect(validKeptSections([`/${"a".repeat(MAX_KEPT_SECTION_LENGTH)}`])).toBeNull();
    const deep = Array.from({ length: MAX_KEPT_SECTION_DEPTH }, () => "a").join("/");
    expect(validKeptSections([`/${deep}`])).toEqual([`/${deep}`]);
    expect(validKeptSections([`/${deep}/a`])).toBeNull();
  });
});

describe("the stored list and the settings", () => {
  it("parseKeptSections reads the column; anything unreadable is the empty list", () => {
    expect(parseKeptSections(JSON.stringify(MEDORA))).toEqual(validKeptSections(MEDORA));
    expect(parseKeptSections(null)).toEqual([]);
    expect(parseKeptSections("")).toEqual([]);
    expect(parseKeptSections("not json")).toEqual([]);
    expect(parseKeptSections('{"a":1}')).toEqual([]);
    expect(parseKeptSections('["/products","/x/:id"]')).toEqual([]);
  });

  it("sensitiveSettingsFrom reads the customers row", () => {
    expect(SENSITIVE_CUSTOMER_SQL).toBe(
      "SELECT sensitive, kept_sections FROM customers WHERE id = ?",
    );
    expect(sensitiveSettingsFrom(null)).toBe(NOT_SENSITIVE);
    expect(sensitiveSettingsFrom({ sensitive: 0, kept_sections: '["/products"]' })).toBe(
      NOT_SENSITIVE,
    );
    expect(sensitiveSettingsFrom({ sensitive: 1, kept_sections: null })).toEqual({
      sensitive: true,
      kept: [],
    });
    expect(sensitiveSettingsFrom({ sensitive: 1, kept_sections: '["/products"]' })).toEqual({
      sensitive: true,
      kept: ["/products"],
    });
  });

  it("the bundle fields: nothing for a customer that is not sensitive, s and sk for one that is", () => {
    expect(bundleSensitiveFields(NOT_SENSITIVE)).toEqual({});
    expect(bundleSensitiveFields(null)).toEqual({});
    expect(JSON.stringify(bundleSensitiveFields(NOT_SENSITIVE))).toBe("{}");
    expect(bundleSensitiveFields({ sensitive: true, kept: [] })).toEqual({ s: 1 });
    expect(bundleSensitiveFields({ sensitive: true, kept: ["/products"] })).toEqual({
      s: 1,
      sk: ["/products"],
    });
  });

  it("bundleSensitive reads them back, strictly", () => {
    expect(bundleSensitive(null)).toBe(NOT_SENSITIVE);
    expect(bundleSensitive({})).toBe(NOT_SENSITIVE);
    expect(bundleSensitive({ sk: ["/products"] })).toBe(NOT_SENSITIVE);
    expect(bundleSensitive({ s: 1 })).toEqual({ sensitive: true, kept: [] });
    expect(bundleSensitive({ s: 1, sk: ["/products"] })).toEqual({
      sensitive: true,
      kept: ["/products"],
    });
    // A list that does not pass keeps nothing: the strictest reading.
    expect(bundleSensitive({ s: 1, sk: ["/products", "/x/:id"] })).toEqual({
      sensitive: true,
      kept: [],
    });
  });
});

describe("the daily counter", () => {
  it("counts the three exposure shapes, one per load, under the normalized masked path", () => {
    expect(PAGE_DAY_EVENT_TYPES).toEqual([
      "variant_shown",
      "personalization_skipped",
      "no_signal_passthrough",
    ]);
    expect(pageDayPath(maskPath("/Products/Ginseng/?x=1"))).toBe("/products/ginseng");
    expect(pageDayPath(maskPath("/orders/91234"))).toBe("/orders/:id");
    expect(pageDayOf(Date.parse("2026-10-11T23:59:59.999Z"))).toBe("2026-10-11");
    expect(pageDayOf(Date.parse("2026-10-12T00:00:00.000Z"))).toBe("2026-10-12");
  });

  it("the upsert names exactly the four columns and no time", () => {
    expect(PAGE_DAYS_UPSERT_SQL).toContain(
      "INSERT INTO page_days (customer_id, day, page_path, loads)",
    );
    expect(PAGE_DAYS_UPSERT_SQL).not.toMatch(/\bts\b|_at\b|visit|arm|intent|source/);
  });
});

describe("foldDay (condition 4)", () => {
  const kept = ["/products", "/about"];

  it("folds a group with fewer than three distinct pages into the group's row", () => {
    expect(FOLD_MIN_PATHS).toBe(3);
    expect(
      foldDay(
        [
          { page_path: "/", loads: 10 },
          { page_path: "/products", loads: 4 },
          { page_path: "/products/ginseng", loads: 3 },
          { page_path: "/products/omega", loads: 2 },
        ],
        kept,
      ),
    ).toEqual([
      { page_path: "/", loads: 10 },
      { page_path: "/products", loads: 4 },
      { page_path: "/products/:item", loads: 5 },
    ]);
    // A group of one.
    expect(foldDay([{ page_path: "/products/ginseng", loads: 7 }], kept)).toEqual([
      { page_path: "/products/:item", loads: 7 },
    ]);
  });

  it("keeps a group with three distinct pages or more", () => {
    const rows = [
      { page_path: "/products/a", loads: 1 },
      { page_path: "/products/b", loads: 2 },
      { page_path: "/products/c", loads: 3 },
    ];
    expect(foldDay(rows, kept)).toEqual(rows);
    expect(foldPlan(rows, kept)).toEqual([]);
  });

  it("never folds / or a kept section, even alone", () => {
    const rows = [
      { page_path: "/", loads: 1 },
      { page_path: "/about", loads: 1 },
    ];
    expect(foldDay(rows, kept)).toEqual(rows);
  });

  it("each group is judged by its own pages: a deeper page is one more page of its group", () => {
    expect(
      foldDay(
        [
          { page_path: "/products/a", loads: 1 },
          { page_path: "/products/b", loads: 1 },
          { page_path: "/products/a/reviews", loads: 1 },
          { page_path: "/ginseng", loads: 5 },
          { page_path: "/category/liver", loads: 2 },
          { page_path: "/about/team", loads: 9 },
        ],
        kept,
      ),
    ).toEqual([
      // /:item has two pages, /about/:item one: both folded.
      { page_path: "/:item", loads: 7 },
      { page_path: "/about/:item", loads: 9 },
      // /products/:item has three distinct pages: kept.
      { page_path: "/products/a", loads: 1 },
      { page_path: "/products/a/reviews", loads: 1 },
      { page_path: "/products/b", loads: 1 },
    ]);
  });

  it("adds to a row the group already has, and folding a folded day changes nothing", () => {
    const once = foldDay(
      [
        { page_path: "/products/:item", loads: 5 },
        { page_path: "/products/late", loads: 1 },
      ],
      kept,
    );
    expect(once).toEqual([{ page_path: "/products/:item", loads: 6 }]);
    expect(foldDay(once, kept)).toEqual(once);
  });

  it("a group's own row does not count as one of its pages", () => {
    expect(
      foldDay(
        [
          { page_path: "/products/:item", loads: 5 },
          { page_path: "/products/a", loads: 1 },
          { page_path: "/products/b", loads: 1 },
        ],
        kept,
      ),
    ).toEqual([{ page_path: "/products/:item", loads: 7 }]);
  });

  it("with an empty list every page but / is in the one group /:item", () => {
    expect(
      foldDay(
        [
          { page_path: "/", loads: 3 },
          { page_path: "/products", loads: 1 },
          { page_path: "/products/a", loads: 1 },
        ],
        [],
      ),
    ).toEqual([
      { page_path: "/", loads: 3 },
      { page_path: "/:item", loads: 2 },
    ]);
  });

  it("the plan names each folded group with its pages", () => {
    expect(
      foldPlan(
        [
          { page_path: "/products/b", loads: 1 },
          { page_path: "/products/a", loads: 1 },
          { page_path: "/ginseng", loads: 1 },
          { page_path: "/", loads: 1 },
        ],
        kept,
      ),
    ).toEqual([
      { group: "/:item", paths: ["/ginseng"] },
      { group: "/products/:item", paths: ["/products/a", "/products/b"] },
    ]);
  });

  describe("the visit floor: three pages do not hide one visit", () => {
    const three = [
      { page_path: "/products/a", loads: 1 },
      { page_path: "/products/b", loads: 1 },
      { page_path: "/products/c", loads: 1 },
    ];
    const ten = Array.from({ length: 10 }, (_, i) => ({
      page_path: `/products/p${"abcdefghij"[i]}`,
      loads: 1,
    }));
    const behind = (n: number) => new Map([["/products/:item", n]]);

    it("one visit, three product pages on a day: the day keeps only the group", () => {
      expect(FOLD_MIN_VISITS).toBe(5);
      expect(foldDay(three, kept, behind(1))).toEqual([{ page_path: "/products/:item", loads: 3 }]);
      expect(foldPlan(three, kept, behind(1))).toEqual([
        { group: "/products/:item", paths: ["/products/a", "/products/b", "/products/c"] },
      ]);
    });

    it("five visits over three pages stays unfolded", () => {
      expect(foldDay(three, kept, behind(5))).toEqual(three);
      expect(foldPlan(three, kept, behind(5))).toEqual([]);
    });

    it("four visits over ten pages folds", () => {
      expect(foldDay(ten, kept, behind(4))).toEqual([{ page_path: "/products/:item", loads: 10 }]);
    });

    it("either floor is enough: two pages fold whatever stands behind them", () => {
      expect(foldDay(three.slice(0, 2), kept, behind(500))).toEqual([
        { page_path: "/products/:item", loads: 2 },
      ]);
    });

    it("a group with no count has no visit behind it, and each group has its own count", () => {
      const rows = [
        ...three,
        { page_path: "/x", loads: 1 },
        { page_path: "/y", loads: 1 },
        { page_path: "/z", loads: 1 },
      ];
      // Nine visits behind the product pages, none counted behind /:item.
      expect(foldDay(rows, kept, behind(9))).toEqual([{ page_path: "/:item", loads: 3 }, ...three]);
      expect(foldDay(rows, kept, new Map())).toEqual([
        { page_path: "/:item", loads: 3 },
        { page_path: "/products/:item", loads: 3 },
      ]);
    });

    it("never touches / or a kept section, and never unfolds a folded day", () => {
      const rows = [
        { page_path: "/", loads: 4 },
        { page_path: "/about", loads: 2 },
        { page_path: "/products/:item", loads: 7 },
      ];
      expect(foldDay(rows, kept, new Map())).toEqual(rows);
      // Later the rows count as many visits (their markers are gone): still folded.
      expect(foldDay(rows, kept, behind(900))).toEqual(rows);
    });

    it("without the count only the page floor is read (a day already folded under both)", () => {
      expect(foldDay(three, kept)).toEqual(three);
      expect(foldDay(three, kept, null)).toEqual(three);
      expect(foldDay(three.slice(0, 2), kept)).toEqual([
        { page_path: "/products/:item", loads: 2 },
      ]);
    });
  });

  it("never loses a load", () => {
    const rows = [
      { page_path: "/", loads: 11 },
      { page_path: "/products/a", loads: 2 },
      { page_path: "/x", loads: 3 },
      { page_path: "/y", loads: 4 },
      { page_path: "/z", loads: 5 },
      { page_path: "/about/a", loads: 6 },
    ];
    const sum = (r: { loads: number }[]) => r.reduce((t, x) => t + x.loads, 0);
    expect(sum(foldDay(rows, kept))).toBe(sum(rows));
  });
});
