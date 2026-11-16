/**
 * Where each button of a page goes, read from the live page when the
 * generation run reads it anyway (inline-shape-backfill.ts) and kept in this
 * isolate only: the lint uses it to tell what a button does ("/signup/" is a
 * start, "/pricing/" is pricing) when its words alone do not. Never stored,
 * never sent to a visitor; a page that cannot be read leaves the words to
 * decide.
 */

import type { Manifest } from "@rawuser/shared";
import { type HTMLElement, parse } from "node-html-parser";
import { isButtonLabelPath } from "./lint/cta-action.ts";

/** Label path → the href of its link, per customer and page (this isolate). */
const links = new Map<string, Map<string, string>>();

/** Tests only: forget every page's links. */
export function resetPageLinks(): void {
  links.clear();
}

/** The href of each button label in the manifest that the page shows as a link. */
export function readButtonHrefs(html: string, manifest: Manifest): Map<string, string> {
  const out = new Map<string, string>();
  let root: ReturnType<typeof parse>;
  try {
    root = parse(html);
  } catch {
    return out;
  }
  for (const [path, entry] of Object.entries(manifest)) {
    if (!isButtonLabelPath(path)) continue;
    for (const sel of entry.css ?? []) {
      let el: HTMLElement | null = null;
      try {
        el = root.querySelector(sel);
      } catch {
        continue;
      }
      if (!el) continue;
      const a = el.tagName === "A" ? el : el.closest("a");
      // The query is dropped before anything is kept (privacy review,
      // 2026-10-12): the page may be the operator's own signed-in render, and
      // only the host, the path and the hash are ever read.
      const href = a
        ?.getAttribute("href")
        ?.trim()
        .replace(/\?[^#]*/, "");
      if (href) out.set(path, href);
      break;
    }
  }
  return out;
}

export function rememberPageLinks(
  customerId: string,
  pagePath: string,
  html: string,
  manifest: Manifest,
): void {
  links.set(`${customerId}|${pagePath}`, readButtonHrefs(html, manifest));
}

/** The hrefs last read for a page in this isolate; empty when it was not read. */
export function pageLinksOf(customerId: string, pagePath: string): ReadonlyMap<string, string> {
  return links.get(`${customerId}|${pagePath}`) ?? new Map();
}
