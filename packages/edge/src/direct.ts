/**
 * Visitors with no signal of their own at `/select` (ADR 0038;
 * docs/specs/direct-visitors.md sections 3 to 6). KV only: every input is the
 * visitor bundle already read, the request's own path, the connection's
 * country and the browser's language tag, read in memory and never kept.
 * The visit marker is never an input here.
 */

import {
  type ConversionTargetForClient,
  HELD_ORIGINAL,
  type IntentDim,
  ORIGINAL_ARM,
  type VisitorBundle,
  drawArm,
  marketSource,
  pageWord,
  pickMarket,
  rememberJs,
  sectionWord,
  siteEntryFor,
  validWeights,
  wordCarry,
} from "@rawuser/shared";

/** A conversion target as a browser receives it, with page one's word (§4). */
export type WordTarget = ConversionTargetForClient & { i?: string };

/**
 * True when page one may choose page two for this customer (§4): the bundle
 * says `dp` (switch on, a "no" to the special-category question, not
 * sensitive, not an audit; generation and the write-back decide) and is not
 * a sensitive or "no events" bundle (checked again here rather than trusting
 * the writer).
 */
export function pageOneOn(b: VisitorBundle | null | undefined): b is VisitorBundle {
  return !!b && b.v === 1 && b.dp === 1 && b.s !== 1 && b.ne !== 1 && b.a !== 1;
}

/** The word this page names for the next page, or null (§4). */
export function pageOneWord(
  b: VisitorBundle | null | undefined,
  pagePath: string,
): IntentDim | null {
  if (!pageOneOn(b)) return null;
  return pageWord(pagePath, siteEntryFor(b.pm, pagePath), b.sd);
}

/**
 * The no-signal answer's page-one fields: `kc` for the page's own word, and
 * each counted button's word as `i`. Nothing when the switch is off or the
 * page and its buttons name nothing.
 */
export function pageOneFields(
  b: VisitorBundle | null | undefined,
  pagePath: string,
  targets: readonly ConversionTargetForClient[],
): { kc?: string; targets: WordTarget[] } {
  if (!pageOneOn(b)) return { targets: [...targets] };
  const word = pageOneWord(b, pagePath);
  const worded = targets.map((t) => {
    const i = sectionWord(t.section_path, b.sd);
    return i ? { ...t, i } : t;
  });
  return { ...(word ? { kc: wordCarry(word) } : {}), targets: worded };
}

/**
 * A carried `direct` pair on a page that names another word: the tab keeps
 * the new word for the next page (§4, "Opens"). Never over a carry with a
 * real source, and never when the page's word is the carried one.
 */
export function nextWordCarry(
  b: VisitorBundle | null | undefined,
  pagePath: string,
  carried: { intent_dim: string; source_dim: string } | null,
): string | null {
  if (!carried || carried.source_dim !== "direct") return null;
  const word = pageOneWord(b, pagePath);
  return word && word !== carried.intent_dim ? wordCarry(word) : null;
}

/**
 * True when the bundle may give a visit with no signal an answer of its own
 * (§3, §5): a readable bundle, not an audit, not "no events", not sensitive
 * (the writers leave `mk` and `dl` out of such a bundle; checked again here).
 */
export function directOn(b: VisitorBundle | null | undefined): b is VisitorBundle {
  return !!b && b.v === 1 && b.ne !== 1 && b.a !== 1 && b.s !== 1;
}

/**
 * The question's own switch (§2): as `directOn`, but a site marked sensitive
 * may have it (the founder's call, 2026-11-04; the writers give `qc` only by
 * `choiceAllowed`).
 */
export function choiceOn(b: VisitorBundle | null | undefined): b is VisitorBundle {
  return !!b && b.v === 1 && b.ne !== 1 && b.a !== 1;
}

/**
 * The visitor memory for the customer's script (§2, "A visitor who comes
 * back"; ADR 0039): while "Remember returning visitors" is on (`rm`), never
 * for an audit or an unmarked "yes". A script without it is byte for byte
 * what it was.
 */
export function choiceRecallFor(bundle: unknown): string {
  const b = bundle as VisitorBundle | null;
  return choiceOn(b) && b.rm === 1 ? rememberJs() : "";
}

/** The visitor's market for this bundle, from the connection's country or the language's region (§5). */
export function directMarket(
  b: VisitorBundle | null | undefined,
  country: string | null | undefined,
  lang: string | null | undefined,
): string | null {
  if (!directOn(b)) return null;
  return pickMarket(b.mk, country, lang);
}

/**
 * What a visit with no signal gets on this page, decided before any read
 * (§3, §5): the market version, the learned default's draw, a held original
 * (`none:direct` in the tab's carry), or nothing. The draw `r` comes from the
 * edge's random source, never from the visit marker.
 */
export type DirectPlan =
  | { kind: "m"; intent: "brand"; source: string; nd: "m" }
  | { kind: "l"; intent: string; source: "default"; nd: string }
  | { kind: "o"; nd: string; held: boolean };

export function planDirect(
  b: VisitorBundle | null | undefined,
  pagePath: string,
  input: { country?: string | null; lang?: string | null; carry?: string | null; r: number },
): DirectPlan | null {
  if (!directOn(b) || !b.pages[pagePath]) return null;
  const weights = b.dl?.w[pagePath];
  const learned = weights && validWeights(weights) ? weights : null;
  // A visit the learned default kept on the page as built stays there.
  if (input.carry === HELD_ORIGINAL) {
    return learned ? { kind: "o", nd: `l:${b.dl?.s}`, held: true } : null;
  }
  // Any other carry here is the visitor's own answer (§2): nothing drawn.
  if (input.carry) return null;
  const market = pickMarket(b.mk, input.country, input.lang);
  if (market) return { kind: "m", intent: "brand", source: marketSource(market), nd: "m" };
  if (!learned) return null;
  const { arm, p } = drawArm(learned, input.r);
  const nd = `l:${b.dl?.s}:${p}`;
  if (arm === ORIGINAL_ARM) return { kind: "o", nd, held: false };
  return { kind: "l", intent: arm, source: "default", nd };
}
