/**
 * Buttons stay as built until the operator turns one on (the founder's
 * decision of 2026-10-12; mock design/mock/sales-readiness/pilot-gaps.html,
 * screen 04; contract docs/specs/button-rewrite.md).
 *
 * One switch per button, off by default, in the parts list on Look and under
 * the page on the Pages card. A counted button is counted either way. Pure
 * functions, tested in test/start/buttons.test.ts.
 */

import type { ButtonRow, ButtonSetAnswer, Manifest, MeasureButton } from "@/types/api";
import { ApiError } from "./api";
import { apiErrorLine } from "./site-map";

export const BUTTON_OFF_NOTE = "Stays as on your page.";
export const BUTTON_ON_NOTE = "Its words will change. It will still open the same page.";
/** "Open the same page" is wrong for a form's button. */
export const FORM_BUTTON_ON_NOTE = "Its words will change. It will still send the same form.";
export const BUTTONS_OFF_LINE = "Buttons stay as on your page.";
export const BUTTON_FAILED_LINE = "Could not change this button. Try again.";

/** The one line under a button's words; a caution only when its words will change. */
export function buttonNote(b: Pick<ButtonRow, "rewrite" | "form">): {
  text: string;
  caution: boolean;
} {
  if (!b.rewrite) return { text: BUTTON_OFF_NOTE, caution: false };
  return { text: b.form ? FORM_BUTTON_ON_NOTE : BUTTON_ON_NOTE, caution: true };
}

/**
 * What the parts line says about the buttons: "Buttons stay as on your
 * page.", "1 button rewritten.", or nothing for a page without buttons (or a
 * worker that does not list them).
 */
export function buttonsLine(buttons: readonly ButtonRow[] | null | undefined): string | null {
  if (!buttons || buttons.length === 0) return null;
  const on = buttons.filter((b) => b.rewrite).length;
  if (on === 0) return BUTTONS_OFF_LINE;
  return `${on} ${on === 1 ? "button" : "buttons"} rewritten.`;
}

/**
 * The "counted" pill: the API's word, or, before go live, the button chosen
 * in "The button to count" on the same screen (it is counted from go live).
 */
export function isCountedButton(
  b: Pick<ButtonRow, "path" | "counted">,
  chosen?: MeasureButton | null,
): boolean {
  return b.counted || chosen?.section_path === b.path;
}

/** The `buttons` of an answer, or null when it has none we can read (an older worker). */
export function readButtons(raw: unknown): ButtonRow[] | null {
  if (!Array.isArray(raw)) return null;
  const out: ButtonRow[] = [];
  for (const b of raw as Array<Partial<ButtonRow> | null>) {
    if (!b || typeof b.path !== "string" || !b.path) continue;
    out.push({
      path: b.path,
      label: typeof b.label === "string" && b.label ? b.label : "Button",
      text: typeof b.text === "string" ? b.text : "",
      rewrite: b.rewrite === true,
      counted: b.counted === true,
      form: b.form === true,
      ...(b.proposed === true ? { proposed: true } : {}),
    });
  }
  return out;
}

/** One button's switch set in a list, for the moment before the API answers. */
export function withSwitch(buttons: readonly ButtonRow[], path: string, on: boolean): ButtonRow[] {
  return buttons.map((b) => (b.path === path ? { ...b, rewrite: on } : b));
}

/**
 * The manifest Go live sends, with every button saying its switch as the
 * screen shows it. The request's manifest is a snapshot of the read; an
 * entry that says `rewrite` itself, true or false, decides (spec, "Reading
 * the page again"). A button the manifest does not have is left out.
 */
export function withSwitches(
  manifest: Manifest,
  buttons: readonly ButtonRow[] | null | undefined,
): Manifest {
  if (!buttons || buttons.length === 0) return manifest;
  const out: Manifest = { ...manifest };
  for (const b of buttons) {
    const entry = out[b.path];
    if (entry) out[b.path] = { ...entry, rewrite: b.rewrite };
  }
  return out;
}

/**
 * Why a switch did not move, in the API's own sentence: during a test the
 * counted button cannot be turned on (409, "A test is running, so the
 * buttons it counts cannot change. Stop the test first to change them.").
 */
export function buttonRefusal(e: unknown): string {
  // Only the 409 is a sentence written for the customer; any other answer
  // (a 404 names the stored record) gets the plain fallback.
  if (e instanceof ApiError && e.status === 409) return apiErrorLine(e, BUTTON_FAILED_LINE);
  return BUTTON_FAILED_LINE;
}

export type ButtonFetcher = <T>(path: string, init?: RequestInit) => Promise<T>;

export type ButtonSetResult =
  /** Stored. `stale`: versions of the page marked to be written again. */
  | { ok: true; buttons: ButtonRow[]; stale: number }
  /** Not stored: the list as it was, and why in one sentence. */
  | { ok: false; buttons: ButtonRow[]; refusal: string };

/**
 * One switch, one POST /admin/onboard/button. The screen takes the answer's
 * list; a refusal (the 409 for a counted button during a test) puts the
 * switch back and gives the API's sentence.
 */
export async function setButton(
  fetcher: ButtonFetcher,
  input: { customerId: string; pagePath: string; path: string; on: boolean },
  before: readonly ButtonRow[],
): Promise<ButtonSetResult> {
  try {
    const r = await fetcher<ButtonSetAnswer>("/admin/onboard/button", {
      method: "POST",
      body: JSON.stringify({
        customer_id: input.customerId,
        page_path: input.pagePath,
        path: input.path,
        rewrite: input.on,
      }),
    });
    return {
      ok: true,
      buttons: readButtons(r?.buttons) ?? withSwitch(before, input.path, input.on),
      stale: Number(r?.stale) > 0 ? Number(r.stale) : 0,
    };
  } catch (e) {
    return { ok: false, buttons: [...before], refusal: buttonRefusal(e) };
  }
}
