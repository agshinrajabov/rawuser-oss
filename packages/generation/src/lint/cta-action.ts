/**
 * What a button does, read from its words and its link (the measure-lab QA,
 * 2026-10-05). A version may change a button's words, never its action: the
 * counted "Start free" (to /signup/) came back as "See how" and "See the
 * facts", and "See plans" (to /pricing/) came back as "Start free", so the
 * page showed two start buttons and only one was counted.
 *
 * A small closed set of kinds, word tables for the languages we write (en,
 * az, ru, tr) and the link as the tiebreaker. Deterministic, no model call.
 * The link is a page fact read in the generation worker; it never reaches a
 * visitor or an event.
 *
 * The first outside pilot (2026-10-12, docs/specs/pilot-gaps.md A1): the
 * counted "Məhsullarımızla tanış olun!" (to /products) came back as
 * "Probleminizi bizə danışın", "Pulsuz məsləhət üçün yazın" and three more,
 * with no flag. The tables read neither "tanış olun" nor "/products", so the
 * button had no kind and the rule skipped it. Since then: the missing verbs
 * are in the tables, a link whose own words say nothing is read from the
 * customer's site map (the kind only), and a button that still has no kind
 * is `unread`, which holds it to what its own label asks for.
 */

import type { SiteKindOrNone } from "@rawuser/shared";

export type CtaKind = "start" | "pricing" | "demo" | "contact" | "buy" | "download" | "learn";

/**
 * The kinds that ask the visitor to do something (sign up, write, book, pay,
 * install), against the two that only show a page (learn, pricing). A label
 * of a doing kind on a button whose own action nobody could read is the
 * pilot's defect: a conversation promised, a product list opened.
 */
export const DOING_KINDS: ReadonlySet<CtaKind> = new Set<CtaKind>([
  "start",
  "contact",
  "demo",
  "buy",
  "download",
]);

/** The languages the word tables cover; elsewhere only the link decides. */
export const CTA_LANGUAGES: ReadonlySet<string> = new Set(["en", "az", "ru", "tr"]);

/**
 * Patterns are whole words; a trailing * makes the last word a prefix (the
 * endings of Azerbaijani, Russian and Turkish). First kind that matches wins,
 * so the narrow kinds come first and the reading words last ("See plans" is
 * pricing, "See how" is learn).
 */
const KIND_WORDS: ReadonlyArray<[CtaKind, readonly string[]]> = [
  [
    "demo",
    [
      "demo",
      "demos",
      "book",
      "booking",
      "schedule*",
      "talk to sales",
      "talk to an expert",
      "görüş təyin*",
      // "Görüşək", "Görüşelim": a meeting, before the Turkish "gör*" reads it
      // as looking. Whole words: "görüşler" are a customer's opinions.
      "görüşək",
      "görüşelim",
      "демо*",
      "забронир*",
      "созвон*",
      "randevu*",
      "görüşme*",
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
      "email us",
      "mailto",
      "əlaqə*",
      "elaqe*",
      "bizə yaz*",
      // "Yazın", "Yazaq": whole words. The bare "yaz" is also a season, and
      // "yazıl*" (enrol) is a start, so no prefix here.
      "yazın",
      "yazaq",
      "danış*",
      "müraciət*",
      "muraciet*",
      "məsləhət*",
      "meslehet*",
      "konsultasiya*",
      "zəng et*",
      "zəng ed*",
      "связаться",
      "свяж*",
      "напиши*",
      "написа*",
      "позвон*",
      "обсуд*",
      "консультац*",
      "заявк*",
      "контакт*",
      "iletişim*",
      "bize ulaş*",
      "bize yaz*",
      "konuş*",
      "başvur*",
      "teklif al*",
      "bizi ara*",
    ],
  ],
  [
    "pricing",
    [
      "pricing",
      "price*",
      "plan",
      "plans",
      "cost*",
      "tiers",
      "qiymət*",
      "qiymet*",
      "planlar*",
      "planı*",
      "tarif*",
      "paket*",
      "тариф*",
      "цен*",
      "стоимост*",
      "план",
      "планы",
      "прайс*",
      "ceny",
      "fiyat*",
      "ücretlendirme*",
    ],
  ],
  [
    "buy",
    [
      "buy*",
      "purchase*",
      "order*",
      "checkout",
      "check out",
      "cart",
      "upgrade*",
      "get pro",
      "satın al*",
      "sifariş*",
      "səbət*",
      "куп*",
      "заказ*",
      "оформить заказ",
      "оплат*",
      "sipariş*",
      "sepete*",
    ],
  ],
  ["download", ["download*", "install*", "get the app", "yüklə*", "скача*", "установ*", "indir*"]],
  [
    "start",
    [
      "sign up",
      "signup",
      "register*",
      "registration",
      "create account",
      "create an account",
      "create your account",
      "get started",
      "get access",
      "start*",
      "try*",
      "trial",
      "free",
      "join*",
      "subscribe*",
      "waitlist",
      "early access",
      "onboarding",
      "begin*",
      "qeydiyyat*",
      "hesab yarat*",
      "başla*",
      "basla*",
      "pulsuz*",
      "sına*",
      "yoxla*",
      "qoşul*",
      "abunə*",
      // Enrol. Whole words: "yazılar" are articles, "yazılım" is software.
      "yazıl",
      "yazılın",
      "зарегистр*",
      "регистрац*",
      "создать аккаунт",
      "начать",
      "начни*",
      "начн*",
      // Sign up for it. Not "запис*": "записи" are recordings.
      "записаться",
      "запиш*",
      "попроб*",
      "бесплатн*",
      "пробн*",
      "присоедин*",
      "подключ*",
      "kaydol*",
      "kayıt ol*",
      "kayit*",
      "üye ol*",
      "hesap oluştur*",
      "katıl*",
      "abone ol*",
      "ücretsiz*",
      "dene*",
    ],
  ],
  [
    "learn",
    [
      "learn*",
      "see*",
      "read*",
      "how",
      "watch*",
      "explore*",
      "discover*",
      "tour",
      "compare*",
      "why",
      "details",
      "features",
      "find out",
      "docs",
      "guide*",
      "ətraflı*",
      // "Bax", "Baxın", "Baxaq": the bare word missed every polite form.
      "bax*",
      "tanış ol*",
      "araşdır*",
      "izlə*",
      "məlumat*",
      "oxu*",
      "necə*",
      "öyrən*",
      "kəşf*",
      "müqayisə*",
      "подробн*",
      "узна*",
      "читать*",
      "смотр*",
      "посмотр*",
      "изуч*",
      "ознаком*",
      "сравн*",
      "как это работает",
      "daha fazla bilgi*",
      "detay*",
      "incele*",
      "keşfet*",
      "nasıl*",
      "oku*",
      "gör*",
      "öğren*",
      "göz at*",
      "bak",
      "bakın",
      "izle*",
      "karşılaştır*",
    ],
  ],
];

/** Lower case, the Turkish dotted capital folded, punctuation and arrows to spaces, padded. */
export function norm(s: string): string {
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

/** The kind a button's words say, or null when the tables do not know them. */
export function ctaKindOfWords(words: string): CtaKind | null {
  const t = norm(words.replace(/\*/g, ""));
  if (t.trim() === "") return null;
  for (const [kind, patterns] of KIND_WORDS) {
    if (patterns.some((p) => matches(t, p))) return kind;
  }
  return null;
}

/** Hosts that only ever book a call. */
const DEMO_HOSTS = /(?:^|\.)(?:calendly\.com|cal\.com|savvycal\.com|chilipiper\.com)$/i;

/**
 * The kind a link says: mailto and tel are contact, a booking host is a
 * demo, otherwise the words of its path and fragment ("/signup/" start,
 * "/pricing/" pricing, "#how" learn). Null for the home page, an empty
 * fragment, or words the tables do not know.
 */
export function ctaKindOfHref(href: string | undefined | null): CtaKind | null {
  const h = href?.trim();
  if (!h) return null;
  if (/^(?:mailto|tel):/i.test(h)) return "contact";
  if (/^javascript:/i.test(h)) return null;
  let url: URL;
  try {
    url = new URL(h, "https://page.invalid/");
  } catch {
    return null;
  }
  if (DEMO_HOSTS.test(url.hostname)) return "demo";
  let words = `${url.pathname} ${url.hash}`;
  try {
    words = decodeURIComponent(words);
  } catch {
    // Keep the encoded form; the tables then miss it, which is safe.
  }
  return ctaKindOfWords(words.replace(/[-_/.#]+/g, " "));
}

/**
 * What a click on a link to a page of each site-map kind does
 * (docs/specs/site-shaped-intents.md §4.4). The site map's `start` covers
 * sign-up, contact and demo pages alike, so it allows all three; every page
 * that is read is `learn`. An operator's `none` says nothing.
 */
const SITE_KIND_CTA: Readonly<Record<SiteKindOrNone, readonly CtaKind[]>> = {
  price: ["pricing"],
  vs: ["learn"],
  compare: ["learn"],
  proof: ["learn"],
  features: ["learn"],
  docs: ["learn"],
  how: ["learn"],
  learn: ["learn"],
  about: ["learn"],
  start: ["start", "contact", "demo"],
  none: [],
};

/** The button kinds a link to a page of this site-map kind may carry; none for an unknown kind. */
export function ctaKindsOfSiteKind(kind: string): readonly CtaKind[] {
  return Object.prototype.hasOwnProperty.call(SITE_KIND_CTA, kind)
    ? SITE_KIND_CTA[kind as SiteKindOrNone]
    : [];
}

/** What the lint knows about one button of the page. */
export interface CtaFacts {
  /** What the page's own button does: its words' kind and its link's kind. */
  kinds: ReadonlySet<CtaKind>;
  /** The page's own words read as a kind: then the version's words must read too. */
  wordsKnown: boolean;
  /** The button whose clicks are counted (conversion_targets). */
  counted: boolean;
  /**
   * The page's label has words, and neither they, nor its link, nor the
   * site map say what the button does. Not a pass: a version may then not
   * give it a doing label (`DOING_KINDS`), it keeps what its own label asks.
   */
  unread?: boolean;
  /**
   * The page's own words on the button (the manifest's signature), set by
   * the orchestrator's `ctasOf`. The prompt says them for a counted button
   * that stays as built (lib/button-rewrite.ts): no other button may show
   * them, and the model cannot avoid words it was never shown.
   */
  own?: string;
}

/**
 * The page's facts for one button, from its words, its link and whether it
 * is counted. `siteKinds` is what the customer's own site map says of the
 * linked page (site-map/link-kinds.ts); it is read only when the link's own
 * words give no kind, so a link that names its action still decides alone.
 */
export function ctaFactsOf(
  words: string | undefined,
  href: string | undefined,
  counted: boolean,
  siteKinds: readonly CtaKind[] = [],
): CtaFacts {
  const kinds = new Set<CtaKind>();
  const byWords = words ? ctaKindOfWords(words) : null;
  const byHref = ctaKindOfHref(href);
  if (byWords) kinds.add(byWords);
  if (byHref) kinds.add(byHref);
  else for (const k of siteKinds) kinds.add(k);
  const hasWords = (words ?? "").replace(/[^\p{L}\p{N}]+/gu, "") !== "";
  return { kinds, wordsKnown: byWords !== null, counted, unread: hasWords && kinds.size === 0 };
}

/** The kinds in plain words, for the prompt, the revise pass and the targeted call. */
export const CTA_KIND_WORDS: Record<CtaKind, string> = {
  start: "a start label (sign up, start, try it free)",
  pricing: "a pricing label (see the prices or the plans)",
  demo: "a demo label (book or see a demo)",
  contact: "a contact label (get in touch)",
  buy: "a buy label (buy, order, upgrade)",
  download: "a download label (download, install)",
  learn: "a reading label (learn more, see how it works)",
};

/**
 * The same instruction for a button nobody could read, in the prompt, the
 * flag and the call for the label alone.
 */
export const KEEP_OWN_ACTION =
  "keep what the page's own label asks the visitor to do, with its verb or a close synonym, and ask for nothing it does not";

/** "a start label (…)" or "a start label (…) or a pricing label (…)". */
export function describeKinds(kinds: ReadonlySet<CtaKind>): string {
  return [...kinds].map((k) => CTA_KIND_WORDS[k]).join(" or ");
}

/** A button label path: `hero.cta.label`, `forms.submit_label`. */
export function isButtonLabelPath(path: string): boolean {
  return /\.(?:label|submit_label)$/.test(path);
}

// ---------------------------------------------------------------------------
// The object a label names (the first outside pilot, 2026-10-12, A1.6)
// ---------------------------------------------------------------------------

/**
 * After the action was fixed, 15 of the pilot's 20 labels kept the action and
 * changed the object. The page's button says "Məhsullarımızla tanış olun!"
 * and opens /products; versions said "Qablaşma xidmətlərimizlə tanış olun",
 * "Qablaşma prosesimizlə tanış olun", "Çevik etiketləmə xidmətinə baxın".
 * A reading label on a reading link, so `cta-action-changed` had nothing to
 * say, and the visitor is promised the services and gets the product list.
 *
 * The object is read from the page's own label only: its words once the
 * action words of the kind tables and the stop words are taken out, each
 * reduced to a stem ("Məhsullarımızla" to "məhsul"). The link, its path and
 * the site map are not read here, and nothing of them reaches a prompt. A
 * label that is only a verb ("Başla", "Göndər", "Learn more") names no
 * object and the rule says nothing.
 */

/**
 * Words of a button label that are neither an action of the kind tables nor
 * an object: function words, pronouns, and the plain verbs labels are made
 * of ("Göndər", "Get", "Отправить"). Same pattern form as the kind tables:
 * whole words, a trailing * for a prefix.
 */
const STOP_WORDS: Readonly<Record<string, readonly string[]>> = {
  en: [
    "a",
    "an",
    "the",
    "our",
    "your",
    "my",
    "its",
    "this",
    "that",
    "these",
    "those",
    "all",
    "any",
    "more",
    "now",
    "here",
    "today",
    "it",
    "us",
    "me",
    "you",
    "we",
    "to",
    "for",
    "of",
    "in",
    "on",
    "at",
    "by",
    "with",
    "from",
    "and",
    "or",
    "out",
    "up",
    "new",
    "full",
    "live",
    "first",
    "best",
    "top",
    "just",
    "please",
    "get",
    "go",
    "view",
    "show",
    "open",
    "check",
    "find",
    "choose",
    "select",
    "pick",
    "take",
    "make",
    "do",
    "send",
    "submit",
    "continue",
    "next",
    "back",
    "ok",
    "yes",
    "no",
    "add",
    "request",
    "ask",
    "visit",
    "browse",
    "shop",
    "click",
    "tap",
    "meet",
    "know",
    "have",
    "be",
    "is",
    "are",
    "how it works",
    "how we work",
    "works",
    "let",
    "let's",
    "lets",
    "what",
    "who",
    "where",
    "when",
  ],
  az: [
    "bizim",
    "sizin",
    "öz",
    "bu",
    "o",
    "bir",
    "hər",
    "bütün",
    "daha",
    "çox",
    "indi",
    "burada",
    "bura",
    "buradan",
    "ilə",
    "üçün",
    "və",
    "ya",
    "də",
    "da",
    "ki",
    "siz",
    "biz",
    "mən",
    "sən",
    "ən",
    "yeni",
    "tam",
    "nə",
    "kim",
    "harada",
    "ol",
    "olun",
    "olaq",
    "olmaq",
    "et",
    "edin",
    "edək",
    "etmək",
    "al",
    "alın",
    "alaq",
    "almaq",
    "ver",
    "verin",
    "verək",
    "göndər*",
    "gəl",
    "gəlin",
    "keç",
    "keçin",
    "saxla",
    "saxlayın",
    "seç",
    "seçin",
    "seçək",
    "daxil",
    "davam",
    "tap",
    "tapın",
    "aç",
    "açın",
    "gör",
    "görün",
    "get",
    "gedin",
    "gedək",
    "əldə",
    "qeyd",
    "təsdiq*",
    "axtar*",
    "soruş*",
    "bizə",
    "bizi",
    "bizdən",
    "sizə",
    "sizi",
    "mənə",
    // "Necə işləyir", "necə işlədiyimizə bax": the verb, never "işlər" (the works).
    "işləy*",
    "işləd*",
    "işləm*",
  ],
  ru: [
    "наш*",
    "ваш*",
    "мой",
    "моя",
    "мои",
    "свой",
    "свои",
    "свою",
    "это",
    "этот",
    "эта",
    "эти",
    "все",
    "всё",
    "весь",
    "вся",
    "больше",
    "ещё",
    "еще",
    "сейчас",
    "здесь",
    "тут",
    "для",
    "на",
    "в",
    "с",
    "о",
    "об",
    "и",
    "или",
    "к",
    "по",
    "у",
    "за",
    "из",
    "от",
    "до",
    "не",
    "вы",
    "мы",
    "я",
    "что",
    "кто",
    "где",
    "новый",
    "новая",
    "новые",
    "получить",
    "получи*",
    "отправить",
    "отправ*",
    "оставить",
    "оставь*",
    "задать",
    "задай*",
    "перейти",
    "перейд*",
    "открыть",
    "открой*",
    "выбрать",
    "выбер*",
    "найти",
    "найд*",
    "сделать",
    "сделай*",
    "продолжить",
    "продолж*",
    "далее",
    "войти",
    "войд*",
    "добавить",
    "добавь*",
    "запросить",
    "проверить",
    "проверь*",
    "нас",
    "нам",
    "нами",
    "вас",
    "вам",
    "вами",
    "мне",
    "меня",
    "себя",
    "работает",
  ],
  tr: [
    "bizim",
    "sizin",
    "bu",
    "şu",
    "o",
    "bir",
    "her",
    "tüm",
    "bütün",
    "daha",
    "çok",
    "şimdi",
    "hemen",
    "burada",
    "buradan",
    "ile",
    "için",
    "ve",
    "veya",
    "de",
    "da",
    "ki",
    "siz",
    "biz",
    "ben",
    "sen",
    "en",
    "yeni",
    "tam",
    "ne",
    "kim",
    "nerede",
    "et",
    "edin",
    "edelim",
    "ol",
    "olun",
    "olalım",
    "al",
    "alın",
    "alalım",
    "ver",
    "verin",
    "gönder*",
    "gel",
    "gelin",
    "geç",
    "geçin",
    "seç",
    "seçin",
    "devam",
    "bul",
    "bulun",
    "aç",
    "açın",
    "git",
    "gidin",
    "yap",
    "yapın",
    "tıkla*",
    "giriş",
    "ara",
    "arayın",
    "bize",
    "bizi",
    "size",
    "sizi",
    "bana",
    "çalışır*",
    "çalışıyor*",
    "çalıştığ*",
  ],
};

/** Dotless and dotted i as one letter, so capitals typed either way agree. */
function fold(word: string): string {
  return word.replace(/ı/g, "i");
}

/** True when the pattern (words, a trailing * for a prefix) starts at token `at`. */
function patternAt(tokens: readonly string[], at: number, pattern: string): number {
  const star = pattern.endsWith("*");
  const words = norm(star ? pattern.slice(0, -1) : pattern)
    .trim()
    .split(" ");
  if (words.length === 0 || at + words.length > tokens.length) return 0;
  for (let i = 0; i < words.length; i++) {
    const token = tokens[at + i] as string;
    const word = words[i] as string;
    const last = i === words.length - 1;
    if (last && star ? !token.startsWith(word) : token !== word) return 0;
  }
  return words.length;
}

/**
 * The endings a noun carries, taken off in the order the language puts them
 * on, each only while a stem of four letters is left. Azerbaijani and
 * Turkish stack them (stem, plural, possessive, case: "məhsul-lar-ımız-la");
 * Russian and English carry one.
 */
const LAYERS: Readonly<Record<string, ReadonlyArray<readonly string[]>>> = {
  az: [
    // Case, and "with".
    [
      "ndan",
      "ndən",
      "dan",
      "dən",
      "nda",
      "ndə",
      "nin",
      "nun",
      "nün",
      "yla",
      "ylə",
      "da",
      "də",
      "la",
      "lə",
      "ya",
      "yə",
      "na",
      "nə",
      "ni",
      "nu",
      "nü",
      "in",
      "un",
      "ün",
      "a",
      "ə",
      "i",
      "u",
      "ü",
    ],
    // Possessive.
    [
      "imiz",
      "umuz",
      "ümüz",
      "iniz",
      "unuz",
      "ünüz",
      "miz",
      "muz",
      "müz",
      "niz",
      "nuz",
      "nüz",
      "im",
      "um",
      "üm",
      "si",
      "su",
      "sü",
      "i",
      "u",
      "ü",
    ],
    // Plural.
    ["lar", "lər"],
  ],
  tr: [
    [
      "ndan",
      "nden",
      "dan",
      "den",
      "tan",
      "ten",
      "nda",
      "nde",
      "nin",
      "nun",
      "nün",
      "yla",
      "yle",
      "da",
      "de",
      "ta",
      "te",
      "la",
      "le",
      "ya",
      "ye",
      "na",
      "ne",
      "yi",
      "yu",
      "yü",
      "ni",
      "nu",
      "nü",
      "in",
      "un",
      "ün",
      "a",
      "e",
      "i",
      "u",
      "ü",
    ],
    [
      "imiz",
      "umuz",
      "ümüz",
      "iniz",
      "unuz",
      "ünüz",
      "miz",
      "muz",
      "müz",
      "niz",
      "nuz",
      "nüz",
      "im",
      "um",
      "üm",
      "si",
      "su",
      "sü",
      "i",
      "u",
      "ü",
    ],
    ["lar", "ler"],
  ],
  ru: [
    [
      "иями",
      "ями",
      "ами",
      "иях",
      "ией",
      "ию",
      "ия",
      "ие",
      "ий",
      "ов",
      "ев",
      "ей",
      "ом",
      "ем",
      "ам",
      "ям",
      "ах",
      "ях",
      "ую",
      "ая",
      "ое",
      "ые",
      "ой",
      "ый",
      "а",
      "я",
      "ы",
      "и",
      "у",
      "ю",
      "е",
      "о",
      "ь",
    ],
  ],
  en: [["ies", "es", "s"]],
};
const MIN_STEM = 4;
/** An object word shorter than this is not one ("iş", "of"); a stem may be this short ("app"). */
const MIN_OBJECT = 3;

/** The stem of a noun as a label writes it: "məhsullarımızla" to "məhsul", "products" to "product". */
export function ctaStem(word: string, lang: string): string {
  let stem = fold(word.toLowerCase());
  for (const layer of LAYERS[lang] ?? []) {
    const ending = layer.find((e) => stem.endsWith(fold(e)) && stem.length - e.length >= MIN_STEM);
    if (ending) stem = stem.slice(0, stem.length - ending.length);
  }
  return stem;
}

/** What a label names: the word as the page writes it and its stem. */
export interface CtaObject {
  word: string;
  stem: string;
}

/**
 * The objects a button label names, in a language the tables cover: its
 * words that are neither an action of the kind tables nor a stop word.
 * Empty for a label that is only a verb, and in any other language (with no
 * stop list a verb would be read as an object).
 */
export function ctaObjectsOf(label: string | undefined | null, lang: string): CtaObject[] {
  return contentWordsOf(label, lang, { dropActions: true });
}

/**
 * The content words of a short text, each with its stem: the words left once
 * the stop words are taken out, and the action words of the kind tables too
 * when `dropActions` is set (a button label; a section heading keeps them,
 * "Qiymətlər" is its subject). `alsoStop` adds stop words for the caller's
 * kind of text. Empty in a language without a stop list.
 */
export function contentWordsOf(
  text: string | undefined | null,
  lang: string,
  opts: { dropActions: boolean; alsoStop?: readonly string[] },
): CtaObject[] {
  const stops = STOP_WORDS[lang];
  if (!text || !stops) return [];
  const tokens = norm(text.replace(/\*/g, "")).trim().split(" ").filter(Boolean);
  const taken = new Array<boolean>(tokens.length).fill(false);
  const patterns = [
    ...(opts.dropActions ? KIND_WORDS.flatMap(([, list]) => list) : []),
    ...stops,
    ...(opts.alsoStop ?? []),
  ];
  for (let at = 0; at < tokens.length; at++) {
    for (const pattern of patterns) {
      const n = patternAt(tokens, at, pattern);
      for (let i = 0; i < n; i++) taken[at + i] = true;
    }
  }
  const out: CtaObject[] = [];
  tokens.forEach((token, i) => {
    if (taken[i] || !/^\p{L}+$/u.test(token) || token.length < MIN_OBJECT) return;
    const stem = ctaStem(token, lang);
    if (stem.length >= MIN_OBJECT && !out.some((o) => o.stem === stem)) {
      out.push({ word: token, stem });
    }
  });
  return out;
}

/** The length of the prefix two words share. */
function sharedPrefix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

/**
 * True when a version's label still names one of the page label's objects:
 * one of its words begins with the stem. A stem of six letters or more may
 * differ in its last letter, the way a root changes before an ending
 * ("продукт" and "продукцию", "kataloğ" and "katalog").
 */
export function keepsCtaObject(label: string, objects: readonly CtaObject[]): boolean {
  if (objects.length === 0) return true;
  const tokens = norm(label.replace(/\*/g, "")).trim().split(" ").filter(Boolean).map(fold);
  return objects.some(({ stem }) =>
    tokens.some(
      (t) => t.startsWith(stem) || (stem.length >= 6 && sharedPrefix(t, stem) >= stem.length - 1),
    ),
  );
}

/** The same instruction in the prompt, the flag and the call for the label alone. */
export function keepObjectLine(objects: readonly CtaObject[]): string {
  const words = objects.map((o) => `"${o.word}"`).join(" or ");
  return `the page's label names ${words}, which is what the button opens: name the same thing, in any form of the word`;
}

/**
 * The signature of a label is the first 40 characters of its text. At that
 * length its last word may be cut, so no object is read from it.
 */
export const LABEL_SIGNATURE_MAX = 40;
