/**
 * Site-shaped intents in the dashboard (mock design/mock/sales-readiness/
 * site-shaped-intents.html, approved 2026-10-05; contract
 * docs/specs/site-shaped-intents.md §18.2). The Look row "Your pages" in its
 * four states, the Change dialog's rows and what Save sends, the Pages
 * card's re-read line, the served tuples the Live screen writes. Pure
 * functions, tested in test/start/site-map.test.ts. One short line per
 * element, no dashes, sentence case. A link's text shows only from the
 * API's `label` (privacy review condition 2), never from anything else.
 */

import type {
  SiteMapKind,
  SiteMapPath,
  SiteMapSetBody,
  SiteMapView,
  VariantListItem,
} from "@/types/api";
import { normalizePath, pagePathRefusal } from "@rawuser/shared";

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/** Versions a page gets when every intent is served: 6 intents × 6 sources. */
export const FULL_VERSIONS = 36;
/** Versions per served intent on one page: the default plus five sources. */
export const VERSIONS_PER_INTENT = 6;

/** The kind list, in the spec's table order; "Not a page to use" last (mock call 5). */
export const KIND_OPTIONS: readonly SiteMapKind[] = [
  "price",
  "vs",
  "compare",
  "proof",
  "features",
  "docs",
  "how",
  "learn",
  "start",
  "about",
  "none",
];

/** The kind in the dialog's list (mock call 4: "Comparison", "Versus a rival"). */
export const KIND_WORD: Record<SiteMapKind, string> = {
  price: "Price",
  vs: "Versus a rival",
  compare: "Comparison",
  proof: "Proof",
  features: "Features",
  docs: "Docs",
  how: "How it works",
  learn: "Reading",
  start: "Contact",
  about: "About",
  none: "Not a page to use",
};

/** The kind inside a sentence ("/tarifler → price"). */
export function kindInLine(kind: SiteMapKind): string {
  return KIND_WORD[kind].toLowerCase();
}

/** Which two pages the Look line names first (mock call 7). */
const LOOK_PRIORITY: readonly SiteMapKind[] = [
  "price",
  "compare",
  "vs",
  "features",
  "proof",
  "how",
  "docs",
  "learn",
  "start",
  "about",
];

const LANGUAGE_NAME: Record<string, string> = {
  az: "Azerbaijani",
  en: "English",
  ru: "Russian",
  tr: "Turkish",
  de: "German",
  fr: "French",
  es: "Spanish",
};

export function languageName(code: string): string {
  return LANGUAGE_NAME[code] ?? code.toUpperCase();
}

// ---------------------------------------------------------------------------
// The Look row
// ---------------------------------------------------------------------------

export const OFF_LINE = `Off. No menus read, ${FULL_VERSIONS} versions a page.`;
export const NONE_FOUND_LINE = "No pages found in your menus.";

export interface FoldSummary {
  /** "No comparison page, so 25 versions a page, not 30." */
  line: string;
  /** Behind Why. */
  why: string;
}

/** The served line and its Why, or null when nothing folds. */
export function foldSummary(
  view: Pick<SiteMapView, "folded" | "versions_per_page">,
): FoldSummary | null {
  const intents = new Set(view.folded.map((f) => f.intent));
  const price = intents.has("pricing");
  const rival = intents.has("competitor");
  if (!price && !rival) return null;
  const page = price && rival ? "price or comparison" : price ? "price" : "comparison";
  const comes = price && rival ? "a price or a rival" : price ? "a price" : "a rival";
  return {
    line: `No ${page} page, so ${view.versions_per_page} versions a page, not ${FULL_VERSIONS}.`,
    why: `Visitors who come for ${comes} see the version for people weighing their options. Add such a page and Rawuser writes theirs.`,
  };
}

export type LookRow =
  /** Nothing found and nothing folds (the lab): the row is hidden, the card says four. */
  | { kind: "hidden" }
  /** Switched off in the dialog: a grey tick and one line. */
  | { kind: "off"; line: string }
  | {
      kind: "found";
      /** The two pages that matter most, path and kind word. */
      pairs: Array<{ path: string; word: string }>;
      /** ", +13 in 2 languages", or "" when every row is named. */
      rest: string;
      /** Set when no row is in use: the whole first line. */
      line: string | null;
      fold: FoldSummary | null;
    };

export function lookRow(view: SiteMapView | null): LookRow {
  if (!view) return { kind: "hidden" };
  if (!view.on) return { kind: "off", line: OFF_LINE };
  const fold = foldSummary(view);
  if (view.paths.length === 0) {
    // The spec hides the row when nothing was found. A site with no menu
    // links can still fold, and then the cost needs its line.
    return fold
      ? { kind: "found", pairs: [], rest: "", line: NONE_FOUND_LINE, fold }
      : { kind: "hidden" };
  }
  const ranked = view.paths
    .filter((p) => p.kind !== "none")
    .map((p, i) => ({ p, i }))
    .sort((a, b) => {
      const d = LOOK_PRIORITY.indexOf(a.p.kind) - LOOK_PRIORITY.indexOf(b.p.kind);
      return d !== 0 ? d : a.i - b.i;
    })
    .map(({ p }) => p);
  // Two different kinds when the site has them: /tarifler and /en/pricing
  // are both price, and the line should show the breadth.
  const first = ranked[0];
  const second = ranked.find((p) => p !== first && p.kind !== first?.kind) ?? ranked[1];
  const used = [first, second]
    .filter((p): p is SiteMapPath => p !== undefined)
    .map((p) => ({ path: p.path, word: kindInLine(p.kind) }));
  if (used.length === 0) {
    const n = view.paths.length;
    return {
      kind: "found",
      pairs: [],
      rest: "",
      line: `None in use, ${n} set aside.`,
      fold,
    };
  }
  const more = view.paths.length - used.length;
  const langs = view.languages.length > 1 ? ` in ${view.languages.length} languages` : "";
  return {
    kind: "found",
    pairs: used,
    rest: more > 0 ? `, +${more}${langs}` : "",
    line: null,
    fold,
  };
}

/** Mock call 1: the card title counts the rows. */
export function checksTitle(row: LookRow): string {
  return row.kind === "hidden" ? "Four things to check" : "Five things to check";
}

// ---------------------------------------------------------------------------
// The Change dialog
// ---------------------------------------------------------------------------

export interface DraftRow {
  path: string;
  kind: SiteMapKind;
  /** Only the API's label; null shows the path alone (condition 2). */
  label: string | null;
  /** The tab it sits on: its language, or the one it was added on. */
  tab: string | null;
  missing: boolean;
  /** Added in this dialog, not yet saved. */
  added: boolean;
}

/** An operator's row has no language: a language prefix decides its tab, else the first tab. */
export function tabOf(row: Pick<SiteMapPath, "path" | "lang">, languages: string[]): string | null {
  if (row.lang) return row.lang;
  if (languages.length === 0) return null;
  const first = row.path.split("/")[1] ?? "";
  return languages.includes(first) ? first : (languages[0] ?? null);
}

export function draftFrom(view: SiteMapView): DraftRow[] {
  return view.paths.map((p) => ({
    path: p.path,
    kind: p.kind,
    label: p.label,
    tab: tabOf(p, view.languages),
    missing: p.missing,
    added: false,
  }));
}

/** Tabs show only when the rows were read in more than one language. */
export function dialogTabs(
  view: SiteMapView,
  draft: DraftRow[],
): Array<{ lang: string; label: string; count: number }> {
  if (view.languages.length < 2) return [];
  return view.languages.map((lang) => ({
    lang,
    label: languageName(lang),
    count: draft.filter((r) => r.tab === lang).length,
  }));
}

/** What Save sends: the rows whose kind changed and the rows added, nothing else. */
export function changedRows(
  view: SiteMapView,
  draft: DraftRow[],
): Array<{ path: string; kind: SiteMapKind }> {
  const before = new Map(view.paths.map((p) => [p.path, p.kind]));
  return draft
    .filter((r) => r.added || before.get(r.path) !== r.kind)
    .map((r) => ({ path: r.path, kind: r.kind }));
}

/** Rows that were in the view and are gone from the draft: Remove (privacy review condition 5). */
export function removedPaths(view: SiteMapView, draft: DraftRow[]): string[] {
  const kept = new Set(draft.map((r) => r.path));
  return view.paths.filter((p) => !kept.has(p.path)).map((p) => p.path);
}

/**
 * What Save posts, or null when nothing changed. The switch alone when it
 * moved; else the changed and added rows and the removed ones together.
 */
export function saveBody(view: SiteMapView, draft: DraftRow[], on: boolean): SiteMapSetBody | null {
  if (on !== view.on) return { customer_id: view.customer_id, on };
  if (!on) return null;
  const paths = changedRows(view, draft);
  const del = removedPaths(view, draft);
  if (paths.length === 0 && del.length === 0) return null;
  return {
    customer_id: view.customer_id,
    ...(paths.length > 0 ? { paths } : {}),
    ...(del.length > 0 ? { delete: del } : {}),
  };
}

export const PATH_REFUSED = "This address belongs to one account. Add a page every visitor sees.";

/** A typed path, normalized as the server does, or the line that refuses it. */
export function checkNewPath(
  raw: string,
  existing: readonly string[],
): { path: string } | { error: string } {
  let p = raw.trim();
  if (!p) return { error: "Type the page's path, like /pricing." };
  if (/^https?:\/\//i.test(p)) {
    try {
      p = new URL(p).pathname;
    } catch {
      return { error: "Type the page's path, like /pricing." };
    }
  }
  if (pagePathRefusal(p)) return { error: PATH_REFUSED };
  const path = normalizePath(p);
  if (path === "/") return { error: "The homepage is not a page to add." };
  if (path.length > 200) return { error: "That path is too long." };
  if (existing.includes(path)) return { error: `${path} is already in the list.` };
  return { path };
}

/** The dialog body when the switch is off or turned on again. */
export const OFF_SAVE_LINES = [
  "Saving deletes this list and stops reading your menus.",
  `Every page gets all ${FULL_VERSIONS} versions again.`,
] as const;
export const OFF_NOW_LINES = [
  "Your menus are not read.",
  `Every page gets all ${FULL_VERSIONS} versions.`,
] as const;
export const ON_AGAIN_LINES = [
  "Saving turns reading back on.",
  "The list fills at the next read of your page.",
] as const;

/** The plain line from an ApiError ("API error 400: {\"error\":\"...\"}"), else a fallback. */
export function apiErrorLine(e: unknown, fallback = "Saving failed. Try again."): string {
  const msg = e instanceof Error ? e.message : "";
  const m = msg.match(/^API error \d+: (.*)$/s);
  if (m?.[1]) {
    try {
      const body = JSON.parse(m[1]) as { error?: unknown };
      if (typeof body.error === "string" && body.error) {
        return body.error.endsWith(".") ? body.error : `${body.error}.`;
      }
    } catch {
      // not JSON
    }
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// The Pages card's re-read line
// ---------------------------------------------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "12 Oct", in the reader's own time zone. */
export function shortDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

export interface PendingLine {
  /** "New page: " or "New pages: ". */
  lead: string;
  pairs: Array<{ path: string; word: string }>;
  /** Set when the growth names no page. */
  plain: string | null;
  /** "10 versions to write." */
  versions: string;
  /** Founder's call 6: "Writes by itself on 12 Oct." */
  auto: string;
}

export function pendingLine(pending: SiteMapView["pending"], now = Date.now()): PendingLine | null {
  if (!pending) return null;
  const pairs = pending.paths
    .filter((p) => p.kind !== "none")
    .map((p) => ({ path: p.path, word: kindInLine(p.kind) }));
  const n = pending.versions;
  return {
    lead: pairs.length > 1 ? "New pages: " : "New page: ",
    pairs,
    plain: pairs.length === 0 ? "Your pages changed." : null,
    versions: `${n} ${n === 1 ? "version" : "versions"} to write.`,
    auto:
      pending.auto_at <= now
        ? "Writes by itself shortly."
        : `Writes by itself on ${shortDate(pending.auto_at)}.`,
  };
}

// ---------------------------------------------------------------------------
// Page versions: a folded intent is one quiet line (mock section 06)
// ---------------------------------------------------------------------------

const FOLD_REASON: Record<string, string> = {
  pricing: "No price page.",
  competitor: "No comparison page.",
};

export function foldReason(intent: string): string {
  return FOLD_REASON[intent] ?? "";
}

/** The intents to show as cards: the served ones, in the given order. */
export function servedOnly<T extends string>(
  all: readonly T[],
  served: readonly string[] | null,
): T[] {
  if (!served) return [...all];
  return all.filter((d) => served.includes(d));
}

/**
 * Ready, stale and errored versions of the served intents only (Page
 * versions' "N ready"): a folded intent's old versions are not counted.
 */
export function servedCounts(
  items: readonly VariantListItem[],
  served: readonly string[] | null,
): { ready: number; stale: number; error: number } {
  const own = items.filter((i) => served === null || served.includes(i.intent_dim));
  return {
    ready: own.filter((i) => i.status === "ready").length,
    stale: own.filter((i) => i.status === "stale").length,
    error: own.filter((i) => i.status === "error").length,
  };
}
