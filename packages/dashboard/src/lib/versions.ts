/**
 * The versions card on the Live screen, after the write (mock
 * design/mock/sales-readiness/pilot-gaps.html, screen 01, approved
 * 2026-10-12; contract docs/specs/refused-versions.md, "The dashboard's
 * fields, as they are").
 *
 * Under the count, at most two quiet lines: versions that keep a part as
 * the page built it, and versions not written yet with what a visitor sees
 * meanwhile. Neither asks the customer for anything, so neither is amber.
 * Pure functions, tested in test/start/versions.test.ts. No rule name, row
 * or key ever reaches the screen.
 */

import type {
  RefusedVersion,
  VariantListAnswer,
  VariantListItem,
  VariantSummary,
  VersionServing,
} from "@/types/api";
import { intentLabel, sourcePhrase } from "./results";

/**
 * The list read in either shape: `{ items, summary }` from a worker that
 * knows `summary=1`, the array alone from one that does not. Anything else
 * reads as an empty list, so the card stays as it was.
 */
export function readVersionList(raw: VariantListAnswer | null | undefined): {
  items: VariantListItem[];
  summary: VariantSummary | null;
} {
  if (Array.isArray(raw)) return { items: raw, summary: null };
  if (raw && typeof raw === "object" && Array.isArray(raw.items)) {
    const s = raw.summary;
    return {
      items: raw.items,
      summary: s && typeof s === "object" && Array.isArray(s.refused_rows) ? s : null,
    };
  }
  return { items: [], summary: null };
}

/** "Problem first, from communities": the names Results uses for a version. */
export function versionName(intentDim: string, sourceDim: string): string {
  const from = sourcePhrase(sourceDim);
  return from ? `${intentLabel(intentDim)}, ${from}` : intentLabel(intentDim);
}

/** A part as the card's sentence opens with it (mock section 08, "part names"). */
const PART_SUBJECT: Record<string, string> = {
  "hero.headline": "The headline",
  "hero.body": "The opening paragraph",
  "hero.cta.label": "The main button",
  "cta.cta.label": "The call-to-action button",
  "features.headline": "The section headline",
  "features.body": "The section paragraph",
  "pricing.cta.label": "The pricing button",
  "forms.submit_label": "The form button",
};

/**
 * "The opening paragraph stays as on your page." A part without a plain
 * name is counted, never spelled as its path.
 */
export function keptLine(paths: readonly string[]): string {
  const unique = [...new Set(paths)];
  const named = unique.flatMap((p) => (PART_SUBJECT[p] ? [PART_SUBJECT[p] as string] : []));
  if (named.length !== unique.length) {
    return unique.length === 1
      ? "One part stays as on your page."
      : `${unique.length} parts stay as on your page.`;
  }
  if (named.length === 1) return `${named[0]} stays as on your page.`;
  const lower = named.map((n, i) => (i === 0 ? n : n.charAt(0).toLowerCase() + n.slice(1)));
  return `${lower.slice(0, -1).join(", ")} and ${lower[lower.length - 1]} stay as on your page.`;
}

export const KEPT_FOOT =
  "A part that does not fit stays in your own words. The rest of the version is live.";

/** Mock section 08, "What visitors see meanwhile". */
const SEES: Record<VersionServing, { one: string; many: string }> = {
  nearest: {
    one: "Visitors with this reason see the closest version.",
    many: "Visitors with these reasons see the closest version.",
  },
  older: {
    one: "Visitors with this reason keep the version written before.",
    many: "Visitors with these reasons keep the version written before.",
  },
  original: {
    one: "Visitors with this reason see your page as it is.",
    many: "Visitors with these reasons see your page as it is.",
  },
};

export function seesLine(serving: VersionServing, many = false): string | null {
  const s = SEES[serving];
  return s ? (many ? s.many : s.one) : null;
}

/**
 * Why a version was not written, in the mock's three sentences (section
 * 08). The stored reason opens with its cause (refused-versions.md, step 4);
 * a cause without a sentence in the mock gives none, never the stored text.
 */
export function refusalLine(errorReason: string | null | undefined): string | null {
  const r = errorReason ?? "";
  if (/parts could not be written|no part is left to write/.test(r)) {
    return "Most of its parts did not fit your page.";
  }
  if (/two parts still say the same thing/.test(r)) {
    return "Two of its parts came out with the same words.";
  }
  if (/headline lost its structure/.test(r)) {
    return "Its headline did not fit how your page animates it.";
  }
  return null;
}

/**
 * "Next try at 14:05." in the reader's own time (mock A5 and A6 say "Next
 * try in 5 minutes" and "in about 6 hours"; the API now gives the time, J8).
 * Past midnight it says "at 02:05 tomorrow". A time already passed gives
 * nothing: the list is a little old, and the queue has had its try.
 */
export function nextTryLine(nextTry: number, now = Date.now()): string | null {
  if (!Number.isFinite(nextTry) || nextTry <= now) return null;
  const d = new Date(nextTry);
  const n = new Date(now);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const sameDay =
    d.getFullYear() === n.getFullYear() &&
    d.getMonth() === n.getMonth() &&
    d.getDate() === n.getDate();
  return sameDay ? `Next try at ${hh}:${mm}.` : `Next try at ${hh}:${mm} tomorrow.`;
}

export interface KeptVersion {
  key: string;
  name: string;
  /** The page, only when the site has more than one connected. */
  page: string | null;
  line: string;
}

export interface UnwrittenVersion {
  key: string;
  name: string;
  page: string | null;
  reason: string | null;
  /** What its visitors see, when the rows differ and the line cannot say it once. */
  sees: string | null;
}

export interface VersionLines {
  /** "18 in full. 2 keep one part as on your page." with the list behind Which ones. */
  kept: { line: string; items: KeptVersion[] } | null;
  /** "1 not written yet." with what visitors see, and the list behind Details. */
  unwritten: { line: string; sees: string | null; items: UnwrittenVersion[] } | null;
}

const NO_LINES: VersionLines = { kept: null, unwritten: null };

export interface VersionLinesInput {
  items: VariantListItem[];
  summary: VariantSummary | null;
  /** The connected pages, as the card counts them. */
  paths: readonly string[];
  /** The intents the site serves; null for all six. */
  served: readonly string[] | null;
  /** The card's own "N of M"; null while the list loads. */
  ready: number | null;
  total: number;
  /** A write is running: the lines appear when it ends (mock A7). */
  running: boolean;
  /** The clock the next-try time is read against; the tests set it. */
  now?: number;
}

/**
 * The lines under the count. Counted against the number the card shows, so
 * "19 of 20" always reads with "17 in full. 2 keep one part" and "1 not
 * written yet". Nothing while a write runs or the list loads.
 */
export function versionLines(input: VersionLinesInput): VersionLines {
  const { items, summary, paths, served, ready, total, running } = input;
  if (running || ready === null) return NO_LINES;
  const onPage = (p: string) => paths.includes(p);
  const isServed = (intent: string) => served === null || served.includes(intent);
  const page = (p: string) => (paths.length > 1 ? p : null);

  const keptItems: KeptVersion[] = items
    .filter(
      (i) =>
        i.status === "ready" &&
        onPage(i.page_path) &&
        isServed(i.intent_dim) &&
        (i.parts_as_built?.length ?? 0) > 0,
    )
    .map((i) => ({
      key: i.kv_key,
      name: versionName(i.intent_dim, i.source_dim),
      page: page(i.page_path),
      line: keptLine((i.parts_as_built ?? []).map((p) => p.path)),
    }));
  let kept: VersionLines["kept"] = null;
  if (keptItems.length > 0) {
    const n = keptItems.length;
    const onePart = items
      .filter((i) => keptItems.some((k) => k.key === i.kv_key))
      .every((i) => new Set((i.parts_as_built ?? []).map((p) => p.path)).size === 1);
    const what = onePart ? "one part" : "some parts";
    const full = Math.max(0, ready - n);
    kept = {
      line: `${full > 0 ? `${full} in full. ` : ""}${n} ${n === 1 ? "keeps" : "keep"} ${what} as on your page.`,
      items: keptItems,
    };
  }

  const gap = Math.max(0, total - ready);
  let unwritten: VersionLines["unwritten"] = null;
  if (gap > 0) {
    const rows: RefusedVersion[] = (summary?.refused_rows ?? []).filter(
      (r) => onPage(r.page_path) && isServed(r.intent_dim),
    );
    const servings = new Set(rows.map((r) => r.serving));
    // One sentence for all of them only when every unwritten version is one
    // of these rows and they share what visitors see; else each row says its own.
    const shared = rows.length === gap && servings.size === 1;
    const first = rows[0];
    // The earliest next try among the rows that have one (J8).
    const times = rows.flatMap((r) => (typeof r.next_try === "number" ? [r.next_try] : []));
    const next = times.length > 0 ? nextTryLine(Math.min(...times), input.now) : null;
    unwritten = {
      line: `${gap} not written yet.${next ? ` ${next}` : ""}`,
      sees: shared && first ? seesLine(first.serving, rows.length > 1) : null,
      items: rows.map((r) => ({
        key: r.kv_key,
        name: versionName(r.intent_dim, r.source_dim),
        page: page(r.page_path),
        reason: refusalLine(r.error_reason),
        sees: shared ? null : seesLine(r.serving),
      })),
    };
  }
  return { kept, unwritten };
}
