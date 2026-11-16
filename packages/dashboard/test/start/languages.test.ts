/**
 * The Look screen's language row (mock design/mock/sales-readiness/
 * pilot-gaps.html, screen 03, states A10 to A13, approved 2026-10-12;
 * docs/specs/per-language.md section 6). A language on the same address is
 * named in one sentence and never counted, ticked or written; a language on
 * its own address keeps its tick. Also: every reader of `languages` when an
 * entry has `path: null`, and a worker that sends no `same_address`.
 */
import { readFileSync } from "node:fs";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LanguageRow } from "../../src/components/start/LanguageRow";
import { tickedPaths } from "../../src/lib/golive";
import {
  isSameAddress,
  languageName,
  sameAddressLangs,
  sameAddressLine,
  sameAddressWhy,
  withPage,
} from "../../src/lib/languages";
import type { LanguagePage, SameAddressLanguage, StoredLanguage } from "../../src/types/api";

function paged(
  lang: string,
  path: string,
  status: LanguagePage["status"] = "primary",
  enabled = true,
): LanguagePage {
  return { lang, path, source: "html-lang", status, parts: 8, brief_drafted: true, enabled };
}

function same(lang: string): SameAddressLanguage {
  return {
    lang,
    path: null,
    source: "switch",
    status: "same_address",
    parts: 0,
    brief_drafted: false,
    enabled: false,
  };
}

const AZ = paged("az", "/");
const EN_PAGE = paged("en", "/en", "ready");
const EN_SAME = same("en");

const LINE =
  "Your site also has English on the same address. Versions are written for Azerbaijani only.";
const WHY =
  "Switching to English on your site keeps the same address. Rawuser writes one language per address, so English visitors see your page as you built it. Writing both is planned.";

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function row(over: Partial<Parameters<typeof LanguageRow>[0]> = {}): {
  html: string;
  text: string;
} {
  const html = renderToStaticMarkup(
    h(LanguageRow, {
      languages: [AZ],
      sameAddress: [],
      language: "az",
      languageSource: "html-lang",
      enabled: new Set<string>(["az"]),
      onToggle: () => undefined,
      onLanguage: () => undefined,
      ...over,
    }),
  );
  return { html, text: text(html) };
}

describe("an entry without a page is never a language to count, tick or write", () => {
  it("withPage drops path: null and status same_address", () => {
    expect(withPage([AZ, EN_SAME])).toEqual([AZ]);
    expect(withPage([AZ, EN_PAGE, same("ru")])).toEqual([AZ, EN_PAGE]);
    expect(withPage(undefined)).toEqual([]);
    expect(withPage(null)).toEqual([]);
  });

  it("an entry is without a page by either mark, whatever else it says", () => {
    expect(isSameAddress(EN_SAME)).toBe(true);
    // A row written by hand, or by a later worker: one mark is enough.
    expect(isSameAddress({ ...EN_SAME, status: "ready" } as unknown as StoredLanguage)).toBe(true);
    expect(isSameAddress({ ...EN_PAGE, status: "same_address" } as unknown as StoredLanguage)).toBe(
      true,
    );
    expect(isSameAddress(EN_PAGE)).toBe(false);
  });

  it("tickedPaths never returns it, even when something ticked it", () => {
    const enabled = new Set(["az", "en", "ru"]);
    expect(tickedPaths([AZ, EN_SAME], enabled, "/")).toEqual([]);
    expect(
      tickedPaths(
        [AZ, EN_PAGE, { ...same("ru"), enabled: true } as unknown as StoredLanguage],
        enabled,
        "/",
      ),
    ).toEqual(["/en"]);
  });

  it("the Live screen and Look read the customers row through withPage", () => {
    const src = readFileSync(
      new URL("../../src/components/start/FirstRun.tsx", import.meta.url),
      "utf8",
    );
    expect(src).toContain("withPage(customer.languages)");
    expect(src).not.toMatch(/\(customer\.languages \?\? \[\]\)/);
    expect(src).not.toMatch(/\(result\.languages \?\? \[\]\)/);
  });
});

describe("sameAddressLangs: where the dashboard learns of it", () => {
  it("reads the quickstart's same_address", () => {
    expect(sameAddressLangs({ languages: [AZ], same_address: [EN_SAME] })).toEqual(["en"]);
  });

  it("reads an entry that sits in languages itself (the customers row)", () => {
    expect(sameAddressLangs({ languages: [AZ, EN_SAME, same("ru")] })).toEqual(["en", "ru"]);
  });

  it("names each once, and never a language that has a page", () => {
    expect(
      sameAddressLangs({ languages: [AZ, EN_PAGE, EN_SAME], same_address: [EN_SAME, same("ru")] }),
    ).toEqual(["ru"]);
    expect(sameAddressLangs({ languages: [AZ, EN_SAME], same_address: [EN_SAME] })).toEqual(["en"]);
  });

  it("an older worker sends no field: nothing to say", () => {
    expect(sameAddressLangs({ languages: [AZ] })).toEqual([]);
    expect(sameAddressLangs({})).toEqual([]);
    expect(sameAddressLangs({ languages: undefined, same_address: null })).toEqual([]);
  });
});

describe("the words", () => {
  it("the mock's sentence and its Why, word for word", () => {
    expect(sameAddressLine(["en"], ["az"])).toBe(LINE);
    expect(sameAddressWhy(["en"])).toBe(WHY);
  });

  it("two languages on the same address", () => {
    expect(sameAddressLine(["en", "ru"], ["az"])).toBe(
      "Your site also has English and Russian on the same address. Versions are written for Azerbaijani only.",
    );
    expect(sameAddressWhy(["en", "ru"])).toBe(
      "Switching to English or Russian on your site keeps the same address. Rawuser writes one language per address, so English and Russian visitors see your page as you built it. Writing them all is planned.",
    );
  });

  it("several written languages are all named", () => {
    expect(sameAddressLine(["de"], ["az", "en"])).toBe(
      "Your site also has German on the same address. Versions are written for Azerbaijani and English only.",
    );
  });

  it("nothing on the same address: no line", () => {
    expect(sameAddressLine([], ["az"])).toBeNull();
  });

  it("names a language outside the short list, and keeps a tag it cannot name", () => {
    expect(languageName("en-GB")).toBe("English");
    expect(languageName("ka")).toBe("Georgian");
    expect(languageName("zz")).toBe("zz");
  });
});

describe("LanguageRow: the states of the row", () => {
  it("A10, same address, closed: one sentence, Why, Change, and nothing to tick", () => {
    const r = row({ sameAddress: ["en"] });
    expect(r.text).toBe(
      `Language Azerbaijani, as the page declares. ${LINE} Why Hide ${WHY} Change`,
    );
    expect(r.html).not.toContain('type="checkbox"');
    expect(r.html).toContain("<details");
    expect(r.html).not.toMatch(/<details[^>]* open/);
    // One language, as far as the count goes.
    expect(r.text).not.toMatch(/Your site is in/);
  });

  it("A12, Why open", () => {
    const r = row({ sameAddress: ["en"], defaultWhy: true });
    expect(r.html).toMatch(/<details[^>]* open=""/);
    expect(r.text).toContain(WHY);
  });

  it("A11, two addresses: a tick per language, no sentence, as it ships today", () => {
    const r = row({ languages: [AZ, EN_PAGE], enabled: new Set(["az", "en"]) });
    expect(r.text).toContain("Your site is in 2 languages");
    expect(r.text).toContain("Azerbaijani / this page");
    expect(r.text).toContain("English /en 8 parts found, brief drafted");
    expect(r.html.match(/type="checkbox"/g)).toHaveLength(2);
    expect(r.html).not.toContain("<details");
    expect(r.text).not.toContain("Change");
  });

  it("the customers row shape (the entry inside languages): still one language, no tick for it", () => {
    const r = row({
      languages: [AZ, EN_SAME],
      sameAddress: sameAddressLangs({ languages: [AZ, EN_SAME] }),
    });
    expect(r.text).toContain("Language Azerbaijani, as the page declares.");
    expect(r.text).toContain(LINE);
    expect(r.html).not.toContain('type="checkbox"');
    expect(r.text).not.toMatch(/2 languages/);
  });

  it("two addresses and a third language on the same one: 2 counted, 2 ticks, one sentence", () => {
    const r = row({
      languages: [AZ, EN_PAGE, same("ru")],
      sameAddress: ["ru"],
      enabled: new Set(["az", "en"]),
    });
    expect(r.text).toContain("Your site is in 2 languages");
    expect(r.html.match(/type="checkbox"/g)).toHaveLength(2);
    expect(r.text).toContain(
      "Your site also has Russian on the same address. Versions are written for Azerbaijani and English only.",
    );
  });

  it("an unticked language is not named as written", () => {
    const r = row({
      languages: [AZ, EN_PAGE],
      sameAddress: ["ru"],
      enabled: new Set(["az"]),
    });
    expect(r.text).toContain("Versions are written for Azerbaijani only.");
  });

  it("an older worker (no same_address): the row as it shipped, with Change", () => {
    const r = row();
    expect(r.text).toBe("Language Azerbaijani, as the page declares. Change");
    expect(r.html).not.toContain("<details");
  });

  it("a guessed language keeps its amber tick and words", () => {
    const r = row({ languageSource: "fallback", sameAddress: ["en"] });
    expect(r.text).toContain("Azerbaijani, a guess, please check.");
    expect(r.html).toContain("state-warn");
  });

  it("the sentence is quiet text, never amber, and carries no dash", () => {
    const r = row({ sameAddress: ["en"], defaultWhy: true });
    expect(r.html).not.toContain("state-warn");
    expect(r.text).not.toMatch(/[\u2013\u2014]/);
  });
});
