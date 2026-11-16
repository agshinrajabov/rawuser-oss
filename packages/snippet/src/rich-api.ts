/**
 * The core's door to the rich writers (2026-09-30). The template writer and
 * the lines writer live in `/rich.js` (rich.ts), loaded only on the pages
 * that need them, which register themselves on `globalThis.__rwx`. The core
 * calls them only through here. Without them a template or post-split lines
 * part is left as the page built it, exactly as a version that does not fit
 * the page's structure is today; nothing here throws.
 */

export interface RichWriters {
  writeTemplate: (el: Element, template: string) => boolean;
  rotationHeights: (el: Element, measure: (el: Element) => number) => number[];
  reserveRotationHeight: (el: Element, measure: (el: Element) => number) => void;
  keepRotationReserved: (el: Element, measure: (el: Element) => number) => void;
  writeLines: (el: Element, text: string) => boolean;
  linesSettled: () => Promise<void>;
  /**
   * The visitor's own choice (docs/specs/direct-visitors.md §2): draws the
   * row under the hero's buttons when it fits; `again` reruns the page's
   * pass after an answer. Absent in a rich.js from before it.
   */
  choice?: (q: unknown, page: { c: string; e: string }, again: () => void) => void;
}

/** The writers, when /rich.js has run on this page. */
export function rich(): RichWriters | undefined {
  return (globalThis as { __rwx?: RichWriters }).__rwx;
}

/** False without the writers: the caller leaves the page whole (or writes a page not split yet). */
export function writeTemplate(el: Element, template: string): boolean {
  return rich()?.writeTemplate(el, template) ?? false;
}

export function writeLines(el: Element, text: string): boolean {
  return rich()?.writeLines(el, text) ?? false;
}

/** The element's height for each rotating word; one height without the writers. */
export function rotationHeights(el: Element, measure: (el: Element) => number): number[] {
  return rich()?.rotationHeights(el, measure) ?? [measure(el)];
}

export function reserveRotationHeight(el: Element, measure: (el: Element) => number): void {
  rich()?.reserveRotationHeight(el, measure);
}

export function keepRotationReserved(el: Element, measure: (el: Element) => number): void {
  rich()?.keepRotationReserved(el, measure);
}

export function linesSettled(): Promise<void> {
  return rich()?.linesSettled() ?? Promise.resolve();
}
