/**
 * Manifests written before 2026-09-14 carry no inline shape. The first
 * generation run that meets such a manifest reads the live page once,
 * attaches the shapes and stores them, so no operator step is needed for
 * existing customers (docs/specs/design-preserving-rewrite.md §2).
 *
 * Since 2026-09-15 the same read also refreshes every entry's length and
 * text signature from the live page (a rebuilt site had left the stored
 * lengths stale, so the length window measured against the wrong number),
 * once per customer and path per isolate every ten minutes.
 */

import type { Manifest } from "@rawuser/shared";
import { fetchPageHtml } from "./detect-elements.ts";
import { attachInlineShapes, refreshLengths } from "./inline-shape-html.ts";
import { isOffButton } from "./lib/button-rewrite.ts";
import { OffHostRedirectError } from "./lib/public-url.ts";
import { rememberPageLinks } from "./page-links.ts";
import { validateSelectors } from "./selector-health.ts";

/** The read of one page, kept on the customer's own host. */
export type PageFetch = (url: string, opts?: { sameHostAs?: string }) => Promise<string>;

/** The page read under a user agent (install-config.ts, fetcherUserAgent). */
export function pageFetcher(userAgent: string): PageFetch {
  return (url, opts) => fetchPageHtml(url, { ...opts, userAgent });
}

/** When the live page was last read for a customer and path (per isolate). */
const readAt = new Map<string, number>();
const REREAD_MS = 10 * 60_000;

/** Tests only: forget every recent read. */
export function resetReads(): void {
  readAt.clear();
}

export function lacksShapes(manifest: Manifest): boolean {
  // A split read before templates existed (or before the nested-split rule)
  // never gained its template: read it again.
  return Object.values(manifest).some(
    (e) =>
      e.inline === undefined ||
      (e.inline.split && !e.inline.template && !e.inline.lines && !e.plain),
  );
}

/** The page's own language from `<html lang>`, primary subtag, or null. */
export function htmlLang(html: string): string | null {
  const m = /<html[^>]*\slang=["']?([a-zA-Z]{2,3})/i.exec(html);
  return m?.[1]?.toLowerCase() ?? null;
}

export async function ensureInlineShapes(
  customerId: string,
  pagePath: string,
  manifest: Manifest,
  db: D1Database,
  /** The page read, under the install's user agent (`pageFetcher`). */
  fetchHtml: PageFetch,
  language: string | null = null,
  /**
   * Called with the page just read, in the manifest's own language, when
   * `manifest_health` is written: the site map's re-read
   * (docs/specs/site-shaped-intents.md §9). Its failure is never this
   * read's failure.
   */
  onRead?: (
    pagePath: string,
    pageUrl: string,
    html: string,
    manifest: Manifest,
    lang: string | null,
  ) => Promise<void>,
): Promise<Manifest> {
  const readKey = `${customerId}|${pagePath}`;
  const last = readAt.get(readKey) ?? 0;
  // An entry with no shape at all is read now; a split still without a
  // template (a letter split has none) waits for the ten-minute re-read like
  // the rest, so it never costs a page fetch per version.
  const noShape = Object.values(manifest).some((e) => e.inline === undefined);
  if (!noShape && Date.now() - last < REREAD_MS) return manifest;
  try {
    const row = await db
      .prepare("SELECT domain FROM customers WHERE id = ?")
      .bind(customerId)
      .first<{ domain?: unknown }>();
    const domain = row?.domain;
    if (typeof domain !== "string" || !domain.includes(".")) return manifest;
    const pageUrl = `https://${domain}${pagePath === "/" ? "/" : pagePath}`;
    // Only the customer's own host (privacy review condition 4, and the /bot
    // page): a redirect to another host ends the read with
    // OffHostRedirectError and the manifest stays as it is. There is no
    // second read without the rule.
    const html = await fetchHtml(pageUrl, { sameHostAs: domain });
    readAt.set(readKey, Date.now());
    let attached = lacksShapes(manifest) ? attachInlineShapes(html, manifest) : manifest;
    // A site that redirects by country (a pilot site sends Azerbaijani visitors to /az) can hand
    // the worker another language's page. The shape is the same across
    // languages on such a site; the phrase is not, so it is dropped then.
    const pageLang = htmlLang(html);
    const want = language?.split("-")[0]?.toLowerCase() ?? null;
    if (want && pageLang && pageLang !== want) {
      attached = Object.fromEntries(
        Object.entries(attached).map(([path, e]) => {
          if (!e.inline?.emphasis_phrase) return [path, e];
          const { emphasis_phrase: _dropped, ...inline } = e.inline;
          return [path, { ...e, inline }];
        }),
      );
    }
    const gained = Object.entries(attached).some(
      ([path, e]) =>
        (e.inline !== undefined && manifest[path]?.inline === undefined) ||
        (e.inline?.template !== undefined && manifest[path]?.inline?.template === undefined),
    );
    // Lengths only from the page in the manifest's own language: another
    // language's text has another length.
    let refreshed: string[] = [];
    if (!want || !pageLang || pageLang === want) {
      // Where each button goes, for the lint's action check (page-links.ts).
      rememberPageLinks(customerId, pagePath, html, attached);
      const r = refreshLengths(html, attached);
      attached = r.manifest;
      refreshed = r.changed;
      // Which parts the page no longer has (a rebuilt site drops a section,
      // a class is renamed): recorded for the Pages card and the heartbeat,
      // never fatal here. The snippet skips such a section on its own.
      const health = validateSelectors(html, attached);
      // A button that stays as built (lib/button-rewrite.ts) is not a part
      // Rawuser writes: the page losing it is nothing to report here. A
      // counted button is found by its own selectors, checked elsewhere.
      const missing = Object.entries(health)
        .filter(([, checks]) => !checks.some((c) => c.status === "ok"))
        .map(([path]) => path)
        .filter((path) => !isOffButton(path, attached[path]));
      await db
        .prepare(
          "INSERT INTO manifest_health (customer_id, page_path, checked_at, missing) VALUES (?, ?, ?, ?) ON CONFLICT(customer_id, page_path) DO UPDATE SET checked_at = excluded.checked_at, missing = excluded.missing",
        )
        .bind(customerId, pagePath, Date.now(), JSON.stringify(missing))
        .run();
      if (onRead) {
        try {
          await onRead(pagePath, pageUrl, html, attached, pageLang ?? want);
        } catch {
          // The site map's own failure; the manifest read goes on.
        }
      }
    }
    if (!gained && refreshed.length === 0) return manifest;
    if (refreshed.length > 0) {
      console.log(
        `[manifest] ${customerId} ${pagePath}: lengths refreshed from the live page for ${refreshed.join(", ")}`,
      );
    }
    await db
      .prepare("UPDATE element_manifests SET manifest = ? WHERE customer_id = ? AND page_path = ?")
      .bind(JSON.stringify(attached), customerId, pagePath)
      .run();
    return attached;
  } catch (e) {
    if (e instanceof OffHostRedirectError) {
      console.error(`[manifest] ${customerId} ${pagePath}: redirect to another host, not followed`);
    }
    return manifest;
  }
}
