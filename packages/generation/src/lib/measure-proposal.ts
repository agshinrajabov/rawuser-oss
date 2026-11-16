/**
 * The button to count, proposed while the captured page is in hand
 * (docs/specs/measure-at-go-live.md, section 4). No model call.
 *
 * Candidates: the four conversion slots in the manifest the chain just
 * detected, unless detection marked one `conversion_candidate: false` or
 * its selectors did not match exactly once (`uncertain_paths`). Ranking:
 * the slot (hero 4, form submit 3, call-to-action 2, pricing 1), action
 * words +3, a link that leaves the page (or a form submit) +2, a same-page
 * anchor -2, reading words -2; ties go to the earlier slot.
 *
 * The link is read from the capture here and never returned: what leaves
 * this module is a slot name and the button's own words (page facts, like
 * the manifest), and the CSS selectors that matched once on each page, for
 * the go-live write (section 6).
 */

import type { Goes, Manifest, SiteKindOrNone } from "@rawuser/shared";
import { type HTMLElement, parse } from "node-html-parser";

/** The four slots a test can count, in tie-break order (spec section 4). */
export const COUNT_SLOTS = [
  "hero.cta.label",
  "forms.submit_label",
  "cta.cta.label",
  "pricing.cta.label",
] as const;

const SLOT_POINTS: Record<string, number> = {
  "hero.cta.label": 4,
  "forms.submit_label": 3,
  "cta.cta.label": 2,
  "pricing.cta.label": 1,
};

/** What a slot is called when the button has no words of its own. */
const SLOT_NAMES: Record<string, string> = {
  "hero.cta.label": "Hero button",
  "forms.submit_label": "Form submit button",
  "cta.cta.label": "Call-to-action button",
  "pricing.cta.label": "Pricing button",
};

export type ConversionLabel =
  | "trial_start"
  | "signup"
  | "demo_request"
  | "waitlist"
  | "purchase"
  | "contact"
  | "download"
  | "other";

// ---------------------------------------------------------------------------
// Words (en, az, ru, tr). A pattern is whole words; a trailing * makes the
// last word a prefix (Russian and Azerbaijani endings).
// ---------------------------------------------------------------------------

/** First match wins, so the narrow kinds come before signup. */
const LABEL_WORDS: ReadonlyArray<[ConversionLabel, readonly string[]]> = [
  [
    "waitlist",
    [
      "waitlist",
      "wait list",
      "waiting list",
      "early access",
      "gözləmə siyahı*",
      "лист ожидания",
      "список ожидания",
      "списке ожидания",
      "ранний доступ",
      "bekleme listesi*",
      "erken erişim",
    ],
  ],
  [
    "demo_request",
    [
      "demo",
      "book",
      "schedule*",
      "talk to sales",
      "görüş*",
      "демо",
      "забронир*",
      "запросить демо",
      "randevu*",
    ],
  ],
  [
    "trial_start",
    [
      "free trial",
      "try*",
      "start free",
      "start for free",
      "start trial",
      "sına*",
      "yoxla*",
      "pulsuz*",
      "попроб*",
      "бесплатн*",
      "пробн*",
      "dene*",
      "ücretsiz*",
    ],
  ],
  [
    "purchase",
    [
      "buy*",
      "purchase",
      "order",
      "checkout",
      "check out",
      "upgrade",
      "add to cart",
      "get pro",
      "al",
      "satın al",
      "sifariş*",
      "куп*",
      "заказ*",
      "оформить заказ",
      "sipariş*",
    ],
  ],
  [
    "contact",
    [
      "contact*",
      "get in touch",
      "talk to us",
      "message us",
      "write to us",
      // A form's Send button (pilot-gaps.md, E1.1): its click is counted.
      "send*",
      "submit",
      "əlaqə*",
      "bizə yaz*",
      "göndər*",
      "связаться",
      "свяж*",
      "напишите*",
      "написать*",
      "контакт*",
      "отправ*",
      "iletişim*",
      "bize ulaş*",
      "gönder*",
    ],
  ],
  [
    "download",
    [
      "download*",
      "install*",
      "get the app",
      "yüklə*",
      "скачать",
      "скача*",
      "установ*",
      "indir*",
      "yükle*",
    ],
  ],
  [
    "signup",
    [
      "sign up",
      "signup",
      "register*",
      "create account",
      "create an account",
      "create your account",
      "get started",
      "start*",
      "join*",
      "subscribe*",
      "qeydiyyat*",
      "hesab yarat*",
      "başla*",
      "qoşul*",
      "abunə*",
      "зарегистр*",
      "регистрац*",
      "создать аккаунт",
      "начать",
      "начни*",
      "присоедин*",
      "записаться",
      "подписаться",
      "kaydol*",
      "kayıt ol*",
      "üye ol*",
      "hesap oluştur*",
      "katıl*",
      "abone ol*",
    ],
  ],
];

/** Action words that are no kind of their own ("Get it", "Əldə et"). */
const GENERIC_ACTION = ["get", "əldə et*", "получить", "получи*", "edin*", "hemen"];

const READING_WORDS = [
  "learn*",
  "see how",
  "read",
  "read more",
  "how it works",
  "watch*",
  "explore*",
  "discover*",
  "see more",
  "ətraflı*",
  "daha çox",
  "oxu*",
  "necə*",
  "bax",
  "öyrən*",
  "подробнее",
  "узнать*",
  "читать*",
  "как это работает",
  "смотреть",
  "посмотр*",
  "daha fazla*",
  "detay*",
  "incele*",
  "keşfet*",
  "nasıl*",
  "oku*",
];

/** Lower case, Turkish dotted capital folded, punctuation and arrows to spaces, padded. */
function norm(s: string): string {
  const t = s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/̇/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  return ` ${t} `;
}

function matches(text: string, pattern: string): boolean {
  if (pattern.endsWith("*")) return text.includes(norm(pattern.slice(0, -1)).trimEnd());
  return text.includes(norm(pattern));
}

function anyOf(text: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => matches(text, p));
}

/** The closed `conversion_label` for a button's words; the customer never sees it. */
export function conversionLabelOf(words: string): ConversionLabel {
  const t = norm(words);
  for (const [label, patterns] of LABEL_WORDS) if (anyOf(t, patterns)) return label;
  return "other";
}

/**
 * The label for a count slot's button: its words first; a form's submit
 * button whose words say nothing ("Go", "OK") is `contact`, since the click
 * on it is what a contact form counts (E1.1, the privacy review's Q3).
 */
export function conversionLabelFor(sectionPath: string, words: string): ConversionLabel {
  const byWords = conversionLabelOf(words);
  if (byWords === "other" && sectionPath === "forms.submit_label") return "contact";
  return byWords;
}

export function isActionWords(words: string): boolean {
  return conversionLabelOf(words) !== "other" || anyOf(norm(words), GENERIC_ACTION);
}

export function isReadingWords(words: string): boolean {
  return anyOf(norm(words), READING_WORDS);
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

type Root = ReturnType<typeof parse>;

function parsePage(html: string): Root | null {
  try {
    return parse(html);
  } catch {
    return null;
  }
}

/** The CSS selectors of a list that match exactly one element on the page. */
function onceIn(root: Root | null, css: readonly string[]): string[] {
  if (!root) return [];
  return css.filter((sel) => {
    try {
      return root.querySelectorAll(sel).length === 1;
    } catch {
      return false;
    }
  });
}

/** The CSS selectors per count slot that match exactly once on this page. */
export function onceSelectors(html: string, manifest: Manifest): Record<string, string[]> {
  const root = parsePage(html);
  const out: Record<string, string[]> = {};
  for (const slot of COUNT_SLOTS) {
    const entry = manifest[slot];
    if (!entry || entry.conversion_candidate === false) continue;
    const once = onceIn(root, entry.css ?? []);
    if (once.length > 0) out[slot] = once;
  }
  return out;
}

export type LinkKind = "leaves" | "anchor" | "none";

const trimSlash = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);

/** Where the button goes, read from the page and never kept. */
export function linkKindOf(el: HTMLElement, pagePath: string): LinkKind {
  const a = el.tagName === "A" ? el : el.closest("a");
  const href = a?.getAttribute("href")?.trim();
  if (href !== undefined && href !== "") {
    if (href.startsWith("#")) return "anchor";
    if (/^javascript:/i.test(href)) return "none";
    let url: URL;
    try {
      url = new URL(href, `https://page.invalid${pagePath}`);
    } catch {
      return "none";
    }
    if (url.host === "page.invalid" && trimSlash(url.pathname) === trimSlash(pagePath)) {
      return url.hash ? "anchor" : "none";
    }
    return "leaves";
  }
  const tag = el.tagName;
  const type = (el.getAttribute("type") ?? "").toLowerCase();
  const submits =
    (tag === "BUTTON" && (type === "" || type === "submit")) ||
    (tag === "INPUT" && (type === "submit" || type === "image"));
  if (submits && el.closest("form")) return "leaves";
  return "none";
}

/** `tel:`, `mailto:`, WhatsApp and Telegram links: a contact the visitor opens. */
const CONTACT_SCHEMES = /^(?:tel|mailto|sms|whatsapp|viber|skype):/i;
const CONTACT_HOSTS =
  /^(?:www\.)?(?:wa\.me|api\.whatsapp\.com|chat\.whatsapp\.com|t\.me|telegram\.me)$/i;

/** Where a link leads, for the readiness check: the kind of its target page, when known. */
export type PageKindOf = (path: string, text: string) => SiteKindOrNone | null;

/**
 * Where the button goes, as the closed word `conversion_targets.goes` holds
 * (docs/specs/readiness-check.md, check 2; shared readiness.ts GOES_WORDS).
 * Read from the element and dropped: the href, the host and the target path
 * never leave this function. `host` is the customer's own host, so an
 * absolute link to it reads as same-site; without one, only a relative link
 * does. `kindOf` is the site map's answer for a same-site path (a `start`
 * page is an action, every other page a visit).
 */
export function goesOf(
  el: HTMLElement,
  pagePath: string,
  host: string | null = null,
  kindOf: PageKindOf | null = null,
): Goes {
  const a = el.tagName === "A" ? el : el.closest("a");
  const href = a?.getAttribute("href")?.trim();
  if (href !== undefined && href !== "") {
    if (href.startsWith("#")) return "anchor";
    if (/^javascript:/i.test(href)) return "none";
    if (CONTACT_SCHEMES.test(href)) return "contact_link";
    const base = host && host !== "" ? host.toLowerCase() : "page.invalid";
    let url: URL;
    try {
      url = new URL(href, `https://${base}${pagePath}`);
    } catch {
      return "none";
    }
    if (CONTACT_HOSTS.test(url.hostname)) return "contact_link";
    if (url.protocol !== "http:" && url.protocol !== "https:") return "none";
    const own = url.hostname.replace(/^www\./, "") === base.replace(/^www\./, "");
    if (!own) return "leaves_site";
    if (trimSlash(url.pathname) === trimSlash(pagePath)) return url.hash ? "anchor" : "none";
    const kind = kindOf ? kindOf(url.pathname, (a?.text ?? "").replace(/\s+/g, " ").trim()) : null;
    return kind === "start" ? "start_page" : "same_site";
  }
  return linkKindOf(el, pagePath) === "leaves" ? "form" : "none";
}

/**
 * The page shows a phone, email, WhatsApp or Telegram link (the hint of
 * check 2: such a link that is not counted). A yes or no, never the link.
 */
export function pageHasContactLink(html: string): boolean {
  const root = parsePage(html);
  if (!root) return false;
  for (const a of root.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href")?.trim() ?? "";
    if (CONTACT_SCHEMES.test(href)) return true;
    try {
      if (CONTACT_HOSTS.test(new URL(href, "https://page.invalid/").hostname)) return true;
    } catch {
      // Not a link that resolves: not a contact link either.
    }
  }
  return false;
}

export interface ScoredButton {
  section_path: string;
  label: string;
  score: number;
  /** Where it goes (goesOf); `none` when the page has no element for it. */
  goes: Goes;
}

function wordsOf(entry: Manifest[string], el: HTMLElement | null, slot: string): string {
  const fromManifest = (entry.text?.[0] ?? "").trim();
  if (fromManifest) return fromManifest;
  const fromPage = (el?.text ?? el?.getAttribute("value") ?? "").replace(/\s+/g, " ").trim();
  if (fromPage) return fromPage.slice(0, 40);
  return SLOT_NAMES[slot] ?? slot;
}

/**
 * Every candidate, best first: the proposal is the first, the rest are the
 * other buttons the Look row lists. Empty: "No main button found".
 */
export function rankButtons(
  html: string,
  manifest: Manifest,
  uncertain: readonly string[],
  pagePath: string,
  site: { host?: string | null; kindOf?: PageKindOf | null } = {},
): ScoredButton[] {
  const root = parsePage(html);
  const skip = new Set(uncertain);
  const out: Array<ScoredButton & { order: number }> = [];
  COUNT_SLOTS.forEach((slot, order) => {
    const entry = manifest[slot];
    if (!entry || entry.conversion_candidate === false || skip.has(slot)) return;
    const once = onceIn(root, entry.css ?? []);
    const el = once[0] && root ? (root.querySelector(once[0]) as HTMLElement | null) : null;
    const label = wordsOf(entry, el, slot);
    let score = SLOT_POINTS[slot] ?? 0;
    if (isActionWords(label)) score += 3;
    if (isReadingWords(label)) score -= 2;
    const link = el ? linkKindOf(el, pagePath) : "none";
    if (link === "leaves") score += 2;
    if (link === "anchor") score -= 2;
    const goes = el ? goesOf(el, pagePath, site.host ?? null, site.kindOf ?? null) : "none";
    out.push({ section_path: slot, label, score, goes, order });
  });
  out.sort((a, b) => b.score - a.score || a.order - b.order);
  return out.map(({ section_path, label, score, goes }) => ({ section_path, label, score, goes }));
}
