/**
 * A version never speaks about where the visitor came from (A13 of
 * docs/specs/pilot-gaps.md; the founder's decision of 2026-10-12).
 *
 * Live on the pilot's site, `problem:ai`, the hero paragraph: "if you asked AI, the
 * answer is this:". The source shapes how a version is framed. It is never
 * something the page says: not the assistant, the search engine, the social
 * app or the community, and not what the visitor did before arriving ("you
 * asked", "you searched", "you saw us on"). A page that says it tells the
 * reader that it knows how they got there.
 *
 * Three readings, in en, az, ru and tr:
 *
 * 1. An arrival said to the reader: a second person and a verb of asking,
 *    searching or arriving in the past ("you asked", "soruşdunuzsa",
 *    "axtarırdınızsa", "вы спросили", "sorduysanız"), or a sender ("ChatGPT
 *    sent you", "as the AI said"). Flagged whatever the product is.
 * 2. A platform beside an arrival: a search engine, a social app or a
 *    community named in a sentence that also says the reader came, saw,
 *    found or heard ("you found us on Google", "LinkedIn-də bizi
 *    gördünüzsə"). Flagged whatever the product is. A platform alone is not
 *    ("Follow us on Instagram", "WhatsApp-da yazın").
 * 3. An AI word or an assistant's name where the customer's own words have
 *    none. A site that sells supplements has no reason to say "AI". A
 *    product about AI has "AI" in its brief and on its page, so the word is
 *    its own subject there and only readings 1 and 2 apply.
 *
 * 4. An ad (docs/specs/ads-platforms.md §3, privacy review condition 3): the
 *    reader's ad said to them ("you saw our ad", "reklamımızı gördünüz",
 *    "reklama tıkladınız", "вы увидели нашу рекламу") is flagged whatever
 *    the product, through reading 1. An ad word alone ("reklam",
 *    "реклам...", "advertisement", "sponsored post") is flagged where the
 *    customer's own words have none, like reading 3: an agency that sells
 *    advertising says it of itself. "reklamasiya", "reklamasyon" and
 *    "рекламация" (a complaint about goods) are not ad words.
 *
 * What stays allowed on purpose: the present tense of need ("looking for a
 * manufacturer?", "axtarırsınızsa", the participles "axtardığınız",
 * "aradığınız", "то, что вы искали"), "you asked for", "the right place"
 * ("doğru yerə gəldiniz"), and a competitor after "coming from".
 *
 * Deterministic, no model call. The flag carries the phrase that was read,
 * never more of the copy.
 */

/**
 * The plain words for artificial intelligence, in the four languages. The
 * acronym is read with its capitals only ("AI", "ИИ"); the words in any case.
 */
const AI_ACRONYM = /(?<![\p{L}\p{N}])(?:AI|A\.I\.|ИИ)(?![\p{L}\p{N}])/u;
const AI_WORDS =
  /artificial\s+intelligence|süni\s+intellekt\p{L}*|yapay\s+zek[aâ]\p{L}*|искусственн\p{L}*\s+интеллект\p{L}*|нейросет\p{L}*/iu;

/** The same family, any case, for the customer's own words. */
const AI_FAMILY_OWN =
  /(?<![\p{L}\p{N}])(?:ai|a\.i\.)(?![\p{L}\p{N}])|artificial\s+intelligence|süni\s+intellekt|yapay\s+zek[aâ]|(?<![\p{L}\p{N}])ии(?![\p{L}\p{N}])|искусственн\p{L}*\s+интеллект|нейросет|machine\s+learning|\bllm\b|\bgpt\b/iu;

/** Words for a chat assistant that are not a product's name. */
const CHATBOT = /\bchat\s?bot\p{L}*|\bçatbot\p{L}*|чат-?бот\p{L}*/iu;

/**
 * Assistants by name. The second group is matched with its capital only: a
 * person is called Claude, a sign Gemini, and "copilot" is a common noun.
 */
const ASSISTANTS_ANY_CASE = ["chatgpt", "chat gpt", "openai", "deepseek", "perplexity"];
const ASSISTANTS_CAPITAL = ["Claude", "Gemini", "Copilot", "Grok", "Bard", "GPT"];

/** An ad as a thing the reader saw or clicked, in English. */
const AD_EN = "(?:ad|advert|advertisement|sponsored\\s+post|promotion)";

/** An ad word in az and tr, never "reklamasiya" or "reklamasyon" (a complaint). */
const AD_AZ_TR = "(?<!\\p{L})reklam(?!as[iı]y|asyon)\\p{L}*";
/** An ad word in ru, never "рекламация" (a complaint). */
const AD_RU = "(?<!\\p{L})реклам(?!аци)\\p{L}*";

/** An ad word alone, for a customer whose own words have none (reading 4). */
const AD_WORDS = new RegExp(
  `${AD_AZ_TR}|${AD_RU}|\\badvert(?:isement)?s?\\b|\\bsponsored\\s+(?:post|ad)s?\\b`,
  "iu",
);

/** The customer's own words are about advertising: then an ad word is its subject. */
const AD_FAMILY_OWN =
  /reklam(?!as[iı]y|asyon)|реклам(?!аци)|advertis|(?<![\p{L}\p{N}])ads(?![\p{L}\p{N}])|\bppc\b|\bsponsored\b/iu;

/** Search engines, social apps and communities: a source only beside an arrival. */
const PLATFORMS =
  /\b(?:google|bing|duckduckgo|yandex|linkedin|instagram|facebook|tiktok|twitter|youtube|telegram|whatsapp|pinterest|snapchat|reddit|hacker\s?news|discord|product\s?hunt|capterra)\b|яндекс\p{L}*|search\s+engine\p{L}*|social\s+(?:media|network)\p{L}*|axtarış\s+(?:sistem|motor)\p{L}*|sosial\s+(?:şəbəkə|media)\p{L}*|поисковик\p{L}*|соцсет\p{L}*|социальн\p{L}*\s+сет\p{L}*|arama\s+motor\p{L}*|sosyal\s+medya\p{L}*|\bforum\p{L}*|форум\p{L}*/iu;

/** A word for the sender, for "as the AI said" and "the assistant sent you". */
const SENDER =
  "(?:ai|a\\.i\\.|the ai|an ai|your ai|chat\\s?gpt|claude|perplexity|gemini|copilot|grok|deepseek|the assistant|your assistant|the chatbot|a chatbot|google|the search|your search)";

/**
 * Reading 1, per language: an arrival said to the reader. English is read on
 * every page (a model slips into it); the others on their own language.
 */
const ARRIVAL: Record<string, readonly RegExp[]> = {
  en: [
    // "you asked", "you just searched", "you've googled"; never "you asked for".
    /\byou(?:'ve| have)?\s+(?:just\s+|already\s+|probably\s+|may\s+have\s+|might\s+have\s+)?(?:asked(?!\s+for\b)|searched|googled)\b/i,
    /\byou\s+were\s+(?:just\s+|probably\s+)?(?:asking|searching|googling|told|referred|sent\s+here|recommended|pointed)\b/i,
    /\byou\s+(?:(?:came|arrived|landed)\s+(?:here\s+)?(?:from|via)|got\s+here\s+(?:from|via|through))\b/i,
    /\byou\s+(?:found|saw|discovered|noticed)\s+(?:us|this\s+page|this\s+site|our\s+(?:site|page|name|ad|post|link))\s+(?:on|via|through|in|from)\b/i,
    /\byou\s+(?:heard|read)\s+(?:about|of)\s+us\s+(?:on|via|through|in|from)\b/i,
    /\byou\s+(?:clicked|followed\s+a\s+link|landed\s+here)\b/i,
    /\bif\s+you(?:'re|\s+are)\s+(?:here|coming|arriving|visiting)\s+from\b/i,
    /\b(?:sent|brought|led|pointed|referred)\s+you\s+here\b/i,
    new RegExp(
      `\\b(?:as|like|what)\\s+${SENDER}\\s+(?:said|told|suggested|recommended|mentioned|answered|says)\\b`,
      "i",
    ),
    new RegExp(
      `\\b${SENDER}\\s+(?:sent|told|recommended|suggested|pointed|referred|brought|led)\\s+(?:you|us\\s+to\\s+you)\\b`,
      "i",
    ),
    new RegExp(`\\brecommended\\s+by\\s+${SENDER}\\b`, "i"),
    /\b(?:coming|arriving|visiting|here)\s+from\s+(?:an?\s+|the\s+|your\s+)?(?:ai|chat|assistant|search|social|feed|forum|thread|community|link)\b/i,
    /\bstop(?:ped)?\s+scrolling\b|\bscrolling\s+past\b/i,
    // "you saw our ad", "you clicked the sponsored post", "the ad you saw".
    new RegExp(
      `\\byou\\s+(?:just\\s+)?(?:saw|clicked|tapped|followed|found|noticed)\\s+(?:on\\s+)?(?:our|an|the|this|that)\\s+${AD_EN}\\b`,
      "i",
    ),
    new RegExp(
      `\\b(?:our|the|this|that)\\s+${AD_EN}\\s+(?:that\\s+)?you\\s+(?:just\\s+)?(?:saw|clicked|tapped|followed)\\b`,
      "i",
    ),
  ],
  az: [
    // "soruşdunuz", "soruşdunuzsa", "soruşmusunuz", "soruşduğunuz", "soruşurdunuz".
    /(?<!\p{L})soruş(?:du(?:n|nuz)|mus(?:an|unuz)|ubs(?:an|unuz)|duğun(?:uz)?|urdu(?:n|nuz))\p{L}*/iu,
    // "axtardınız", "axtarırdınızsa", "axtarmısınız"; never the present
    // "axtarırsınız" or the participle "axtardığınız".
    /(?<!\p{L})axtar(?:dı(?:n|nız)|ırdı(?:n|nız)|mıs(?:an|ınız))\p{L}*/iu,
    // "axtarışdan gəldiniz", "linkdən gələnlər".
    /(?<!\p{L})(?:axtarış|şəbəkə|link|keçid|forum|icma|çat|söhbət|tövsiyə)\p{L}*d[aə]n\s+gəl\p{L}*/iu,
    // "bizi ... gördünüz", "haqqımızda eşitdiniz".
    /(?<!\p{L})(?:bizi|haqqımızda|barəmizdə)(?!\p{L})[^.!?]{0,40}?(?<!\p{L})(?:gördü(?:n|nüz)|eşitdi(?:n|niz)|oxudu(?:n|nuz)|tapdı(?:n|nız))\p{L}*/iu,
    /sürüşdürmə\p{L}*\s+(?:dayan|saxla)\p{L}*/iu,
    // "reklamımızı gördünüz", "reklamdan gəldiniz", "reklama kliklədiniz":
    // an ad and a second-person past arrival in one sentence; never the
    // participle ("reklamdan gələn müştərilər" is an agency's own line).
    new RegExp(
      `${AD_AZ_TR}[^.!?]{0,40}?(?<!\\p{L})(?:gördü(?:n|nüz)|gəldi(?:n|niz)|gəlmis(?:ən|iniz)|gəlibs(?:ən|iniz)|kliklədi(?:n|niz)|klikləmis(?:ən|iniz)|basdı(?:n|nız)|keçdi(?:n|niz)|tapdı(?:n|nız))\\p{L}*`,
      "iu",
    ),
    // "gördüyünüz reklam", "kliklədiyiniz reklam".
    new RegExp(
      `(?<!\\p{L})(?:gördüyün(?:üz)?|kliklədiyin(?:iz)?|basdığın(?:ız)?)\\s+${AD_AZ_TR}`,
      "iu",
    ),
  ],
  ru: [
    /(?<!\p{L})(?:вы|ты)\s+(?:уже\s+|только\s+что\s+|наверное\s+)?(?:спросил[аи]?|спрашивал[аи]?|задал[аи]?\s+вопрос|гуглил[аи]?|загуглил[аи]?)(?!\p{L})/iu,
    // "вы искали", never "то, что вы искали" or "которую вы искали".
    /(?<!(?:что|котор\p{L}{1,4})\s)(?<!\p{L})(?:вы|ты)\s+(?:уже\s+)?искал[аи]?(?!\p{L})/iu,
    /(?<!\p{L})(?:вы|ты)\s+(?:пришл[аи]|пришёл|пришел|перешл[аи]|перешёл|перешел|попал[аи]?)\s+(?:сюда\s+)?(?:из|с|со|от|по\s+ссылке)(?!\p{L})/iu,
    /(?<!\p{L})(?:вы|ты)\s+(?:увидел[аи]?|нашл[аи]|нашёл|нашел|узнал[аи]?|услышал[аи]?|прочитал[аи]?)\s+(?:нас|о\s+нас|про\s+нас)(?!\p{L})/iu,
    /(?<!\p{L})(?:вам|тебе)\s+(?:посоветовал[аи]?|порекомендовал[аи]?|рекомендовал[аи]?|подсказал[аи]?|ответил[аи]?)(?!\p{L})/iu,
    /(?<!\p{L})(?:перестаньте|хватит)\s+листать(?!\p{L})/iu,
    // "вы увидели нашу рекламу", "вы пришли по рекламе", "реклама, которую
    // вы видели"; never "клиенты пришли по рекламе" (no "вы").
    new RegExp(
      `(?<!\\p{L})(?:вы|ты)\\s+(?:уже\\s+|только\\s+что\\s+)?(?:увидел[аи]?|видел[аи]?|заметил[аи]?|пришл[аи]|пришёл|пришел|перешл[аи]|перешёл|перешел|нажал[аи]?|кликнул[аи]?)(?!\\p{L})[^.!?]{0,30}?${AD_RU}`,
      "iu",
    ),
    new RegExp(
      `${AD_RU},?\\s+(?:котор\\p{L}+|что)\\s+(?:вы|ты)\\s+(?:увидел|видел|заметил|нажал|кликнул)\\p{L}*`,
      "iu",
    ),
  ],
  tr: [
    // "sordunuz", "sorduysanız", "sorduğunuz".
    /(?<!\p{L})sor(?:du(?:n|nuz)|duysa(?:n|nız)|muş(?:sun|sunuz)|duğun(?:uz)?)\p{L}*/iu,
    // "aradınız", "aradıysanız", "arıyordunuz"; never the participle "aradığınız".
    /(?<!\p{L})ar(?:adı(?:n|nız)|adıysa(?:n|nız)|ıyordu(?:n|nuz))\p{L}*/iu,
    /(?<!\p{L})(?:arama|bağlantı|link|forum|topluluk|sohbet|tavsiye)\p{L}*[dt][ae]n\s+gel\p{L}*/iu,
    /(?<!\p{L})(?:bizi|hakkımızda)(?!\p{L})[^.!?]{0,40}?(?<!\p{L})(?:gördü(?:n|nüz)|duydu(?:n|nuz)|okudu(?:n|nuz)|buldu(?:n|nuz))\p{L}*/iu,
    /kaydırmayı\s+bırak\p{L}*/iu,
    // "reklamımızı gördünüz", "reklama tıkladınız", "reklamdan geldiniz";
    // never the participle ("reklamdan gelen müşteriler").
    new RegExp(
      `${AD_AZ_TR}[^.!?]{0,40}?(?<!\\p{L})(?:gördü(?:n|nüz)|gördüyse(?:n|niz)|geldi(?:n|niz)|geldiyse(?:n|niz)|tıkladı(?:n|nız)|tıkladıysa(?:n|nız)|bastı(?:n|nız)|buldu(?:n|nuz))\\p{L}*`,
      "iu",
    ),
    // "gördüğünüz reklam", "tıkladığınız reklam".
    new RegExp(`(?<!\\p{L})(?:gördüğün(?:üz)?|tıkladığın(?:ız)?)\\s+${AD_AZ_TR}`, "iu"),
  ],
};

/** Reading 2, per language: the reader came, saw, found or heard, in the past. */
const ARRIVED: Record<string, RegExp> = {
  en: /\byou\s+(?:came|arrived|landed|found|saw|discovered|heard|read|clicked|searched|googled)\b|\b(?:coming|arriving|here)\s+from\b|\bfound\s+us\b|\bsaw\s+us\b|\bsent\s+you\b|\bbrought\s+you\b/i,
  az: /(?<!\p{L})(?:gəldi(?:n|niz)|gəlmis(?:ən|iniz)|gəlibs(?:ən|iniz)|gələn(?:lər)?|gördü(?:n|nüz)|görmüs(?:ən|ünüz)|tapdı(?:n|nız)|tapmıs(?:an|ınız)|eşitdi(?:n|niz)|eşitmis(?:ən|iniz)|oxudu(?:n|nuz)|oxumus(?:an|unuz)|keçdi(?:n|niz))\p{L}*/iu,
  ru: /(?<!\p{L})(?:пришл[аи]|пришёл|пришел|пришедш\p{L}*|перешл[аи]|перешёл|перешел|перешедш\p{L}*|увидел[аи]?|нашл[аи]|нашёл|нашел|узнал[аи]?|услышал[аи]?|прочитал[аи]?)(?!\p{L})/iu,
  tr: /(?<!\p{L})(?:geldi(?:n|niz)|geldiyse(?:n|niz)|gelen(?:ler)?|gördü(?:n|nüz)|gördüyse(?:n|niz)|buldu(?:n|nuz)|bulduysa(?:n|nız)|duydu(?:n|nuz)|okudu(?:n|nuz))\p{L}*/iu,
};

const SCROLL_OWN = /scroll|sürüşdür|листа|kaydır/iu;

function primary(lang: string): string {
  return lang.split("-")[0]?.toLowerCase() ?? lang.toLowerCase();
}

function clip(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > 60 ? `${t.slice(0, 57)}…` : t;
}

/**
 * The phrase in `text` that speaks about the visitor's source, or null.
 *
 * `own` is the customer's own words (the brief, the page's sentences, the
 * page's own parts). Without it reading 3 is not made: nothing says whether
 * "AI" is the product's subject.
 */
export function sourceAddressed(
  text: string,
  language: string,
  own?: string | null,
): string | null {
  const lang = primary(language);
  const plain = text.replace(/\*/g, "");

  // 1. An arrival said to the reader.
  const tables = lang === "en" ? [ARRIVAL.en] : [ARRIVAL[lang], ARRIVAL.en];
  for (const table of tables) {
    for (const re of table ?? []) {
      const m = re.exec(plain);
      if (!m) continue;
      // "Stop scrolling" on a product about scrolling is its own subject.
      if (/scroll|sürüşdür|листать|kaydır/iu.test(m[0]) && own && SCROLL_OWN.test(own)) continue;
      return clip(m[0]);
    }
  }

  // 2. A platform beside an arrival, in one sentence.
  const arrived = [ARRIVED[lang], ARRIVED.en].filter((r): r is RegExp => r !== undefined);
  for (const sentence of plain.split(/(?<=[.!?…])\s+|\n+/)) {
    const platform = PLATFORMS.exec(sentence);
    if (!platform) continue;
    const verb = arrived.map((r) => r.exec(sentence)).find((m) => m !== null && m !== undefined);
    if (verb) return clip(`${platform[0]} … ${verb[0]}`);
  }

  // 3 and 4 read the customer's own words.
  if (own === undefined || own === null) return null;

  // 4. An ad word that is not the customer's own subject.
  if (!AD_FAMILY_OWN.test(own)) {
    const ad = AD_WORDS.exec(plain);
    if (ad) return clip(ad[0]);
  }

  // 3. An AI word or an assistant's name that is not the customer's own.
  const ownLower = own.toLowerCase();
  for (const name of ASSISTANTS_ANY_CASE) {
    const at = plain.toLowerCase().indexOf(name);
    if (at >= 0 && !ownLower.includes(name)) return clip(plain.slice(at, at + name.length));
  }
  for (const name of ASSISTANTS_CAPITAL) {
    const m = new RegExp(`(?<![\\p{L}\\p{N}])${name}(?![\\p{Ll}\\p{N}])`, "u").exec(plain);
    if (m && !ownLower.includes(name.toLowerCase())) return clip(m[0]);
  }
  if (AI_FAMILY_OWN.test(own)) return null;
  const ai = AI_ACRONYM.exec(plain) ?? AI_WORDS.exec(plain) ?? CHATBOT.exec(plain);
  return ai ? clip(ai[0]) : null;
}

/** What to do about it, for the revise pass and the call for the part alone. */
export const SOURCE_ADDRESSED_FIX =
  'say nothing about where the reader came from or what they did before arriving: no AI or assistant, no search, no social app, no community, no ad, no "you asked", "you searched", "you saw us on"; state the same point as a plain sentence about the product or the reader\'s need';
