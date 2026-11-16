/**
 * Ad links, one line per platform (mock design/mock/sales-readiness/
 * ads-platforms.html, approved 2026-10-22; spec docs/specs/ads-platforms.md
 * §2 and the privacy review's ruling §10). "Your ads" on Campaign links and
 * "Running ads?" on Connect read the same templates from @rawuser/shared.
 *
 * A sensitive customer, or one that answered yes to the special-category
 * question, sees only each template's `reduced` line: source and medium, no
 * name macros (privacy review condition 2). When the dashboard cannot tell, the
 * lines are reduced too.
 *
 * Pure functions and the screen's strings, tested in
 * test/links/ad-links.test.ts. No dashes.
 */

import { AD_TEMPLATES, type AdPlatform, type AdTemplate, adMacros } from "@rawuser/shared";
import type { ReadinessResponse } from "./readiness";

// ---------------------------------------------------------------------------
// The strings (mock sections 01 to 05, and its section 07)
// ---------------------------------------------------------------------------

export const ADS_HEADING = "Your ads";
export const RUNNING_ADS = "Running ads?";
/** The subtitle around the shaded word: before, the word, after. */
export const SUBTITLE_LINKS = [
  "One line per platform. The platform fills in the",
  "shaded",
  "parts at each click.",
] as const;
export const SUBTITLE_CONNECT = [
  "One line per platform. The platform fills in the",
  "shaded",
  "parts.",
] as const;
export const REDUCED_WHY =
  "These lines carry no campaign, ad or keyword names. On a special-category site a name can say who an ad was for.";
export const RULE_NAMES = "Name campaigns by what they sell, never by who they target.";
/** keyword-intent.md, privacy review condition 2: this line as written, around the code. */
export const RULE_SEARCH = ["Do not use", "{QueryString}", "or search-term parameters."] as const;
export const WHAT_WE_READ = "What Rawuser reads";
export const WHAT_WE_READ_LINES = [
  "Only the link: the platform, the kind of ad, and the words in the campaign name or keyword.",
  "Those words pick a version and are never stored. A click id's value is never read.",
] as const;
export const ALSO_ON_LINKS = "Also on Campaign links, once you are live.";
export const WORD_LABEL = "Your campaign word";
export const WORD_PLACEHOLDER = "your-campaign";
/** Shown on a row that needs a word when the template carries no note of its own. */
export const WORD_NOTE = "X has no campaign macro. Type your own campaign word.";
export const COPY = "Copy";
export const COPIED = "Copied";
export const COPIED_MS = 2000;

export const GROUP_LABEL: Record<AdTemplate["group"], string> = {
  search: "Search ads",
  social: "Social ads",
};

// ---------------------------------------------------------------------------
// Which lines a customer sees
// ---------------------------------------------------------------------------

/**
 * True when the customer must see the reduced lines: the special-category
 * question is not answered "no" (a yes, or not answered yet, as for the
 * keyword lexicon), or the site is marked sensitive. The mark shows as the
 * category check in green with no action ("Set up as a special-category
 * site", `categoryCheck` in generation's readiness.ts, pinned by a test
 * there), where "Not a special-category site" always carries Change.
 * No answer (loading, an older worker, a failed read) is reduced.
 */
export function adsReduced(answer: ReadinessResponse | null): boolean {
  if (!answer) return true;
  if (answer.special_category !== false) return true;
  const category = answer.checks.find((c) => c.id === "category");
  return category?.state === "green" && category.action === null;
}

/** The two groups in the shared order, search first. */
export function adGroups(
  templates: readonly AdTemplate[] = AD_TEMPLATES,
): { group: AdTemplate["group"]; rows: AdTemplate[] }[] {
  return (["search", "social"] as const)
    .map((group) => ({ group, rows: templates.filter((t) => t.group === group) }))
    .filter((g) => g.rows.length > 0);
}

/** The faint part after a platform's name on Campaign links (mock A1). */
const ALSO: Partial<Record<AdPlatform, string>> = { meta: "Facebook, Instagram" };

export function alsoLine(t: AdTemplate): string | null {
  return ALSO[t.platform] ?? null;
}

/** Connect's tighter where lines (mock A5, A10); the others as on Campaign links. */
const CONNECT_WHERE: Partial<Record<AdPlatform, string>> = {
  google: "Final URL suffix",
  microsoft: "Final URL suffix",
  linkedin: "Account settings",
  x: "Website card URL",
};

/** Where the line goes; a lone "?" at the end never wraps by itself. */
export function whereLine(t: AdTemplate, form: "links" | "connect" = "links"): string {
  const where = (form === "connect" ? CONNECT_WHERE[t.platform] : undefined) ?? t.where;
  return where.replace(/ (\S)$/, "\u00a0$1");
}

// ---------------------------------------------------------------------------
// The line
// ---------------------------------------------------------------------------

export interface Run {
  text: string;
  /** Filled by the platform at the click: drawn shaded. */
  macro: boolean;
}

/** One parameter's text with its macros marked, the first and longest match first. */
function markRuns(param: string, macros: readonly string[]): Run[] {
  const needles = [...macros].filter((m) => m.length > 0).sort((a, b) => b.length - a.length);
  const out: Run[] = [];
  let rest = param;
  while (rest.length > 0) {
    let at = -1;
    let hit = "";
    for (const n of needles) {
      const i = rest.indexOf(n);
      if (i >= 0 && (at < 0 || i < at)) {
        at = i;
        hit = n;
      }
    }
    if (at < 0) {
      out.push({ text: rest, macro: false });
      break;
    }
    if (at > 0) out.push({ text: rest.slice(0, at), macro: false });
    out.push({ text: hit, macro: true });
    rest = rest.slice(at + hit.length);
  }
  return out;
}

/**
 * The line split at each `&` (a parameter never breaks inside, mock `.pr`),
 * each parameter as runs with the platform's macros marked. The `&` stays at
 * the head of every parameter after the first.
 */
export function lineParams(line: string): Run[][] {
  if (!line) return [];
  const macros = adMacros(line);
  return line.split("&").map((p, i) => markRuns(i === 0 ? p : `&${p}`, macros));
}

/** The line a row shows: the reduced one for a special-category site. */
export function shownLine(t: AdTemplate, reduced: boolean): string {
  return reduced ? t.reduced : t.template;
}

/** True when the row asks for the customer's own campaign word. */
export function asksWord(t: AdTemplate, reduced: boolean): boolean {
  return !reduced && t.needsWord === true;
}

/**
 * The customer's campaign word as typed (mock A2): lower case, spaces become
 * hyphens, and nothing that would end the parameter or start another.
 */
export function campaignWord(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}._~-]/gu, "");
}

/** The word as copied: no hyphen or dot left hanging at either end. */
function finished(word: string): string {
  return campaignWord(word).replace(/^[-.]+|[-.]+$/g, "");
}

/** Copy is off on a row that asks for a word until one is typed. */
export function canCopy(t: AdTemplate, reduced: boolean, word: string): boolean {
  return !asksWord(t, reduced) || finished(word).length > 0;
}

/** What Copy puts on the clipboard: the parameters only, no leading `?` (mock note 7). */
export function copiedLine(t: AdTemplate, reduced: boolean, word: string): string {
  const line = shownLine(t, reduced);
  return asksWord(t, reduced) ? `${line}${finished(word)}` : line;
}

/** The note under a row's line; none on the reduced lines (mock A6). */
export function rowNote(t: AdTemplate, reduced: boolean): string | null {
  if (reduced) return null;
  if (t.note) return t.note;
  return t.needsWord ? WORD_NOTE : null;
}
