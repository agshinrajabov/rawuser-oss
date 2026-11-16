/**
 * The languages of a customer's site on the Look and Live screens
 * (docs/specs/per-language.md). Two cases that must not look alike (mock
 * design/mock/sales-readiness/pilot-gaps.html, screen 03, approved
 * 2026-10-12): a language on its own address gets a tick box and its own
 * versions; a language on the same address (section 6 of the spec) gets one
 * sentence and nothing to tick, because nothing is written for it.
 *
 * `customers.languages` holds both kinds since 2026-10-12, so every reader
 * goes through `withPage`: an entry without a page is never counted, ticked
 * or written.
 */

import type { LanguagePage, SameAddressLanguage, StoredLanguage } from "@/types/api";

export const LANGUAGES: { value: string; label: string }[] = [
  { value: "az", label: "Azerbaijani" },
  { value: "en", label: "English" },
  { value: "ru", label: "Russian" },
  { value: "tr", label: "Turkish" },
  { value: "de", label: "German" },
  { value: "fr", label: "French" },
  { value: "es", label: "Spanish" },
];

/** "English" for "en" or "en-GB"; a code we cannot name stays the code. */
export function languageName(code: string): string {
  const primary = code.trim().toLowerCase().split(/[-_]/)[0] ?? "";
  const known = LANGUAGES.find((l) => l.value === primary);
  if (known) return known.label;
  try {
    const name = new Intl.DisplayNames(["en"], { type: "language" }).of(primary);
    if (name && name.toLowerCase() !== primary) return name;
  } catch {
    // not a tag the runtime knows
  }
  return code;
}

/** True for an entry with no page of its own: nothing to tick, count or write. */
export function isSameAddress(l: StoredLanguage): l is SameAddressLanguage {
  return l.status === "same_address" || l.path === null || l.path === undefined;
}

/** The languages that have a page: the only ones a screen counts or ticks. */
export function withPage(list: readonly StoredLanguage[] | null | undefined): LanguagePage[] {
  return (list ?? []).filter((l): l is LanguagePage => !isSameAddress(l));
}

/**
 * The language tags a site also serves on the same address: the quickstart's
 * `same_address`, and any such entry that sits in `languages` itself (the
 * customers row). Each once, never one that has a page. Empty for a worker
 * that does not send the field.
 */
export function sameAddressLangs(input: {
  languages?: readonly StoredLanguage[] | null;
  same_address?: readonly SameAddressLanguage[] | null;
}): string[] {
  const paged = new Set(withPage(input.languages).map((l) => l.lang));
  const out: string[] = [];
  const all = [...(input.same_address ?? []), ...(input.languages ?? []).filter(isSameAddress)];
  for (const l of all) {
    if (typeof l?.lang !== "string" || !l.lang) continue;
    if (!paged.has(l.lang) && !out.includes(l.lang)) out.push(l.lang);
  }
  return out;
}

function list(words: string[], joiner: "and" | "or"): string {
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} ${joiner} ${words[words.length - 1]}`;
}

/**
 * "Your site also has English on the same address. Versions are written for
 * Azerbaijani only." `written` are the languages versions are written for.
 */
export function sameAddressLine(also: string[], written: string[]): string | null {
  if (also.length === 0) return null;
  const first = `Your site also has ${list(also.map(languageName), "and")} on the same address.`;
  const names = written.map(languageName).filter(Boolean);
  if (names.length === 0) return first;
  return `${first} Versions are written for ${list(names, "and")} only.`;
}

/** The two sentences of why and the one of what comes, behind Why. */
export function sameAddressWhy(also: string[]): string {
  const names = also.map(languageName);
  return `Switching to ${list(names, "or")} on your site keeps the same address. Rawuser writes one language per address, so ${list(names, "and")} visitors see your page as you built it. ${names.length > 1 ? "Writing them all is planned." : "Writing both is planned."}`;
}
