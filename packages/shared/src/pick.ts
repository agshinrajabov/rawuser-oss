import type { ChoiceClient } from "./choice.ts";
import type { WrapMetrics, WrapWidth } from "./wrap.ts";
/**
 * Pick on the page (docs/specs/visual-picker.md), shared by the edge, the
 * generation worker, the dashboard and the picker module.
 *
 * The operator opens their own page with `?rawuser_pick=<token>`; the
 * snippet loads the picker; the picker reads the seed manifest from the
 * edge, lets the operator confirm or reassign elements, and posts the
 * result back under the same token. Selectors and short text signatures
 * only; never the DOM, never a visitor.
 */

// page-groups.ts imports segmentHoldsIdentifier from here; the cycle is
// safe because each side calls the other only at run time, never at load.
import { countPageIsGroup, pageGroupMatches } from "./page-groups.ts";
import { normalizePath } from "./path.ts";
import type { ElementTargets, InlineShape, Manifest } from "./types.ts";

export const PICK_PARAM = "rawuser_pick";
export const PICK_TTL_S = 15 * 60;
/** How many times the seed may be read under one token (a reload or two while picking). */
export const PICK_MAX_SEED_READS = 3;

/** The slots Rawuser personalises, in display order, with operator labels. */
export const PICK_SLOTS: ReadonlyArray<{ path: string; label: string; conversion: boolean }> = [
  { path: "hero.headline", label: "Hero headline", conversion: false },
  { path: "hero.body", label: "Hero text", conversion: false },
  { path: "hero.cta.label", label: "Hero button", conversion: true },
  { path: "cta.cta.label", label: "Call-to-action button", conversion: true },
  { path: "features.headline", label: "Features headline", conversion: false },
  { path: "features.body", label: "Features text", conversion: false },
  { path: "pricing.cta.label", label: "Pricing button", conversion: true },
  { path: "forms.submit_label", label: "Form submit button", conversion: true },
];

const SLOT_PATHS = new Set(PICK_SLOTS.map((s) => s.path));

export function pickTokenKey(token: string): string {
  return `pick-token:${token}`;
}

export function pickKey(customerId: string, pagePath: string): string {
  return `pick:${customerId}:${pagePath}`;
}

export interface PickTokenMeta {
  customer_id: string;
  page_path: string;
  /** The manifest the picker starts from (detected or confirmed); may be empty. */
  manifest: Manifest;
  /** Seed reads so far; the token is refused after PICK_MAX_SEED_READS. */
  reads?: number;
  /**
   * "count": a count-only pick (docs/specs/visual-picker.md §9). One slot,
   * the button to count; the result becomes a conversion target, never a
   * manifest. Absent: the eight-slot manifest pick.
   */
  mode?: "count" | "choice";
  /**
   * "choice": the operator's preview of the visitor's own choice
   * (docs/specs/direct-visitors.md §2): the question as a browser would get
   * it, drawn on the operator's own page only. Nothing is picked or stored.
   */
  choice?: ChoiceClient;
}

export interface PickStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

const MAX_CSS = 3;
const MAX_CSS_LEN = 300;
const MAX_TEXT = 1;
const MAX_TEXT_LEN = 40;
const MAX_STRUCTURAL_LEN = 120;

function strings(v: unknown, max: number, maxLen: number): string[] | null {
  if (!Array.isArray(v) || v.length > max) return null;
  const out: string[] = [];
  for (const s of v) {
    if (typeof s !== "string" || s.length === 0 || s.length > maxLen) return null;
    out.push(s);
  }
  return out;
}

function count(v: unknown): number | undefined | null {
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 100000) return null;
  return v;
}

const ICONS = new Set(["none", "leading", "trailing", "both"]);

/** The inline shape as the picker posts it: closed enum, small ints, a short phrase. */
export function validateInline(v: unknown): InlineShape | null {
  if (!v || typeof v !== "object") return null;
  const s = v as Record<string, unknown>;
  if (typeof s.icons !== "string" || !ICONS.has(s.icons)) return null;
  if (
    typeof s.emphasis !== "number" ||
    !Number.isInteger(s.emphasis) ||
    s.emphasis < 0 ||
    s.emphasis > 4
  )
    return null;
  if (typeof s.split !== "boolean" || typeof s.animated_text !== "boolean") return null;
  const out: InlineShape = {
    icons: s.icons as InlineShape["icons"],
    emphasis: s.emphasis,
    split: s.split,
    animated_text: s.animated_text,
  };
  // Lines the page cut at runtime are seen only by the picker (GSAP
  // SplitText splits after the server HTML): a small count, 2 to 8.
  if (s.lines !== undefined) {
    if (typeof s.lines !== "number" || !Number.isInteger(s.lines) || s.lines < 2 || s.lines > 8)
      return null;
    out.lines = s.lines;
  }
  if (s.letters === true) out.letters = true;
  if (s.emphasis_phrase !== undefined) {
    if (typeof s.emphasis_phrase !== "string" || s.emphasis_phrase.length > 60) return null;
    if (s.emphasis_phrase.length > 0) out.emphasis_phrase = s.emphasis_phrase;
  }
  return out;
}

const WIDTHS = new Set([1280, 768, 390]);
const MAX_CHARS = 200;

const num = (v: unknown, lo: number, hi: number): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;

/**
 * The picker's wrap measurement (docs/specs/interactive-text.md §3.4):
 * page facts in fixed bounds, each width at most once, a table of at most
 * 200 single characters. Null when anything is off.
 */
export function validateMetrics(v: unknown): WrapMetrics | null {
  if (!v || typeof v !== "object") return null;
  const m = v as Record<string, unknown>;
  if (m.v !== 1 || !["plain", "template", "lines"].includes(m.kind as string)) return null;
  if (m.upper !== undefined && typeof m.upper !== "boolean") return null;
  if (!m.chars || typeof m.chars !== "object" || Array.isArray(m.chars)) return null;
  const chars: Record<string, number> = {};
  const entries = Object.entries(m.chars as Record<string, unknown>);
  if (entries.length === 0 || entries.length > MAX_CHARS) return null;
  for (const [c, w] of entries) {
    if (Array.from(c).length !== 1 || !num(w, 0, 400)) return null;
    chars[c] = Math.round(w * 10) / 10;
  }
  if (!Array.isArray(m.widths) || m.widths.length === 0 || m.widths.length > 3) return null;
  const widths: WrapWidth[] = [];
  const seen = new Set<number>();
  for (const raw of m.widths) {
    if (!raw || typeof raw !== "object") return null;
    const x = raw as Record<string, unknown>;
    if (!num(x.w, 0, 4000) || !WIDTHS.has(x.w) || seen.has(x.w)) return null;
    seen.add(x.w);
    if (!num(x.size, 4, 400) || !num(x.box, 1, 4000) || !num(x.ls, -50, 50) || !num(x.k, 0.5, 2))
      return null;
    if (!num(x.lines, 1, 40) || !Number.isInteger(x.lines)) return null;
    const at: WrapWidth = { w: x.w, size: x.size, box: x.box, ls: x.ls, k: x.k, lines: x.lines };
    if (x.glyphs !== undefined) {
      if (
        !Array.isArray(x.glyphs) ||
        x.glyphs.length > 12 ||
        !x.glyphs.every((g) => num(g, 0, 2000))
      )
        return null;
      at.glyphs = x.glyphs as number[];
    }
    if (x.tl !== undefined) {
      if (
        !Array.isArray(x.tl) ||
        x.tl.length > 12 ||
        !x.tl.every((n) => num(n, 0, 40) && Number.isInteger(n))
      )
        return null;
      at.tl = x.tl as number[];
    }
    if (x.lw !== undefined) {
      if (!Array.isArray(x.lw) || x.lw.length > 12 || !x.lw.every((n) => num(n, 0, 20000)))
        return null;
      at.lw = x.lw as number[];
    }
    if (x.ra !== undefined) {
      if (!num(x.ra, 0, 12) || !Number.isInteger(x.ra)) return null;
      at.ra = x.ra;
    }
    widths.push(at);
  }
  return {
    v: 1,
    kind: m.kind as WrapMetrics["kind"],
    ...(m.upper ? { upper: true } : {}),
    chars,
    widths,
  };
}

/**
 * Validates a manifest posted by the picker. Only known slots, bounded
 * strings, integer counts, boolean flag. Returns null on any violation.
 */
export function validatePickedManifest(input: unknown): Manifest | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const out: Manifest = {};
  for (const [path, raw] of Object.entries(input as Record<string, unknown>)) {
    if (!SLOT_PATHS.has(path)) return null;
    if (!raw || typeof raw !== "object") return null;
    const e = raw as Record<string, unknown>;
    const css = strings(e.css, MAX_CSS, MAX_CSS_LEN);
    const text = strings(e.text, MAX_TEXT, MAX_TEXT_LEN);
    if (css === null || css.length === 0 || text === null) return null;
    if (
      typeof e.structural !== "string" ||
      e.structural.length === 0 ||
      e.structural.length > MAX_STRUCTURAL_LEN
    )
      return null;
    const chars = count(e.original_char_length);
    const words = count(e.original_word_count);
    if (chars === null || words === null) return null;
    if (e.conversion_candidate !== undefined && typeof e.conversion_candidate !== "boolean")
      return null;
    const entry: ElementTargets = { css, text, structural: e.structural };
    if (chars !== undefined) entry.original_char_length = chars;
    if (words !== undefined) entry.original_word_count = words;
    if (typeof e.conversion_candidate === "boolean")
      entry.conversion_candidate = e.conversion_candidate;
    if (e.inline !== undefined) {
      const inline = validateInline(e.inline);
      if (inline === null) return null;
      entry.inline = inline;
    }
    if (e.skip !== undefined) {
      if (typeof e.skip !== "boolean") return null;
      entry.skip = e.skip;
    }
    if (e.plain !== undefined) {
      if (typeof e.plain !== "boolean") return null;
      entry.plain = e.plain;
    }
    // A measurement that does not pass is left out, never the whole pick:
    // the page is still written, only without the wrap simulation.
    if (e.metrics !== undefined) {
      const m = validateMetrics(e.metrics);
      if (m) entry.metrics = m;
    }
    out[path] = entry;
  }
  return out;
}

export type PickSeedOutcome =
  | {
      status: 200;
      body: {
        page_path: string;
        manifest: Manifest;
        slots: typeof PICK_SLOTS;
        mode?: "count" | "choice";
        choice?: ChoiceClient;
      };
    }
  | { status: 400 | 403; body: { error: string } };

/**
 * GET side: the seed manifest for a live token. The token is not burned
 * (the operator may reload while picking) but it is counted: after
 * PICK_MAX_SEED_READS the token is deleted, and it lives fifteen minutes
 * like the capture token (privacy review condition, 2026-09-12).
 */
export async function readPickSeed(token: unknown, store: PickStore): Promise<PickSeedOutcome> {
  if (typeof token !== "string" || token.length === 0 || token.length > 64) {
    return { status: 400, body: { error: "token is required" } };
  }
  const key = pickTokenKey(token);
  const meta = await store.get(key);
  if (meta === null) return { status: 403, body: { error: "invalid or expired token" } };
  let parsed: PickTokenMeta;
  try {
    parsed = JSON.parse(meta) as PickTokenMeta;
  } catch {
    return { status: 403, body: { error: "invalid token state" } };
  }
  const reads = (parsed.reads ?? 0) + 1;
  if (reads > PICK_MAX_SEED_READS) {
    await store.delete(key);
    return {
      status: 403,
      body: { error: "this link was opened too many times; create a new one" },
    };
  }
  await store.put(key, JSON.stringify({ ...parsed, reads }), { expirationTtl: PICK_TTL_S });
  if (parsed.mode === "count") {
    return {
      status: 200,
      body: {
        page_path: parsed.page_path,
        manifest: parsed.manifest ?? {},
        slots: [COUNT_SLOT],
        mode: "count",
      },
    };
  }
  if (parsed.mode === "choice") {
    // One-time: the preview link opens once (docs/specs/direct-visitors.md §2).
    await store.delete(key);
    return {
      status: 200,
      body: {
        page_path: parsed.page_path,
        manifest: {},
        slots: [],
        mode: "choice",
        ...(parsed.choice ? { choice: { ...parsed.choice, p: 1 as const } } : {}),
      },
    };
  }
  return {
    status: 200,
    body: { page_path: parsed.page_path, manifest: parsed.manifest ?? {}, slots: PICK_SLOTS },
  };
}

export type PickOutcome =
  | { status: 200; body: { ok: true; page_path: string; customer_id: string; elements: number } }
  | { status: 400 | 403; body: { error: string } };

/** POST side: validate, store under the customer/path key, burn the token. */
export async function receivePick(
  payload: unknown,
  store: PickStore,
): Promise<PickOutcome | CountPickOutcome> {
  const params = (payload ?? {}) as { token?: unknown; manifest?: unknown; button?: unknown };
  if (typeof params.token !== "string" || params.token.length === 0 || params.token.length > 64) {
    return { status: 400, body: { error: "token is required" } };
  }
  // The count-only picker posts `button`, never `manifest` (§9).
  if (params.button !== undefined) return receiveCountPick(payload, store);
  const manifest = validatePickedManifest(params.manifest);
  if (manifest === null || Object.keys(manifest).length === 0) {
    return { status: 400, body: { error: "manifest is missing or malformed" } };
  }
  const tokenKey = pickTokenKey(params.token);
  const meta = await store.get(tokenKey);
  if (meta === null) return { status: 403, body: { error: "invalid or expired token" } };
  let parsed: PickTokenMeta;
  try {
    parsed = JSON.parse(meta) as PickTokenMeta;
  } catch {
    return { status: 403, body: { error: "invalid token state" } };
  }
  // A count link never writes a manifest: the page's versions stay as they are.
  if (parsed.mode === "count") {
    return { status: 403, body: { error: "this link picks the button to count only" } };
  }
  // A preview of the question stores nothing.
  if (parsed.mode === "choice") {
    return { status: 403, body: { error: "this link shows the question only" } };
  }
  // A manifest for a page whose address names one account is never stored
  // (event-paths.md §8, condition 3); the mint refuses it first.
  const refusal = pagePathRefusal(parsed.page_path);
  if (refusal) return { status: 400, body: { error: refusal } };
  await store.put(pickKey(parsed.customer_id, parsed.page_path), JSON.stringify(manifest), {
    expirationTtl: PICK_TTL_S,
  });
  await store.delete(tokenKey);
  return {
    status: 200,
    body: {
      ok: true,
      page_path: parsed.page_path,
      customer_id: parsed.customer_id,
      elements: Object.keys(manifest).length,
    },
  };
}

// ---------------------------------------------------------------------------
// Count-only pick (docs/specs/visual-picker.md §9, 2026-10-05)
// ---------------------------------------------------------------------------

/** The one slot of a count link. Not a rewrite slot: never in a manifest. */
export const COUNT_SLOT = {
  path: "count.button",
  label: "The button to count",
  conversion: true,
} as const;

/**
 * A picked button is a conversion target keyed by its page:
 * `section_path = "count:" + page_path`. UNIQUE (customer_id, section_path)
 * makes it one per customer and page; no migration.
 */
export const COUNT_TARGET_PREFIX = "count:";

export function countTargetPath(pagePath: string): string {
  return `${COUNT_TARGET_PREFIX}${normalizePath(pagePath)}`;
}

/** The page a count target lives on, or null for a manifest-slot target. */
export function countTargetPage(sectionPath: string): string | null {
  return sectionPath.startsWith(COUNT_TARGET_PREFIX)
    ? sectionPath.slice(COUNT_TARGET_PREFIX.length)
    : null;
}

// ---------------------------------------------------------------------------
// A button on every page (docs/specs/visual-picker.md §9, "A button on every
// page", 2026-10-13): a counted button the site shows on every page (a nav
// "Əlaqə", a phone link). `section_path = "site:" + a slug of its words`:
// never the selector, never a path, so the row names no page. The edge
// treats it as a slot target (`conversionTargetsForPage`: no `count:`
// prefix, offered on every page), so nothing changes there.
// ---------------------------------------------------------------------------

export const SITE_TARGET_PREFIX = "site:";
/** At most this many site-wide buttons per customer. */
export const SITE_TARGETS_MAX = 5;
export const SITE_TARGETS_FULL_LINE = `You already count ${SITE_TARGETS_MAX} buttons on every page. Remove one first.`;

/** A manifest slot's path: dot-separated words (`hero.cta.label`). */
const SLOT_SECTION_PATH = /^[a-z_]+(\.[a-z_]+){1,3}$/;

export function isSiteTarget(sectionPath: string): boolean {
  return sectionPath.startsWith(SITE_TARGET_PREFIX);
}

/**
 * A target offered on every page that is not a manifest slot: a `site:`
 * one, or a selector typed by hand into the section path before `site:`
 * existed (the pilot's `a[href$=contact]`, 2026-10-13). The dashboard says
 * "on every page" for both.
 */
export function isSiteWideTarget(sectionPath: string): boolean {
  return !sectionPath.startsWith(COUNT_TARGET_PREFIX) && !SLOT_SECTION_PATH.test(sectionPath);
}

const LATIN_EXTRA: Readonly<Record<string, string>> = {
  ə: "e",
  ı: "i",
  ğ: "g",
  ş: "s",
  ç: "c",
  ö: "o",
  ü: "u",
  ß: "ss",
  æ: "ae",
  ø: "o",
  đ: "d",
  ł: "l",
};
const CYRILLIC = "абвгдеёжзийклмнопрстуфхцчшщъыьэюяіїєғқңөүұһ";
const CYRILLIC_LATIN = [
  "a",
  "b",
  "v",
  "g",
  "d",
  "e",
  "yo",
  "zh",
  "z",
  "i",
  "y",
  "k",
  "l",
  "m",
  "n",
  "o",
  "p",
  "r",
  "s",
  "t",
  "u",
  "f",
  "kh",
  "ts",
  "ch",
  "sh",
  "shch",
  "",
  "y",
  "",
  "e",
  "yu",
  "ya",
  "i",
  "yi",
  "ye",
  "g",
  "q",
  "n",
  "o",
  "u",
  "u",
  "h",
];
const SITE_SLUG_MAX = 24;

/** A `tel:` or `mailto:` link, or words that are a phone number or an address. */
export type ContactKind = "phone" | "email";
export const CONTACT_LABELS: Readonly<Record<ContactKind, string>> = {
  phone: "Phone number",
  email: "Email address",
};
/** `a[href^=tel]`, `a[href^="tel:"]`, `a[href^="mailto:x"]`: the scheme with or without its colon. */
const HREF_KIND = /href[\^$*|~]?=["']?\s*(tel|mailto)(?=:|["'\]])/i;
const PHONE_SHAPE = /^[+\d\s()./-]+$/;
const EMAIL_SHAPE_WHOLE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The kind of a contact link (privacy review, condition 1):
 * from the words first (a string of digits with spaces, `+`, `-`,
 * brackets, dots, at least five digits is a phone; one with `@` and a dot
 * is an address), then from a css candidate that names a `tel:` or
 * `mailto:` href (a hand-typed selector; the picker posts no href of its
 * own). Null for any other button.
 */
export function contactKindOf(words: string, css: readonly string[] = []): ContactKind | null {
  const t = words.replace(/\s+/g, " ").trim();
  if (t !== "" && EMAIL_SHAPE_WHOLE.test(t)) return "email";
  if (t !== "" && PHONE_SHAPE.test(t) && (t.match(/\d/g) ?? []).length >= 5) return "phone";
  for (const c of css) {
    const m = HREF_KIND.exec(c);
    if (m) return m[1]?.toLowerCase() === "tel" ? "phone" : "email";
  }
  return null;
}

/**
 * A short stable slug from a button's words: ascii letters and digits,
 * hyphen-joined, at most 24 characters ("Əlaqə" is `elaqe`, "Telefon
 * nömrəsi" is `telefon-nomresi`); `button` when nothing is left. A phone
 * number or an address is its kind word (`phone`, `email`), never the
 * digits or the address.
 */
export function siteSlugOf(words: string, css: readonly string[] = []): string {
  const kind = contactKindOf(words, css);
  if (kind !== null) return kind;
  let out = "";
  for (const ch of words.toLowerCase()) {
    const i = CYRILLIC.indexOf(ch);
    out += i >= 0 ? (CYRILLIC_LATIN[i] ?? "") : (LATIN_EXTRA[ch] ?? ch);
  }
  const slug = out
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SITE_SLUG_MAX)
    .replace(/-+$/g, "");
  return slug === "" ? "button" : slug;
}

/** `site:{slug}`, with `-2`, `-3`, ... when the path is taken. */
export function freeSiteTargetPath(slug: string, taken: ReadonlySet<string>): string {
  const base = `${SITE_TARGET_PREFIX}${slug}`;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const path = `${base}-${n}`;
    if (!taken.has(path)) return path;
  }
}

/**
 * The targets a page's answer carries: every manifest-slot target (they
 * count on every page, as before), a picked button only on the page it
 * was picked on, so a positional selector never counts another page's
 * element, and a group's button (`count:/products/*`,
 * docs/specs/page-groups.md) on a page the pattern matches that is not a
 * confirmed page (`confirmedPages`: the bundle's `pages`, or the one page
 * the database answered for; a confirmed page inside a pattern keeps its
 * own targets and gets nothing from the group). The match is the pattern's
 * own (`pageGroupMatches`): exactly one segment more than the fixed part,
 * never `/`, never the fixed part, never deeper or a longer sibling;
 * `pagePath` is the caller's `normalizePath(maskPath(path))`, so
 * `/products/:id` matches. Order: slot and exact-page targets as listed,
 * then the group's, so an exact page's own button comes first; both may be
 * in the answer (a group's pick adds, it does not replace). Without
 * `confirmedPages` (the default) no page is confirmed and a group target
 * is offered on every page it matches: a bundle from before groups still
 * matches from the target alone.
 */
export function conversionTargetsForPage<T extends { section_path: string }>(
  targets: readonly T[],
  pagePath: string,
  confirmedPages: Readonly<Record<string, unknown>> = {},
): T[] {
  const own: T[] = [];
  const group: T[] = [];
  // hasOwnProperty, not Object.hasOwn: the snippet compiles this file for ES2020.
  const confirmed = Object.prototype.hasOwnProperty.call(confirmedPages, pagePath);
  for (const t of targets) {
    const page = countTargetPage(t.section_path);
    if (page === null) own.push(t);
    else if (countPageIsGroup(page)) {
      if (!confirmed && pageGroupMatches(page, pagePath)) group.push(t);
    } else if (page === pagePath) own.push(t);
  }
  return group.length === 0 ? own : [...own, ...group];
}

/** Where the edge leaves a landed count pick for the generation hand-over. */
export function pickCountKey(customerId: string, pagePath: string): string {
  return `pick-count:${customerId}:${pagePath}`;
}

/** What a count pick carries: selectors, a 40-character signature, the page path. */
export interface CountPick {
  page_path: string;
  css: string[];
  text: string[];
  structural: string;
}

const MAX_PAGE_PATH = 200;

/** The picker's refusal lines (§9.8, conditions 1 to 3); the edge answers with the same words. */
export const COUNT_REFUSALS = {
  notButton: "Pick a link or a button.",
  account: "This button shows something about one account. Pick a button every visitor sees.",
  path: "This address belongs to one account. Pick the button on a page every visitor sees.",
} as const;

const EMAIL_SHAPE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const DIGIT_RUN = /\d{6,}/;
const ALL_DIGITS = /^\d+$/;
const UUID_SHAPE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Something about one account in a picked button's words or selectors: an
 * email shape, or six or more digits in a row (§9.8, condition 2). The
 * picker mirrors it (snippet/src/picker/selector.ts, parity test).
 */
export function holdsAccountDetail(s: string): boolean {
  return EMAIL_SHAPE.test(s) || DIGIT_RUN.test(s);
}

/**
 * A path segment that names one account or carries a secret (§9.8,
 * condition 3, widened by event-paths.md §8 conditions 1 and 2): see
 * `segmentHoldsIdentifier`. Segments are read percent-decoded too, so `%40`
 * is an `@`.
 */
export function pathHoldsIdentifier(path: string): boolean {
  return path.split("/").some(segmentHoldsIdentifier);
}

/**
 * One path segment, read as written and percent-decoded, that names one
 * account or carries a secret: the single rule behind `pathHoldsIdentifier`
 * (the count pick, the manifest pick and the add-page flow refuse the page)
 * and `maskPath` (an event row stores `:id` in its place). Flagged:
 * - an `@`;
 * - all digits, any length (`/students/482`; `/blog/2024/10` too, accepted);
 * - six or more digits in a row;
 * - a UUID;
 * - a run of 20 or more `[A-Za-z0-9_-]` that mixes letters and digits, or
 *   upper and lower case (a random token with no digit).
 * Case matters: run it on a path before it is lowercased.
 */
export function segmentHoldsIdentifier(raw: string): boolean {
  let seg = raw;
  try {
    seg = decodeURIComponent(raw);
  } catch {
    // A malformed escape is read as written.
  }
  if (seg.includes("@") || ALL_DIGITS.test(seg) || DIGIT_RUN.test(seg) || UUID_SHAPE.test(seg)) {
    return true;
  }
  for (const run of seg.match(/[A-Za-z0-9_-]{20,}/g) ?? []) {
    if (/[A-Za-z]/.test(run) && /[0-9]/.test(run)) return true;
    if (/[a-z]/.test(run) && /[A-Z]/.test(run)) return true;
  }
  return false;
}

/**
 * The refusal line for a page an operator adds or picks when its path holds
 * an identifier (event-paths.md §8, condition 3), else null. Such a page
 * could never be served once visitor paths are masked, and it is the last
 * way an identifier could reach element_manifests, manifest_health,
 * version_bodies or a KV key. Read the path as given, before it is
 * lowercased; the query and fragment are not part of it.
 */
export function pagePathRefusal(path: unknown): string | null {
  if (typeof path !== "string") return null;
  return pathHoldsIdentifier(path.split(/[?#]/, 1)[0] ?? "") ? COUNT_REFUSALS.path : null;
}

/** What a masked segment reads as. */
export const MASKED_SEGMENT = ":id";

/**
 * A page path with every segment `segmentHoldsIdentifier` flags replaced by
 * `:id`, the other segments kept as written, the query and the fragment
 * dropped (docs/specs/event-paths.md). Applied before a visitor's page path
 * is stored anywhere: `/admin/students/<uuid>` is stored as
 * `/admin/students/:id`. A path with no identifier comes back unchanged
 * (less its query and fragment), so it still finds its confirmed page.
 * Known cost, kept on purpose: a long slug that mixes words and a number
 * (`/blog/what-we-learned-in-2024`) and a dated archive (`/blog/2024/10`)
 * are masked too (event-paths.md §3, §8).
 */
export function maskPath(path: string): string {
  let p = path;
  const q = p.search(/[?#]/);
  if (q !== -1) p = p.slice(0, q);
  if (p === "") return "/";
  return p
    .split("/")
    .map((seg) => (segmentHoldsIdentifier(seg) ? MASKED_SEGMENT : seg))
    .join("/");
}

/** Which screen refuses a count pick, for the refusal line; null when none does. */
export function countPickRefusal(button: unknown, pagePath: unknown): "account" | "path" | null {
  const e = (button && typeof button === "object" ? button : {}) as Record<string, unknown>;
  const words = [e.css, e.text, e.structural]
    .flatMap((v) => (Array.isArray(v) ? v : [v]))
    .filter((v): v is string => typeof v === "string");
  if (words.some(holdsAccountDetail)) return "account";
  if (typeof pagePath === "string" && pathHoldsIdentifier(pagePath)) return "path";
  return null;
}

/**
 * Validates the picked button and the page it was picked on. Only the three
 * selector fields are copied; anything else in the payload is dropped, never
 * stored. Null on any violation.
 */
export function validateCountPick(button: unknown, pagePath: unknown): CountPick | null {
  if (!button || typeof button !== "object" || Array.isArray(button)) return null;
  const e = button as Record<string, unknown>;
  const css = strings(e.css, MAX_CSS, MAX_CSS_LEN);
  const text = strings(e.text, MAX_TEXT, MAX_TEXT_LEN);
  if (css === null || css.length === 0 || text === null) return null;
  if (
    typeof e.structural !== "string" ||
    e.structural.length === 0 ||
    e.structural.length > MAX_STRUCTURAL_LEN
  )
    return null;
  // The path only: no query, no fragment, bounded.
  if (
    typeof pagePath !== "string" ||
    !pagePath.startsWith("/") ||
    pagePath.length > MAX_PAGE_PATH ||
    /[?#\s]/.test(pagePath)
  )
    return null;
  // Nothing about one account, in the button or in the address (§9.8).
  if (countPickRefusal(button, pagePath) !== null) return null;
  return { page_path: normalizePath(pagePath), css, text, structural: e.structural };
}

export type CountPickOutcome =
  | { status: 200; body: { ok: true; page_path: string; customer_id: string; elements: 1 } }
  | { status: 400 | 403; body: { error: string } };

/**
 * POST side of a count link: validate, store under the customer and the
 * link's page for the generation hand-over, burn the token. The stored
 * `page_path` is where the button was picked (a site that redirects / to
 * /en counts it on /en, where visitors see it).
 */
export async function receiveCountPick(
  payload: unknown,
  store: PickStore,
): Promise<CountPickOutcome> {
  const params = (payload ?? {}) as { token?: unknown; button?: unknown; page_path?: unknown };
  if (typeof params.token !== "string" || params.token.length === 0 || params.token.length > 64) {
    return { status: 400, body: { error: "token is required" } };
  }
  const pick = validateCountPick(params.button, params.page_path);
  if (pick === null) {
    const refusal = countPickRefusal(params.button, params.page_path);
    return {
      status: 400,
      body: { error: refusal ? COUNT_REFUSALS[refusal] : "button is missing or malformed" },
    };
  }
  const tokenKey = pickTokenKey(params.token);
  const meta = await store.get(tokenKey);
  if (meta === null) return { status: 403, body: { error: "invalid or expired token" } };
  let parsed: PickTokenMeta;
  try {
    parsed = JSON.parse(meta) as PickTokenMeta;
  } catch {
    return { status: 403, body: { error: "invalid token state" } };
  }
  if (parsed.mode !== "count") {
    return { status: 403, body: { error: "this link is not for counting a button" } };
  }
  await store.put(pickCountKey(parsed.customer_id, parsed.page_path), JSON.stringify(pick), {
    expirationTtl: PICK_TTL_S,
  });
  await store.delete(tokenKey);
  return {
    status: 200,
    body: { ok: true, page_path: pick.page_path, customer_id: parsed.customer_id, elements: 1 },
  };
}
