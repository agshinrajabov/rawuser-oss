/**
 * The screens and the rules of docs/specs/site-shaped-intents.md §4.3 to
 * §4.5: which of a page's own links may be kept at all, and which kind the
 * word tables give each one. Pure: the generation worker reads the links
 * and calls the model for what the rules leave.
 */

import { globalPathKinds } from "../classify/path-intent.ts";
import { normalizePath } from "../path.ts";
import { holdsAccountDetail, pathHoldsIdentifier } from "../pick.ts";
import { langPrefix } from "../site-languages.ts";
import type { SiteKind } from "./kinds.ts";
import {
  FOLDED_ACCOUNT_WORDS,
  FOLDED_NEVER_WORDS,
  kindsNamed,
  namesAny,
  wordsOf,
} from "./words.ts";

/** Why a link was dropped. Never stored, never sent to a model. */
export type LinkDrop = "identifier" | "detail" | "account" | "never" | "file" | "root";

/** A path never longer than this is stored (spec §5). */
export const SITE_PATH_MAX = 200;
/** The link text is cut to this many characters (the picker's signature cap). */
export const SITE_LABEL_MAX = 40;
/** At most this many links are read from one page. */
export const SITE_LINKS_PER_PAGE = 60;
/** At most this many paths are stored per customer. */
export const SITE_PATHS_PER_CUSTOMER = 200;
/** At most this many links go to the model in one read. */
export const SITE_MODEL_MAX = 40;

const FILE_EXT =
  /\.(xml|rss|atom|json|txt|csv|pdf|zip|png|jpe?g|gif|svg|webp|avif|ico|mp4|mp3|webm|docx?|xlsx?|pptx?)$/i;

/** Whitespace collapsed, cut to the label cap. */
export function cleanLinkText(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim().slice(0, SITE_LABEL_MAX).trim();
}

/**
 * Null when the link may be kept, else why not. Run before anything is
 * stored or sent (§4.3, privacy review conditions 1 and 3):
 * 1. its path, read as written before lower-casing, holds an identifier
 *    (`pathHoldsIdentifier`: an `@`, digits, a UUID, a token);
 * 2. its text holds an account detail (an email shape, six digits in a row);
 * 3. its path or text names an account area, in any of the four languages;
 * 4. it is a legal, jobs or feed link, or a file;
 * 5. it is the site's root or a bare language root (`/az`).
 */
export function screenLink(rawPath: string, text: string): LinkDrop | null {
  const pathOnly = rawPath.split(/[?#]/, 1)[0] ?? "";
  if (pathHoldsIdentifier(pathOnly)) return "identifier";
  if (holdsAccountDetail(text)) return "detail";
  const path = normalizePath(pathOnly);
  if (path === "/") return "root";
  const prefix = langPrefix(path);
  if (prefix && path === `/${prefix}`) return "root";
  const pathWords = wordsOf(path);
  const textWords = wordsOf(text);
  if (namesAny(pathWords, FOLDED_ACCOUNT_WORDS) || namesAny(textWords, FOLDED_ACCOUNT_WORDS)) {
    return "account";
  }
  if (namesAny(pathWords, FOLDED_NEVER_WORDS) || namesAny(textWords, FOLDED_NEVER_WORDS)) {
    return "never";
  }
  if (FILE_EXT.test(path)) return "file";
  return null;
}

/** The first segment after a language prefix: `/az/work/portal` → "work". */
export function kindSegment(path: string): string {
  const segs = path.split("/").filter((s) => s.length > 0);
  const prefix = langPrefix(path);
  const rest = prefix && segs[0] === prefix ? segs.slice(1) : segs;
  return rest[0] ?? "";
}

export interface RuleResult {
  /** The kind the rules give, or null when the model decides. */
  kind: SiteKind | null;
  /** high: path and text agree; medium: one names it, the other is silent. */
  confidence: "high" | "medium" | null;
  /** Kinds the link text named in the word tables (the label rule, condition 2). */
  textKinds: SiteKind[];
}

/**
 * The rules of §4.4: the path's first segment (after a language prefix)
 * and the link text, each matched on whole words; a global-table match
 * counts as the path naming its kind. Path and text agree: high. One names
 * a kind, the other is silent: medium. They disagree, or either names two
 * kinds, or both are silent: left for the model.
 */
export function ruleKind(link: { path: string; text: string; lang?: string | null }): RuleResult {
  const path = normalizePath(link.path);
  const pathKinds = [
    ...new Set([...kindsNamed(wordsOf(kindSegment(path)), link.lang), ...globalPathKinds(path)]),
  ];
  const textKinds = kindsNamed(wordsOf(link.text), link.lang);
  const p = pathKinds.length === 1 ? pathKinds[0] : null;
  const t = textKinds.length === 1 ? textKinds[0] : null;
  const pConflict = pathKinds.length > 1;
  const tConflict = textKinds.length > 1;
  if (pConflict || tConflict) return { kind: null, confidence: null, textKinds };
  if (p && t) {
    return p === t
      ? { kind: p, confidence: "high", textKinds }
      : { kind: null, confidence: null, textKinds };
  }
  if (p) return { kind: p, confidence: "medium", textKinds };
  if (t) return { kind: t, confidence: "medium", textKinds };
  return { kind: null, confidence: null, textKinds };
}

/**
 * The link text kept on a row (privacy review condition 2). A capture is the
 * operator's own browser, maybe signed in, and nobody chose the link: its
 * text is kept only when it named the row's kind in the word tables, else
 * null (the dialog shows the path). A cookie-less server read keeps the
 * screened text.
 */
export function labelToKeep(
  source: "capture" | "fetch",
  text: string,
  kind: SiteKind,
  textKinds: readonly SiteKind[],
): string | null {
  const t = cleanLinkText(text);
  if (t === "") return null;
  if (source === "fetch") return t;
  return textKinds.includes(kind) ? t : null;
}
