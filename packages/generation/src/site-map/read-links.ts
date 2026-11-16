/**
 * Reads a page's own links for the site map (docs/specs/site-shaped-intents.md
 * §4.2, §4.3): `<a href>` inside `nav`, `header`, `footer`,
 * `[role=navigation]`, the hero (the container of the manifest's `hero.*`
 * parts) and the manifest's buttons; never links inside article text.
 * Same host only (`www.` folded), the path only (a fragment-only link is
 * dropped; a menu link to the page itself is kept), the text cut to 40
 * characters. Every link passes the screens before it is returned: a
 * dropped link is never stored and never sent to a model (privacy review
 * conditions 1 and 3). Offline only, on HTML already in hand.
 */

import {
  type Manifest,
  SITE_LINKS_PER_PAGE,
  SITE_PATH_MAX,
  cleanLinkText,
  normalizePath,
  screenLink,
} from "@rawuser/shared";
import { type HTMLElement, parse } from "node-html-parser";
import { isButtonLabelPath } from "../lint/cta-action.ts";

/** One kept link: the normalized path, its screened text, the page's language. */
export interface ReadLink {
  path: string;
  text: string;
  lang: string | null;
}

export interface LinkRead {
  links: ReadLink[];
  /**
   * The whole page was read (its `</body>` is there): only then may a link
   * that is not on it be marked missing. A server read cut at the size cap
   * can lose the footer.
   */
  complete: boolean;
  /** How many links each screen dropped, for tests; never logged with paths. */
  dropped: number;
}

const CONTAINERS = "nav, header, footer, [role=navigation]";

function hostKey(h: string): string {
  return h.toLowerCase().replace(/^www\./, "");
}

function firstMatch(
  root: HTMLElement,
  selectors: readonly string[] | undefined,
): HTMLElement | null {
  for (const sel of selectors ?? []) {
    try {
      const el = root.querySelector(sel);
      if (el) return el;
    } catch {
      // A selector this parser cannot read is skipped.
    }
  }
  return null;
}

function ancestors(el: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = [];
  let cur: HTMLElement | null = el;
  while (cur) {
    out.push(cur);
    cur = cur.parentNode as HTMLElement | null;
  }
  return out;
}

/** The smallest element holding every hero part, unless that is the whole body. */
function heroContainer(root: HTMLElement, manifest: Manifest | null): HTMLElement | null {
  const parts = Object.entries(manifest ?? {})
    .filter(([path]) => path.startsWith("hero."))
    .map(([, e]) => firstMatch(root, e.css))
    .filter((el): el is HTMLElement => el !== null);
  const head = parts[0];
  if (!head) return null;
  const others = parts.slice(1).map((p) => new Set(ancestors(p)));
  const lca = ancestors(head).find((a) => others.every((set) => set.has(a))) ?? null;
  const tag = lca?.tagName?.toLowerCase();
  if (!lca || !tag || tag === "body" || tag === "html") return null;
  return lca;
}

function anchorsIn(el: HTMLElement): HTMLElement[] {
  const own = el.tagName?.toLowerCase() === "a" && el.getAttribute("href") ? [el] : [];
  return [...own, ...el.querySelectorAll("a[href]")];
}

/**
 * The page's own links, screened. `pageUrl` is the page that was read; its
 * host is the only host kept.
 */
export function readSiteLinks(
  html: string,
  pageUrl: string,
  manifest: Manifest | null,
  lang: string | null,
): LinkRead {
  let root: HTMLElement;
  let base: URL;
  try {
    root = parse(html);
    base = new URL(pageUrl);
  } catch {
    return { links: [], complete: false, dropped: 0 };
  }
  const anchors: HTMLElement[] = [];
  const seenNodes = new Set<HTMLElement>();
  const push = (a: HTMLElement) => {
    if (seenNodes.has(a)) return;
    seenNodes.add(a);
    anchors.push(a);
  };
  try {
    for (const c of root.querySelectorAll(CONTAINERS)) for (const a of anchorsIn(c)) push(a);
  } catch {
    // An unreadable document gives what was found so far.
  }
  const hero = heroContainer(root, manifest);
  if (hero) for (const a of anchorsIn(hero)) push(a);
  for (const [path, entry] of Object.entries(manifest ?? {})) {
    if (!isButtonLabelPath(path)) continue;
    const el = firstMatch(root, entry.css);
    const a = el ? (el.tagName?.toLowerCase() === "a" ? el : el.closest("a")) : null;
    if (a?.getAttribute("href")) push(a);
  }

  const out: ReadLink[] = [];
  const kept = new Map<string, ReadLink>();
  let dropped = 0;
  for (const a of anchors) {
    const href = a.getAttribute("href")?.trim() ?? "";
    // A fragment-only link (#how) is this page, never an entry. A menu link
    // to the page itself is kept: it names the page's own kind.
    if (href === "" || href.startsWith("#")) continue;
    let u: URL;
    try {
      u = new URL(href, base);
    } catch {
      continue;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") continue;
    if (hostKey(u.hostname) !== hostKey(base.hostname)) continue;
    const text = cleanLinkText(a.text) || cleanLinkText(a.getAttribute("aria-label"));
    // The screens run on the path as written, before lower-casing.
    if (screenLink(u.pathname, text) !== null) {
      dropped++;
      continue;
    }
    const path = normalizePath(u.pathname);
    if (path.length > SITE_PATH_MAX) continue;
    const earlier = kept.get(path);
    if (earlier) {
      // A logo or icon link first, the menu's words later: keep the words.
      if (earlier.text === "" && text !== "") earlier.text = text;
      continue;
    }
    const link = { path, text, lang };
    kept.set(path, link);
    out.push(link);
    if (out.length >= SITE_LINKS_PER_PAGE) break;
  }
  return { links: out, complete: /<\/body\s*>/i.test(html), dropped };
}
