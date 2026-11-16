/**
 * Site-shaped intents (docs/specs/site-shaped-intents.md §4.3, §4.4, §14):
 * the word tables, the screens and the rules, with every row of section 14
 * as a fixture.
 */
import { describe, expect, it } from "vitest";
import {
  ACCOUNT_WORDS,
  FOLDED_ACCOUNT_WORDS,
  FOLDED_KIND_WORDS,
  FOLDED_NEVER_WORDS,
  KIND_WORDS,
  SITE_LANGS,
  SITE_LINKS_PER_PAGE,
  cleanLinkText,
  foldText,
  kindSegment,
  kindsNamed,
  labelToKeep,
  ruleKind,
  screenLink,
  spellingKey,
  wordsOf,
} from "../../src/index.ts";

describe("folding", () => {
  it("folds Azerbaijani, Turkish and Cyrillic to plain letters", () => {
    expect(foldText("Qiymətlər")).toBe("qiymetler");
    expect(foldText("Fiyatlandırma")).toBe("fiyatlandirma");
    expect(foldText("İşlər")).toBe("isler");
    expect(foldText("Özellikler")).toBe("ozellikler");
    expect(foldText("цены")).toBe("tseny");
  });

  it("brings the usual transliterations of one Russian word together", () => {
    expect(wordsOf("/ceny")).toEqual(wordsOf("/tseny"));
    expect(wordsOf("цены")).toEqual(wordsOf("/ceny"));
    expect(spellingKey("kontakty")).toBe(spellingKey("kontakti"));
  });

  it("no spelling key names two kinds, and no kind word is an account or never word", () => {
    // One known meeting across languages, settled by the page's language
    // first: az "alternativi" (its alternative, vs) and ru "альтернативы"
    // (alternatives, compare) share a key.
    const ACROSS = new Set(["alternativi"]);
    const owner = new Map<string, { kind: string; lang: string }>();
    for (const [kind, table] of Object.entries(FOLDED_KIND_WORDS)) {
      for (const lang of SITE_LANGS) {
        for (const phrase of table[lang]) {
          const key = phrase.join(" ");
          const prev = owner.get(key);
          if (prev !== undefined && prev.kind !== kind) {
            expect(prev.lang).not.toBe(lang);
            expect(ACROSS.has(key)).toBe(true);
          }
          owner.set(key, { kind, lang });
        }
      }
    }
    expect(kindsNamed(wordsOf("Alternativi"), "az")).toEqual(["vs"]);
    expect(kindsNamed(wordsOf("Альтернативы"), "ru")).toEqual(["compare"]);
    for (const table of [FOLDED_ACCOUNT_WORDS, FOLDED_NEVER_WORDS]) {
      for (const lang of SITE_LANGS) {
        for (const phrase of table[lang]) expect(owner.get(phrase.join(" "))).toBeUndefined();
      }
    }
  });

  it("keeps the spec's starting lists in code", () => {
    expect(KIND_WORDS.price.az).toEqual(expect.arrayContaining(["qiymət", "tariflər", "paketlər"]));
    expect(KIND_WORDS.price.ru).toEqual(expect.arrayContaining(["цены", "тарифы", "стоимость"]));
    expect(KIND_WORDS.price.tr).toEqual(expect.arrayContaining(["fiyatlar", "fiyatlandırma"]));
    expect(KIND_WORDS.proof.az).toEqual(expect.arrayContaining(["işlər", "keyslər"]));
    expect(KIND_WORDS.how.ru).toEqual(expect.arrayContaining(["как это работает", "подход"]));
  });
});

describe("price in four languages", () => {
  it.each(["/qiymetler", "/tarifler", "/ceny", "/tseny", "/fiyatlar", "/pricing", "/az/qiymetler"])(
    "%s maps to price by its path",
    (path) => {
      expect(ruleKind({ path, text: "", lang: null }).kind).toBe("price");
    },
  );

  it("цены as link text names price", () => {
    expect(ruleKind({ path: "/x", text: "Цены", lang: "ru" }).kind).toBe("price");
  });
});

describe("the longest phrase wins", () => {
  it('"How we work" names how, not proof for its "work"', () => {
    expect(kindsNamed(wordsOf("How we work"), "en")).toEqual(["how"]);
  });
  it("two kinds of the same length are a conflict, for the model", () => {
    const r = ruleKind({ path: "/x", text: "Pricing and features", lang: "en" });
    expect(r.kind).toBeNull();
  });
});

describe("confidence", () => {
  it("path and text agree: high; the global table counts as the path", () => {
    expect(ruleKind({ path: "/pricing", text: "Pricing", lang: "en" })).toMatchObject({
      kind: "price",
      confidence: "high",
    });
  });
  it("one names it, the other is silent: medium", () => {
    expect(ruleKind({ path: "/work/portal", text: "Portal", lang: "en" })).toMatchObject({
      kind: "proof",
      confidence: "medium",
    });
    expect(ruleKind({ path: "/p/8", text: "Our approach", lang: "en" })).toMatchObject({
      kind: "how",
      confidence: "medium",
    });
  });
  it("path and text disagree: left for the model", () => {
    expect(ruleKind({ path: "/pricing", text: "Case studies", lang: "en" }).kind).toBeNull();
  });
  it("the first segment after a language prefix is the one read", () => {
    expect(kindSegment("/az/work/portal")).toBe("work");
    expect(kindSegment("/blog/pricing-guide")).toBe("blog");
    expect(ruleKind({ path: "/blog/pricing-guide", text: "", lang: "en" }).kind).toBe("learn");
  });
});

// Section 14, a pilot site's own links (en and az) and measure-lab's.
const LUMERA: Array<{
  path: string;
  text: string;
  lang: string;
  kind: string | null;
  drop?: string;
}> = [
  { path: "/work", text: "Work", lang: "en", kind: "proof" },
  { path: "/work", text: "Case archive", lang: "en", kind: "proof" },
  { path: "/az/work", text: "İşlər", lang: "az", kind: "proof" },
  { path: "/az/work", text: "İş arxivi", lang: "az", kind: "proof" },
  { path: "/approach", text: "Approach", lang: "en", kind: "how" },
  { path: "/approach", text: "AI practice", lang: "en", kind: "how" },
  { path: "/az/approach", text: "Yanaşmamız", lang: "az", kind: "how" },
  { path: "/insights", text: "Insights", lang: "en", kind: "learn" },
  { path: "/insights", text: "All research", lang: "en", kind: "learn" },
  { path: "/az/insights", text: "Araşdırmalar", lang: "az", kind: "learn" },
  // Left for the model (expected learn), section 14.
  { path: "/retail-ux-report", text: "Retail report", lang: "en", kind: null },
  { path: "/az/retail-ux-report", text: "Bank UX indeksi", lang: "az", kind: null },
  { path: "/az/retail-ux-index", text: "Bank UX indeksi", lang: "az", kind: null },
  { path: "/menzil-bazari-hesabati", text: "Property census", lang: "en", kind: null },
  { path: "/az/menzil-bazari-hesabati", text: "Əmlak sayımı", lang: "az", kind: null },
  { path: "/about", text: "Studio", lang: "en", kind: "about" },
  { path: "/az/about", text: "Haqqımızda", lang: "az", kind: "about" },
  { path: "/contact", text: "Start a build →", lang: "en", kind: "start" },
  { path: "/az/contact", text: "Layihəni danışaq", lang: "az", kind: "start" },
  { path: "/careers", text: "Open roles", lang: "en", kind: null, drop: "never" },
  { path: "/az/careers", text: "Vakansiyalar", lang: "az", kind: null, drop: "never" },
  { path: "/privacy", text: "PRIVACY", lang: "en", kind: null, drop: "never" },
  { path: "/az/privacy", text: "Məxfilik", lang: "az", kind: null, drop: "never" },
  { path: "/rss.xml", text: "RSS", lang: "en", kind: null, drop: "never" },
];

describe("section 14 fixtures: lumera.test", () => {
  it.each(LUMERA)("$path ($text) → $kind", (row) => {
    const drop = screenLink(row.path, row.text);
    if (row.drop) {
      expect(drop).toBe(row.drop);
      return;
    }
    expect(drop).toBeNull();
    expect(ruleKind(row).kind).toBe(row.kind);
  });

  it("the az contact text names no kind, so a capture keeps no label for it", () => {
    const r = ruleKind({ path: "/az/contact", text: "Layihəni danışaq", lang: "az" });
    expect(r.kind).toBe("start");
    expect(labelToKeep("capture", "Layihəni danışaq", "start", r.textKinds)).toBeNull();
    expect(labelToKeep("fetch", "Layihəni danışaq", "start", r.textKinds)).toBe("Layihəni danışaq");
  });
});

describe("section 14 fixtures: measure-lab", () => {
  it("/pricing with Pricing or See plans is price, high", () => {
    expect(ruleKind({ path: "/pricing", text: "Pricing", lang: "en" })).toMatchObject({
      kind: "price",
      confidence: "high",
    });
    expect(ruleKind({ path: "/pricing", text: "See plans", lang: "en" })).toMatchObject({
      kind: "price",
      confidence: "high",
    });
  });
  it('a "Sign in" link to /signup is an account word: dropped', () => {
    expect(screenLink("/signup", "Sign in")).toBe("account");
    expect(screenLink("/signup", "Start free")).toBeNull();
  });
});

describe("the lab: the zoo pages name no kind", () => {
  it.each(["letters", "lines", "scramble", "typewriter", "marquee"])("/zoo/%s", (name) => {
    expect(ruleKind({ path: `/zoo/${name}`, text: name, lang: "en" }).kind).toBeNull();
  });
});

describe("screens (§4.3, privacy review condition 1)", () => {
  it("an identifier in the path, read before lower-casing", () => {
    expect(screenLink("/u/jane@x.test", "Jane")).toBe("identifier");
    expect(screenLink("/students/482", "Student")).toBe("identifier");
    expect(screenLink("/p/3f2b8c1e-9d4a-4c1b-8e7f-0a1b2c3d4e5f", "x")).toBe("identifier");
    expect(screenLink("/s/AbCdEfGhIjKlMnOpQrStUv", "x")).toBe("identifier");
  });
  it("an account detail in the text", () => {
    expect(screenLink("/team", "jane@acme.example")).toBe("detail");
    expect(screenLink("/team", "Call 5551234")).toBe("detail");
  });
  it.each([
    ["/w/acme", "Jane's workspace"],
    ["/my-projects", "Projects"],
    ["/billing", "Plans and billing"],
    ["/orders", "Orders"],
    ["/inbox", "Inbox"],
    ["/notifications", "Alerts"],
    ["/members", "Team"],
    ["/invite", "Invite"],
    ["/reset", "Reset"],
    ["/verify", "Verify"],
    ["/unsubscribe", "Unsubscribe"],
    ["/x", "Sign out"],
    ["/x", "Log out"],
    ["/login", "Log in"],
    ["/dashboard", "Dashboard"],
    ["/settings", "Settings"],
    ["/cart", "Cart"],
    ["/checkout", "Checkout"],
    ["/x", "Daxil ol"],
    ["/x", "Şəxsi kabinet"],
    ["/x", "Hesabım"],
    ["/x", "Gələnlər"],
    ["/x", "Gələn qutusu"],
    ["/sifirla", "Şifrəni sıfırla"],
    ["/x", "Личный кабинет"],
    ["/x", "Войти"],
    ["/x", "Выйти"],
    ["/x", "Hesabım"],
    ["/x", "Çıkış yap"],
    ["/x", "Oturum aç"],
  ])("%s %s is an account area", (path, text) => {
    expect(screenLink(path, text)).toBe("account");
  });
  it("every account word in the four lists is caught", () => {
    for (const lang of SITE_LANGS) {
      for (const w of ACCOUNT_WORDS[lang]) expect(screenLink("/x", w)).toBe("account");
    }
  });
  it("legal, jobs and feed links are never an intent; files are dropped", () => {
    expect(screenLink("/terms", "Terms")).toBe("never");
    expect(screenLink("/x", "Gizlilik")).toBe("never");
    expect(screenLink("/brochure.pdf", "Brochure")).toBe("file");
  });
  it("the root and a bare language root are not entries", () => {
    expect(screenLink("/", "Home")).toBe("root");
    expect(screenLink("/az", "AZ")).toBe("root");
    expect(screenLink("/az/work", "İşlər")).toBeNull();
  });
});

describe("the label rule (privacy review condition 2)", () => {
  it('"Jane Doe" on /u/jane-doe: no kind from the rules, no label from a capture', () => {
    const r = ruleKind({ path: "/u/jane-doe", text: "Jane Doe", lang: "en" });
    expect(r.kind).toBeNull();
    expect(r.textKinds).toEqual([]);
    expect(labelToKeep("capture", "Jane Doe", "proof", r.textKinds)).toBeNull();
  });
  it("a capture keeps the text that named the kind", () => {
    const r = ruleKind({ path: "/tarifler", text: "Qiymətlər", lang: "az" });
    expect(labelToKeep("capture", "Qiymətlər", "price", r.textKinds)).toBe("Qiymətlər");
  });
  it("text is cut to 40 characters", () => {
    expect(cleanLinkText(`  ${"a".repeat(60)}  `)).toHaveLength(40);
  });
  it("a page gives at most 60 links", () => {
    expect(SITE_LINKS_PER_PAGE).toBe(60);
  });
});
