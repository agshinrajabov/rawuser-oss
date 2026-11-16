/**
 * A button on every page, picked on the page (mock design/mock/sales-
 * readiness/site-wide-and-sensitive.html, sections 01 to 04, approved
 * 2026-10-22; contract docs/specs/visual-picker.md §9.10).
 *
 * The count link with `scope: "site"` opens the homepage in the picker with
 * one slot; at Done the worker stores one `site:{slug}` target, switched on,
 * ADDED to the counted buttons. A phone number or an address is stored by
 * its kind ("Phone number", "Email address"), never the digits: the list
 * shows that name as it is, without quotes.
 *
 * The button list (one switch per row, Remove behind the row's menu) is
 * here too. Pure functions plus the calls with an injectable fetch, tested
 * in test/conversions/site-pick.test.ts.
 */

import type {
  ConversionTarget,
  ConversionsListResponse,
  CountPickStatusResponse,
  CountPickTokenResponse,
} from "@/types/api";
import { CONTACT_LABELS } from "@rawuser/shared";
import { apiFetch } from "./api";
import {
  type Api,
  DELETE_PATH,
  LIST_PATH,
  PICK_STATUS_PATH,
  PICK_TOKEN_PATH,
  UPSERT_PATH,
  refusalOf,
} from "./measure";
import { type Outcome, kindWord } from "./page-groups";
import { COUNTS_ON_EVERY_PAGE, isSiteWideTarget } from "./site-wide";

// ---------------------------------------------------------------------------
// The words (mock section 09)
// ---------------------------------------------------------------------------

export const LIST_TITLE = "Which buttons count?";
export const LIST_LEAD =
  "Buttons Rawuser found on your pages. Turn on the ones that mean a visitor wants to talk to you.";
export const LIST_EMPTY = "Rawuser has not found a button on your pages yet.";
export const DONE = "Done";
export const ENTRY = "A button on every page (menu or footer)";
export const PICK_IT = "Pick it on your page";
export const ONE_PAGE_ONLY = "A button on one page only?";
export const WHAT_TO_COUNT = "What should I count?";
export const WHAT_TO_COUNT_LINES = [
  "Count the action that means a visitor wants to talk to you.",
  "A link that only opens another page of yours is not it.",
] as const;
export const SITE_PICK_TITLE = "The button to count on every page";
export const SITE_OPEN_LINE = "Open your site and click the button in the menu or the footer.";
export const SITE_OPEN_LABEL = "Open your page to pick";
/** Beside a site row on the Pages card (A3), fainter than its words. */
export const ON_EVERY_PAGE_FAINT = "on every page";

/** The page the site link opens: any page would do, the button is on all of them. */
export const SITE_PICK_PAGE = "/";

// ---------------------------------------------------------------------------
// One row's words
// ---------------------------------------------------------------------------

const KIND_NAMES = new Set<string>(Object.values(CONTACT_LABELS));

/**
 * The row's name: the button's own words in quotes ("“Əlaqə”"), or a
 * contact kind the worker stored in place of the digits ("Phone number"),
 * as it is.
 */
export function buttonName(t: Pick<ConversionTarget, "label" | "section_path" | "site">): string {
  if (isSiteWideTarget(t) && KIND_NAMES.has(t.label)) return t.label;
  return `“${t.label}”`;
}

/**
 * A site row on the Pages card (mock A3): 'Counting clicks on "Əlaqə"', or
 * '"Əlaqə", not counted'; a contact kind without quotes.
 */
export function siteCountingLine(
  t: Pick<ConversionTarget, "label" | "section_path" | "site" | "enabled">,
): string {
  const name = isSiteWideTarget(t) && KIND_NAMES.has(t.label) ? t.label : `"${t.label}"`;
  return t.enabled ? `Counting clicks on ${name}` : `${name}, not counted`;
}

/** "Contact · Counts on every page", or "Counts on every page" without a kind. */
export function sitePickedLine(t: Pick<ConversionTarget, "conversion_label">): string {
  const kind = kindWord(t.conversion_label);
  return kind ? `${kind} · ${COUNTS_ON_EVERY_PAGE}` : COUNTS_ON_EVERY_PAGE;
}

/** Pick again sits in a site row's menu; every row has Remove. */
export function canPickAgain(t: Pick<ConversionTarget, "section_path" | "site">): boolean {
  return isSiteWideTarget(t);
}

// ---------------------------------------------------------------------------
// The calls
// ---------------------------------------------------------------------------

const FAILED = "That did not go through. Try again in a minute.";

function outcomeOf<T>(e: unknown, fallback: string): Outcome<T> {
  const r = refusalOf(e);
  if (r && (r.status === 409 || r.status === 400) && r.error) {
    return { kind: "refused", sentence: r.error };
  }
  return { kind: "failed", message: r?.error ?? fallback };
}

/**
 * POST /admin/conversions/pick-token with `scope: "site"`. 409 (a test runs,
 * five such buttons already, the tag withheld) and 400 come back as the
 * API's sentence.
 */
export async function mintSitePick(
  customerId: string,
  api: Api = apiFetch,
): Promise<Outcome<{ link: string; pagePath: string }>> {
  try {
    const r = await api<CountPickTokenResponse>(PICK_TOKEN_PATH, {
      method: "POST",
      body: JSON.stringify({
        customer_id: customerId,
        page_path: SITE_PICK_PAGE,
        scope: "site",
      }),
    });
    return { kind: "ok", value: { link: r.link, pagePath: r.page_path } };
  } catch (e) {
    return outcomeOf(e, "Could not make the link. Try again.");
  }
}

export type SitePollOutcome =
  | { kind: "waiting" }
  | { kind: "landed"; target: ConversionTarget; items: ConversionTarget[] }
  | { kind: "refused"; sentence: string }
  | { kind: "failed"; message: string };

/**
 * One poll of the site link. A pick from the page body is refused with 400
 * (`SITE_PLACEMENT_LINE`), shown as written like the 409s.
 */
export async function pollSitePick(
  customerId: string,
  pagePath: string,
  api: Api = apiFetch,
): Promise<SitePollOutcome> {
  try {
    const r = await api<CountPickStatusResponse>(
      `${PICK_STATUS_PATH}?customer_id=${encodeURIComponent(customerId)}&scope=site&page_path=${encodeURIComponent(pagePath)}`,
    );
    if (r.landed && r.target) return { kind: "landed", target: r.target, items: r.items };
    return { kind: "waiting" };
  } catch (e) {
    const r = refusalOf(e);
    if ((r?.status === 409 || r?.status === 400) && r.error) {
      return { kind: "refused", sentence: r.error };
    }
    if (r && r.status >= 400 && r.error) return { kind: "failed", message: r.error };
    return { kind: "waiting" };
  }
}

/**
 * One row's switch: the upsert with the row's own selectors riding along
 * (never the homepage manifest's), then the list. It moves this button
 * only; "Count this button" (POST /admin/conversions/count) would switch
 * every other one off. While a test runs the API refuses (409) with its
 * own sentence.
 */
export async function setCounted(
  customerId: string,
  t: ConversionTarget,
  on: boolean,
  api: Api = apiFetch,
): Promise<Outcome<ConversionTarget[]>> {
  try {
    await api<unknown>(UPSERT_PATH, {
      method: "POST",
      body: JSON.stringify({
        customer_id: customerId,
        id: t.id,
        section_path: t.section_path,
        label: t.label,
        conversion_label: t.conversion_label,
        enabled: on,
        css_selectors: t.css_selectors,
        text_selectors: t.text_selectors,
        structural_selector: t.structural_selector,
      }),
    });
    const list = await api<ConversionsListResponse>(
      `${LIST_PATH}?customer_id=${encodeURIComponent(customerId)}`,
    );
    return { kind: "ok", value: list.items };
  } catch (e) {
    return outcomeOf(e, FAILED);
  }
}

/**
 * "Pick again" after a pick that added a new row: the new row goes first, so
 * a second pick does not leave two. A pick that landed on a row that was
 * already there (the same button) leaves it.
 */
export async function undoNewPick(
  target: ConversionTarget,
  before: readonly ConversionTarget[] | null,
  api: Api = apiFetch,
): Promise<Outcome<true>> {
  if (before?.some((t) => t.id === target.id)) return { kind: "ok", value: true };
  try {
    await api<unknown>(DELETE_PATH, { method: "POST", body: JSON.stringify({ id: target.id }) });
    return { kind: "ok", value: true };
  } catch (e) {
    return outcomeOf(e, FAILED);
  }
}
