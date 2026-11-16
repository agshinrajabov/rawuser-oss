/**
 * Site language discovery (docs/specs/per-language.md).
 *
 * From one captured page, which languages does this site publish, and at
 * which paths? Read in this order of trust:
 *   1. `<link rel="alternate" hreflang="…" href="…">`: the site's own
 *      declaration; same host only; x-default ignored.
 *   2. `<html lang>` for the page itself, at its own path.
 *   3. Internal links whose path starts with a language code (`/az/…`,
 *      `/ru`) or a language subdomain (`az.example.com`).
 * Deduped by primary language subtag, the page's own language first, at
 * most eight. Nothing about a visitor is involved; this reads the
 * operator's own HTML.
 */

export interface SiteLanguage {
  /** Primary subtag, lower case: "az", "en", "ru". */
  lang: string;
  /** Normalised path of that language's home page ("/" or "/az"). */
  path: string;
  source: "hreflang" | "html-lang" | "nav";
}

const MAX_LANGUAGES = 8;
const LANG_TAG = /^[a-z]{2,3}(?:[-_][a-z0-9]{2,8})*$/i;

function primary(tag: string): string | null {
  const t = tag.trim().toLowerCase();
  if (!LANG_TAG.test(t)) return null;
  const p = t.split(/[-_]/)[0] ?? "";
  return /^[a-z]{2,3}$/.test(p) ? p : null;
}

function normPath(pathname: string): string {
  const p = pathname.replace(/\/+$/, "").toLowerCase();
  return p === "" ? "/" : p;
}

function sameHost(href: string, base: URL): URL | null {
  try {
    const u = new URL(href, base);
    const strip = (h: string) => h.replace(/^www\./, "");
    return strip(u.hostname) === strip(base.hostname) ? u : null;
  } catch {
    return null;
  }
}

/** Language-looking first path segment, e.g. "/az/about" → "az". */
export function langPrefix(pathname: string): string | null {
  const m = /^\/([a-z]{2}(?:-[a-z]{2})?)(?:\/|$)/i.exec(pathname);
  const p = m?.[1] ? primary(m[1]) : null;
  // Two-letter words that are not languages but common path roots.
  if (!p || /^(go|my|us|id|to|me|vs|ai|ux|ui|it|do|no|on|in|at|by|of|or|up)$/.test(p)) return null;
  return p;
}

export function discoverLanguages(html: string, pageUrl: string): SiteLanguage[] {
  let base: URL;
  try {
    base = new URL(pageUrl);
  } catch {
    return [];
  }
  const found: SiteLanguage[] = [];
  const push = (lang: string | null, path: string, source: SiteLanguage["source"]) => {
    if (!lang) return;
    if (found.some((f) => f.lang === lang)) return;
    found.push({ lang, path: normPath(path), source });
  };

  // 2 first for ordering: the page's own language leads the list.
  const htmlLang = /<html\b[^>]*\blang\s*=\s*["']?([A-Za-z0-9-_]+)/i.exec(html)?.[1];
  const own = htmlLang ? primary(htmlLang) : null;
  const ownPath = normPath(base.pathname);

  // 1. hreflang alternates.
  const hreflangs: Array<{ lang: string; path: string }> = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/\brel\s*=\s*["']?alternate\b/i.test(tag)) continue;
    const hl = /\bhreflang\s*=\s*["']?([A-Za-z0-9-_]+)/i.exec(tag)?.[1];
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (!hl || !href || hl.toLowerCase() === "x-default") continue;
    const u = sameHost(href, base);
    const lang = primary(hl);
    if (u && lang) hreflangs.push({ lang, path: normPath(u.pathname) });
  }
  const ownFromHreflang = hreflangs.find((h) => h.path === ownPath);
  if (own) push(own, ownPath, "html-lang");
  else if (ownFromHreflang) push(ownFromHreflang.lang, ownPath, "hreflang");
  for (const h of hreflangs) push(h.lang, h.path, "hreflang");

  // 3. Internal links with a language prefix or subdomain.
  for (const m of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"'#?]+)[^"']*["']/gi)) {
    const u = sameHost(m[1] ?? "", base);
    if (!u) continue;
    const prefix = langPrefix(u.pathname);
    if (prefix) {
      push(prefix, `/${prefix}`, "nav");
      continue;
    }
    const sub = /^([a-z]{2})\./i.exec(u.hostname)?.[1];
    if (sub && u.hostname !== base.hostname) push(primary(sub), "/", "nav");
  }

  return found.slice(0, MAX_LANGUAGES);
}
