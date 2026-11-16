/**
 * The visitors' country switch (ADR 0036, point 6; dashboard v2 Settings,
 * Account; the founder's yes to a customer-facing switch, 2026-11-02).
 *
 * Contract (docs/specs/visitors-page.md §2):
 *   POST /admin/country/off { customer_id }  and  POST /admin/country/on
 *   -> { ok, customer_id, country_recording: "on" | "off", cleared, done }
 *   500 { error }: saved, the bundle not written; send it again.
 * A worker built before the contract answers 404 there and takes
 *   POST /admin/analytics/country { customer_id, off } -> { off, ... };
 * the call falls back to it once. The state is read from the Visitors
 * answer's `country_recording`. Every call and word of the switch is here.
 */

import { ApiError, apiFetch } from "./api";

export const countryPath = (off: boolean) => `/admin/country/${off ? "off" : "on"}`;
export const COUNTRY_FALLBACK_PATH = "/admin/analytics/country";

export interface CountrySwitchAnswer {
  off: boolean;
  cleared: number;
  done: boolean;
}

function readSwitch(raw: unknown, asked: boolean): CountrySwitchAnswer {
  const r = (raw ?? {}) as Record<string, unknown>;
  const off =
    r.country_recording === "off"
      ? true
      : r.country_recording === "on"
        ? false
        : typeof r.off === "boolean"
          ? r.off
          : asked;
  return {
    off,
    cleared: typeof r.cleared === "number" ? r.cleared : 0,
    done: r.done !== false,
  };
}

export const COUNTRY_LINES = {
  label: "Visitors' country",
  on: "Recorded",
  off: "Off",
  sub: "Country only, never the city.",
  offSub: "Not recorded. Turning it back on records from then on.",
  turnOff: "Turn off",
  turnOn: "Turn on",
  confirmTitle: "Stop recording visitors' country?",
  confirmLine: "Turning it off removes it from past visits too. That cannot be undone.",
  keep: "Keep it on",
  failed: "That did not go through. Try again in a minute.",
} as const;

export type CountryOutcome =
  | { kind: "ok"; answer: CountrySwitchAnswer }
  | { kind: "failed"; message: string };

export async function setCountryOff(
  customerId: string,
  off: boolean,
  api: typeof apiFetch = apiFetch,
): Promise<CountryOutcome> {
  const fail = (e: unknown): CountryOutcome =>
    e instanceof ApiError && e.status === 500
      ? { kind: "failed", message: "Saved, but not everywhere yet. Press it again." }
      : { kind: "failed", message: COUNTRY_LINES.failed };
  try {
    const raw = await api<unknown>(countryPath(off), {
      method: "POST",
      body: JSON.stringify({ customer_id: customerId }),
    });
    return { kind: "ok", answer: readSwitch(raw, off) };
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 404)) return fail(e);
  }
  try {
    const raw = await api<unknown>(COUNTRY_FALLBACK_PATH, {
      method: "POST",
      body: JSON.stringify({ customer_id: customerId, off }),
    });
    return { kind: "ok", answer: readSwitch(raw, off) };
  } catch (e) {
    return fail(e);
  }
}
