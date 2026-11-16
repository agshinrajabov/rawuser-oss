/**
 * The special-category screen of the keyword lexicon
 * (docs/specs/keyword-intent.md §4 and §10, privacy review condition 7): does a
 * lexicon phrase name a GDPR Art. 9 category (racial or ethnic origin,
 * political opinions, religious or philosophical beliefs, trade union
 * membership, genetic data, biometric data, health, sex life or sexual
 * orientation) or an Art. 10 one (criminal convictions and offences)? A
 * phrase that does is refused, so a lexicon can never steer a version by a
 * sensitive search. Tables in en, az, ru and tr; any other site language is
 * screened by a second offline model call (condition 7), not here.
 *
 * Health reads one source with the claims lock (special-category/health.ts)
 * and the readiness check's health words (special-category/words.ts), plus
 * the named conditions below.
 *
 * The screen refuses, never adds. It is pure string work and returns a
 * yes or a category name, never the words it matched.
 *
 * Collisions: a refused phrase costs the lexicon one phrase, a missed one
 * would steer by a sensitive search, so the default leans to refusing. But
 * words that ordinary commercial phrases use in another sense are left out
 * on their own and kept only in compounds: "care", "life", "union" ("credit
 * union"), "cold" ("cold email"), "pain" ("pain points"), "stress" ("stress
 * test"), "energy", "weight", "skin" and "hair" (shops), "dna" ("brand
 * dna"), "agnostic" ("platform agnostic"), "treatment" ("water
 * treatment"), "diagnostics" (cars, networks), az "siyasət" and tr
 * "politika", ru "политика" (also "policy": "məxfilik siyasəti", "gizlilik
 * politikası", "политика конфиденциальности"), az and ru "partiya",
 * "партия" (a batch of goods), tr "seçim" (a choice), tr "ceza" (a late
 * fee), tr "seksen" (eighty), az "seksiya" (a sports section), tr
 * "grip" (en "grip socks"), "condominium" (condom), az and tr "din" (a
 * DIN rail), az "irq" (en "irq handler"), "disabled" (a button state).
 */

import { HEALTH_ADDRESSED_PATTERNS, HEALTH_SYMPTOM_NOUNS } from "./health.ts";
import { HEALTH_WORDS, foldHealthText } from "./words.ts";

/** The categories the screen names: Art. 9, split where a test should see each half, and Art. 10. */
export const SPECIAL_CATEGORIES = [
  "ethnic",
  "political",
  "religious",
  "union",
  "genetic",
  "biometric",
  "health",
  "sex_life",
  "sexual_orientation",
  "criminal",
] as const;
export type SpecialCategory = (typeof SPECIAL_CATEGORIES)[number];

/**
 * How many letters a stem entry (`word*`) may take after its stem. Generous
 * for the agglutinating languages (tr "sendikalaşma", az "milliyyəti").
 */
const STEM_EXTRA = 10;

/**
 * The tables. One entry is a folded whole word, a stem (`patient*`), or a
 * phrase of such words matched as a run of whole words ("trade union*").
 * Written as spelled; folded at load the way words.ts folds (lower case,
 * diacritics off, `ə` as `e`, `ı` as `i`; Cyrillic stays Cyrillic, `й`
 * folds to `и` on both sides).
 */
const TERMS: Record<SpecialCategory, readonly string[]> = {
  ethnic: [
    // en
    "racial*",
    "racism",
    "racist*",
    "ethnic*",
    "ethnicity",
    "mixed race",
    "race discrimination",
    "race relations",
    "skin colour",
    "skin color",
    "ancestry",
    "indigenous people*",
    "gypsy",
    "gypsies",
    "roma people",
    // az
    "irqi",
    "irqin",
    "irqə",
    "irqçi*",
    "irq ayrı*",
    "irq bərabərliy*",
    "etnik*",
    "milliyyət*",
    "milli azlıq*",
    "qaraçı",
    "qaraçılar",
    "qaraçıların",
    // ru
    "расов*",
    "раса",
    "расы",
    "расу",
    "расой",
    "расизм*",
    "расист*",
    "этнич*",
    "этнос*",
    "национальност*",
    "нацменьшинств*",
    "цыган*",
    // tr
    "ırk",
    "ırkı",
    "ırka",
    "ırkın",
    "ırkçı*",
    "ırksal",
    "etnisite",
    "çingene*",
    // Added on the privacy review's build review (keyword build, condition C).
    "latino*",
    "latina*",
    "latinx",
    "hispanic*",
    "black owned",
    "asian owned",
    "minority owned",
    "qaradərili*",
    "латиноамерикан*",
    "чернокож*",
    "темнокож*",
    "siyahi*",
    "zenci*",
  ],
  political: [
    // en
    "political*",
    "politics",
    "politician*",
    "democrats",
    "democratic party",
    "republican*",
    "communis*",
    "socialism",
    "socialist*",
    "fascis*",
    "nazi",
    "nazis",
    "nazism",
    "neonazi*",
    "neo nazi*",
    "marxis*",
    "anarchis*",
    "nationalism",
    "nationalist*",
    "feminism",
    "feminist*",
    "left wing",
    "right wing",
    "far right",
    "far left",
    "leftist*",
    "liberals",
    "labour party",
    "labor party",
    "green party",
    "conservative party",
    "tory",
    "tories",
    "maga",
    "zionis*",
    // az ("siyasət" alone is also "policy", so only the adjective and the person)
    "siyasi*",
    "siyasətçi*",
    "müxalif*",
    "kommunist*",
    "kommunizm*",
    "sosialist*",
    "sosializm*",
    "faşist*",
    "faşizm*",
    "millətçi*",
    "feminizm*",
    // ru ("политика" is also "policy", so only the adjective and the person)
    "политическ*",
    "политолог*",
    "политик",
    "политиков",
    "политиком",
    "оппозици*",
    "коммунист*",
    "коммунизм*",
    "социалист*",
    "социализм*",
    "фашис*",
    "фашизм*",
    "нацис*",
    "нацизм*",
    "национализм*",
    "националист*",
    "феминизм*",
    "феминист*",
    "либерализм*",
    "либералы",
    "либералов",
    "единая россия",
    "кпрф",
    "лдпр",
    // tr ("politika" is also "policy", "siyaset" also "pricing policy")
    "siyasetçi*",
    "muhalefet*",
    "komünist*",
    "komünizm*",
    "sosyalist*",
    "sosyalizm*",
    "milliyetçi*",
    "ülkücü*",
    "solcu*",
    "sağcı*",
    "akp",
    "chp",
    "mhp",
    "hdp",
    "ak parti",
    "dem parti",
    // Added on the privacy review's build review (keyword build, condition C).
    "election*",
    "vote",
    "votes",
    "voting",
    "voter*",
    "ballot*",
    "seçki*",
    "səsvermə*",
    "səs ver*",
    "выборы",
    "выборов",
    "выборах",
    "голосован*",
    "избирател*",
    "seçmen*",
    "oy ver*",
    "oy kullan*",
    "sandık başı*",
  ],
  religious: [
    // en (religious and philosophical beliefs)
    "religion*",
    "religious",
    "church",
    "churches",
    "mosque*",
    "synagogue*",
    "christian*",
    "muslim*",
    "islam",
    "islamic",
    "islamist*",
    "islamophob*",
    "jew",
    "jews",
    "jewish",
    "judaism",
    "catholic*",
    "protestant*",
    "evangelical*",
    "orthodox church*",
    "buddhis*",
    "hindu",
    "hindus",
    "hinduism",
    "sikh*",
    "atheis*",
    "agnosticism",
    "bible",
    "bibles",
    "biblical",
    "quran",
    "koran",
    "prayer",
    "prayers",
    "praying",
    "pray",
    "ramadan",
    "halal",
    "kosher",
    "hijab*",
    "jehovah*",
    "mormon*",
    "scientolog*",
    "freemason*",
    "spiritual",
    "spirituality",
    // az and tr ("din" alone is also a DIN rail, "dinə" folds to "dine",
    // "dinlər" to tr "they listen": only the adjective and compounds)
    "dini",
    "din adam*",
    "din xadim*",
    "din kitab*",
    "din təhsil*",
    "din dersi",
    "din eğitim*",
    "din işler*",
    "dinin",
    "dindar*",
    "dinsiz*",
    "məscid*",
    "kilsə*",
    "xristian*",
    "müsəlman*",
    "islami",
    "yəhudi*",
    "ateist*",
    "ateizm*",
    "namaz*",
    "ramazan*",
    "quran*",
    "dua",
    "dualar",
    "duası",
    "hicab*",
    "sünni*",
    "məzhəb*",
    // ru
    "религи*",
    "религиозн*",
    "церковь",
    "церкви",
    "церковн*",
    "храм",
    "храма",
    "храмы",
    "храме",
    "мечет*",
    "синагог*",
    "христиан*",
    "мусульман*",
    "ислам",
    "исламск*",
    "иудаизм*",
    "иудей*",
    "еврей*",
    "православ*",
    "католи*",
    "протестант*",
    "евангелие",
    "евангелия",
    "евангельск*",
    "евангелическ*",
    "буддиз*",
    "буддист*",
    "индуизм*",
    "атеиз*",
    "атеист*",
    "молитв*",
    "библия",
    "библии",
    "библию",
    "библейск*",
    "коран",
    "корана",
    "корану",
    "кораном",
    "коране",
    "намаз*",
    "халяль",
    "халял*",
    "кошерн*",
    "рамадан*",
    "ураза*",
    "хиджаб*",
    "секта",
    "секты",
    "сектант*",
    "масон*",
    // tr ("cami*" would take "camia", a community: exact forms only)
    "cami",
    "camii",
    "camide",
    "camisi",
    "camiler*",
    "kilise*",
    "hristiyan*",
    "hıristiyan*",
    "müslüman*",
    "islamiyet",
    "islamcı*",
    "yahudi*",
    "oruç",
    "kuran",
    "kur an",
    "kuranı",
    "helal",
    "tesettür*",
    "türban*",
    "başörtü*",
    "mezhep*",
    "tarikat*",
    "cemaat*",
    "alevi*",
  ],
  union: [
    // en ("union" alone is left out: "credit union", "european union")
    "trade union*",
    "labor union*",
    "labour union*",
    "union member*",
    "union dues",
    "union rep*",
    "unionize*",
    "unionise*",
    "unionization",
    "unionisation",
    "teamsters",
    "afl cio",
    "collective bargaining",
    "shop steward*",
    // az ("həmkarlar" alone is "colleagues")
    "həmkarlar ittifaq*",
    "kollektiv müqavilə*",
    // ru
    "профсоюз*",
    "тред юнион*",
    "коллективн* договор*",
    // tr
    "sendika",
    "sendikası",
    "sendikaya",
    "sendikada",
    "sendikadan",
    "sendikanın",
    "sendikal*",
    "toplu sözleşme*",
    "toplu iş sözleşme*",
  ],
  genetic: [
    // en ("dna" alone is left out: "brand dna")
    "genetic*",
    "genome*",
    "genomic*",
    "genotyp*",
    "dna test*",
    "dna kit*",
    "dna analys*",
    "dna sequenc*",
    "dna profil*",
    "dna ancestry",
    "paternity test*",
    "23andme",
    "hereditary",
    "gene therap*",
    "gene test*",
    // az
    "genetik*",
    "genom*",
    "dnt analiz*",
    "dnt test*",
    "dnk analiz*",
    "dnk test*",
    "irsi*",
    // ru ("днк" alone is left out: "днк бренда")
    "генетик*",
    "генетич*",
    "геном*",
    "генотип*",
    "днк тест*",
    "тест* днк",
    "анализ* днк",
    "днк анализ*",
    "днк экспертиз*",
    "тест* на отцовств*",
    // tr
    "genotip*",
    "dna testi",
    "dna analiz*",
    "babalık test*",
    "kalıtsal",
  ],
  biometric: [
    // en ("fingerprint" also names browser fingerprinting; refused all the same)
    "biometric*",
    "fingerprint*",
    "face recognition",
    "facial recognition",
    "face id",
    "face scan*",
    "iris scan*",
    "iris recognition",
    "retina scan*",
    "voiceprint*",
    "palm vein*",
    "palm print*",
    // az
    "biometrik*",
    "barmaq iz*",
    "üz tanıma*",
    "üz tanın*",
    // ru
    "биометри*",
    "отпечат* пальц*",
    "распознаван* лиц*",
    "сканирован* радужк*",
    // tr
    "biyometrik*",
    "parmak iz*",
    "yüz tanıma*",
    "iris tarama*",
    "retina tarama*",
  ],
  health: [
    // Named conditions on top of the shared health tables. en
    "cancer*",
    "oncolog*",
    "tumor*",
    "tumour*",
    "hiv",
    "covid*",
    "coronavirus",
    "abortion*",
    "rehab",
    "addiction*",
    "addict",
    "addicts",
    "alcoholism",
    "autism",
    "autistic",
    "adhd",
    "dementia",
    "alzheimer*",
    "parkinson*",
    "asthma*",
    "obesity",
    "obese",
    "disabilit*",
    "disabled people",
    "disabled person*",
    "disabled access",
    "disabled parking",
    "wheelchair*",
    "mental health",
    "mental illness",
    "psychiatr*",
    "psychologist*",
    "psychotherap*",
    "schizophren*",
    "bipolar",
    "suicid*",
    "eating disorder*",
    "anorexia",
    "bulimia",
    "ivf",
    "miscarriage*",
    "menopaus*",
    "stds",
    "std test*",
    "hepatitis",
    "tuberculosis",
    "epilep*",
    "chemotherap*",
    "dialysis",
    "insulin",
    "medication*",
    "diagnosis",
    "diagnosed",
    "diagnoses",
    "weight loss",
    "lose weight",
    "hair loss",
    "pain relief",
    "painkiller*",
    "back pain",
    "chronic pain",
    "sleep apnea",
    "sleep disorder*",
    "panic attack*",
    "ptsd",
    "hearing aid*",
    "hearing loss",
    "blood pressure",
    "blood test*",
    "blood sugar",
    "drug test*",
    // az
    "xərçəng*",
    "onkolo*",
    "qiçs",
    "abort",
    "abortlar*",
    "narkoman*",
    "alkoqolizm*",
    "autizm*",
    "demensiya*",
    "astma*",
    "piylənmə*",
    "əlil*",
    "psixiatr*",
    "psixoloq*",
    "psixoterap*",
    "intihar*",
    "arıqlama*",
    "insulin*",
    "hepatit*",
    "vərəm*",
    "epilepsiya*",
    "qan təzyiq*",
    "qan analiz*",
    "sonsuzluq*",
    // ru ("психолог*" would take "психология продаж": exact forms only)
    "онколог*",
    "опухол*",
    "вич",
    "спид",
    "ковид*",
    "коронавирус*",
    "аборт*",
    "наркоман*",
    "наркозависим*",
    "алкоголизм*",
    "алкоголик*",
    "реабилитационн* центр*",
    "аутизм*",
    "аутист*",
    "сдвг",
    "деменци*",
    "альцгеймер*",
    "паркинсон*",
    "астм*",
    "ожирени*",
    "инвалид*",
    "психиатр*",
    "психотерап*",
    "психолог",
    "психолога",
    "психологу",
    "психологом",
    "шизофрен*",
    "биполярн*",
    "суицид*",
    "самоубийств*",
    "анорекси*",
    "булими*",
    "выкидыш*",
    "климакс*",
    "менопауз*",
    "гепатит*",
    "туберкулез*",
    "эпилепс*",
    "химиотерап*",
    "диализ*",
    "инсулин*",
    "диагноз*",
    "похуден*",
    "похудет*",
    "выпадени* волос*",
    "анализ* крови",
    "венерическ*",
    "иппп",
    // tr ("psikolog*" would take "renk psikolojisi": exact forms only)
    "kanser*",
    "onkoloji*",
    "tümör*",
    "kovid*",
    "koronavirüs*",
    "kürtaj*",
    "bağımlılık*",
    "bağımlılığı",
    "alkolizm*",
    "otizm*",
    "otistik*",
    "dehb",
    "demans*",
    "astım*",
    "obezite*",
    "engelli*",
    "psikiyatr*",
    "psikolog",
    "psikologlar",
    "psikoterap*",
    "şizofreni*",
    "intihar*",
    "anoreksi*",
    "bulimi*",
    "tüp bebek*",
    "menopoz*",
    "verem*",
    "epilepsi*",
    "kemoterapi*",
    "diyaliz*",
    "insülin*",
    "zayıflama*",
    "kilo verme*",
    "saç dökülme*",
    "tansiyon*",
    "kan tahlil*",
    "kan şekeri*",
    "kısırlık*",
    "gıda takviye*",
    "grip aşı*",
    // Added on the privacy review's build review (keyword build, condition C).
    "ozempic",
    "wegovy",
    "mounjaro",
    "semaglutid*",
    "tirzepatid*",
    "оземпик*",
    "семаглутид*",
    "acne",
    "psoriasis",
    "eczema",
    "dermatolog*",
    "sti",
    "sti test*",
    "telehealth",
    "telemedicine",
    "vaccin*",
    "glucose monitor*",
    "glucometer*",
    "self harm",
    "sober",
    "sobriety",
    "period tracker*",
    "menstrua*",
    "diet pill*",
    "weight loss pill*",
    "sızanaq*",
    "psoriaz*",
    "ekzema*",
    "dermatoloq*",
    "peyvənd*",
    "qlükometr*",
    "telemedisin*",
    "aybaşı*",
    "menstruasiya*",
    "özünə zərər*",
    "акне",
    "прыщ*",
    "псориаз*",
    "экзем*",
    "дерматолог*",
    "вакцин*",
    "прививк*",
    "глюкометр*",
    "самоповрежд*",
    "трезвост*",
    "телемедицин*",
    "месячны*",
    "менструа*",
    "akne",
    "sivilce*",
    "sedef hastalığı",
    "egzama*",
    "aşı",
    "aşısı",
    "aşılar",
    "aşılama*",
    "glukometre*",
    "teletıp",
    "regl",
    "menstrüasyon*",
    "kendine zarar*",
  ],
  sex_life: [
    // en
    "sex",
    "sexual*",
    "sexuality",
    "porn*",
    "erotic*",
    "escort service*",
    "escorts",
    "sex toy*",
    "condom",
    "condoms",
    "viagra",
    "erectile",
    "libido",
    "orgasm*",
    "fetish*",
    "bdsm",
    "hookup*",
    "onlyfans",
    "adult content",
    "xxx",
    "swinger*",
    "prostitut*",
    "contracepti*",
    "birth control",
    // az ("seks*" would take "seksiya", a sports section; "cinsi" alone is "of its kind")
    "seks",
    "seksual*",
    "cinsi əlaqə*",
    "cinsi həyat*",
    "cinsi istək*",
    "porno*",
    "erotik*",
    "prezervativ*",
    "intim xidmət*",
    "intim əlaqə*",
    "fahişə*",
    "kontrasepsiya*",
    // ru
    "секс",
    "секса",
    "сексу",
    "сексом",
    "сексуальн*",
    "сексшоп*",
    "порн*",
    "эротик*",
    "эротич*",
    "интим",
    "интим услуг*",
    "интимн* услуг*",
    "презерватив*",
    "проститут*",
    "эскорт*",
    "фетиш*",
    "бдсм",
    "либидо",
    "оргазм*",
    "контрацеп*",
    "виагр*",
    "потенция",
    "потенции",
    // tr ("seks*" would take "seksen", eighty)
    "seksi",
    "seksüel*",
    "cinsel*",
    "prezervatif*",
    "eskort*",
    "fuhuş",
    "fetiş*",
    "doğum kontrol*",
    "kontrasepsiyon*",
  ],
  sexual_orientation: [
    // en
    "gay",
    "gays",
    "lesbian*",
    "bisexual*",
    "transgender*",
    "transsexual*",
    "queer*",
    "lgbt*",
    "homosexual*",
    "heterosexual*",
    "asexual*",
    "pansexual*",
    "nonbinary",
    "non binary",
    "gender identity",
    "drag queen*",
    "pride parade*",
    // az
    "gey",
    "geylər",
    "lezbiyan*",
    "biseksual*",
    "transseksual*",
    "homoseksual*",
    "heteroseksual*",
    "cinsi oriyentasiya*",
    "cinsi azlıq*",
    // ru
    "гей",
    "геев",
    "геям",
    "лесби*",
    "бисексуал*",
    "трансгендер*",
    "транссексуал*",
    "гомосексуал*",
    "гетеросексуал*",
    "лгбт*",
    "квир*",
    "небинарн*",
    "нетрадиционн* ориентаци*",
    // tr
    "lezbiyen*",
    "biseksüel*",
    "trans birey*",
    "transseksüel*",
    "eşcinsel*",
    "heteroseksüel*",
    "cinsiyet kimliğ*",
  ],
  criminal: [
    // en (Art. 10)
    "criminal*",
    "crime",
    "crimes",
    "convicted",
    "felony",
    "felonies",
    "felon",
    "felons",
    "mugshot*",
    "arrest record*",
    "arrest warrant*",
    "arrested",
    "jail",
    "jailed",
    "prison",
    "prisons",
    "prisoner*",
    "inmate*",
    "parole",
    "sex offender*",
    "ex offender*",
    "ex convict*",
    "expunge*",
    "dui",
    "dwi",
    "probation officer*",
    "dbs check*",
    "police record*",
    // az
    "cinayət*",
    "məhkum*",
    "həbs*",
    "türmə*",
    "məhbus*",
    "cəzaçəkmə*",
    // ru ("заключенный" is also "a concluded contract")
    "судимост*",
    "судимый",
    "уголовн*",
    "преступлен*",
    "преступник*",
    "тюрьм*",
    "тюрем*",
    "осужденн*",
    "арестован*",
    // tr ("ceza" alone is also a late fee)
    "sabıka*",
    "adli sicil*",
    "hükümlü*",
    "mahkum*",
    "cezaevi*",
    "hapis*",
    "hapse",
    "hapsedil*",
    "suç",
    "suçlar*",
    "suçlu*",
    "tutuklu*",
    "tutuklan*",
    "ağır ceza*",
    "ceza avukat*",
    "ceza dava*",
    "gözaltı*",
    // Added on the privacy review's build review (keyword build, condition C).
    "background check*",
    "sabıka kaydı",
    "adli sicil*",
    "проверка судимост*",
  ],
};

/**
 * Health words of the shared tables the screen does not take alone: in a
 * keyword they are ordinary commerce more often than a health search
 * ("water treatment", "network diagnostics", "personel takviyesi",
 * "ürəkdən", "сердце" in a shop name). Their health compounds are in TERMS.
 */
const HEALTH_WORDS_SKIP: ReadonlySet<string> = new Set([
  "treatment*",
  "diagnos*",
  "диагно*",
  "takviye*",
  "urek*",
  "сердц*",
]);

/**
 * Symptom nouns of the claims lock the screen does not take alone, as the
 * claims lock spells them: a body word or a state that commerce uses in
 * another sense ("cold email", "pain points", "stress test", "energy
 * drinks", "hair salon", "dəri çanta", "kalp" in a shop name, "kilo" as a
 * weight unit). Their health compounds are in TERMS.
 */
const SYMPTOM_SKIP: Readonly<Record<string, ReadonlySet<string>>> = {
  en: new Set([
    "stress",
    "pain",
    "cold",
    "skin",
    "hair",
    "joints",
    "bones",
    "heart",
    "sleep",
    "energy",
    "weight",
    "gut",
    "weakness",
  ]),
  az: new Set([
    "stress",
    "narahatlıq",
    "dəri",
    "saç",
    "oynaq",
    "sümük",
    "ürək",
    "yuxu",
    "enerji",
    "çəki",
  ]),
  ru: new Set([
    "стресс",
    "вес",
    "кожа",
    "волосы",
    "сердце",
    "сон",
    "энергия",
    "кости",
    "суставы",
    "боль",
    "боли",
    "слабость",
  ]),
  tr: new Set([
    "stres",
    "kaygı",
    "cilt",
    "saç",
    "kalp",
    "uyku",
    "enerji",
    "kilo",
    "kemik",
    "eklem",
    "grip",
  ]),
};

/**
 * Folded words a stem would take but that name no category: "hospitality"
 * (hospital*), "здорово" ("great", здоров*), "печенье" (cookies, печен*),
 * "doktora" and "doctorate" (a PhD, doktor* and doctor*), "докторская"
 * (a sausage or a thesis, доктор*), "ilaçlama" (pest control, ilaç*),
 * "supplementary" (supplement*), "preparation" (az preparat*).
 */
const NOT_TERMS: ReadonlySet<string> = new Set(
  [
    "hospitality",
    "hospitable",
    "здорово",
    "печенье",
    "печенья",
    "печеньем",
    "печенька",
    "печеньки",
    "печенек",
    "doktora",
    "doktorasi",
    "doktorant",
    "doktorantura",
    "doctorate",
    "doctoral",
    "докторская",
    "докторской",
    "докторскую",
    "докторский",
    "ilaçlama",
    "ilaçlaması",
    "supplementary",
    "preparation",
    "preparations",
    "preparatory",
  ].map(foldHealthText),
);

/** Words of a text as the screen reads them: folded, split on anything that is not a letter or digit. */
function screenWords(text: string): string[] {
  return foldHealthText(text.normalize("NFKC"))
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 0);
}

/** One word of an entry: a folded whole word, a stem, or a pattern (az and tr symptom nouns). */
type Part = { word: string; stem: boolean } | { re: RegExp };
type Entry = readonly Part[];

function parseEntry(entry: string): Entry {
  return entry
    .split(" ")
    .filter((w) => w.length > 0)
    .map((w) =>
      w.endsWith("*")
        ? { word: foldHealthText(w.slice(0, -1)), stem: true }
        : { word: foldHealthText(w), stem: false },
    );
}

function partMatches(part: Part, word: string): boolean {
  if (NOT_TERMS.has(word)) return false;
  if ("re" in part) return part.re.test(word);
  if (!part.stem) return word === part.word;
  return word.startsWith(part.word) && word.length - part.word.length <= STEM_EXTRA;
}

function entryMatches(entry: Entry, words: readonly string[]): boolean {
  const n = entry.length;
  for (let i = 0; i + n <= words.length; i++) {
    let all = true;
    for (let j = 0; j < n; j++) {
      const part = entry[j];
      const word = words[i + j];
      if (!part || word === undefined || !partMatches(part, word)) {
        all = false;
        break;
      }
    }
    if (all) return true;
  }
  return false;
}

/** A plural and one case ending on an az or tr noun, folded (the claims lock's NOUN_WORD, folded). */
function nounWithEndings(noun: string): RegExp {
  const safe = noun.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${safe}(?:lar|ler)?(?:dan|den|tan|ten|da|de|ta|te|[iuae])?$`, "u");
}

function symptomEntries(): Entry[] {
  const out: Entry[] = [];
  for (const [lang, nouns] of Object.entries(HEALTH_SYMPTOM_NOUNS)) {
    const skip = SYMPTOM_SKIP[lang];
    for (const noun of nouns) {
      if (skip?.has(noun)) continue;
      const folded = foldHealthText(noun);
      if (folded.includes(" ") || (lang !== "az" && lang !== "tr")) {
        out.push(parseEntry(folded));
      } else {
        out.push([{ re: nounWithEndings(folded) }]);
      }
    }
  }
  return out;
}

const TABLES: ReadonlyArray<readonly [SpecialCategory, readonly Entry[]]> = SPECIAL_CATEGORIES.map(
  (category) => {
    const entries = TERMS[category].map(parseEntry);
    if (category === "health") {
      for (const w of HEALTH_WORDS) if (!HEALTH_WORDS_SKIP.has(w)) entries.push(parseEntry(w));
      entries.push(...symptomEntries());
    }
    return [category, entries] as const;
  },
);

const ADDRESSED: readonly RegExp[] = Object.values(HEALTH_ADDRESSED_PATTERNS).flat();

/**
 * The category a phrase names, or null. Categories are read in
 * SPECIAL_CATEGORIES order; the first that holds the phrase answers.
 * Returns a category name only, never the words that matched.
 */
export function specialCategoryOf(phrase: string | null | undefined): SpecialCategory | null {
  if (!phrase) return null;
  const words = screenWords(phrase);
  if (words.length === 0) return null;
  for (const [category, entries] of TABLES) {
    if (category === "health") {
      // The claims lock's patterns read the phrase as spelled (ğ, ə, ı kept).
      const spelled = phrase.normalize("NFKC").toLocaleLowerCase("und").replace(/i̇/g, "i");
      if (ADDRESSED.some((re) => re.test(spelled))) return category;
    }
    if (entries.some((e) => entryMatches(e, words))) return category;
  }
  return null;
}

/**
 * The keyword lexicon's screen (validateLexicon's `refused`): true when the
 * phrase names any Art. 9 or Art. 10 category in en, az, ru or tr. Takes a
 * phrase folded by foldKeyword and folds it again (diacritics, `ə`, `ı`).
 */
export function refusesSpecialCategory(phrase: string): boolean {
  return specialCategoryOf(phrase) !== null;
}
