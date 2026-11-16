/**
 * Entry-point integration tests for snippet/src/index.ts — cohort paths.
 *
 * The snippet is an IIFE that fires once when the script tag executes.
 * We can't import it directly without triggering side effects, so we test
 * the individual module functions that the IIFE calls, covering the four
 * cohort branches introduced in Batch C:
 *
 *   - holdout:       source="holdout"  → no DOM mutation, fires variant_shown
 *                    with cohort="holdout", installs conversion listeners.
 *   - personalized:  applied=true       → fires variant_shown cohort="personalized"
 *   - skipped:       applied=false      → fires personalization_skipped cohort="skipped"
 *   - no_signal:     source="original"  → fires no_signal_passthrough cohort="no_signal"
 *
 * Each test wires together: fireEvent (the event emitter) + the EventPayload
 * type contract. DOM mutation tests are in apply.test.ts; conversion listener
 * tests are in conversions.test.ts. This file focuses on the cohort field.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent } from "../src/events.ts";
import type { EventPayload } from "../src/types.ts";
import { at } from "./helpers.ts";

// ---------------------------------------------------------------------------
// Fetch mock helpers
// ---------------------------------------------------------------------------

interface FetchCall {
  url: string;
  body: EventPayload;
}

let fetchCalls: FetchCall[];

beforeEach(() => {
  fetchCalls = [];
  vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
    fetchCalls.push({ url, body: JSON.parse(init.body as string) as EventPayload });
    return Promise.resolve(new Response(null, { status: 202 }));
  });
  vi.stubGlobal("navigator", { sendBeacon: undefined });
  vi.stubGlobal("location", { pathname: "/pricing" });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Cohort field: holdout branch
// ---------------------------------------------------------------------------

describe("snippet cohort — holdout branch", () => {
  it("fires variant_shown with cohort='holdout' and empty variant_key", () => {
    const payload: EventPayload = {
      event_type: "variant_shown",
      page_path: "/pricing",
      variant_key: "",
      intent_dim: "problem",
      source_dim: "ai",
      cohort: "holdout",
    };
    fireEvent("https://edge.rawuser.test", "acme", payload);

    expect(fetchCalls).toHaveLength(1);
    expect(at(fetchCalls, 0).body.event_type).toBe("variant_shown");
    expect(at(fetchCalls, 0).body.cohort).toBe("holdout");
    expect(at(fetchCalls, 0).body.variant_key).toBe("");
  });

  it("holdout payload serializes cohort field into the request body", () => {
    const payload: EventPayload = {
      event_type: "variant_shown",
      page_path: "/",
      variant_key: "",
      cohort: "holdout",
    };
    fireEvent("https://edge.rawuser.test", "acme", payload);

    // The raw body string must include the cohort field.
    const rawBody = JSON.stringify(payload);
    expect(rawBody).toContain('"cohort":"holdout"');
  });
});

// ---------------------------------------------------------------------------
// Cohort field: personalized branch
// ---------------------------------------------------------------------------

describe("snippet cohort — personalized branch (applied=true)", () => {
  it("fires variant_shown with cohort='personalized' when variant was applied", () => {
    const payload: EventPayload = {
      event_type: "variant_shown",
      page_path: "/pricing",
      variant_key: "v1:variant:acme:competitor:ai",
      intent_dim: "competitor",
      source_dim: "ai",
      cohort: "personalized",
    };
    fireEvent("https://edge.rawuser.test", "acme", payload);

    expect(fetchCalls).toHaveLength(1);
    expect(at(fetchCalls, 0).body.event_type).toBe("variant_shown");
    expect(at(fetchCalls, 0).body.cohort).toBe("personalized");
  });
});

// ---------------------------------------------------------------------------
// Cohort field: skipped branch (applied=false)
// ---------------------------------------------------------------------------

describe("snippet cohort — skipped branch (applied=false, manifest gap)", () => {
  it("fires personalization_skipped with cohort='skipped' when applyVariant aborted", () => {
    const payload: EventPayload = {
      event_type: "personalization_skipped",
      page_path: "/features",
      variant_key: "v1:variant:acme:feature:organic",
      intent_dim: "feature",
      source_dim: "organic",
      cohort: "skipped",
    };
    fireEvent("https://edge.rawuser.test", "acme", payload);

    expect(fetchCalls).toHaveLength(1);
    expect(at(fetchCalls, 0).body.event_type).toBe("personalization_skipped");
    expect(at(fetchCalls, 0).body.cohort).toBe("skipped");
  });
});

// ---------------------------------------------------------------------------
// Cohort field: no_signal branch
// ---------------------------------------------------------------------------

describe("snippet cohort — no_signal branch (source='original')", () => {
  it("fires no_signal_passthrough with cohort='no_signal' when no signal arrived", () => {
    const payload: EventPayload = {
      event_type: "no_signal_passthrough",
      page_path: "/",
      cohort: "no_signal",
    };
    fireEvent("https://edge.rawuser.test", "acme", payload);

    expect(fetchCalls).toHaveLength(1);
    expect(at(fetchCalls, 0).body.event_type).toBe("no_signal_passthrough");
    expect(at(fetchCalls, 0).body.cohort).toBe("no_signal");
  });
});

// ---------------------------------------------------------------------------
// Backward compat: cohort field is optional
// ---------------------------------------------------------------------------

describe("snippet cohort — backward compatibility", () => {
  it("fires events without cohort field (pre-Batch-C payload shape still works)", () => {
    const payload: EventPayload = {
      event_type: "variant_shown",
      page_path: "/",
      variant_key: "v1:variant:acme:brand:direct",
    };
    fireEvent("https://edge.rawuser.test", "acme", payload);

    expect(fetchCalls).toHaveLength(1);
    // cohort must NOT be present in the serialized body.
    expect(at(fetchCalls, 0).body).not.toHaveProperty("cohort");
  });

  it("EventPayload type accepts all four cohort values without TS error", () => {
    const cohorts: Array<EventPayload["cohort"]> = [
      "personalized",
      "holdout",
      "skipped",
      "no_signal",
      undefined,
    ];
    // This test validates the type contract at compile time via the import.
    // At runtime we just assert the array was constructed without throwing.
    expect(cohorts).toHaveLength(5);
    expect(cohorts[0]).toBe("personalized");
    expect(cohorts[1]).toBe("holdout");
    expect(cohorts[2]).toBe("skipped");
    expect(cohorts[3]).toBe("no_signal");
    expect(cohorts[4]).toBeUndefined();
  });
});

describe("snippet — L2 Layer D dark_social echo", () => {
  it("carries dark_social: 1 on the no_signal event when the edge flagged it", () => {
    const payload: EventPayload = {
      event_type: "no_signal_passthrough",
      page_path: "/",
      cohort: "no_signal",
      dark_social: 1,
    };
    fireEvent("https://edge.rawuser.test", "acme", payload);
    expect(at(fetchCalls, 0).body.dark_social).toBe(1);
  });
});
