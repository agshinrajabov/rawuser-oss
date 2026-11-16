/**
 * The claims lock (docs/specs/claims-lock.md): three hard rules for a
 * customer whose site is about health (`customers.sensitive = 1`). Nothing
 * here runs for any other customer.
 *
 * 1. `health-addressed`: the version states or asks about the reader's own
 *    body, health, symptoms, condition or diagnosis ("tired?", "your
 *    liver", "if you suffer from"; az "yorğunsunuz?", "qaraciyəriniz"; ru
 *    "если у вас болит"; tr "karaciğeriniz"). Tables in az, en, ru and tr;
 *    English is read on every page (a model slips into it); any other
 *    language gets the English table only. A phrase the page itself says
 *    passes.
 * 2. `claim-added`: a health or efficacy claim, a dose, a certificate or an
 *    approval, or a number, that the page's own words do not hold. By word
 *    family: a claim the page makes is allowed anywhere in its versions.
 * 3. `name-changed`: a product or brand name in the original part must
 *    appear unchanged in the version of that part. When unsure, nothing is
 *    flagged.
 *
 * "The page's own words" are the page read the generator holds plus the
 * manifest's originals; the brief does not count. Deterministic, no model
 * call. A flag carries the phrase that was read, never more of the copy.
 */

import {
  HEALTH_ADDRESSED_PATTERNS as HEALTH,
  HEALTH_SYMPTOM_NOUNS as SYMPTOM_NOUNS,
} from "@rawuser/shared";

export const HEALTH_ADDRESSED = "health-addressed";
export const CLAIM_ADDED = "claim-added";
export const NAME_CHANGED = "name-changed";

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const CLAIMS_LOCK_RULES_SET: ReadonlySet<string> = new Set([
  HEALTH_ADDRESSED,
  CLAIM_ADDED,
  NAME_CHANGED,
]);

/** What the lint is given for a sensitive customer; absent for anyone else. */
export interface ClaimsLock {
  /** The page's own words: the page read as text and the manifest's originals. */
  pageWords: string;
  /** The customer's own brand, from its domain: a first word equal to it is a name. */
  brand?: string;
}

export interface ClaimsFlag {
  rule: typeof HEALTH_ADDRESSED | typeof CLAIM_ADDED | typeof NAME_CHANGED;
  excerpt: string;
}

// ---------------------------------------------------------------------------
// 1. The reader's own health
// ---------------------------------------------------------------------------

// The health tables live in @rawuser/shared (special-category/health.ts),
// one source with the keyword screen; read here under their old names.

/** A listed noun as one word: exact, or (az, tr) with a plural and one case ending. */
const NOUN_WORD: Record<string, (noun: string) => RegExp> = {
  az: (n) => new RegExp(`^${escapeRe(n)}(?:lar|lər)?(?:dan|dən|da|də|[ıiuüaə])?$`, "u"),
  tr: (n) =>
    new RegExp(`^${escapeRe(n)}(?:lar|ler)?(?:dan|den|tan|ten|da|de|ta|te|[ıiuüae])?$`, "u"),
};
/** Question particles (az, tr) and connectors, dropped before the words are read. */
const PARTICLE = /\s*(?:mı|mi|mu|mü)$/u;
const CONNECTOR = /^(?:və|and|или|и|ve|ya|veya|or)$/u;

/** Whether a fragment is a symptom-only question. */
function nounOnlyQuestion(fragment: string, langs: readonly string[]): boolean {
  const body = fragment.replace(/\?+$/, "").trim();
  if (!fragment.trimEnd().endsWith("?") || body.length === 0) return false;
  let text = norm(body.replace(/^[^\p{L}]+|[^\p{L}\p{N}]+$/gu, ""));
  if (langs.some((l) => l === "az" || l === "tr")) text = text.replace(PARTICLE, "").trim();
  const words = text.split(/\s+/).filter((w) => w.length > 0 && !CONNECTOR.test(w));
  if (words.length === 0 || words.length > 3) return false;
  for (const lang of langs) {
    const nouns = SYMPTOM_NOUNS[lang] ?? [];
    const word = NOUN_WORD[lang] ?? ((n: string) => new RegExp(`^${escapeRe(n)}$`, "u"));
    const isNoun = (w: string) => nouns.some((n) => !n.includes(" ") && word(n).test(w));
    if (nouns.some((n) => n.includes(" ") && n === words.join(" "))) return true;
    if (words.every(isNoun)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 2. Claims, doses, certificates, numbers
// ---------------------------------------------------------------------------

/** Each entry is one word family: allowed when the page uses the family. */
const ACRONYMS = ["GMP", "ISO", "HACCP", "FDA", "EFSA", "CE", "AQTA"].map(
  (a) => new RegExp(`(?<![\\p{L}\\p{N}])${a}(?![\\p{L}\\p{N}])`, "u"),
);

const DOSES: readonly RegExp[] = [
  /\d+(?:[.,]\d+)?\s?(?:mg|mcg|µg|μg|ml|iu|мг|мл|мкг|ме)(?![\p{L}\p{N}])/iu,
  /\d+\s?(?:kapsul|kapsül|capsule|капсул|tablet|таблет)\p{L}*/iu,
];

const CLAIMS: Record<string, readonly RegExp[]> = {
  _universal: [...ACRONYMS, ...DOSES, /(?<!\p{L})(?:halal|helal|kosher|koşer)(?!\p{L})/iu],
  en: [
    /\bcure[sd]?\b|\bcuring\b/i,
    /\bheal(?:s|ed|ing)?\b/i,
    /\btreat(?:s|ed|ment|ments|ing)?\b/i,
    /\bclinical(?:ly)?\b/i,
    /\bproven\b/i,
    /\bguarantee[sd]?\b/i,
    /\beffective\b/i,
    /\bprevent(?:s|ion|ive)?\b/i,
    /\breliev(?:es|e|ed|ing)\b/i,
    /\bboost(?:s|ed|ing)?\s+(?:your\s+)?(?:immun\p{L}*|energy|metabolism)/iu,
    /\bdetox\p{L}*/iu,
    /\b(?:lose|loses|losing)\s+weight\b|\bweight\s+loss\b|\bfat\s+burn\p{L}*/iu,
    /\bsafe\b/i,
    /\bapproved\b/i,
    /\bcertif(?:ied|icate[sd]?|ication)\b/i,
    /\blicen[cs]ed\b/i,
    /\baccredited\b/i,
    /\bpharmaceutical[-\s]grade\b/i,
    /\bdoctor[-\s]recommended\b/i,
    /\bno\s+side\s+effects\b/i,
  ],
  az: [
    /(?<!\p{L})müalicə\p{L}*/iu,
    /(?<!\p{L})sağald\p{L}*/iu,
    /(?<!\p{L})sübut\s+(?:olunmuş|edilmiş|olunub|edilib)/iu,
    /(?<!\p{L})klinik\p{L}*/iu,
    /(?<!\p{L})effektiv\p{L}*/iu,
    /(?<!\p{L})zəmanət\p{L}*/iu,
    /(?<!\p{L})qarşısını\s+al\p{L}*/iu,
    /(?<!\p{L})arıqla\p{L}*/iu,
    /(?<!\p{L})detoks\p{L}*/iu,
    /(?<!\p{L})immuniteti\s+(?:gücləndir|artır|möhkəmləndir)\p{L}*/iu,
    /(?<!\p{L})təhlükəsiz\p{L}*/iu,
    /(?<!\p{L})təsdiq\p{L}*/iu,
    /(?<!\p{L})sertifikat\p{L}*/iu,
    /(?<!\p{L})lisenziya\p{L}*/iu,
    /(?<!\p{L})akkreditasiya\p{L}*/iu,
    /(?<!\p{L})dərman\p{L}*/iu,
    /(?<!\p{L})yan\s+təsir\p{L}*/iu,
  ],
  ru: [
    /(?<!\p{L})лечит(?!\p{L})|(?<!\p{L})лечени\p{L}*|(?<!\p{L})лечебн\p{L}*/iu,
    /(?<!\p{L})исцел\p{L}*|(?<!\p{L})излечив\p{L}*/iu,
    /(?<!\p{L})клиническ\p{L}*/iu,
    /(?<!\p{L})доказан\p{L}*/iu,
    /(?<!\p{L})эффективн\p{L}*/iu,
    /(?<!\p{L})гарантир\p{L}*/iu,
    /(?<!\p{L})предотвращ\p{L}*/iu,
    /(?<!\p{L})укрепляет\s+иммунитет/iu,
    /(?<!\p{L})похуд\p{L}*/iu,
    /(?<!\p{L})детокс\p{L}*/iu,
    /(?<!\p{L})безопасн\p{L}*/iu,
    /(?<!\p{L})одобрен\p{L}*/iu,
    /(?<!\p{L})сертифи\p{L}*/iu,
    /(?<!\p{L})лиценз\p{L}*/iu,
    /(?<!\p{L})аккредит\p{L}*/iu,
    /(?<!\p{L})лекарств\p{L}*/iu,
    /(?<!\p{L})без\s+побочных/iu,
    /(?<!\p{L})рекомендован\p{L}*\s+врач\p{L}*/iu,
  ],
  tr: [
    /(?<!\p{L})tedavi\p{L}*/iu,
    /(?<!\p{L})iyileştir\p{L}*/iu,
    /(?<!\p{L})şifa\p{L}*/iu,
    /(?<!\p{L})kanıtlanmış/iu,
    /(?<!\p{L})klinik\p{L}*/iu,
    /(?<!\p{L})etkili\p{L}*/iu,
    /(?<!\p{L})garanti\p{L}*/iu,
    /(?<!\p{L})önle(?:r|yici)(?!\p{L})/iu,
    /(?<!\p{L})zayıfla\p{L}*|(?<!\p{L})kilo\s+ver\p{L}*/iu,
    /(?<!\p{L})detoks\p{L}*/iu,
    /(?<!\p{L})bağışıklığı\s+güçlendir\p{L}*/iu,
    /(?<!\p{L})güvenli\p{L}*/iu,
    /(?<!\p{L})onayl\p{L}*/iu,
    /(?<!\p{L})sertifika\p{L}*/iu,
    /(?<!\p{L})lisans\p{L}*/iu,
    /(?<!\p{L})akredit\p{L}*/iu,
    /(?<!\p{L})ilaç\p{L}*/iu,
    /(?<!\p{L})yan\s+etki\p{L}*/iu,
    /(?<!\p{L})doktor\s+tavsiye\p{L}*/iu,
  ],
};

/** The same shape as lint/index.ts: separators stripped, leading zeros dropped. */
const NUMBER_RE = /\d[\d.,]*\+?/g;
const normNumber = (raw: string) => raw.replace(/[.,+]/g, "").replace(/^0+(?=\d)/, "");

// ---------------------------------------------------------------------------
// 3. Names
// ---------------------------------------------------------------------------

/** The manifest's text signature is cut at this many characters. */
const SIGNATURE_MAX = 40;

/**
 * A company's legal form, which is not a name of its own (2026-11-11).
 * The pilot's `/products` paragraph opens "Medora MMC olaraq", and the first
 * word of a sentence is skipped, so `MMC` was the only name the rule
 * protected: nine of that page's twenty-four versions had the paragraph
 * refused and left as built for dropping the suffix, while a version that
 * dropped "Medora" itself passed. Skipping a form protects it less, never
 * more, and the brand below is protected in its place.
 */
const LEGAL_FORMS: ReadonlySet<string> = new Set([
  "mmc",
  "asc",
  "as",
  "aş",
  "sti",
  "şti",
  "llc",
  "ltd",
  "inc",
  "corp",
  "co",
  "plc",
  "lp",
  "llp",
  "gmbh",
  "ag",
  "ug",
  "kg",
  "ooo",
  "zao",
  "oao",
  "pao",
  "bv",
  "nv",
  "ab",
  "oy",
  "oyj",
  "sa",
  "sas",
  "sarl",
  "sl",
  "srl",
  "spa",
]);

/**
 * The customer's brand as one lowercase word, from its domain
 * (`www.medora.test` to `medora`). Empty when the first label is too short to
 * be a name, and then no first word is protected.
 */
export function brandOf(domain: string | null | undefined): string {
  const host = (domain ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/^www\./, "");
  const label = (host.split(".")[0] ?? "").replace(/-/g, "");
  return /^[\p{L}\p{N}]{3,}$/u.test(label) ? label : "";
}

/** A token read for comparison: its letters and digits, folded. */
const bare = (t: string) => norm(t.replace(/[^\p{L}\p{N}]/gu, ""));

/**
 * The names an original part carries: an all-capitals token of two letters
 * or more, or a capitalised token of three or more, never a legal form, and
 * none at all when the original is written in title case. The first word of
 * a sentence is skipped, since its capital is the sentence's, unless it is
 * the customer's own brand. The last token is skipped when the signature was
 * cut.
 */
export function namesOf(original: string, originalLength?: number, brand = ""): string[] {
  const tokens = original
    .split(/\s+/)
    .map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return [];
  const cut =
    original.length >= SIGNATURE_MAX &&
    (originalLength === undefined || originalLength > original.length);
  const kept = cut ? tokens.slice(0, -1) : tokens;
  const words = kept.filter((t) => t.replace(/[^\p{L}]/gu, "").length >= 3);
  // Title case: three or more words written Capital-then-lowercase, and more
  // than half of the words. An all-capitals token is a name, not title case.
  const titled = words.filter((t) => /^\p{Lu}\p{Ll}/u.test(t));
  if (titled.length >= 3 && titled.length * 2 > words.length) return [];
  const raw = original.split(/\s+/).filter((t) => t.length > 0);
  const out: string[] = [];
  const brandWord = brand.length >= 3 ? norm(brand) : "";
  for (let i = 0; i < kept.length; i++) {
    const t = kept[i] as string;
    const letters = t.replace(/[^\p{L}]/gu, "");
    if (LEGAL_FORMS.has(norm(letters))) continue;
    const first = i === 0 || /[.!?:]$/.test(raw[i - 1] ?? "");
    // A sentence's first capital is the sentence's, so it names nothing;
    // the brand itself is the exception, or dropping it would pass.
    if (first && (brandWord === "" || bare(t) !== brandWord)) continue;
    const allCaps = letters.length >= 2 && /^[\p{Lu}\p{N}]+$/u.test(t);
    const capital = t.length >= 3 && /^\p{Lu}\p{Ll}{2,}/u.test(t);
    if ((allCaps || capital) && !out.includes(t)) out.push(t);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The read
// ---------------------------------------------------------------------------

function primary(lang: string): string {
  return lang.split("-")[0]?.toLowerCase() ?? lang.toLowerCase();
}

function clip(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > 60 ? `${t.slice(0, 57)}…` : t;
}

/** Lowercase for a containment check; the dotted capital İ folds to i first. */
const norm = (s: string) => s.replace(/İ/g, "i").toLowerCase().replace(/\s+/g, " ");

/**
 * Every match of `re` in `text`. The dotted capital İ of Azerbaijani and
 * Turkish does not case-fold under /iu, so the text is read with it as i;
 * the excerpt is taken from the text as written.
 */
function matches(re: RegExp, text: string): string[] {
  const read = text.replace(/İ/g, "i");
  const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`;
  const out: string[] = [];
  for (const m of read.matchAll(new RegExp(re.source, flags))) {
    out.push(text.slice(m.index ?? 0, (m.index ?? 0) + m[0].length));
  }
  return out;
}

/**
 * The claims lock on one string of a version. `original` is the page's own
 * text of that part (the manifest's signature) and `originalLength` its
 * full character count; without them the name rule is not read.
 */
export function claimsLockFlags(
  text: string,
  language: string,
  lock: ClaimsLock,
  part: { original?: string; originalLength?: number } = {},
): ClaimsFlag[] {
  const lang = primary(language);
  const plain = text.replace(/\*/g, "");
  const page = norm(lock.pageWords);
  const out: ClaimsFlag[] = [];
  const seen = new Set<string>();
  const push = (rule: ClaimsFlag["rule"], excerpt: string) => {
    const key = `${rule}|${excerpt}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ rule, excerpt: clip(excerpt) });
  };

  // 1. The reader's own health, unless the page itself says the phrase.
  const healthTables = lang === "en" ? [HEALTH.en] : [HEALTH[lang], HEALTH.en];
  for (const table of healthTables) {
    for (const re of table ?? []) {
      for (const m of matches(re, plain)) {
        const phrase = m.replace(/^[.!?]\s*/, "");
        if (page.includes(norm(phrase))) continue;
        push(HEALTH_ADDRESSED, phrase);
      }
    }
  }
  // A bare symptom question, unless the page itself asks it.
  const langs = lang === "en" ? ["en"] : [lang, "en"];
  for (const fragment of plain.split(/(?<=[.!?…])\s+|\n+/)) {
    if (!nounOnlyQuestion(fragment, langs)) continue;
    if (page.includes(norm(fragment.replace(/\?+$/, "").trim()))) continue;
    push(HEALTH_ADDRESSED, fragment.trim());
  }

  // 2. A claim family the page does not use; a number the page does not hold.
  const claimTables = [CLAIMS._universal, lang === "en" ? undefined : CLAIMS[lang], CLAIMS.en];
  const flaggedSpans: string[] = [];
  for (const table of claimTables) {
    for (const re of table ?? []) {
      const found = matches(re, plain);
      if (found.length === 0) continue;
      if (matches(re, lock.pageWords).length > 0) continue;
      for (const m of found) {
        flaggedSpans.push(m);
        push(CLAIM_ADDED, m);
      }
    }
  }
  const pageNumbers = new Set<string>();
  for (const n of lock.pageWords.match(NUMBER_RE) ?? []) pageNumbers.add(normNumber(n));
  for (const n of plain.match(NUMBER_RE) ?? []) {
    if (pageNumbers.has(normNumber(n))) continue;
    if (flaggedSpans.some((s) => s.includes(n))) continue;
    push(CLAIM_ADDED, n);
  }

  // 3. A name of the original part, missing from the version.
  if (part.original) {
    for (const name of namesOf(part.original, part.originalLength, lock.brand ?? "")) {
      if (new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(name)}`, "u").test(plain)) continue;
      push(NAME_CHANGED, name);
    }
  }
  return out;
}

/** What to do about each rule, for the revise pass and the part's own call. */
export const CLAIMS_LOCK_FIX: Record<string, string> = {
  [HEALTH_ADDRESSED]:
    "say nothing about the reader's own body, health, symptoms, condition or diagnosis: no question or statement aimed at the reader's health; write about the product and the company",
  [CLAIM_ADDED]:
    "no health or efficacy claim, dose, certificate, approval or number the page itself does not state; drop it or say only what the page says",
  [NAME_CHANGED]:
    "keep the product or brand name of the page's own text, spelled exactly as the page spells it",
};
