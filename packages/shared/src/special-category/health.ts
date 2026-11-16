/**
 * The health tables of the claims lock (docs/specs/claims-lock.md, rule 1),
 * moved here so the claims lock and the keyword screen
 * (special-category/terms.ts, docs/specs/keyword-intent.md §10 condition 7)
 * read one source. Unchanged from the claims lock: the claims lock imports
 * them back under their old names.
 *
 * HEALTH_ADDRESSED_PATTERNS: per language (en, az, ru, tr), the patterns of
 * a sentence aimed at the reader's own body, health, symptoms or condition.
 * HEALTH_SYMPTOM_NOUNS: per language, the body and state nouns a bare
 * symptom question is made of. Both read unfolded text (ğ, ə, ı kept).
 */

const EN_BODY =
  "body|health|liver|kidneys?|skin|hair|heart|stomach|gut|digestion|immune\\s+system|immunity|sleep|energy(?:\\s+levels?)?|weight|blood(?:\\s+(?:sugar|pressure))?|joints?|bones?|symptoms?|condition|diagnosis|pain|fatigue|mood|hormones?|cholesterol|doctor|physician";
const EN_STATE =
  "tired|exhausted|ill|sick|bloated|stressed|anxious|unwell|overweight|weak|sleepless|in\\s+pain|run\\s+down";

/** Azerbaijani health stems; read only with a second-person plural possessive. */
const AZ_STEMS =
  "sağlamlığ|səhhət|bədən|qaraciyər|böyrəy|böyrək|dəri|saç|ürəy|ürək|mədə|bağırsağ|bağırsaq|həzm|immunitet|yuxu|enerji|çəki|qan|oynaq|sümüy|sümük|simptom|əlamət|xəstəliy|xəstəlik|diaqnoz|ağrı|yorğunluğ|əhval|hormon|xolesterin|həkim";
const AZ_POSS = "(?:lar|lər)?(?:ınız|iniz|unuz|ünüz|nız|niz|nuz|nüz)\\p{L}*";

const TR_STEMS =
  "sağlığ|vücud|beden|karaciğer|böbreğ|böbrek|cild|cilt|saç|kalb|kalp|mide|bağırsağ|bağırsak|sindirim|bağışıklığ|bağışıklık|uyku|enerji|kilo|kan|eklem|kemiğ|kemik|semptom|belirti|hastalığ|hastalık|teşhis|tanı|ağrı|yorgunluğ|hormon|kolesterol|doktor|hekim";
const TR_POSS = "(?:lar|ler)?(?:ınız|iniz|unuz|ünüz|nız|niz|nuz|nüz)\\p{L}*";

const RU_BODY =
  "здоровь\\p{L}*|организм\\p{L}*|печен\\p{L}*|почк\\p{L}*|кож\\p{L}*|желуд\\p{L}*|кишечник\\p{L}*|иммунитет\\p{L}*|сон|сна|сну|вес\\p{L}*|самочувстви\\p{L}*|симптом\\p{L}*|диагноз\\p{L}*|бол\\p{L}*|сердц\\p{L}*|сустав\\p{L}*|волос\\p{L}*|давлени\\p{L}*|гормон\\p{L}*|холестерин\\p{L}*|врач\\p{L}*";

export const HEALTH_ADDRESSED_PATTERNS: Record<string, readonly RegExp[]> = {
  en: [
    new RegExp(`\\byour\\s+(?:own\\s+)?(?:${EN_BODY})\\b`, "i"),
    new RegExp(
      `\\b(?:if|when|do|should)\\s+you\\s+(?:suffer|struggle|have|feel|experience|are\\s+(?:${EN_STATE})|cannot\\s+sleep|can't\\s+sleep)\\b`,
      "i",
    ),
    new RegExp(`\\byou(?:'re|\\s+are)\\s+(?:${EN_STATE})\\b`, "i"),
    new RegExp(`\\b(?:feeling|feel)\\s+(?:${EN_STATE})\\b`, "i"),
    new RegExp(`(?:^|[.!?]\\s*)(?:${EN_STATE})\\s*\\?`, "i"),
  ],
  az: [
    new RegExp(`(?<!\\p{L})(?:${AZ_STEMS})${AZ_POSS}`, "iu"),
    /(?<!\p{L})(?:sağlamlıq|səhhət)\s+problem\p{L}*/iu,
    /(?<!\p{L})(?:yorğunsunuz|yorğunsan|halsızsınız|halsızsan|xəstəsiniz|xəstəsən|yorulmusunuz|yorulursunuz|narahatsınız|narahatsan)(?!\p{L})/iu,
    /(?<!\p{L})əziyyət\s+çəkirs(?:iniz|ən)\p{L}*/iu,
    /(?<!\p{L})yata\s+bilmirs(?:iniz|ən)\p{L}*/iu,
  ],
  ru: [
    new RegExp(
      `(?<!\\p{L})у\\s+(?:вас|тебя)\\s+(?:есть\\s+|часто\\s+|постоянно\\s+)?(?:болит|болят|боли|симптом\\p{L}*|усталост\\p{L}*|бессонниц\\p{L}*|лишн\\p{L}*\\s+вес|диагноз|заболеван\\p{L}*|слаб\\p{L}*\\s+иммунитет|проблем\\p{L}*\\s+(?:со|с)\\s+(?:${RU_BODY}))`,
      "iu",
    ),
    new RegExp(`(?<!\\p{L})(?:ваш|тво)\\p{L}{0,3}\\s+(?:${RU_BODY})(?!\\p{L})`, "iu"),
    /(?<!\p{L})вы\s+(?:устал\p{L}*|болеете|страдаете|плохо\s+спите|не\s+высыпаетесь|чувствуете\s+(?:усталость|слабость|себя\s+плохо))(?!\p{L})/iu,
    /(?:^|[.!?]\s*)устал[иа]?\s*\?/iu,
  ],
  tr: [
    new RegExp(`(?<!\\p{L})(?:${TR_STEMS})${TR_POSS}`, "iu"),
    /(?<!\p{L})(?:yorgun\s+musunuz|hasta\s+mısınız|halsiz\s+misiniz|uyuyamıyor\s+musunuz)/iu,
    /(?<!\p{L})(?:acı|ağrı)\s+çekiyor(?:sunuz|san)\p{L}*/iu,
    /(?<!\p{L})(?:şikayet|rahatsızlığ)\p{L}*\s+(?:varsa|var\s+mı)/iu,
    /(?<!\p{L})mustarip\p{L}*/iu,
    /(?<!\p{L})sağlık\s+(?:sorun|problem)\p{L}*/iu,
  ],
};

/**
 * A bare symptom question with no pronoun ("Yorğunluq?", "Fatigue?",
 * "Усталость?", "Yorgunluk mu?"): a fragment that ends in `?` whose content
 * words are only body or state nouns from these lists (a symptom, a body
 * part, a condition). Exact forms, so "Ağrıkəsici?" (a product) or "Hansı
 * məhsul?" pass; az and tr also take a plural and one case ending on a
 * listed noun. A multi-word entry is read as the whole fragment.
 */
export const HEALTH_SYMPTOM_NOUNS: Record<string, readonly string[]> = {
  en: [
    "fatigue",
    "tiredness",
    "exhaustion",
    "insomnia",
    "stress",
    "anxiety",
    "bloating",
    "headache",
    "headaches",
    "pain",
    "nausea",
    "allergy",
    "allergies",
    "cold",
    "flu",
    "liver",
    "kidneys",
    "stomach",
    "gut",
    "skin",
    "hair",
    "joints",
    "bones",
    "heart",
    "immunity",
    "sleep",
    "energy",
    "weight",
    "cholesterol",
    "digestion",
    "constipation",
    "migraine",
    "migraines",
    "depression",
    "burnout",
    "weakness",
  ],
  az: [
    "yorğunluq",
    "yuxusuzluq",
    "stress",
    "narahatlıq",
    "köpmə",
    "baş ağrısı",
    "başağrısı",
    "ağrı",
    "ürəkbulanma",
    "allergiya",
    "soyuqdəymə",
    "qrip",
    "qaraciyər",
    "böyrək",
    "mədə",
    "bağırsaq",
    "dəri",
    "saç",
    "oynaq",
    "sümük",
    "ürək",
    "immunitet",
    "yuxu",
    "enerji",
    "çəki",
    "xolesterin",
    "həzm",
    "qəbizlik",
    "miqren",
    "depressiya",
    "halsızlıq",
  ],
  ru: [
    "усталость",
    "усталости",
    "утомление",
    "бессонница",
    "бессонницы",
    "стресс",
    "тревога",
    "вздутие",
    "головная боль",
    "головные боли",
    "боль",
    "боли",
    "тошнота",
    "аллергия",
    "простуда",
    "грипп",
    "печень",
    "почки",
    "желудок",
    "кишечник",
    "кожа",
    "волосы",
    "суставы",
    "кости",
    "сердце",
    "иммунитет",
    "сон",
    "энергия",
    "вес",
    "холестерин",
    "пищеварение",
    "запор",
    "мигрень",
    "депрессия",
    "слабость",
  ],
  tr: [
    "yorgunluk",
    "uykusuzluk",
    "stres",
    "kaygı",
    "şişkinlik",
    "baş ağrısı",
    "ağrı",
    "mide bulantısı",
    "alerji",
    "soğuk algınlığı",
    "grip",
    "karaciğer",
    "böbrek",
    "mide",
    "bağırsak",
    "cilt",
    "saç",
    "eklem",
    "kemik",
    "kalp",
    "bağışıklık",
    "uyku",
    "enerji",
    "kilo",
    "kolesterol",
    "sindirim",
    "kabızlık",
    "migren",
    "depresyon",
    "halsizlik",
  ],
};
