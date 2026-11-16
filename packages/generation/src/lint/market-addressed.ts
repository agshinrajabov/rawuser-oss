/**
 * A market version never addresses where its reader is from (ADR 0038 part
 * 5; docs/specs/direct-visitors.md §5): the wording is written for a market,
 * never for the reader's location, origin or nationality. Hard, and only on
 * a market version.
 *
 * Read in en, az, ru and tr: the second person beside a place ("your
 * country", "where you live", "ölkənizdə", "в вашей стране", "ülkenizde"),
 * a crowd from somewhere ("visitors from", "people from"), and "local to
 * you". Deterministic, no model call; the flag carries the phrase only.
 */

const ADDRESSED: readonly RegExp[] = [
  /\byour\s+(?:own\s+)?(?:country|nation|region|city|area|home\s+country)\b/i,
  /\bwhere\s+you\s+(?:live|are\s+(?:from|based|located)|come\s+from)\b/i,
  /\byou(?:'re|\s+are)\s+(?:from|based\s+in|located\s+in)\b/i,
  /\b(?:visitors?|people|readers?|customers?)\s+(?:from|in)\s+your\b/i,
  /\b(?:[Vv]isitors?|[Pp]eople|[Rr]eaders?)\s+from\s+\p{Lu}/u,
  /\blocal\s+to\s+you\b/i,
  /\bnear\s+you\b/i,
  /ölkənizd\p{L}*|ölkənizin|yaşadığınız\s+(?:ölkə|şəhər|yer)\p{L}*/iu,
  /в\s+вашей\s+стран\p{L}*|вашей\s+страны|где\s+вы\s+живёте|где\s+вы\s+живете|из\s+вашей\s+страны/iu,
  /ülkenizd\p{L}*|ülkenizin|yaşadığınız\s+(?:ülke|şehir|yer)\p{L}*/iu,
];

/** The phrase that addresses the reader's place, or null. */
export function marketAddressed(text: string): string | null {
  for (const re of ADDRESSED) {
    const m = re.exec(text);
    if (m) return m[0];
  }
  return null;
}

/** What the revise pass is told for a part that failed it. */
export const MARKET_ADDRESSED_FIX =
  "nothing about where the reader lives, is from or is now, and never a nationality";
