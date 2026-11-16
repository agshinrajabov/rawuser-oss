/**
 * The health guess of the readiness check (docs/specs/readiness-check.md,
 * check 3): does the customer's own page read like a health site? A words
 * table per language (en, az, ru, tr), health only; a hit is three distinct
 * table words in the text. Pure string work.
 *
 * What the guess is for, and what it is not (the privacy review's condition 3):
 * it colours one unanswered line amber ("Your page reads like a health
 * site. Tell us if it is."). It is never stored, logged, alerted or
 * quoted: this module returns a count, never the words it matched.
 */

/** Distinct table words a text must hold to read like a health site. */
export const HEALTH_HIT_WORDS = 3;

/**
 * One entry is a folded whole word; a trailing `*` makes it a stem
 * (`patient*` takes patients, `müalicə*` takes müalicəsi). Folded means
 * lower case, diacritics off, `ə` as `e` and `ı` as `i`; Cyrillic stays
 * Cyrillic. Short generic words (blood, skin, pain in isolation) are left
 * out: a false hit on an ordinary site costs an amber line nobody asked for.
 */
export const HEALTH_WORDS: readonly string[] = [
  // en
  "health",
  "healthcare",
  "medical",
  "medicine*",
  "clinic*",
  "doctor*",
  "physician*",
  "patient*",
  "therap*",
  "treatment*",
  "pharmac*",
  "supplement*",
  "vitamin*",
  "symptom*",
  "diagnos*",
  "disease*",
  "illness*",
  "wellness",
  "dental",
  "dentist*",
  "hospital*",
  "prescription*",
  "dosage",
  "immune",
  "immunity",
  "cholesterol",
  "diabet*",
  "liver",
  "kidney*",
  "cardio*",
  "pregnan*",
  "fertility",
  "anxiety",
  "depression",
  "hormon*",
  "allerg*",
  "infection*",
  "probiotic*",
  "nutrition*",
  // az (folded)
  "saglamliq*",
  "saglamliga",
  "tibb*",
  "klinik*",
  "hekim*",
  "xeste*",
  "mualice*",
  "derman*",
  "aptek*",
  "simptom*",
  "diaqnoz*",
  "immun*",
  "qaraciyer*",
  "boyrek*",
  "urek*",
  "hamile*",
  "stomatolo*",
  "diabet*",
  "terapiya*",
  "preparat*",
  "vitamin*",
  "qida elavesi",
  // ru
  "здоров*",
  "медицин*",
  "клиник*",
  "врач*",
  "доктор*",
  "пациент*",
  "лечени*",
  "лечебн*",
  "аптек*",
  "витамин*",
  "симптом*",
  "диагно*",
  "болезн*",
  "иммун*",
  "печен*",
  "почк*",
  "сердц*",
  "беремен*",
  "стоматолог*",
  "диабет*",
  "терапи*",
  "препарат*",
  "таблетк*",
  "лекарств*",
  "гормон*",
  "аллерг*",
  "инфекц*",
  "бад",
  "бады",
  // tr (folded)
  "saglik*",
  "saglig*",
  "tibbi*",
  "doktor*",
  "hasta*",
  "tedavi*",
  "eczane*",
  "takviye*",
  "semptom*",
  "belirti*",
  "teshis*",
  "bagisiklik*",
  "karaciger*",
  "bobrek*",
  "hamile*",
  "gebelik*",
  "diyabet*",
  "terapi*",
  "ilac*",
  "hormon*",
  "alerji*",
  "enfeksiyon*",
];

/** Lower case, diacritics off, `ə` as `e` and `ı` as `i`; Cyrillic letters kept. */
export function foldHealthText(s: string): string {
  return s
    .toLowerCase()
    .replace(/ə/g, "e")
    .replace(/ı/g, "i")
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
}

interface Entry {
  word: string;
  stem: boolean;
}

const ENTRIES: readonly Entry[] = HEALTH_WORDS.map((w) =>
  w.endsWith("*")
    ? { word: foldHealthText(w.slice(0, -1)), stem: true }
    : { word: foldHealthText(w), stem: false },
);

/**
 * How many distinct table entries the text holds. Whole words only; a stem
 * entry matches a word that starts with it; a phrase entry matches as a
 * phrase. The count is the only thing that leaves: no word, no position.
 */
export function healthWordHits(text: string | null | undefined): number {
  if (!text) return 0;
  const folded = foldHealthText(text);
  const words = folded.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 0);
  const joined = ` ${words.join(" ")} `;
  let hits = 0;
  for (const e of ENTRIES) {
    if (e.word.includes(" ")) {
      if (joined.includes(` ${e.word} `)) hits++;
      continue;
    }
    const hit = e.stem
      ? words.some((w) => w.startsWith(e.word) && w.length - e.word.length <= 6)
      : words.includes(e.word);
    if (hit) hits++;
  }
  return hits;
}

/** True when the text holds HEALTH_HIT_WORDS distinct table words or more. */
export function readsLikeHealth(text: string | null | undefined): boolean {
  return healthWordHits(text) >= HEALTH_HIT_WORDS;
}
