/**
 * Copy lint: deterministic checks on a validated VariantBody before it is
 * written (docs/specs/generation-quality.md §2). No model calls.
 *
 * Hard flags fail the variant if a revise pass cannot clear them: a number
 * the brief never gave, or copy in the wrong language. Soft flags are the
 * machine patterns from no-ai-slop; they trigger one revise pass and are
 * stored on the variant row if they survive.
 */

import type { VariantBody } from "@rawuser/shared";
import {
  parseTemplate,
  templateBlanks,
  templateLineMisses,
  templateText,
  templateViolations,
} from "@rawuser/shared/template";
import { BANNED_WORDS, TURKISH_MARKERS_IN_AZ } from "../prompts/quality-rules.ts";
import { type ClaimsLock, claimsLockFlags } from "./claims-lock.ts";
import {
  CTA_KIND_WORDS,
  CTA_LANGUAGES,
  type CtaFacts,
  DOING_KINDS,
  KEEP_OWN_ACTION,
  LABEL_SIGNATURE_MAX,
  ctaKindOfWords,
  ctaObjectsOf,
  describeKinds,
  keepObjectLine,
  keepsCtaObject,
} from "./cta-action.ts";
import { marketAddressed } from "./market-addressed.ts";
import {
  isSectionHeadingPath,
  keepSubjectLine,
  keepsSectionSubject,
  sectionSubjectsOf,
} from "./section-subject.ts";
import { sourceAddressed } from "./source-addressed.ts";

export interface LintFlag {
  path: string;
  rule: string;
  excerpt: string;
  severity: "hard" | "soft";
}

export interface LintContext {
  /** BCP-47 tag of the brief. */
  language: string;
  /** Every number the copy may use: from the brief, hints and page samples. */
  allowedNumbers: ReadonlySet<string>;
  /**
   * For each allowed number, the word stems that follow it in the brief
   * ("4" → {"il", "ill"}), so "4 həftə" is caught when the brief only ever
   * says "4 il". Optional; without it only bare presence is checked.
   */
  allowedUnits?: ReadonlyMap<string, ReadonlySet<string>>;
  /** Slots whose original emphasises a phrase; the version marks one with `*…*`. */
  emphasisSlots?: ReadonlySet<string>;
  /** The original element's visible character count per slot (manifest). */
  originalLengths?: ReadonlyMap<string, number>;
  /** The original element's text signature per slot (manifest `text[0]`, up to 40 characters). */
  originalTexts?: ReadonlyMap<string, string>;
  /**
   * The page's template per slot built word by word
   * (docs/specs/template-writing.md §3.2): the version's value and its other
   * lengths are templates of the same structure.
   */
  templates?: ReadonlyMap<string, string>;
  /**
   * Parts whose lengths were chosen by the page's measured wrap
   * (docs/specs/interactive-text.md §3.4): their character caps and windows
   * are not checked, the simulation already chose what holds the lines.
   */
  simulated?: ReadonlySet<string>;
  /**
   * What each button of the page does (its words, its link) and whether it
   * is the counted one (conversion_targets): a version keeps the action and
   * never gives another button the counted button's words.
   */
  ctas?: ReadonlyMap<string, CtaFacts>;
  /**
   * The customer's own words: the brief and the page's sentences
   * (`ownWordsFor`). With them an AI word or an assistant's name in a
   * version is told apart from the product's own subject
   * (lint/source-addressed.ts); without them only what is said about the
   * visitor's arrival is read.
   */
  ownWords?: string;
  /**
   * The claims lock of a customer whose site is about health
   * (docs/specs/claims-lock.md, lint/claims-lock.ts): the page's own words,
   * which no version may add a claim, a dose, a certificate or a number to,
   * and which decide what is said about the reader's health. Absent for
   * every other customer, and then nothing of it runs.
   */
  claimsLock?: ClaimsLock;
  /**
   * The market of a market version (docs/specs/direct-visitors.md §5), an
   * upper-case ISO code. With it, a part that addresses where the reader is
   * from is a hard flag (lint/market-addressed.ts). Absent for every other
   * version, and then nothing of it runs.
   */
  market?: string;
}

/** A part whose lengths the wrap simulation chose, or one of its other lengths. */
function simulatedPart(ctx: LintContext, path: string): boolean {
  return ctx.simulated?.has(path.replace(/_alt2?$/, "")) ?? false;
}

/** Below this share of the original's length a headline or button changes the line count. */
export const LENGTH_DRIFT_FLOOR = 0.75;
const LINE_BOUND_PATH = /\.(headline|label|submit_label)$/;
/** A paragraph (40 characters or more) outside this window leaves a hole or overflows the page. */
export const PARAGRAPH_DRIFT_FLOOR = 0.9;
export const HEADLINE_CAP = 1.05;
export const PARAGRAPH_ALT_FLOOR = 0.75;
export const PARAGRAPH_ALT_CAP = 0.9;
export const HEADLINE_ALT_CAP = 1.15;
/** Where the third length should sit: the shorter headline, the longer paragraph. */
export const HEADLINE_ALT2_FLOOR = 0.7;
export const HEADLINE_ALT2_CAP = 0.85;
/**
 * The short length every headline and paragraph owes (docs/decisions/0031):
 * on the Webflow test page no length at or under 85% of the original took a
 * line more at any of nine widths, 1440 to 360 px (2026-09-30), and the
 * snippet brings a shorter one to the page's own line count.
 */
export const SHORT_HEADLINE = 0.88;
export const SHORT_PARAGRAPH = 0.92;
export const PARAGRAPH_ALT2_FLOOR = 1.05;
export const PARAGRAPH_ALT2_CAP = 1.15;
/** A soft flag past this share on either side of a paragraph's original; hard past PARAGRAPH_DRIFT_CAP. */
export const PARAGRAPH_SOFT_CAP = 1.1;
/** The window a paragraph's first length is asked for: 95% to 105% of the page's own. */
export const PARAGRAPH_NEAR_FLOOR = 0.95;
export const PARAGRAPH_NEAR_CAP = 1.05;
export const LABEL_CAP = 1.25;
export const LABEL_MIN_CAP = 12;
/** Characters over a label's cap that stay a soft flag. */
export const LABEL_CAP_GRACE = 2;

/** The most characters a line-bound part may have: headlines 1.05x (soft; hard past 1.25x), labels 1.25x and never under 12. */
export function labelCap(path: string, original: number): number {
  return path.endsWith("headline")
    ? Math.round(original * HEADLINE_CAP)
    : Math.max(LABEL_MIN_CAP, Math.round(original * LABEL_CAP));
}
export const PARAGRAPH_DRIFT_CAP = 1.2;
const PARAGRAPH_MIN_CHARS = 40;

const MARKER = /\*[^*\n]{1,80}\*/g;

export interface LintResult {
  hard: LintFlag[];
  soft: LintFlag[];
}

const NUMBER_RE = /\d[\d.,]*\+?/g;

/** Numeric tokens in a set of texts, normalised (separators stripped). */
export function collectNumbers(texts: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const t of texts) {
    for (const m of t.match(NUMBER_RE) ?? []) out.add(normNumber(m));
  }
  return out;
}

function normNumber(raw: string): string {
  return raw.replace(/[.,+]/g, "").replace(/^0+(?=\d)/, "");
}

const UNIT_STEM_LEN = 2;

/**
 * Two-letter stems of measurement words (time, money, percent) in the
 * languages we write. The unit rule fires only when the brief gives a
 * number with one of these: "4 il" against "4 həftə" is a wrong claim,
 * "11-person team" against "11 months" is the same number in another
 * sentence (a pilot site's /approach, 2026-09-14: 12 of 30 versions failed on
 * a noun the lint took for a unit).
 */
const MEASURE_STEMS: ReadonlySet<string> = new Set([
  "il",
  "ay",
  "gü",
  "hə",
  "sa",
  "də",
  "fa",
  "ma",
  "az",
  "ye",
  "mo",
  "we",
  "da",
  "ho",
  "mi",
  "se",
  "pe",
  "do",
  "us",
  "eu",
  "ce",
  "го",
  "ме",
  "не",
  "дн",
  "ча",
  "ми",
  "пр",
  "yı",
  "ha",
  "yü",
  "tl",
]);

/**
 * The stems of the two words after each number: "4 illik təcrübə" → 4: {il, tə};
 * "40-dan çox məhsul" → 40: {ço, mə} (a hyphenated case suffix is skipped);
 * "$12/mo" → 12: {mo} (a slash counts as the space; a Lovable test site's four
 * pricing versions failed for a month on "12/mo" against the brief's own
 * "$12/mo", 2026-09-14). Two-letter stems so "il" and "illik" agree.
 */

/** English words a bare verb follows: where the page's rotating verbs hang. */
const VERB_LEADS: ReadonlySet<string> = new Set([
  "can",
  "could",
  "will",
  "would",
  "may",
  "might",
  "must",
  "should",
  "shall",
  "to",
  "cannot",
  "can't",
  "won't",
  "and",
  "or",
  "then",
  "you",
  "they",
  "we",
  "i",
  "let",
  "help",
  "them",
  "us",
  "people",
  "visitors",
  "buyers",
  "customers",
  "users",
  // An adverb between the lead and the verb ("can still read").
  "still",
  "also",
  "now",
  "always",
  "finally",
  "easily",
  "instantly",
  "just",
  "only",
  "even",
  "first",
]);

/** The unit collectUnits gives a number written with a currency. */
export const CURRENCY_UNIT = "¤";
const CURRENCY_BEFORE = /(?:[$€£₼¥₺₽]|\b(?:USD|EUR|AZN|GBP|TRY|RUB))\s*$/i;
const CURRENCY_AFTER =
  /^\s*(?:[$€£₼¥₺₽]|(?:USD|EUR|AZN|GBP|TRY|RUB)\b|(?:manat|dollar|euro|lira|rubl|рубл|доллар)\p{L}*)/iu;

export function collectUnits(texts: readonly string[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const t of texts) {
    // The number ends on a digit, so the full stop of "$0.45. Choose what"
    // ends the sentence and the next one's words are never its unit
    // (template-lab, 2026-09-27: "ch/wh" refused a price the brief gave).
    const re = /(\d(?:[\d.,]*\d)?\+?)(?:-\p{L}+)?(?:(?:\s*\/\s*|\s+)(\p{L}+)?(?:\s+(\p{L}+))?)?/gu;
    for (const m of t.matchAll(re)) {
      const n = normNumber(m[1] ?? "");
      if (!n) continue;
      const set = out.get(n) ?? new Set<string>();
      for (const w of [m[2], m[3]]) {
        if (w && w.length >= UNIT_STEM_LEN) set.add(w.toLowerCase().slice(0, UNIT_STEM_LEN));
      }
      // A currency around the number is a unit of its own: "$0.45" in the
      // brief and "0.45" in the copy is a price that lost its sign (the lab
      // run, 2026-09-28); the same sign on both sides is the same price,
      // whatever words follow it.
      const at = m.index ?? 0;
      const before = t.slice(Math.max(0, at - 5), at);
      const after = t.slice(at + (m[1]?.length ?? 0));
      if (CURRENCY_BEFORE.test(before) || CURRENCY_AFTER.test(after)) set.add(CURRENCY_UNIT);
      out.set(n, set);
    }
  }
  return out;
}

function flattenStrings(obj: unknown, prefix = "", out: Array<[string, string]> = []) {
  if (typeof obj !== "object" || obj === null) return out;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") out.push([p, v]);
    else if (v && typeof v === "object") flattenStrings(v, p, out);
  }
  return out;
}

function scriptOf(lang: string): RegExp | null {
  const p = lang.split("-")[0]?.toLowerCase() ?? "";
  if (["ru", "uk", "bg", "sr", "kk", "ky", "mn"].includes(p)) return /\p{Script=Cyrillic}/u;
  if (["ar", "fa", "ur"].includes(p)) return /\p{Script=Arabic}/u;
  if (["zh", "ja"].includes(p)) return /\p{Script=Han}/u;
  if (["ko"].includes(p)) return /\p{Script=Hangul}/u;
  if (["he"].includes(p)) return /\p{Script=Hebrew}/u;
  return /\p{Script=Latin}/u;
}

export function lintVariant(body: VariantBody, ctx: LintContext): LintResult {
  const hard: LintFlag[] = [];
  const soft: LintFlag[] = [];
  // A slot built word by word carries a template. Its structure is checked
  // here; every other rule reads the words a visitor sees, so a token's digit
  // ({g1}) is never a number and a token never counts as a character.
  const raw = flattenStrings(body.sections);
  const pageTemplate = (path: string) => ctx.templates?.get(path.replace(/_alt2?$/, ""));
  for (const [path, text] of raw) {
    const page = pageTemplate(path);
    if (page === undefined) continue;
    const broken = templateViolations(page, text);
    broken.forEach((v, i) => {
      // The revise pass sees only the flags: the first carries the page's
      // structure with its words blank, so a version that dropped it can be
      // rebuilt on it without being handed the page's words to copy.
      const excerpt =
        i === 0
          ? `${v.excerpt}; the page's structure, each _ a word: ${templateBlanks(page)}`
          : v.excerpt;
      hard.push({ path, rule: v.rule, excerpt, severity: "hard" });
    });
    // The page's own words back in its own template is no version (the first
    // real run, 2026-09-27: three of five intents returned the page verbatim).
    if (
      broken.length === 0 &&
      normalizeForCompare(templateText(text)) === normalizeForCompare(templateText(page))
    ) {
      hard.push({
        path,
        rule: "template-copy",
        excerpt:
          "this is the page's own headline word for word; keep the tokens, write this visitor's words",
        severity: "hard",
      });
    }
    // One of the page's own lines kept whole is a copy too (the first run's
    // local trial kept "Choose what you can {rot:read|compare|buy|skip}.").
    else if (broken.length === 0) {
      const own = new Set(
        templateText(page)
          .split("\n")
          .map(normalizeForCompare)
          .filter((l) => l.length >= 12),
      );
      const kept = templateText(text)
        .split("\n")
        .findIndex((l) => own.has(normalizeForCompare(l)));
      if (kept >= 0) {
        hard.push({
          path,
          rule: "template-copy",
          excerpt: `line ${kept + 1} is the page's own line; write this visitor's words`,
          severity: "hard",
        });
      }
    }
    if (broken.length === 0) {
      // A sentence that ends at a line's end keeps its full stop: built from
      // word lists, "You compared tools / Most read who came / Rawuser reads
      // intent" read as one run-on line (the lab run, 2026-09-28).
      const vis = templateText(text).split("\n");
      const open = vis.findIndex(
        (l, i) =>
          i < vis.length - 1 &&
          !/[.!?,;:…]$/.test(l.trim()) &&
          /^\p{Lu}/u.test(vis[i + 1] ?? "") &&
          !/^I\b/.test(vis[i + 1] ?? ""),
      );
      if (open >= 0) {
        soft.push({
          path,
          rule: "template-stop",
          excerpt: `line ${open + 1} ends a sentence without its full stop`,
          severity: "soft",
        });
      }
      // The rotating words about as long as each other: the page cycles them
      // after the reveal, and a long one can wrap a line the others do not.
      const alts = parseTemplate(text).flatMap((tok) => (tok.t === "rot" ? tok.alts : []));
      const own = parseTemplate(page).flatMap((tok) => (tok.t === "rot" ? tok.alts : []));
      const spread = (xs: string[]) =>
        xs.length === 0
          ? 0
          : Math.max(...xs.map((a) => a.length)) - Math.min(...xs.map((a) => a.length));
      // The version wrote the page's rotating word itself right before the
      // slot ("to read {rot:read|…}", 2026-09-28): the word shows twice.
      const beforeRot = templateText(text.replace(/\{rot:[^}]*\}[\s\S]*$/, ""))
        .trim()
        .split(/\s+/)
        .pop()
        ?.toLowerCase()
        .replace(/[^\p{L}\p{N}]/gu, "");
      if (beforeRot && alts.some((a) => a.toLowerCase() === beforeRot)) {
        hard.push({
          path,
          rule: "rotator-doubled",
          excerpt: `"${beforeRot}" stands right before the rotating word, which says it again; end the run on the word that leads into it`,
          severity: "hard",
        });
      }
      // Where the page leads into its rotating word with a word a verb follows
      // ("they can" + "read"), the version must too: a finished phrase with
      // the page's verb after it does not read ("skip the banner read",
      // "pick a page read", the lab trial, 2026-09-28). English only for now.
      const lead = (t: string) =>
        templateText(t.replace(/\{rot:[^}]*\}[\s\S]*$/, ""))
          .trim()
          .split(/\s+/)
          .pop()
          ?.toLowerCase()
          .replace(/[^\p{L}\p{N}']/gu, "");
      const pageLead = lead(page);
      // "built to can read": a modal right after "to" does not read.
      const toModal = (t: string) =>
        /\bto (?:can|will|may|must|should|could|would)$/i.test(
          templateText(t.replace(/\{rot:[^}]*\}[\s\S]*$/, "")).trim(),
        );
      if (
        ctx.language.toLowerCase().startsWith("en") &&
        alts.length > 0 &&
        pageLead &&
        VERB_LEADS.has(pageLead) &&
        beforeRot &&
        (!VERB_LEADS.has(lead(text) ?? "") || toModal(text))
      ) {
        hard.push({
          path,
          rule: "rotator-dangling",
          excerpt: `the rotating words follow "${lead(text)}", which no verb follows; end the run on a word like "${pageLead}", "to" or "will" so "… ${pageLead} ${alts[0]}" reads`,
          severity: "hard",
        });
      }
      // Four rotating words that are one word do not rotate ("you|you|you|you").
      if (new Set(alts.map((a) => a.toLowerCase().trim())).size < alts.length) {
        hard.push({
          path,
          rule: "rotator-repeats",
          excerpt: "the rotating words repeat; write different alternatives",
          severity: "hard",
        });
      }
      if (alts.length > 0 && spread(alts) > Math.max(spread(own), 3) + 2) {
        soft.push({
          path,
          rule: "rotator-spread",
          excerpt: `the rotating words run from ${Math.min(...alts.map((a) => a.length))} to ${Math.max(...alts.map((a) => a.length))} characters; keep them within ${Math.max(spread(own), 3) + 2} of each other`,
          severity: "soft",
        });
      }
    }
    if (path.endsWith("_alt") || path.endsWith("_alt2")) continue;
    // Lines are fixed (the founder's call, 2026-09-28): each line near its
    // page line in characters, so a phone wraps it the way it wraps the
    // page's (390 px: the page takes 6 lines, the versions took 3 to 5), and
    // the last line, counted with the page's longest rotating word, never
    // longer than the page's own: the page's layout then proves every word
    // fits, and the headline cannot gain a line as the words rotate (seven
    // cells flipped, CLS up to 0.46).
    // A headline with no fixed line and no rotating word (a word split into
    // letters) wraps as plain text: no line to hold.
    const lineRule = /\{br\}|\{rot:/.test(page) && !simulatedPart(ctx, path);
    for (const m of lineRule ? templateLineMisses(page, text) : []) {
      // Only the last line's cap is hard: it is what stops a line flipping
      // as the words rotate, and the model meets it (20 of 21 lengths in the
      // local trial). The other windows it did not meet once in 21, so they
      // guide the revise pass without failing the version.
      const over = m.last && m.n > m.hi;
      (over ? hard : soft).push({
        path,
        rule: over ? "template-line-length" : "length-drift",
        excerpt: m.last
          ? `the last line has ${m.n} characters with its longest rotating word; the page's has ${m.own}: write ${m.lo} to ${m.hi}, counting the longest rotating word`
          : `line ${m.line} has ${m.n} characters; the page's has ${m.own}: write ${m.lo} to ${m.hi}`,
        severity: over ? "hard" : "soft",
      });
    }
  }
  const strings: Array<[string, string]> = raw.map(([path, text]) =>
    pageTemplate(path) === undefined
      ? [path, text]
      : [path, templateText(text).replace(/\n/g, " ")],
  );
  const lang = ctx.language.split("-")[0]?.toLowerCase() ?? ctx.language;
  const banned = [...(BANNED_WORDS._universal ?? []), ...(BANNED_WORDS[lang] ?? [])];
  const expectScript = scriptOf(lang);
  // The customer's own words with the page's own parts: what "AI" must be
  // found in to be the product's subject and not the visitor's source.
  const own =
    ctx.ownWords === undefined
      ? undefined
      : [ctx.ownWords, ...(ctx.originalTexts?.values() ?? [])].join("\n");

  for (const [path, text] of strings) {
    if (path.endsWith(".kind") || path.endsWith(".href")) continue;
    const ex = text.length > 90 ? `${text.slice(0, 87)}…` : text;
    const lower = text.toLowerCase();

    // Hard: numbers the brief never gave, or gave with another unit
    // ("4 il" in the brief, "4 həftə" in the copy).
    for (const m of text.match(NUMBER_RE) ?? []) {
      const n = normNumber(m);
      if (!ctx.allowedNumbers.has(n)) {
        hard.push({ path, rule: "number-not-in-brief", excerpt: m, severity: "hard" });
        continue;
      }
      const allowedUnits = ctx.allowedUnits?.get(n);
      if (allowedUnits?.has(CURRENCY_UNIT) && !collectUnits([text]).get(n)?.has(CURRENCY_UNIT)) {
        hard.push({
          path,
          rule: "currency-missing",
          excerpt: `${m} is a price in the brief; write it with its currency`,
          severity: "hard",
        });
        continue;
      }
      const briefMeasures = allowedUnits && [...allowedUnits].some((u) => MEASURE_STEMS.has(u));
      if (allowedUnits && allowedUnits.size > 0 && briefMeasures) {
        const copyUnits = collectUnits([text]).get(n) ?? new Set<string>();
        const overlap = [...copyUnits].some((u) => allowedUnits.has(u));
        if (copyUnits.size > 0 && !overlap) {
          hard.push({
            path,
            rule: "number-unit-mismatch",
            excerpt: `${m} ${[...copyUnits].join("/")} (brief: ${[...allowedUnits].join("/")})`,
            severity: "hard",
          });
        }
      }
    }

    // Hard: the version speaks about where the visitor came from (the
    // first outside pilot, A13: "if you asked AI, the answer is this:"). The source
    // shapes the framing and is never said.
    const addressed = sourceAddressed(text, ctx.language, own);
    if (addressed) {
      hard.push({ path, rule: "source-addressed", excerpt: addressed, severity: "hard" });
    }

    // Hard, a market version only: the wording addresses the market, never
    // where the reader is from (docs/specs/direct-visitors.md §5).
    if (ctx.market) {
      const place = marketAddressed(text);
      if (place) hard.push({ path, rule: "market-addressed", excerpt: place, severity: "hard" });
    }

    // Hard, a sensitive customer only (docs/specs/claims-lock.md): nothing
    // about the reader's health, no claim or number the page does not make,
    // the page's own names kept.
    if (ctx.claimsLock) {
      const base = path.replace(/_alt2?$/, "");
      const flags = claimsLockFlags(text, ctx.language, ctx.claimsLock, {
        original: ctx.originalTexts?.get(base),
        originalLength: ctx.originalLengths?.get(base),
      });
      for (const f of flags)
        hard.push({ path, rule: f.rule, excerpt: f.excerpt, severity: "hard" });
    }

    // Hard: wrong script for the language (a Cyrillic line in Azerbaijani copy).
    const letters = text.replace(/[^\p{L}]/gu, "");
    if (expectScript && letters.length >= 6) {
      const matching = (letters.match(new RegExp(expectScript.source, "gu")) ?? []).length;
      if (matching / letters.length < 0.6) {
        hard.push({ path, rule: "wrong-script", excerpt: ex, severity: "hard" });
      }
    }
    // Hard: Turkish markers in Azerbaijani.
    if (lang === "az") {
      for (const mk of TURKISH_MARKERS_IN_AZ) {
        const m = mk.exec(text);
        if (m) {
          hard.push({ path, rule: "turkish-in-az", excerpt: m[0], severity: "hard" });
          break;
        }
      }
    }

    // Soft patterns.
    if (/[—–]/.test(text)) soft.push({ path, rule: "dash", excerpt: ex, severity: "soft" });
    for (const w of banned) {
      if (lower.includes(w.toLowerCase())) {
        soft.push({ path, rule: `banned:${w}`, excerpt: ex, severity: "soft" });
      }
    }
    const isHeadline = path.endsWith(".headline");
    if (isHeadline) {
      if ((text.match(/\?/g) ?? []).length >= 2) {
        soft.push({ path, rule: "question-stack", excerpt: ex, severity: "soft" });
      }
      if (text.split(/\s+/).filter(Boolean).length > 12) {
        soft.push({ path, rule: "headline-over-12-words", excerpt: ex, severity: "soft" });
      }
    }
    if (/^[^:.!?]{2,40}:\s*\p{Ll}/u.test(text)) {
      soft.push({ path, rule: "colon-reveal", excerpt: ex, severity: "soft" });
    }
    if (
      /\b(not|isn't|isn’t)\b[^.]{0,60}\b(it's|it’s|but)\b/i.test(text) ||
      /\b(yox|deyil)\b[^.]{0,40},\s*[^.]{0,60}\b(deyil|yox)\b/i.test(text) ||
      /\bне\b[^.]{0,60}\bа\b/i.test(text) ||
      /\bdeğil\b[^.]{0,60}\b(ama|aksine)\b/i.test(text)
    ) {
      soft.push({ path, rule: "binary-contrast", excerpt: ex, severity: "soft" });
    }
    if (path.endsWith(".body")) {
      const sentences = text.split(/[.!?]+\s+|[.!?]+$/).filter((s) => s.trim());
      const tiny = sentences.filter((s) => s.trim().split(/\s+/).length <= 3).length;
      if (tiny >= 2) soft.push({ path, rule: "fragments", excerpt: ex, severity: "soft" });
    }
  }

  // Wrong language, same script: an Azerbaijani version written for an
  // English page passes the script check (both Latin). The letter ə exists
  // in Azerbaijani and in no other language we write; one is enough.
  // Seen on a pilot site root problem:default, 2026-09-14.
  if (lang !== "az") {
    for (const [path, text] of strings) {
      if (path.endsWith(".kind") || path.endsWith(".href")) continue;
      if (/[əƏ]/.test(text)) {
        const ex = text.length > 90 ? `${text.slice(0, 87)}…` : text;
        hard.push({ path, rule: "wrong-language", excerpt: ex, severity: "hard" });
      }
    }
  }

  // Length drift (docs/specs/NEXT.md, a Lovable test site 2026-09-14): a headline
  // or button far shorter than the original takes fewer lines and shifts
  // the page. Soft: the revise pass gets the range.
  // Paragraphs (2026-09-14, the founder's ask): the same rule with a
  // window on both sides, because a paragraph half the page's length
  // leaves a hole where the original filled the design, and one much
  // longer overflows it.
  for (const [path, text] of strings) {
    const original = ctx.originalLengths?.get(path.replace(/_alt2?$/, ""));
    if (original === undefined || simulatedPart(ctx, path)) continue;
    const len = text.replace(/\*/g, "").trim().length;
    if (LINE_BOUND_PATH.test(path)) {
      // Too long breaks the row: a five-character button that comes back
      // with twenty-six wraps the form and the hero's button row (a pilot site
      // /az, 2026-09-15), and twenty still wrapped it on a phone. Labels:
      // 1.25x, never under 12. A headline's base: 1.1x (its alt may run to
      // 1.25x; both over the cap is what made the alt useless at 768 px).
      const cap = labelCap(path, original);
      if (len > cap) {
        // A button label over its cap breaks its row; a headline over its
        // cap still has the alt. So labels are hard (2026-09-15), headlines
        // soft; one or two characters over a short cap is soft too (a
        // 13-character label against a cap of 12 failed five versions).
        // A label over its cap by more than the grace is hard. A headline is
        // hard only past 1.25x (2026-09-16): with a shorter third length in
        // hand the page can fall back, and a hard 1.1x had rejected a third
        // of the versions.
        const hardCap = path.endsWith("headline") ? Math.round(original * 1.25) : cap;
        const severity = len <= hardCap + LABEL_CAP_GRACE ? "soft" : "hard";
        (severity === "hard" ? hard : soft).push({
          path,
          rule: "length-drift",
          excerpt: `${len} characters; the original has ${original}, write at most ${cap}`,
          severity,
        });
        continue;
      }
      if (original < 20 || len >= original * LENGTH_DRIFT_FLOOR) continue;
      soft.push({
        path,
        rule: "length-drift",
        excerpt: `${len} characters; the original has ${original}, write ${Math.round(original * (path.endsWith("headline") ? 0.95 : 0.85))} to ${cap}`,
        severity: "soft",
      });
    } else if (path.endsWith("headline_alt")) {
      // The longer second headline: just over the original, at most 1.15x
      // (2026-09-16 afternoon: candidates 35 points apart bracketed the
      // count and still missed the line).
      const capAlt = Math.round(original * HEADLINE_ALT_CAP);
      if (len > capAlt) {
        soft.push({
          path,
          rule: "length-drift",
          excerpt: `${len} characters; the original has ${original}, write ${Math.round(original * 1.05)} to ${capAlt}`,
          severity: "soft",
        });
      }
    } else if (path.endsWith("headline_alt2")) {
      // The shorter third headline: the safe short length (0031).
      if (original < 20 || (len <= original * SHORT_HEADLINE && len >= original * 0.65)) continue;
      soft.push({
        path,
        rule: "length-drift",
        excerpt: `${len} characters; the original has ${original}, write ${Math.round(original * HEADLINE_ALT2_FLOOR)} to ${Math.round(original * HEADLINE_ALT2_CAP)}`,
        severity: "soft",
      });
    } else if (path.endsWith("body_alt2")) {
      // The longer third paragraph: just over the original's count.
      if (original < PARAGRAPH_MIN_CHARS || (len >= original && len <= original * 1.2)) continue;
      soft.push({
        path,
        rule: "length-drift",
        excerpt: `${len} characters; the original has ${original}, write ${Math.round(original * PARAGRAPH_ALT2_FLOOR)} to ${Math.round(original * PARAGRAPH_ALT2_CAP)}`,
        severity: "soft",
      });
    } else if (path.endsWith("body_alt")) {
      // The shorter second paragraph: just under the original.
      if (original < PARAGRAPH_MIN_CHARS) continue;
      const lo = Math.round(original * PARAGRAPH_ALT_FLOOR);
      if (len >= lo && len <= original * SHORT_PARAGRAPH) continue;
      soft.push({
        path,
        rule: "length-drift",
        excerpt: `${len} characters; the original has ${original}, write ${lo} to ${Math.round(original * PARAGRAPH_ALT_CAP)}`,
        severity: "soft",
      });
    } else {
      if (original < PARAGRAPH_MIN_CHARS) continue;
      if (len >= original * PARAGRAPH_DRIFT_FLOOR && len <= original * PARAGRAPH_SOFT_CAP) continue;
      // Over the hard cap is hard (2026-09-16, the founder's call: a base at
      // 155% had shipped on a soft flag and only the alt saved the lines);
      // outside the soft window on either side is soft, with the narrow
      // range for the revise pass.
      const severity = len > original * PARAGRAPH_DRIFT_CAP ? "hard" : "soft";
      (severity === "hard" ? hard : soft).push({
        path,
        rule: "length-drift",
        excerpt: `${len} characters; the original has ${original}, write ${Math.round(original * PARAGRAPH_NEAR_FLOOR)} to ${Math.round(original * PARAGRAPH_NEAR_CAP)}`,
        severity,
      });
    }
  }

  // Same as the original: a version that repeats the page's own headline or
  // button word for word is no version (five brand rows on a Lovable test site,
  // 2026-09-14). Soft: the revise pass writes it in its own words.
  for (const [path, text] of strings) {
    if (!LINE_BOUND_PATH.test(path)) continue;
    const sig = ctx.originalTexts?.get(path);
    if (!sig || sig.length < 12) continue;
    const a = normalizeForCompare(text.replace(/\*/g, ""));
    const b = normalizeForCompare(sig);
    const same = sig.length >= 40 ? a.startsWith(b) : a === b;
    if (same) {
      const ex = text.length > 90 ? `${text.slice(0, 87)}…` : text;
      soft.push({ path, rule: "same-as-original", excerpt: ex, severity: "soft" });
    }
  }

  // A heading that labels what is under it keeps its subject (the first outside
  // pilot, A3): "Sağlamlığınız üçün əlavələr" sits over the product grid, and
  // versions wrote "Probleminizi necə həll edirik" over the same grid. The
  // version does not change the grid, so the heading must still name it.
  // Each length is read. Soft until it has been measured on real rows.
  for (const [path, text] of strings) {
    const base = path.replace(/_alt2?$/, "");
    if (!isSectionHeadingPath(base)) continue;
    const own = ctx.originalTexts?.get(base);
    const subjects = sectionSubjectsOf(own, ctx.language);
    if (subjects.length === 0 || keepsSectionSubject(text, subjects)) continue;
    const ex = text.length > 60 ? `${text.slice(0, 57)}…` : text;
    soft.push({
      path,
      rule: "section-subject-changed",
      excerpt: `"${ex}" names something else than the page's "${own}", which labels what is under it: ${keepSubjectLine(subjects)}`,
      severity: "soft",
    });
  }

  // No paragraph length at or under the original (2026-09-15, the founder's
  // call): a paragraph whose last line is nearly full gains a line on any
  // growth, and the snippet can only keep the line count when one of its
  // lengths does not exceed the page's own. Soft since 2026-09-16
  // afternoon (the founder's call after the tenth rewrite): with the
  // windows pulled in the rule rejected 27 of 90 rows, each a whole page
  // served from an older run, to save one line below the fold; the page
  // picks the closest length anyway.
  {
    const all = new Map(strings);
    for (const [path, text] of all) {
      if (!path.endsWith(".body")) continue;
      const original = ctx.originalLengths?.get(path);
      if (original === undefined || original < PARAGRAPH_MIN_CHARS) continue;
      const lengths = [text, all.get(`${path}_alt`), all.get(`${path}_alt2`)]
        .filter((t): t is string => t !== undefined)
        .map((t) => t.replace(/\*/g, "").trim().length);
      if (lengths.some((n) => n <= original)) continue;
      soft.push({
        path: `${path}_alt`,
        rule: "paragraph-over-original",
        excerpt: `${lengths.join(" and ")} characters against the original's ${original}; write ${path}_alt with at most ${original}`,
        severity: "soft",
      });
    }
  }

  // One safely short length (docs/decisions/0031): the snippet brings a
  // length under the original to the page's own line count at any width,
  // and never has to take one that adds a line while a short one exists.
  {
    const all = new Map(strings);
    for (const [path, text] of all) {
      const head = path.endsWith(".headline");
      if (!head && !path.endsWith(".body")) continue;
      const original = ctx.originalLengths?.get(path);
      if (original === undefined || original < (head ? 20 : PARAGRAPH_MIN_CHARS)) continue;
      const share = head ? SHORT_HEADLINE : SHORT_PARAGRAPH;
      const ns = [text, all.get(`${path}_alt`), all.get(`${path}_alt2`)]
        .filter((t): t is string => t !== undefined)
        .map((t) => t.replace(/\*/g, "").trim().length);
      if (ns.some((n) => n <= original * share)) continue;
      const slot = `${path}${head ? "_alt2" : "_alt"}`;
      soft.push({
        path: slot,
        rule: "short-missing",
        excerpt: `${ns.join(" and ")} characters against the original's ${original}; write ${slot} with at most ${Math.floor(original * (head ? HEADLINE_ALT2_CAP : PARAGRAPH_ALT_CAP))} characters`,
        severity: "soft",
      });
    }
  }

  // The two lengths must bracket the original (2026-09-16): a paragraph
  // with both lengths under it loses a line, a headline with both over it
  // gains one, and the snippet's measure has nothing on the other side.
  {
    const all = new Map(strings);
    for (const [path, text] of all) {
      if (!path.endsWith(".body") && !path.endsWith(".headline")) continue;
      if (simulatedPart(ctx, path)) continue;
      const original = ctx.originalLengths?.get(path);
      if (original === undefined) continue;
      const altText = all.get(`${path}_alt`);
      if (altText === undefined) continue;
      const ns = [text, altText, all.get(`${path}_alt2`)]
        .filter((t): t is string => t !== undefined)
        .map((t) => t.replace(/\*/g, "").trim().length);
      const listed = ns.join(" and ");
      if (path.endsWith(".body")) {
        if (original < PARAGRAPH_MIN_CHARS || ns.some((n) => n >= original)) continue;
        soft.push({
          path,
          rule: "bracket-missing",
          excerpt: `${listed} characters, all under the original's ${original}; write ${path}_alt2 at ${Math.round(original * PARAGRAPH_ALT2_FLOOR)} to ${Math.round(original * PARAGRAPH_ALT2_CAP)}`,
          severity: "soft",
        });
      } else {
        if (original < 20 || ns.some((n) => n <= original)) continue;
        soft.push({
          path,
          rule: "bracket-missing",
          excerpt: `${listed} characters, all over the original's ${original}; write ${path}_alt2 at ${Math.round(original * HEADLINE_ALT2_FLOOR)} to ${Math.round(original * HEADLINE_ALT2_CAP)}`,
          severity: "soft",
        });
      }
    }
  }

  // Two lengths: the second headline must be longer than the first, the
  // second paragraph shorter.
  {
    const all = new Map(strings);
    for (const [path, alt] of all) {
      if (!/_alt2?$/.test(path) || simulatedPart(ctx, path)) continue;
      const main = all.get(path.replace(/_alt2?$/, ""));
      if (main === undefined) continue;
      const a = alt.replace(/\*/g, "").trim().length;
      const m = main.replace(/\*/g, "").trim().length;
      if (path.endsWith("headline_alt2") && a >= m) {
        soft.push({
          path,
          rule: "alt2-not-shorter",
          excerpt: `${a} characters against ${m}; write fewer than ${m}`,
          severity: "soft",
        });
      } else if (path.endsWith("body_alt2") && a <= m) {
        soft.push({
          path,
          rule: "alt2-not-longer",
          excerpt: `${a} characters against ${m}; write more than ${m}`,
          severity: "soft",
        });
      } else if (path.endsWith("headline_alt") && a <= m) {
        soft.push({
          path,
          rule: "alt-not-longer",
          excerpt: `${a} characters against ${m}; write more than ${m}, up to ${Math.round(m * 1.15)}`,
          severity: "soft",
        });
      } else if (path.endsWith("body_alt") && a >= m) {
        soft.push({
          path,
          rule: "alt-not-shorter",
          excerpt: `${a} characters against ${m}; write fewer than ${m}`,
          severity: "soft",
        });
      }
    }
  }

  // A length that copies another is no length (the ninth rewrite of
  // a pilot site, 2026-09-16: the third length repeated the first in 43 of 156
  // headline slots and 24 of 156 paragraph slots). Soft: the revise pass
  // writes it again, in its own words, in its own range.
  {
    const all = new Map(strings);
    for (const [path, text] of all) {
      if (!/_alt2?$/.test(path)) continue;
      const base = path.replace(/_alt2?$/, "");
      const others = path.endsWith("_alt2") ? [base, `${base}_alt`] : [base];
      const norm = normalizeForCompare(text.replace(/\*/g, ""));
      if (norm.length === 0) continue;
      const twin = others.find((o) => {
        const t = all.get(o);
        return t !== undefined && normalizeForCompare(t.replace(/\*/g, "")) === norm;
      });
      if (twin === undefined) continue;
      const original = ctx.originalLengths?.get(base);
      const range =
        original === undefined
          ? ""
          : path.endsWith("headline_alt2")
            ? ` at ${Math.round(original * HEADLINE_ALT2_FLOOR)} to ${Math.round(original * HEADLINE_ALT2_CAP)} characters`
            : path.endsWith("body_alt2")
              ? ` at ${Math.round(original * PARAGRAPH_ALT2_FLOOR)} to ${Math.round(original * PARAGRAPH_ALT2_CAP)} characters`
              : path.endsWith("headline_alt")
                ? ` at ${Math.round(original * 1.05)} to ${Math.round(original * HEADLINE_ALT_CAP)} characters`
                : ` at ${Math.round(original * PARAGRAPH_ALT_FLOOR)} to ${Math.round(original * PARAGRAPH_ALT_CAP)} characters`;
      soft.push({
        path,
        rule: "alt-copies",
        excerpt: `the same text as ${twin}; write the same idea in other words${range}`,
        severity: "soft",
      });
    }
  }

  // Emphasis markers (docs/specs/design-preserving-rewrite.md §2): one pair
  // where the page emphasises a phrase, none anywhere else, never unbalanced.
  for (const [path, text] of strings) {
    if (path.endsWith(".kind") || path.endsWith(".href")) continue;
    const ex = text.length > 90 ? `${text.slice(0, 87)}…` : text;
    const stars = (text.match(/\*/g) ?? []).length;
    const pairs = (text.match(MARKER) ?? []).length;
    const wanted = ctx.emphasisSlots?.has(path.replace(/_alt2?$/, "")) ?? false;
    if (stars % 2 === 1 || pairs * 2 !== stars) {
      hard.push({ path, rule: "emphasis-unbalanced", excerpt: ex, severity: "hard" });
    } else if (pairs > 1) {
      hard.push({ path, rule: "emphasis-count", excerpt: ex, severity: "hard" });
    } else if (pairs === 1 && !wanted) {
      hard.push({ path, rule: "emphasis-unexpected", excerpt: ex, severity: "hard" });
    } else if (pairs === 0 && wanted) {
      soft.push({ path, rule: "emphasis-missing", excerpt: ex, severity: "soft" });
    }
  }

  // Distinct slots (docs/specs/design-preserving-rewrite.md §2). The rebuilt
  // a pilot site (2026-09-14) showed the hero headline again as the section
  // headline and the two buttons with one label: 13 of 59 versions.
  const slots = [...strings].filter(([p]) => !p.endsWith(".kind") && !p.endsWith(".href"));
  const seen = new Map<string, string>();
  for (const [path, text] of slots) {
    const key = normalizeForCompare(text);
    if (key.length < 8) continue;
    const earlier = seen.get(key);
    // A headline and its own second length are the same idea by design;
    // identical text between them is the alt-not-longer rule below.
    if (earlier !== undefined && earlier.replace(/_alt2?$/, "") === path.replace(/_alt2?$/, ""))
      continue;
    if (earlier !== undefined) {
      const ex = text.length > 90 ? `${text.slice(0, 87)}…` : text;
      if (isCtaLabel(earlier) && isCtaLabel(path)) {
        soft.push({ path, rule: `cta-same-label:${earlier}`, excerpt: ex, severity: "soft" });
      } else {
        hard.push({ path, rule: `slot-duplicate:${earlier}`, excerpt: ex, severity: "hard" });
      }
      continue;
    }
    seen.set(key, path);
  }
  ctaActionFlags(new Map(strings), ctx, lang, hard, soft);

  const bodies = slots.filter(([p]) => p.endsWith(".body"));
  for (const [path, text] of bodies) {
    for (const sentence of text.split(/[.!?]/)) {
      const s = sentence.trim();
      if (s.length <= 20) continue;
      const needle = normalizeForCompare(s);
      for (const [other, otherText] of bodies) {
        if (other === path) continue;
        if (normalizeForCompare(otherText).includes(needle)) {
          hard.push({ path: other, rule: `sentence-reuse:${path}`, excerpt: s, severity: "hard" });
        }
      }
    }
  }

  return { hard, soft };
}

/**
 * Buttons keep their action (the measure-lab QA, 2026-10-05): a label may
 * change its words, never what the button does. Hard on the counted button
 * (a version that turns it into "See how" sends the counted clicks nowhere),
 * soft elsewhere. A counted button whose page words the tables read must
 * read in the version too; an unread label elsewhere passes. No version gives
 * another button the counted button's words (two "Start free" buttons, one
 * counted).
 *
 * A button nobody could read (the first outside pilot, 2026-10-12: neither its
 * words, nor its link, nor the site map gave a kind) is not skipped: a
 * version that gives it a doing label (start, contact, demo, buy, download)
 * is flagged, graded like the rest (hard on the counted button, soft
 * elsewhere). Only in a language the tables cover: elsewhere an unread
 * original is the usual case and a stray cognate would be the only evidence.
 * A reading label on such a button passes; nothing says it is wrong.
 *
 * A label also keeps its object (`cta-object-changed`, 2026-10-12): where
 * the page's own label names a thing, the version names the same thing.
 * Until it is decided whether buttons are rewritten by default, this and
 * the action rule are what protect a button.
 */
function ctaActionFlags(
  all: ReadonlyMap<string, string>,
  ctx: LintContext,
  lang: string,
  hard: LintFlag[],
  soft: LintFlag[],
): void {
  const ctas = ctx.ctas;
  if (!ctas || ctas.size === 0) return;
  const tablesRead = CTA_LANGUAGES.has(lang);
  const capOf = (path: string) => {
    const n = ctx.originalLengths?.get(path);
    return n === undefined ? "" : ` in at most ${labelCap(path, n)} characters`;
  };
  for (const [path, facts] of ctas) {
    const text = all.get(path);
    if (text === undefined) continue;
    const kind = ctaKindOfWords(text);
    const own = ctx.originalTexts?.get(path);
    const was = own ? `the page's "${own}"` : "the page's own label";
    // The object (the first outside pilot, A1.6): a label that keeps the action
    // and names another thing ("tanış olun" with the services on a button
    // that opens the products) is as wrong as one that changes the action.
    // Read from the page's own label only; graded like the action.
    if (tablesRead && own && own.length < LABEL_SIGNATURE_MAX) {
      const objects = ctaObjectsOf(own, lang);
      if (objects.length > 0 && !keepsCtaObject(text, objects)) {
        (facts.counted ? hard : soft).push({
          path,
          rule: "cta-object-changed",
          excerpt: `"${text}" names something else than ${was}${facts.counted ? ", and it is the counted button" : ""}: ${keepObjectLine(objects)}${capOf(path)}`,
          severity: facts.counted ? "hard" : "soft",
        });
      }
    }
    if (facts.kinds.size === 0) {
      if (!facts.unread || !tablesRead || kind === null || !DOING_KINDS.has(kind)) continue;
      (facts.counted ? hard : soft).push({
        path,
        rule: "cta-action-changed",
        excerpt: `"${text}" reads as ${CTA_KIND_WORDS[kind]}, but neither ${was} nor its link reads as that${facts.counted ? ", and it is the counted button" : ""}: ${KEEP_OWN_ACTION}${capOf(path)}`,
        severity: facts.counted ? "hard" : "soft",
      });
      continue;
    }
    const lost =
      kind === null ? facts.counted && facts.wordsKnown && tablesRead : !facts.kinds.has(kind);
    if (!lost) continue;
    const reads =
      kind === null ? "does not read as any action" : `reads as ${CTA_KIND_WORDS[kind]}`;
    (facts.counted ? hard : soft).push({
      path,
      rule: "cta-action-changed",
      excerpt: `"${text}" ${reads}, but this button does what ${was} does${facts.counted ? ", and it is the counted button" : ""}: write ${describeKinds(facts.kinds)}${capOf(path)}`,
      severity: facts.counted ? "hard" : "soft",
    });
  }
  // What the page shows on each button: the version's words, else its own.
  const shown = (path: string) => all.get(path) ?? ctx.originalTexts?.get(path);
  const key = (t: string) => normalizeForCompare(t.replace(/\*/g, ""));
  for (const [counted, cf] of ctas) {
    if (!cf.counted) continue;
    const words = shown(counted);
    if (!words || key(words) === "") continue;
    // The counted button's page words too: a version that swaps the two
    // labels ("See pricing" on the counted one, "Start free" on the pricing
    // one, every pricing version on measure-lab) still shows a second
    // "Start free" that is not counted.
    const own = ctx.originalTexts?.get(counted);
    const taken = new Set([key(words), ...(own ? [key(own)] : [])].filter((k) => k !== ""));
    for (const [path, f] of ctas) {
      if (f.counted || path === counted) continue;
      // Neither written by the version: the page's own, not ours to flag.
      if (!all.has(path) && !all.has(counted)) continue;
      const other = shown(path);
      if (!other || !taken.has(key(other))) continue;
      // The page's own words left on a button the version did not write.
      if (!all.has(path) && key(other) !== key(words)) continue;
      const at = all.has(path) ? path : counted;
      const facts = at === path ? f : cf;
      hard.push({
        path: at,
        rule: "cta-duplicates-counted",
        excerpt:
          at === path
            ? `"${other}" is the counted button's label (${counted}): give this button its own words, ${describeKinds(facts.kinds) || "for its own action"}${capOf(path)}`
            : `"${words}" is already the label of ${path}, which is not counted: give the counted button its own words, ${describeKinds(facts.kinds) || "for its own action"}${capOf(counted)}`,
        severity: "hard",
      });
    }
  }
}

/** Case-folded, letters and digits only, single spaces: what "the same text" means. */
export function normalizeForCompare(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function isCtaLabel(path: string): boolean {
  return path.endsWith(".cta.label") || path.endsWith(".submit_label");
}

/**
 * Sameness across a run: share of headline pairs whose word 3-gram Jaccard
 * exceeds 0.5. Reporting only.
 */
export function headlineSameness(headlines: readonly string[]): number {
  const grams = headlines.map((h) => {
    const w = h.toLowerCase().split(/\s+/).filter(Boolean);
    const g = new Set<string>();
    for (let i = 0; i + 2 < w.length; i++) g.add(`${w[i]} ${w[i + 1]} ${w[i + 2]}`);
    return g;
  });
  let pairs = 0;
  let alike = 0;
  for (let i = 0; i < grams.length; i++) {
    for (let j = i + 1; j < grams.length; j++) {
      const a = grams[i] ?? new Set<string>();
      const b = grams[j] ?? new Set<string>();
      if (a.size === 0 && b.size === 0) continue;
      pairs++;
      let inter = 0;
      for (const g of a) if (b.has(g)) inter++;
      const union = a.size + b.size - inter;
      if (union > 0 && inter / union > 0.5) alike++;
    }
  }
  return pairs === 0 ? 0 : alike / pairs;
}

/** Number → unit stems from the brief and the page samples. */
export function allowedUnitsFor(
  dna: Parameters<typeof allowedNumbersFor>[0],
  samples: readonly string[] = [],
): Map<string, Set<string>> {
  return collectUnits(briefTexts(dna, samples));
}

function briefTexts(
  dna: Parameters<typeof allowedNumbersFor>[0],
  samples: readonly string[],
): string[] {
  return [
    dna.product,
    dna.icp,
    dna.target_market,
    ...dna.value_props,
    ...dna.differentiators,
    ...dna.proof_points,
    ...Object.values(dna.per_intent_hints ?? {}).filter((v): v is string => typeof v === "string"),
    ...samples,
  ];
}

/**
 * The customer's own words, as one text: the brief and the page's own
 * sentences. What a version may take a subject from (lint/source-addressed.ts).
 */
export function ownWordsFor(
  dna: Parameters<typeof allowedNumbersFor>[0],
  samples: readonly string[] = [],
): string {
  return briefTexts(dna, samples)
    .filter((t): t is string => typeof t === "string")
    .join("\n");
}

/** Numbers the copy may use, drawn from the brief and the page samples. */
export function allowedNumbersFor(
  dna: {
    product: string;
    icp: string;
    target_market: string;
    value_props: string[];
    differentiators: string[];
    proof_points: string[];
    per_intent_hints?: Partial<Record<string, string>>;
  },
  samples: readonly string[] = [],
): Set<string> {
  return collectNumbers(briefTexts(dna, samples));
}
