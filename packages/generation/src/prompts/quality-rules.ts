/**
 * Quality rules for generated copy, in three layers
 * (docs/specs/generation-quality.md):
 *
 *   1. CORE_QUALITY_RULES: language-agnostic. What makes copy read as a
 *      machine wrote it is the same in every language (no-ai-slop patterns),
 *      and so is what makes it dishonest (numbers the brief never gave).
 *   2. LANGUAGE_LAYER: a short block per language about its register and
 *      known calques, written for that culture; a generic block for the rest.
 *   3. buildSamplesBlock: the customer's own sentences from their live page,
 *      the most precise register anchor there is.
 *
 * All three live in the cached preamble, so the 30 calls of a run share them.
 */

export const CORE_QUALITY_RULES = `=== WRITING RULES (every language) ===

1. ONLY WHAT THE BRIEF SAYS. Every number, price, duration, client name,
   award and result must appear in the brief or in the page samples below.
   If the brief gives no price, write no price. If it names two clients,
   name those two and no story about them beyond what the brief states.
   A plausible detail you added is a lie the customer will have to retract.

2. ONE IDEA PER HEADLINE. Declarative, front-loaded, under twelve words.
   Not a question, and never two questions. The lead paragraph earns the
   headline with one specific fact, not a second slogan.

3. COMPLETE SENTENCES. No fragment kickers ("No surprises. Ever."), no
   stacked three-word sentences for drama. Vary sentence length naturally.

4. NO MACHINE PATTERNS: no "not X, it's Y" contrasts; no short label, then
   a colon, then a reveal; no "the truth is / here's the thing" openers; no
   summary line that repeats the headline; no em or en dashes anywhere.

5. PLAIN REGISTER. Words a twelve-year-old reads without effort. Prefer the
   everyday word to the formal one. Keep the product words the market keeps
   in English (AI, SaaS, sprint, onboarding) unless the samples translate
   them.

6. EVERY PART ITS OWN WORDS. No two parts of the page say the same thing:
   the section headline is never the hero headline said again, the two
   buttons do not share a label, no sentence from the lead paragraph is
   used in another paragraph. A reader who scrolls should meet each idea
   once.

7. SOUND LIKE THE PAGE. The samples below are the customer's own voice in
   their own market. Match their register, sentence length and how they
   address the reader. Do not import the tone of an American startup site
   into a market that does not write that way.

8. BUTTONS KEEP THEIR ACTION. A button label may change its words, never
   what the button does: its link stays the page's own. Sign up, start or
   try stays a start; pricing or plans stays pricing; a demo stays a demo;
   a reading link stays a reading link. Two buttons never share a label,
   least of all the one whose clicks are counted.

9. NEVER SAY HOW THE READER ARRIVED. The page does not know where its
   reader came from and never says so: no AI assistant, search, social app,
   community or ad as the reader's way here, no "you asked", "you searched",
   "you saw us on", "you came from". Such words appear only where they
   describe the product itself.`;

/**
 * The claims lock (docs/specs/claims-lock.md): one block after the writing
 * rules, only in the preamble of a customer whose site is about health.
 * Language-agnostic like the core; the lint holds every rule in it.
 */
export const CLAIMS_LOCK_RULES = `=== CLAIMS LOCK (this site is about health) ===

10. WRITE ABOUT THE PRODUCT AND THE COMPANY, NEVER ABOUT THE READER'S
    HEALTH. No sentence states or asks about the reader's body, health,
    symptoms, condition or diagnosis: no "tired?", no "your liver", no "if
    you suffer from". Say what the company makes and how it works.

11. ADD NO CLAIM THE PAGE DOES NOT MAKE. No health or efficacy claim, no
    dose, no certificate or approval (GMP, ISO, "approved", "clinically
    proven", "treats") and no number unless the page's own text already
    says it. Here the brief is not enough; only what the page says counts.

12. KEEP NAMES AS WRITTEN. A product or brand name in the page's own text
    stays in the version of that part, spelled exactly as the page spells
    it.`;

/**
 * Per-language register and calque notes. Written for the culture, not
 * translated from one another. `_generic` is the fallback template; it is
 * filled with the language and market names.
 */
export const LANGUAGE_LAYER: Record<string, string> = {
  az: `=== AZƏRBAYCAN DİLİ ===

Write native business Azerbaijani, the register an Azerbaijani company uses on its
own site: warm, direct, not bureaucratic. Not translated English and not
Turkish. Turkish markers that must not appear: "değil", "musunuz",
"mısınız", "misiniz", "müsünüz", "yapıyor", "için", "şey", "-yor" verbs.
Use "deyil", "-mısınız/-misiniz" in the Azerbaijani form, "üçün", "şey"
only as Azerbaijani writes it.

Calques observed in generation, do not use:
- "məbləğ" for product/work/project (it means a sum of money): use "iş",
  "layihə", "məhsul".
- "lansman": use "başlamaq", "təqdim etmək".
- "rüsum" for a price or fee (reads as a state duty): use "qiymət",
  "ödəniş".
- "istinad hərfi": use "tövsiyə məktubu".

Numbers: "40-dan çox", never "40 artıq". Read each headline aloud; if it
sounds like a government form, rewrite it.`,

  en: `=== ENGLISH ===

Write the way a good founder writes to a peer, not the way a marketing
department writes to nobody. Banned words and phrases: delve, leverage,
unlock, seamless, empower, transform, elevate, streamline, robust,
cutting-edge, game changer, supercharge, harness, journey, tapestry,
"it's not just X", "in today's world". American spelling unless the
samples are British.`,

  ru: `=== РУССКИЙ ===

Пишите живым деловым русским, как компания пишет о себе на собственном
сайте: на «вы», без канцелярита и без кальки с английского. Не
используйте: «осуществлять», «являться», «данный», «в рамках»,
«функционал», «инновационный», «уникальный», «эффективный» без
конкретики, «мы предоставляем решения». Одна мысль в заголовке, глагол в
каждом предложении. Числа и даты в русском формате.`,

  tr: `=== TÜRKÇE ===

Yerli bir ekibin kendi sitesinde yazdığı gibi yazın: sıcak, net, doğrudan.
İngilizceden kalıp çeviri yok. Kullanmayın: "çözümler sunuyoruz",
"yenilikçi", "eşsiz", "kusursuz", "devrim niteliğinde", "-yı bir üst
seviyeye taşıyın", "keşfedin". Başlıkta tek fikir, soru yok. Sayılar ve
tarihler Türkçe biçiminde.`,

  _generic: `=== {LANGUAGE} ===

Write as a native copywriter for {LANGUAGE} in {MARKET}: the register a
local business uses on its own website, not a translation from English.
No calques, no imported startup idioms, local number and date formats,
and the product words the market itself keeps in English stay in English.`,
};

/** The language block for a tag, falling back to the generic template. */
export function languageLayer(lang: string, languageName: string, market: string): string {
  const primary = lang.split("-")[0]?.toLowerCase() ?? lang;
  const block = LANGUAGE_LAYER[primary];
  if (block) return block;
  return (LANGUAGE_LAYER._generic ?? "")
    .replace(/\{LANGUAGE\}/g, languageName)
    .replace(/\{MARKET\}/g, market || "its home market");
}

/** The customer's own sentences as the style anchor. Empty when none. */
export function buildSamplesBlock(samples: readonly string[]): string {
  const clean = samples.map((s) => s.trim()).filter((s) => s.length > 0);
  if (clean.length === 0) return "";
  return `=== THE CUSTOMER'S OWN WORDS (from their live page; match this voice) ===

${clean.map((s) => `- ${s}`).join("\n")}`;
}

/**
 * Words that mark machine-written copy, per language, for the lint. The
 * English list is universal (these leak into every language); the others
 * are the calques above.
 */
export const BANNED_WORDS: Record<string, readonly string[]> = {
  _universal: [
    "delve",
    "leverage",
    "unlock",
    "seamless",
    "empower",
    "elevate",
    "streamline",
    "robust",
    "cutting-edge",
    "game changer",
    "game-changer",
    "supercharge",
    "harness",
    "tapestry",
    "paradigm",
  ],
  az: ["məbləğ", "lansman", "rüsum", "istinad hərfi", "40 artıq"],
  ru: ["осуществля", "являет", "данный", "в рамках", "функционал", "инновационн"],
  tr: ["çözümler sunuyoruz", "yenilikçi", "eşsiz", "kusursuz", "devrim niteliğinde", "keşfedin"],
};

/**
 * Turkish-only markers that should not appear in Azerbaijani copy, as whole
 * words. Whole words on purpose: Turkish writes the question particle
 * separately ("geliyor musunuz"), Azerbaijani attaches it ("gəlirsinizmi"),
 * and "-mısınız/-misiniz" is also Azerbaijani's perfect tense
 * ("eşitmisiniz"), which a substring check flagged on 5 of 30 variants.
 */
export const TURKISH_MARKERS_IN_AZ: readonly RegExp[] = [
  /\bdeğil\b/i,
  /\b(musunuz|mısınız|misiniz|müsünüz|mu|mı|mi|mü)\b(?=\s*\?)/i,
  /\byapıyor\w*\b/i,
  /\bediyor\w*\b/i,
  /\biçin\b/i,
  /\bşimdi\b/i,
  // "olduğunu" is spelled the same in both languages and is good Azerbaijani;
  // it flagged 2 of 30 valid variants on 2026-09-11 and is not a marker.
];
