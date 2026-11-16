import { describe, expect, it } from "vitest";
import { foldKeyword, validateLexicon } from "../src/keyword-lexicon.ts";
import {
  SPECIAL_CATEGORIES,
  type SpecialCategory,
  refusesSpecialCategory,
  specialCategoryOf,
} from "../src/special-category/terms.ts";

type Lang = "en" | "az" | "ru" | "tr";

/** At least one phrase per category per language (privacy review condition 7). */
const POSITIVES: Record<SpecialCategory, Record<Lang, readonly string[]>> = {
  ethnic: {
    en: ["ethnic minority jobs", "racial discrimination lawyer"],
    az: ["irqi ayrıseçkilik", "milliyyəti üzrə ayrıseçkilik"],
    ru: ["расовая дискриминация", "национальность по паспорту"],
    tr: ["ırkçılık haberleri", "IRKÇILIK"],
  },
  political: {
    en: ["socialist newspaper", "far right news"],
    az: ["siyasi partiya", "müxalifət mitinqi"],
    ru: ["политическая партия", "оппозиция новости"],
    tr: ["milliyetçi parti", "muhalefet lideri"],
  },
  religious: {
    en: ["christian bookstore", "halal food delivery", "church management software"],
    az: ["məscid yaxınlığında ev", "namaz vaxtları", "dini kitablar"],
    ru: ["православная церковь", "время намаза"],
    tr: ["tesettür giyim", "İslam", "kilise düğünü"],
  },
  union: {
    en: ["trade union membership", "unionize my workplace"],
    az: ["həmkarlar ittifaqı üzvlüyü"],
    ru: ["профсоюз работников", "вступить в профсоюз"],
    tr: ["sendika üyeliği", "sendikalaşma hakkı"],
  },
  genetic: {
    en: ["genetic testing kit", "dna test kit"],
    az: ["genetik analiz", "irsi xəstəliklər"],
    ru: ["генетический тест", "анализ днк"],
    tr: ["babalık testi", "dna testi fiyatı"],
  },
  biometric: {
    en: ["fingerprint scanner", "facial recognition app"],
    az: ["barmaq izi oxuyucu", "üz tanıma sistemi"],
    ru: ["отпечаток пальца сканер", "распознавание лиц"],
    tr: ["yüz tanıma sistemi", "parmak izi okuyucu"],
  },
  health: {
    en: ["diabetes supplements", "your liver", "insomnia", "weight loss pills", "cancer clinic"],
    az: ["qaraciyər müalicəsi", "yuxusuzluqdan", "xərçəng müalicəsi", "qaraciyəriniz"],
    ru: ["лечение диабета", "мигрень", "онколог в баку", "у вас болит"],
    tr: ["kanser tedavisi", "migren", "karaciğeriniz", "tansiyon ölçer"],
  },
  sex_life: {
    en: ["sex toys shop", "erotic massage"],
    az: ["prezervativ almaq", "cinsi əlaqə"],
    ru: ["секс шоп", "эскорт услуги"],
    tr: ["prezervatif fiyatları", "erotik film"],
  },
  sexual_orientation: {
    en: ["gay bars", "transgender support"],
    az: ["lezbiyan cütlük", "homoseksual münasibət"],
    ru: ["лгбт сообщество", "гей клуб"],
    tr: ["eşcinsel evlilik", "lezbiyen çift"],
  },
  criminal: {
    en: ["criminal record check", "mugshot search"],
    az: ["məhkumluq arayışı", "cinayət vəkili"],
    ru: ["справка о судимости", "уголовное дело"],
    tr: ["adli sicil kaydı", "sabıka kaydı sorgulama"],
  },
};

/** Ordinary commercial phrases, many of them near a refused word. */
const NEGATIVES: readonly string[] = [
  // asked for by the build
  "crm pricing",
  "customer care",
  "life cycle",
  "credit union software",
  "best project management",
  "fiyat",
  "qiymət",
  "цена",
  // en collisions
  "hospitality software",
  "cold email tool",
  "customer pain points",
  "stress testing tool",
  "platform agnostic",
  "brand dna",
  "network diagnostics",
  "water treatment",
  "european union",
  "gen z marketing",
  "consumer psychology",
  "energy drinks",
  "hair salon booking",
  "developer evangelist",
  "dine in restaurant",
  "pipedrive alternative",
  "hubspot vs salesforce",
  "free crm",
  "how to track leads",
  "zapier integration",
  "life insurance quote",
  "customer lifecycle",
  "party supplies",
  "condominium rentals",
  "doctorate programs",
  "grip socks",
  "din rail",
  "irq handler",
  "abortcontroller",
  "disabled button",
  "supplementary materials",
  "preparation time",
  // az collisions
  "məxfilik siyasəti",
  "qaytarma siyasəti",
  "idman seksiyası",
  "təhsil naziri",
  "həmkarlarla paylaş",
  "dəri çanta",
  "endirim",
  "ən yaxşı crm",
  "pulsuz sınaq",
  // ru collisions
  "политика конфиденциальности",
  "партия товара",
  "купить печенье",
  "психология продаж",
  "днк бренда",
  "евангелист",
  "скидка",
  "лучшая crm",
  "докторская колбаса",
  "секстет",
  "корандо",
  "либеральные цены",
  "реабилитация зданий",
  // tr collisions
  "gizlilik politikası",
  "iade politikası",
  "fiyat siyaseti",
  "gecikme cezası",
  "seksen yaş",
  "doktora programı",
  "renk psikolojisi",
  "personel takviyesi",
  "iş camiası",
  "en iyi crm",
  "ücretsiz deneme",
  "kampanya",
  "ilaçlama firması",
  "sendikasyon kredisi",
];

describe("special-category screen: every category in every language", () => {
  for (const category of SPECIAL_CATEGORIES) {
    for (const lang of ["en", "az", "ru", "tr"] as const) {
      const phrases = POSITIVES[category][lang];
      it(`${category} / ${lang}`, () => {
        expect(phrases.length).toBeGreaterThan(0);
        for (const phrase of phrases) {
          const folded = foldKeyword(phrase);
          expect({ phrase, category: specialCategoryOf(folded) }).toEqual({ phrase, category });
          expect(refusesSpecialCategory(folded)).toBe(true);
        }
      });
    }
  }
});

describe("special-category screen: ordinary commercial phrases pass", () => {
  for (const phrase of NEGATIVES) {
    it(phrase, () => {
      const folded = foldKeyword(phrase);
      expect({ phrase, category: specialCategoryOf(folded) }).toEqual({ phrase, category: null });
      expect(refusesSpecialCategory(folded)).toBe(false);
    });
  }
});

describe("special-category screen: input handling", () => {
  it("folds again: unfolded, upper case and dotted capital input match", () => {
    expect(refusesSpecialCategory("İSLAM")).toBe(true);
    expect(refusesSpecialCategory("Qaraciyər Müalicəsi")).toBe(true);
    expect(refusesSpecialCategory("Sendika-Üyeliği")).toBe(true);
  });

  it("empty input names nothing", () => {
    expect(refusesSpecialCategory("")).toBe(false);
    expect(specialCategoryOf(null)).toBe(null);
    expect(specialCategoryOf("   ")).toBe(null);
  });

  it("whole words only: a refused word inside another word does not count", () => {
    expect(refusesSpecialCategory("essex office")).toBe(false);
    expect(refusesSpecialCategory("unisex hoodies")).toBe(false);
    expect(refusesSpecialCategory("churchill quotes")).toBe(false);
  });

  it("a stem takes its own endings", () => {
    expect(refusesSpecialCategory("sendikalarımızdan")).toBe(true);
    expect(refusesSpecialCategory("lgbtqia")).toBe(true);
  });

  it("returns a category name, never a matched word", () => {
    const out = specialCategoryOf("diabetes supplements");
    expect(SPECIAL_CATEGORIES).toContain(out);
  });
});

describe("special-category screen inside validateLexicon", () => {
  it("drops refused phrases and keeps commercial ones", () => {
    const out = validateLexicon(
      {
        pricing: ["crm pricing", "diabetes pricing", "fiyat"],
        competitor: ["hubspot", "gay crm"],
        feature: ["fingerprint login", "zapier integration"],
      },
      null,
      refusesSpecialCategory,
    );
    expect(out).toEqual({
      competitor: ["hubspot"],
      pricing: ["crm pricing", "fiyat"],
      feature: ["zapier integration"],
    });
  });
});

describe("special-category screen: the privacy review's build-review gaps (condition C)", () => {
  const ADDED: ReadonlyArray<readonly [string, string]> = [
    ["ozempic online", "health"],
    ["wegovy price", "health"],
    ["semaglutide", "health"],
    ["mounjaro", "health"],
    ["tirzepatide", "health"],
    ["acne cream", "health"],
    ["psoriasis", "health"],
    ["eczema care", "health"],
    ["dermatologist near", "health"],
    ["sti test", "health"],
    ["telehealth app", "health"],
    ["vaccine", "health"],
    ["glucose monitor", "health"],
    ["self harm", "health"],
    ["sober living", "health"],
    ["period tracker", "health"],
    ["diet pills", "health"],
    ["sızanaq kremi", "health"],
    ["peyvənd", "health"],
    ["aybaşı", "health"],
    ["вакцина", "health"],
    ["акне", "health"],
    ["самоповреждение", "health"],
    ["akne", "health"],
    ["aşı", "health"],
    ["egzama", "health"],
    ["election software", "political"],
    ["vote", "political"],
    ["seçki", "political"],
    ["səsvermə", "political"],
    ["выборы", "political"],
    ["голосование", "political"],
    ["seçmen", "political"],
    ["oy ver", "political"],
    ["latino", "ethnic"],
    ["hispanic", "ethnic"],
    ["black owned", "ethnic"],
    ["qaradərili", "ethnic"],
    ["чернокожие", "ethnic"],
    ["siyahi", "ethnic"],
    ["background check", "criminal"],
    ["adli sicil", "criminal"],
    ["проверка судимости", "criminal"],
  ];
  for (const [phrase, category] of ADDED) {
    it(`${phrase}: ${category}`, () => {
      expect(specialCategoryOf(foldKeyword(phrase))).toBe(category);
    });
  }
  // Words that share a start with an added one and must still pass.
  for (const phrase of [
    "aşırı",
    "seçim",
    "выбор",
    "choice",
    "upvote",
    "regular",
    "sedef",
    "sticker",
  ]) {
    it(`${phrase}: passes`, () => {
      expect(specialCategoryOf(foldKeyword(phrase))).toBe(null);
    });
  }
});
