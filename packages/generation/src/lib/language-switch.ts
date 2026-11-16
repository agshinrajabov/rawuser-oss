/**
 * A language on the same address (docs/specs/per-language.md, "A language
 * on the same address"; docs/specs/pilot-gaps.md I1).
 *
 * the pilot's language switch is `<a href="https://www.medora.test/language/en">
 * English </a>`: it sets the site's session and sends the visitor back to
 * the same path, where `/` then answers `<html lang="en">`. No hreflang, no
 * `/en/` path, so the discovery (`@rawuser/shared` site-languages.ts: one
 * language per path) found one language and said nothing of the other.
 *
 * This reads the operator's own captured page for such a switch and returns
 * the languages it offers. Nothing is fetched, nothing is written for them:
 * the quickstart only records that they exist, so the Look screen can say
 * "Your site also has English on the same address. Versions are written for
 * Azerbaijani only." Only the language tags are kept; the link, its text and
 * its path are not.
 *
 * Three shapes, each conservative:
 *   1. own-host links whose whole path is a switch word and a language tag
 *      (`/language/en`, `/lang/ru`, `/locale/tr`, `/setlocale/en`,
 *      `/change-language/en`);
 *   2. own-host links to this same address whose query names a language
 *      (`?lang=en`, `?locale=en`, `?language=en`);
 *   3. a `<select>` named for languages whose options are all language tags
 *      (or links of the two shapes above), and radio buttons or buttons
 *      named `lang`, `language` or `locale` whose values all are.
 * A tag counts only when its primary subtag is an ISO 639-1 code, it is not
 * the page's own language, and the site does not already publish it at a
 * path of its own. `/language/learning` is not a language.
 *
 * Two-letter codes are also other things (`/lang/ts` and `/lang/cs` on a
 * site about programming), so links are read as a family (the same switch
 * word, or the same query name): one value in it that is no language tag
 * and the family is not a switch; and a family counts only when it also
 * offers the page's own language, as a real switch nearly always does, or
 * when the link itself says its language (its text is the code or the
 * language's name, or it carries `hreflang` or `lang`).
 */

import { parse } from "node-html-parser";

/** ISO 639-1, the two-letter codes. A closed list: "go", "js", "py" and "learning" are not in it. */
const ISO_639_1: ReadonlySet<string> = new Set(
  (
    "aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch co cr cs cu cv cy " +
    "da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu " +
    "hy hz ia id ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb " +
    "lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ny oc oj om " +
    "or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su sv sw " +
    "ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu"
  ).split(" "),
);

/** Path words that set a language, compared without "-" and "_". */
const SWITCH_WORDS: ReadonlySet<string> = new Set([
  "language",
  "languages",
  "lang",
  "langs",
  "locale",
  "locales",
  "setlocale",
  "setlang",
  "setlanguage",
  "changelanguage",
  "changelang",
  "changelocale",
  "switchlanguage",
  "switchlang",
  "switchlocale",
]);

/** Query and form field names that carry a language. */
const LANGUAGE_FIELDS: ReadonlySet<string> = new Set(["lang", "language", "locale"]);

/** At most this many same-address languages are recorded. */
export const MAX_SAME_ADDRESS_LANGUAGES = 5;

/** The primary subtag of a real language tag ("en", "en-US", "pt_BR", "zh-Hans"), else null. */
export function languageOfTag(raw: string | null | undefined): string | null {
  const tag = (raw ?? "").trim().toLowerCase();
  if (!/^[a-z]{2}(?:[-_][a-z0-9]{2,8}){0,2}$/.test(tag)) return null;
  const primary = tag.slice(0, 2);
  return ISO_639_1.has(primary) ? primary : null;
}

function normPath(pathname: string): string {
  const p = pathname.replace(/\/+$/, "").toLowerCase();
  return p === "" ? "/" : p;
}

function sameHost(href: string, base: URL): URL | null {
  try {
    const u = new URL(href, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const strip = (h: string) => h.replace(/^www\./, "").toLowerCase();
    return strip(u.hostname) === strip(base.hostname) ? u : null;
  } catch {
    return null;
  }
}

/** A link that looks like a language switch: its family and the value it carries. */
interface SwitchLink {
  /** `path:language` or `query:lang`: links of one family are one switch. */
  family: string;
  /** The language the value names, null when it is no language tag. */
  lang: string | null;
}

/** The switch a link is part of, when it has one of the two link shapes. */
export function switchLinkOf(href: string | null | undefined, base: URL): SwitchLink | null {
  const raw = href?.trim();
  if (!raw || raw.startsWith("#")) return null;
  const u = sameHost(raw, base);
  if (!u) return null;
  // 1. The whole path is a switch word and a value.
  const segments = u.pathname.split("/").filter(Boolean);
  if (segments.length === 2) {
    const word = (segments[0] as string).toLowerCase().replace(/[-_]/g, "");
    if (SWITCH_WORDS.has(word)) {
      return { family: `path:${word}`, lang: languageOfTag(decodeSafe(segments[1] as string)) };
    }
  }
  // 2. This same address, with the language in the query.
  if (normPath(u.pathname) !== normPath(base.pathname)) return null;
  for (const [key, value] of u.searchParams) {
    const name = key.toLowerCase();
    if (LANGUAGE_FIELDS.has(name)) return { family: `query:${name}`, lang: languageOfTag(value) };
  }
  return null;
}

/**
 * What a switch link calls its language, for the languages we meet most:
 * the English name and the language's own. Lower case.
 */
const LANGUAGE_NAMES: Readonly<Record<string, readonly string[]>> = {
  en: ["english"],
  az: ["azerbaijani", "azərbaycan", "azərbaycanca", "azərbaycan dili"],
  ru: ["russian", "русский"],
  tr: ["turkish", "türkçe"],
  de: ["german", "deutsch"],
  fr: ["french", "français"],
  es: ["spanish", "español"],
  it: ["italian", "italiano"],
  pt: ["portuguese", "português"],
  nl: ["dutch", "nederlands"],
  pl: ["polish", "polski"],
  uk: ["ukrainian", "українська"],
  ka: ["georgian", "ქართული"],
  kk: ["kazakh", "қазақша"],
  uz: ["uzbek", "o'zbek", "oʻzbek", "o‘zbek"],
  ar: ["arabic", "العربية"],
  fa: ["persian", "فارسی"],
  zh: ["chinese", "中文"],
  ja: ["japanese", "日本語"],
  ko: ["korean", "한국어"],
};

/** True when the link itself says it leads to `lang`: its text, or its `hreflang` or `lang`. */
function saysItsLanguage(
  lang: string,
  text: string,
  attrs: ReadonlyArray<string | undefined>,
): boolean {
  if (attrs.some((a) => languageOfTag(a) === lang)) return true;
  const t = text.replace(/\s+/g, " ").trim().toLowerCase();
  if (t === "") return false;
  if (languageOfTag(t) === lang) return true;
  return (LANGUAGE_NAMES[lang] ?? []).some((name) => t === name || t.startsWith(`${name} `));
}

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** True when a name, id or class says the field is about languages ("lang", "locale-select", "languageSwitcher"). */
function namesLanguage(...attrs: Array<string | undefined>): boolean {
  const words = attrs
    .filter((a): a is string => typeof a === "string")
    .join(" ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
  return words.some((w) => /^(?:lang|langs|language|languages|locale|locales)$/.test(w));
}

/**
 * The languages the page's switch offers on this same address, in page
 * order: not `own` (the page's language), not any of `known` (languages the
 * site publishes at a path of their own), each once, five at most.
 */
export function sameAddressLanguages(
  html: string,
  pageUrl: string,
  own: string | null,
  known: readonly string[] = [],
): string[] {
  let base: URL;
  try {
    base = new URL(pageUrl);
  } catch {
    return [];
  }
  let root: ReturnType<typeof parse>;
  try {
    root = parse(html);
  } catch {
    return [];
  }
  const skip = new Set(
    [own, ...known]
      .filter((l): l is string => typeof l === "string")
      .map((l) => languageOfTag(l) ?? l.trim().toLowerCase()),
  );
  const out: string[] = [];
  const add = (lang: string | null) => {
    if (lang && !skip.has(lang) && !out.includes(lang)) out.push(lang);
  };

  const ownLang = own ? (languageOfTag(own) ?? own.trim().toLowerCase()) : null;

  // Links, read family by family.
  const families = new Map<string, Array<{ lang: string | null; says: boolean }>>();
  for (const a of root.querySelectorAll("a")) {
    const link = switchLinkOf(a.getAttribute("href"), base);
    if (!link) continue;
    const list = families.get(link.family) ?? [];
    list.push({
      lang: link.lang,
      says:
        link.lang !== null &&
        saysItsLanguage(link.lang, a.text, [a.getAttribute("hreflang"), a.getAttribute("lang")]),
    });
    families.set(link.family, list);
  }
  for (const links of families.values()) {
    // One value that is no language and the family is something else.
    if (links.some((l) => l.lang === null)) continue;
    const offersOwn = ownLang !== null && links.some((l) => l.lang === ownLang);
    for (const l of links) if (offersOwn || l.says) add(l.lang);
  }

  // A select named for languages whose every option is a language.
  for (const select of root.querySelectorAll("select")) {
    if (
      !namesLanguage(
        select.getAttribute("name"),
        select.getAttribute("id"),
        select.getAttribute("class"),
        select.getAttribute("aria-label"),
      )
    ) {
      continue;
    }
    const langs = select.querySelectorAll("option").map((o) => {
      const value = (o.getAttribute("value") ?? o.text ?? "").trim();
      return languageOfTag(value) ?? switchLinkOf(value, base)?.lang ?? null;
    });
    if (langs.length < 2 || langs.some((l) => l === null)) continue;
    for (const l of langs) add(l);
  }

  // Radio buttons and buttons that post a language by name; all of them
  // must carry a language, as with the links.
  const posted: Array<string | null> = [];
  for (const el of [...root.querySelectorAll("input"), ...root.querySelectorAll("button")]) {
    const name = (el.getAttribute("name") ?? "").toLowerCase();
    if (!LANGUAGE_FIELDS.has(name)) continue;
    const type = (el.getAttribute("type") ?? "").toLowerCase();
    // A hidden field carries the page's own state, not a choice.
    if (el.tagName === "INPUT" && type !== "radio" && type !== "submit") continue;
    posted.push(languageOfTag(el.getAttribute("value")));
  }
  if (posted.length >= 2 && posted.every((l) => l !== null)) for (const l of posted) add(l);

  return out.slice(0, MAX_SAME_ADDRESS_LANGUAGES);
}
