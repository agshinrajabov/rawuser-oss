/**
 * A language on the same address (docs/specs/per-language.md; I1 of
 * docs/specs/pilot-gaps.md). The pilot's switch is a link to
 * `/language/en` that sets the site's session and returns to the same path.
 * The pages below are built from that fact, not copied from the site.
 */
import { discoverLanguages } from "@rawuser/shared";
import { describe, expect, it } from "vitest";
import {
  MAX_SAME_ADDRESS_LANGUAGES,
  languageOfTag,
  sameAddressLanguages,
  switchLinkOf,
} from "../../src/lib/language-switch.ts";

const page = (lang: string, body: string) => `<html lang="${lang}"><body>${body}</body></html>`;
const HOME = "https://www.medora.test/";

/** The switch as the read of 2026-10-12 found it. */
const MEDORA = page(
  "az",
  `<nav><div class="dropdown-menu">
     <a class="dropdown-item d-flex" href="https://www.medora.test/language/az"> Azərbaycan </a>
     <a class="dropdown-item d-flex" href="https://www.medora.test/language/en"> English </a>
   </div><a href="/products">Məhsullar</a><a href="/about">Haqqımızda</a></nav><h1>Başlıq</h1>`,
);

describe("Medora's switch", () => {
  it("the path discovery finds one language, as it did", () => {
    expect(discoverLanguages(MEDORA, HOME)).toEqual([
      { lang: "az", path: "/", source: "html-lang" },
    ]);
  });

  it("the switch says the site also has English on the same address", () => {
    expect(sameAddressLanguages(MEDORA, HOME, "az")).toEqual(["en"]);
  });

  it("read from the English session, it says Azerbaijani", () => {
    expect(sameAddressLanguages(MEDORA.replace('lang="az"', 'lang="en"'), HOME, "en")).toEqual([
      "az",
    ]);
  });
});

describe("a link whose path is a switch word and a tag", () => {
  const both = (word: string) =>
    page("az", `<a href="/${word}/az">AZ</a><a href="/${word}/ru">RU</a>`);

  it.each([
    "language",
    "lang",
    "locale",
    "setlocale",
    "set-locale",
    "change-language",
    "switch_lang",
  ])("/%s/xx", (word) => {
    expect(sameAddressLanguages(both(word), HOME, "az")).toEqual(["ru"]);
  });

  it("reads a tag with a region, with a hyphen or an underscore", () => {
    const html = page(
      "az",
      '<a href="/language/az-AZ">AZ</a><a href="/language/en-US">EN</a><a href="/language/pt_BR">PT</a>',
    );
    expect(sameAddressLanguages(html, HOME, "az-Latn")).toEqual(["en", "pt"]);
  });

  it("a word that is not a language is not one: /language/learning", () => {
    const html = page(
      "en",
      '<a href="/language/learning">Language learning</a><a href="/language/english">English</a>',
    );
    expect(sameAddressLanguages(html, "https://school.example/", "en")).toEqual([]);
    expect(languageOfTag("learning")).toBeNull();
    expect(languageOfTag("english")).toBeNull();
    expect(languageOfTag("xx")).toBeNull();
    expect(languageOfTag("")).toBeNull();
  });

  it("a site about programming languages is not a switch: one value that is no language spoils the family", () => {
    // "ts" and "cs" are ISO codes too (Tsonga, Czech); "go" and "py" are not.
    const html = page(
      "en",
      '<a href="/lang/ts">TypeScript</a><a href="/lang/cs">C#</a><a href="/lang/go">Go</a><a href="/lang/py">Python</a>',
    );
    expect(sameAddressLanguages(html, "https://docs.example/", "en")).toEqual([]);
  });

  it("two-letter values alone are not enough: the family must offer the page's own language or say its own", () => {
    const html = page("en", '<a href="/lang/ts">TypeScript</a><a href="/lang/cs">C#</a>');
    expect(sameAddressLanguages(html, "https://docs.example/", "en")).toEqual([]);
  });

  it("a toggle that shows only the other language counts when the link says its language", () => {
    for (const link of [
      '<a href="/language/en">English</a>',
      '<a href="/language/en">EN</a>',
      '<a href="/language/en" hreflang="en"><img src="/flags/gb.svg" alt=""></a>',
      '<a href="/language/ru">Русский</a>',
      '<a href="/language/tr">Türkçe</a>',
    ]) {
      const want = /\/language\/(\w\w)/.exec(link)?.[1];
      expect(sameAddressLanguages(page("az", link), HOME, "az")).toEqual([want]);
    }
    // A toggle that says nothing of a language is left alone.
    expect(
      sameAddressLanguages(page("az", '<a href="/language/en">Keçid</a>'), HOME, "az"),
    ).toEqual([]);
  });

  it("only the customer's own host, the apex and www as one", () => {
    const html = page(
      "az",
      '<a href="https://medora.test/language/az">AZ</a><a href="https://medora.test/language/en">EN</a><a href="https://other.example/language/de">DE</a><a href="mailto:x@medora.test">Mail</a>',
    );
    expect(sameAddressLanguages(html, HOME, "az")).toEqual(["en"]);
  });

  it("a deeper path is a page, not a switch", () => {
    const html = page("az", '<a href="/language/az">AZ</a><a href="/blog/language/en">EN</a>');
    expect(sameAddressLanguages(html, HOME, "az")).toEqual([]);
    expect(switchLinkOf("/language/en/about", new URL(HOME))).toBeNull();
  });
});

describe("a link to this same address with the language in its query", () => {
  it("?lang=, ?locale= and ?language=", () => {
    for (const key of ["lang", "locale", "language", "LANG"]) {
      const html = page("tr", `<a href="?${key}=tr">TR</a><a href="/?${key}=en">EN</a>`);
      expect(sameAddressLanguages(html, "https://shop.example/", "tr")).toEqual(["en"]);
    }
  });

  it("on the page's own path only: a link to another page is not this page's switch", () => {
    const html = page("en", '<a href="/pricing?lang=en">EN</a><a href="/pricing?lang=de">DE</a>');
    expect(sameAddressLanguages(html, "https://shop.example/pricing", "en")).toEqual(["de"]);
    expect(sameAddressLanguages(html, "https://shop.example/", "en")).toEqual([]);
  });

  it("code tabs are not languages", () => {
    const html = page(
      "en",
      '<a href="?lang=js">JS</a><a href="?lang=ts">TS</a><a href="?lang=py">Py</a>',
    );
    expect(sameAddressLanguages(html, "https://docs.example/start", "en")).toEqual([]);
  });
});

describe("a select or a form of languages", () => {
  it("a select named for languages whose options are all tags", () => {
    for (const attr of [
      'name="locale"',
      'id="lang-select"',
      'class="form-select languageSwitcher"',
    ]) {
      const html = page(
        "ru",
        `<select ${attr}><option value="ru" selected>Русский</option><option value="az">Azərbaycan</option><option value="en">English</option></select>`,
      );
      expect(sameAddressLanguages(html, "https://shop.example/", "ru")).toEqual(["az", "en"]);
    }
  });

  it("a select whose options are the switch's own links", () => {
    const html = page(
      "az",
      '<select name="language" onchange="location=this.value"><option value="/language/az">AZ</option><option value="/language/en">EN</option></select>',
    );
    expect(sameAddressLanguages(html, HOME, "az")).toEqual(["en"]);
  });

  it("a select of something else is not one, whatever its two letters", () => {
    // US states: "de", "id" and "in" are also language codes.
    const states = page(
      "en",
      '<select name="state"><option value="de">Delaware</option><option value="id">Idaho</option><option value="in">Indiana</option></select>',
    );
    expect(sameAddressLanguages(states, "https://shop.example/", "en")).toEqual([]);
    // Named for languages, but one option is none.
    const mixed = page(
      "en",
      '<select name="lang"><option value="">Choose</option><option value="en">English</option><option value="de">Deutsch</option></select>',
    );
    expect(sameAddressLanguages(mixed, "https://shop.example/", "en")).toEqual([]);
    // A single option is no choice.
    const one = page("en", '<select name="lang"><option value="de">Deutsch</option></select>');
    expect(sameAddressLanguages(one, "https://shop.example/", "en")).toEqual([]);
  });

  it("radio buttons and buttons named lang, language or locale", () => {
    const radios = page(
      "az",
      '<form action="/setlocale" method="post"><input type="radio" name="locale" value="az" checked><input type="radio" name="locale" value="ru"></form>',
    );
    expect(sameAddressLanguages(radios, HOME, "az")).toEqual(["ru"]);
    const buttons = page(
      "az",
      '<form method="post"><button name="lang" value="az">AZ</button><button name="lang" value="en">EN</button></form>',
    );
    expect(sameAddressLanguages(buttons, HOME, "az")).toEqual(["en"]);
  });

  it("a hidden field is the page's own state, not a choice", () => {
    const html = page(
      "az",
      '<form action="/search"><input type="hidden" name="lang" value="en"><input type="hidden" name="locale" value="ru"><input name="q"></form>',
    );
    expect(sameAddressLanguages(html, HOME, "az")).toEqual([]);
  });
});

describe("what is left out", () => {
  it("a language the site already publishes at a path of its own", () => {
    const html = page(
      "az",
      '<a href="/language/az">AZ</a><a href="/language/en">EN</a><a href="/language/ru">RU</a><a href="/ru/about">Haqqımızda (RU)</a>',
    );
    const known = discoverLanguages(html, HOME).map((l) => l.lang);
    expect(known).toEqual(["az", "ru"]);
    expect(sameAddressLanguages(html, HOME, "az", known)).toEqual(["en"]);
  });

  it("the page's own language, however the page writes it", () => {
    const html = page("az-AZ", '<a href="/language/AZ">AZ</a><a href="/language/az-Latn">AZ</a>');
    expect(sameAddressLanguages(html, HOME, "az-AZ")).toEqual([]);
  });

  it("each language once, five at most, in page order", () => {
    const tags = ["en", "ru", "tr", "de", "fr", "es", "it", "en"];
    const html = page(
      "az",
      `<a href="/lang/az">AZ</a>${tags.map((t) => `<a href="/lang/${t}">${t}</a>`).join("")}`,
    );
    const found = sameAddressLanguages(html, HOME, "az");
    expect(found).toEqual(["en", "ru", "tr", "de", "fr"]);
    expect(found).toHaveLength(MAX_SAME_ADDRESS_LANGUAGES);
  });

  it("a page with no switch, an address that is none, a page that is not HTML", () => {
    expect(sameAddressLanguages(page("en", "<h1>Hello</h1>"), "https://a.example/", "en")).toEqual(
      [],
    );
    expect(sameAddressLanguages(MEDORA, "not a url", "az")).toEqual([]);
    expect(sameAddressLanguages("", HOME, "az")).toEqual([]);
  });
});
