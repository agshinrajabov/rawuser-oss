import { describe, expect, it } from "vitest";
import { discoverLanguages } from "../src/site-languages.ts";

describe("discoverLanguages", () => {
  it("reads hreflang alternates with the page's own language first", () => {
    const html = `<html lang="en"><head>
      <link rel="alternate" hrefLang="en" href="https://lumera.test/"/>
      <link rel="alternate" hrefLang="az" href="https://lumera.test/az"/>
      <link rel="alternate" hrefLang="x-default" href="https://lumera.test/"/>
      <link rel="alternate" href="https://lumera.test/rss.xml"/>
    </head><body></body></html>`;
    expect(discoverLanguages(html, "https://lumera.test/")).toEqual([
      { lang: "en", path: "/", source: "html-lang" },
      { lang: "az", path: "/az", source: "hreflang" },
    ]);
  });

  it("falls back to language-prefixed navigation links and ignores other hosts", () => {
    const html = `<html lang="ru"><body>
      <a href="/en/">EN</a><a href="/tr/about">TR</a><a href="/go/pricing">go</a>
      <a href="https://other.example/az/">x</a><a href="/ru/">RU</a>
    </body></html>`;
    expect(discoverLanguages(html, "https://site.example/ru/")).toEqual([
      { lang: "ru", path: "/ru", source: "html-lang" },
      { lang: "en", path: "/en", source: "nav" },
      { lang: "tr", path: "/tr", source: "nav" },
    ]);
  });

  it("returns a single language for a monolingual page", () => {
    expect(
      discoverLanguages(
        `<html lang="de-DE"><body><a href="/preise">Preise</a></body></html>`,
        "https://x.de/",
      ),
    ).toEqual([{ lang: "de", path: "/", source: "html-lang" }]);
  });
});
