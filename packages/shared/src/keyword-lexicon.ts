/**
 * Keyword intent (docs/specs/keyword-intent.md): a customer's own keyword
 * lexicon, built offline by the generation model from the brief, and the
 * edge's match of an ad keyword (`utm_term`) against it.
 *
 * Nothing here is a word list: the phrases come from each customer's
 * lexicon (the founder's call, 2026-10-21). The only fixed table the
 * lexicon passes through is the special-category screen
 * (special-category/terms.ts), which refuses a phrase, never adds one.
 *
 * Privacy (privacy review, sections 9 and 10): the keyword is read in memory for
 * one `/select` call and dropped; only the intent word it chose leaves this
 * module. The lexicon stays in its customer's scope and never reaches a
 * browser, an event, a log or an alert.
 */

import { INTENT_DIMENSIONS, type IntentDim } from "./vector/dimensions.ts";

/** Intent → phrases, each folded (see foldKeyword). Only served intents, never `brand`. */
export type KeywordLexicon = Partial<Record<IntentDim, string[]>>;

/** The intents a keyword may choose: every intent but `brand` (the default, never a keyword's). */
export const KEYWORD_INTENTS: readonly IntentDim[] = INTENT_DIMENSIONS.filter((d) => d !== "brand");

/** Phrases per intent, all languages together (40 per language, up to three languages). */
export const LEXICON_MAX_PER_INTENT = 120;
/** Words in one phrase. */
export const LEXICON_MAX_WORDS = 4;
/** Characters in one phrase. */
export const LEXICON_MAX_CHARS = 40;
/** Characters of a keyword the edge reads at all; a longer one is ignored, not cut. */
export const KEYWORD_MAX_CHARS = 120;

/**
 * The order an equal match falls back to: the more specific intent first.
 * A phrase is in one intent only (validateLexicon), so a tie can only come
 * from two different phrases of the same length in one keyword.
 */
const TIE_ORDER: readonly IntentDim[] = [
  "competitor",
  "pricing",
  "evaluation",
  "feature",
  "problem",
];

/**
 * Words of a text: runs of letters and digits in any script, lower case,
 * NFKC. The dotted capital `İ` (az, tr) lower-cases to `i` plus a combining
 * dot, which is not a letter and would split "İslam" into "i slam"; it is
 * read as a plain `i`.
 */
export function keywordWords(text: string): string[] {
  return (
    text
      .normalize("NFKC")
      .toLocaleLowerCase("und")
      .replace(/i̇/g, "i")
      .match(/[\p{L}\p{N}]+/gu) ?? []
  ).slice(0, 64);
}

/** A phrase or a keyword as the lexicon stores and compares it: its words joined by one space. */
export function foldKeyword(text: string): string {
  return keywordWords(text).join(" ");
}

/**
 * The lexicon a model answered, as it may be stored: only served intents
 * other than `brand`, phrases folded, 1 to LEXICON_MAX_WORDS words and at
 * most LEXICON_MAX_CHARS characters, not digits only, each phrase in one
 * intent (the first in TIE_ORDER keeps it), at most LEXICON_MAX_PER_INTENT
 * per intent, and none the screen refuses. Null when nothing is left.
 *
 * `served` is the site's served intents, null for all six.
 * `refused(phrase)` is the special-category screen: true refuses.
 */
export function validateLexicon(
  raw: unknown,
  served: readonly IntentDim[] | null,
  refused: (phrase: string) => boolean,
): KeywordLexicon | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  const seen = new Set<string>();
  const out: KeywordLexicon = {};
  let total = 0;
  for (const intent of TIE_ORDER) {
    if (served && !served.includes(intent)) continue;
    const list = input[intent];
    if (!Array.isArray(list)) continue;
    const kept: string[] = [];
    for (const item of list) {
      if (typeof item !== "string") continue;
      const phrase = foldKeyword(item);
      if (!phrase || phrase.length > LEXICON_MAX_CHARS) continue;
      const words = phrase.split(" ");
      if (words.length > LEXICON_MAX_WORDS) continue;
      if (words.every((w) => /^\p{N}+$/u.test(w))) continue;
      if (seen.has(phrase)) continue;
      if (refused(phrase)) continue;
      seen.add(phrase);
      kept.push(phrase);
      if (kept.length >= LEXICON_MAX_PER_INTENT) break;
    }
    if (kept.length > 0) {
      out[intent] = kept;
      total += kept.length;
    }
  }
  return total > 0 ? out : null;
}

/**
 * The intent an ad keyword chooses, or null. The keyword's words are
 * searched for every lexicon phrase as a run of whole words; the longest
 * phrase found wins (more words, then more characters), an equal one falls
 * back to TIE_ORDER. A keyword over KEYWORD_MAX_CHARS is ignored.
 *
 * Pure and in memory: the caller drops the keyword right after
 * (docs/specs/keyword-intent.md §3.4).
 */
export function matchKeywordIntent(
  keyword: string | null | undefined,
  lexicon: KeywordLexicon | null | undefined,
): IntentDim | null {
  if (!keyword || !lexicon || keyword.length > KEYWORD_MAX_CHARS) return null;
  const words = keywordWords(keyword);
  if (words.length === 0) return null;
  let best: { intent: IntentDim; words: number; chars: number; rank: number } | null = null;
  for (const [rank, intent] of TIE_ORDER.entries()) {
    for (const phrase of lexicon[intent] ?? []) {
      const pw = phrase.split(" ");
      if (!containsRun(words, pw)) continue;
      const cand = { intent, words: pw.length, chars: phrase.length, rank };
      if (
        !best ||
        cand.words > best.words ||
        (cand.words === best.words && cand.chars > best.chars) ||
        (cand.words === best.words && cand.chars === best.chars && cand.rank < best.rank)
      ) {
        best = cand;
      }
    }
  }
  return best ? best.intent : null;
}

/** True when `run` appears in `words` as consecutive whole words. */
function containsRun(words: readonly string[], run: readonly string[]): boolean {
  if (run.length === 0 || run.length > words.length) return false;
  outer: for (let i = 0; i + run.length <= words.length; i++) {
    for (let j = 0; j < run.length; j++) {
      if (words[i + j] !== run[j]) continue outer;
    }
    return true;
  }
  return false;
}

/** The stored lexicon (a D1 JSON text) as the bundle carries it; null on anything malformed. */
export function parseStoredLexicon(raw: string | null | undefined): KeywordLexicon | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const out: KeywordLexicon = {};
    for (const intent of KEYWORD_INTENTS) {
      const list = (parsed as Record<string, unknown>)[intent];
      if (!Array.isArray(list)) continue;
      const strings = list.filter((p): p is string => typeof p === "string" && p.length > 0);
      if (strings.length > 0) out[intent] = strings;
    }
    return Object.keys(out).length > 0 ? out : null;
  } catch {
    return null;
  }
}
