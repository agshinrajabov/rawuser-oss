/**
 * The words that name a page's kind, in English, Azerbaijani, Russian and
 * Turkish (docs/specs/site-shaped-intents.md §4.4), the account words that
 * drop a link before anything is kept (§4.3, privacy review condition 1), and the
 * legal, jobs and feed words that are never an intent.
 *
 * Matching is on whole words after folding: lower case, diacritics off
 * (ə → e, ı → i, ş → s, ç → c, ğ → g, ö → o, ü → u), Cyrillic through a
 * plain transliteration, then a spelling key that makes the common
 * transliterations meet (`/ceny`, `/tseny` and `цены` are one word). The
 * same fold runs on the tables and on what is read, so the tables are
 * written in each language's own spelling.
 */

import type { SiteKind } from "./kinds.ts";

export const SITE_LANGS = ["en", "az", "ru", "tr"] as const;
export type SiteLang = (typeof SITE_LANGS)[number];

const CYRILLIC: Record<string, string> = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",
  ё: "e",
  ж: "zh",
  з: "z",
  и: "i",
  й: "y",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
  х: "kh",
  ц: "ts",
  ч: "ch",
  ш: "sh",
  щ: "shch",
  ъ: "",
  ы: "y",
  ь: "",
  э: "e",
  ю: "yu",
  я: "ya",
  і: "i",
  ї: "i",
  є: "e",
  ґ: "g",
};

/** Lower case, diacritics off, Cyrillic transliterated: plain a to z and digits remain. */
export function foldText(s: string): string {
  let out = "";
  for (const ch of s.toLowerCase()) {
    if (ch === "ə") out += "e";
    else if (ch === "ı") out += "i";
    else out += CYRILLIC[ch] ?? ch;
  }
  return out.normalize("NFD").replace(/\p{M}/gu, "");
}

/**
 * One spelling key per word, so the usual transliterations of a Russian
 * word meet (ts/c, kh/h, ya/ia/a, y/i). Applied the same way to the tables
 * and to what is read; a table word and another kind's table word never
 * share a key (tested).
 */
export function spellingKey(token: string): string {
  return token
    .replace(/shch|sch|sh/g, "s")
    .replace(/kh/g, "h")
    .replace(/ts|tz/g, "c")
    .replace(/zh/g, "j")
    .replace(/ch/g, "c")
    .replace(/yu|iu/g, "u")
    .replace(/ya|ia/g, "a")
    .replace(/ye/g, "e")
    .replace(/y/g, "i");
}

/** Whole words of a path or a link text, folded and keyed. */
export function wordsOf(s: string): string[] {
  return foldText(s)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0)
    .map(spellingKey);
}

type Table = Readonly<Record<SiteLang, readonly string[]>>;

/** The starting lists of the spec, with the common forms. Phrases are space-separated. */
export const KIND_WORDS: Readonly<Record<SiteKind, Table>> = {
  price: {
    en: ["pricing", "price", "prices", "plans", "plan", "cost", "costs", "fees", "tariffs"],
    az: ["qiymət", "qiymətlər", "qiymətimiz", "tarif", "tariflər", "paketlər", "paket"],
    ru: ["цены", "цена", "тарифы", "тариф", "стоимость", "прайс"],
    tr: ["fiyat", "fiyatlar", "fiyatlandırma", "ücretler", "ücret", "paketler", "tarifeler"],
  },
  vs: {
    en: ["vs", "versus", "alternative to"],
    az: ["alternativi", "qarşı"],
    ru: ["альтернатива", "против"],
    tr: ["alternatifi", "karşı"],
  },
  compare: {
    en: ["compare", "comparison", "comparisons", "alternatives", "reviews"],
    az: ["müqayisə", "alternativlər", "rəylər"],
    ru: ["сравнение", "сравнить", "альтернативы", "отзывы"],
    tr: ["karşılaştırma", "karşılaştır", "alternatifler", "yorumlar"],
  },
  proof: {
    en: [
      "work",
      "our work",
      "case studies",
      "case study",
      "cases",
      "customers",
      "clients",
      "portfolio",
      "showcase",
      "testimonials",
      "success stories",
      "projects",
    ],
    az: ["işlər", "işlərimiz", "keyslər", "müştərilər", "layihələr", "layihələrimiz"],
    ru: ["кейсы", "клиенты", "портфолио", "работы", "проекты"],
    tr: ["referanslar", "müşteriler", "projelerimiz", "projeler", "işlerimiz"],
  },
  features: {
    en: [
      "features",
      "feature",
      "product",
      "products",
      "services",
      "service",
      "integrations",
      "capabilities",
      "platform",
      "what we do",
    ],
    az: ["imkanlar", "xüsusiyyətlər", "xidmətlər", "xidmətlərimiz", "məhsul", "məhsullar"],
    ru: ["возможности", "функции", "услуги", "продукт", "продукты"],
    tr: ["özellikler", "hizmetler", "hizmetlerimiz", "ürün", "ürünler"],
  },
  docs: {
    en: ["docs", "doc", "documentation", "api", "developers", "developer", "reference", "sdk"],
    az: ["sənədlər", "sənədləşmə"],
    ru: ["документация", "разработчикам"],
    tr: ["dokümantasyon", "geliştiriciler", "belgeler"],
  },
  how: {
    en: [
      "how it works",
      "how we work",
      "how",
      "why",
      "approach",
      "our approach",
      "use cases",
      "use case",
      "solutions",
      "solution",
      "process",
      "method",
    ],
    az: ["necə işləyir", "niyə", "yanaşma", "yanaşmamız", "həllər", "metod"],
    ru: ["как это работает", "подход", "решения", "почему"],
    tr: ["nasıl çalışır", "neden", "yaklaşım", "yaklaşımımız", "çözümler"],
  },
  learn: {
    en: [
      "blog",
      "insights",
      "research",
      "articles",
      "news",
      "resources",
      "guides",
      "learn",
      "library",
      "journal",
      "podcast",
    ],
    az: ["bloq", "məqalələr", "araşdırma", "araşdırmalar", "yazılar"],
    ru: ["блог", "статьи", "исследования", "новости"],
    tr: ["makaleler", "araştırma", "araştırmalar", "haberler"],
  },
  start: {
    en: [
      "contact",
      "contact us",
      "demo",
      "book a demo",
      "sign up",
      "signup",
      "register",
      "trial",
      "free trial",
      "start",
      "get started",
      "get in touch",
      "book",
    ],
    az: ["əlaqə", "başla", "qeydiyyat", "sınaq", "bizimlə əlaqə"],
    ru: ["контакты", "связаться", "регистрация", "начать", "демо"],
    tr: ["iletişim", "kayıt", "deneme", "başla", "bize ulaşın"],
  },
  about: {
    en: ["about", "about us", "team", "studio", "company", "who we are"],
    az: ["haqqımızda", "komanda", "biz kimik", "studiya"],
    ru: ["о нас", "команда", "компания", "о компании"],
    tr: ["hakkımızda", "ekip", "şirket", "biz kimiz"],
  },
};

/**
 * A link that names an account area is dropped before anything is kept
 * (§4.3 point 3, widened by privacy review condition 1): a capture made while the
 * operator is signed in can carry "Jane's workspace".
 */
export const ACCOUNT_WORDS: Table = {
  en: [
    "login",
    "log in",
    "signin",
    "sign in",
    "logout",
    "log out",
    "signout",
    "sign out",
    "account",
    "accounts",
    "dashboard",
    "admin",
    "settings",
    "profile",
    "cart",
    "basket",
    "checkout",
    "workspace",
    "workspaces",
    "my",
    "billing",
    "orders",
    "inbox",
    "notifications",
    "members",
    "invite",
    "reset",
    "verify",
    "unsubscribe",
    "password",
  ],
  az: [
    "daxil ol",
    "giriş",
    "çıxış",
    "hesab",
    "hesabım",
    "kabinet",
    "şəxsi kabinet",
    "idarə paneli",
    "panel",
    "parametrlər",
    "ayarlar",
    "profil",
    "səbət",
    "sifarişlər",
    "sifarişlərim",
    "iş sahəsi",
    "mənim",
    "hesablar",
    "bildirişlər",
    "gələnlər",
    "gələn qutusu",
    "sıfırla",
    "üzvlər",
    "dəvət",
    "şifrə",
    "təsdiqlə",
    "abunəlikdən çıx",
  ],
  ru: [
    "вход",
    "войти",
    "выход",
    "выйти",
    "логин",
    "аккаунт",
    "кабинет",
    "личный кабинет",
    "панель",
    "настройки",
    "профиль",
    "корзина",
    "оформление заказа",
    "заказы",
    "рабочее пространство",
    "мой",
    "мои",
    "биллинг",
    "счета",
    "входящие",
    "уведомления",
    "участники",
    "пригласить",
    "сброс",
    "пароль",
    "подтвердить",
    "отписаться",
  ],
  tr: [
    "giriş",
    "giriş yap",
    "oturum aç",
    "çıkış",
    "çıkış yap",
    "hesap",
    "hesabım",
    "panel",
    "yönetim",
    "ayarlar",
    "profil",
    "sepet",
    "ödeme",
    "siparişler",
    "siparişlerim",
    "çalışma alanı",
    "benim",
    "faturalandırma",
    "fatura",
    "gelen kutusu",
    "bildirimler",
    "üyeler",
    "davet",
    "sıfırla",
    "şifre",
    "doğrula",
    "abonelikten çık",
  ],
};

/** Legal, jobs and feed links: not personal, just never an intent (§4.3). */
export const NEVER_INTENT_WORDS: Table = {
  en: [
    "privacy",
    "terms",
    "tos",
    "legal",
    "cookies",
    "cookie",
    "gdpr",
    "imprint",
    "impressum",
    "careers",
    "career",
    "jobs",
    "vacancies",
    "open roles",
    "rss",
    "feed",
    "atom",
    "sitemap",
  ],
  az: ["məxfilik", "şərtlər", "qaydalar", "karyera", "vakansiyalar", "iş elanları"],
  ru: ["конфиденциальность", "политика", "условия", "оферта", "карьера", "вакансии"],
  tr: ["gizlilik", "koşullar", "şartlar", "kvkk", "kariyer", "iş ilanları", "açık pozisyonlar"],
};

/** A table folded into phrase keys, per language. */
export type FoldedTable = Readonly<Record<SiteLang, readonly (readonly string[])[]>>;

function foldTable(t: Table): FoldedTable {
  const out = {} as Record<SiteLang, string[][]>;
  for (const lang of SITE_LANGS) {
    out[lang] = t[lang].map((p) => wordsOf(p)).filter((p) => p.length > 0);
  }
  return out;
}

export const FOLDED_KIND_WORDS: Readonly<Record<SiteKind, FoldedTable>> =
  /* @__PURE__ */ Object.fromEntries(
    Object.entries(KIND_WORDS).map(([k, t]) => [k, foldTable(t)]),
  ) as Record<SiteKind, FoldedTable>;
export const FOLDED_ACCOUNT_WORDS = /* @__PURE__ */ foldTable(ACCOUNT_WORDS);
export const FOLDED_NEVER_WORDS = /* @__PURE__ */ foldTable(NEVER_INTENT_WORDS);

/** Where a phrase occurs in a word list: start indexes. */
function occurrences(words: readonly string[], phrase: readonly string[]): number[] {
  const out: number[] = [];
  outer: for (let i = 0; i + phrase.length <= words.length; i++) {
    for (let j = 0; j < phrase.length; j++) {
      if (words[i + j] !== phrase[j]) continue outer;
    }
    out.push(i);
  }
  return out;
}

/** True when any phrase of the table (every language) is in the words. */
export function namesAny(words: readonly string[], table: FoldedTable): boolean {
  for (const lang of SITE_LANGS) {
    for (const p of table[lang]) if (occurrences(words, p).length > 0) return true;
  }
  return false;
}

/**
 * The kinds the words name, the longest phrase winning: "how we work"
 * names `how`, not also `proof` for its "work". The page's language first;
 * only when its list names nothing, the other three (mixed pages are common).
 */
export function kindsNamed(words: readonly string[], lang: string | null | undefined): SiteKind[] {
  const first = (SITE_LANGS as readonly string[]).includes(lang ?? "") ? [lang as SiteLang] : [];
  const rest = SITE_LANGS.filter((l) => !first.includes(l));
  for (const langs of [first, rest]) {
    if (langs.length === 0) continue;
    const found = matchKinds(words, langs);
    if (found.length > 0) return found;
  }
  return [];
}

function matchKinds(words: readonly string[], langs: readonly SiteLang[]): SiteKind[] {
  const spans: Array<{ kind: SiteKind; start: number; end: number }> = [];
  for (const [kind, table] of Object.entries(FOLDED_KIND_WORDS) as [SiteKind, FoldedTable][]) {
    for (const lang of langs) {
      for (const p of table[lang]) {
        for (const i of occurrences(words, p)) spans.push({ kind, start: i, end: i + p.length });
      }
    }
  }
  // A match inside a longer match of another phrase does not count.
  const kept = spans.filter(
    (a) =>
      !spans.some(
        (b) => b !== a && b.end - b.start > a.end - a.start && b.start <= a.start && b.end >= a.end,
      ),
  );
  return [...new Set(kept.map((s) => s.kind))];
}
