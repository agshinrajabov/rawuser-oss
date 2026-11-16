import { describe, expect, it } from "vitest";
import { hasMeaningfulSignal, hasSourceSignal } from "../../src/signals/meaningful.ts";
import type { Signals } from "../../src/types.ts";

function makeSignals(overrides: Partial<Signals> = {}): Signals {
  return {
    utm: {},
    referrerHost: null,
    device: "desktop",
    language: null,
    country: null,
    aiSource: null,
    _isCitationClick: false,
    ...overrides,
  };
}

describe("hasMeaningfulSignal", () => {
  it("returns false for a bare visit (no signals at all)", () => {
    expect(hasMeaningfulSignal(makeSignals())).toBe(false);
  });

  it("returns false even with country + language + device (passive attributes only)", () => {
    expect(
      hasMeaningfulSignal(makeSignals({ country: "AZ", language: "az-AZ", device: "mobile" })),
    ).toBe(false);
  });

  it("returns true when any utm_* param is present", () => {
    expect(hasMeaningfulSignal(makeSignals({ utm: { campaign: "ux-course-pricing" } }))).toBe(true);
  });

  it("returns true when external referrerHost is set", () => {
    expect(hasMeaningfulSignal(makeSignals({ referrerHost: "news.ycombinator.com" }))).toBe(true);
  });

  it("returns true when aiSource is detected", () => {
    expect(hasMeaningfulSignal(makeSignals({ aiSource: "chatgpt" }))).toBe(true);
  });

  it("returns false when referrerHost is null (same-origin already reduced)", () => {
    // parseReferrerHost returns null for same-origin; the caller treats
    // that as no signal — internal nav should not trigger personalization.
    expect(hasMeaningfulSignal(makeSignals({ referrerHost: null }))).toBe(false);
  });

  it("returns false for empty utm object (defensive — no keys)", () => {
    expect(hasMeaningfulSignal(makeSignals({ utm: {} }))).toBe(false);
  });

  // Entry-path signal (L1, ADR 0023)
  it("returns true for an intent-bearing entry path (naked direct /pricing)", () => {
    expect(hasMeaningfulSignal(makeSignals({ entryPath: "/pricing" }))).toBe(true);
  });

  it("returns true for a nested intent path (/docs/quickstart)", () => {
    expect(hasMeaningfulSignal(makeSignals({ entryPath: "/docs/quickstart" }))).toBe(true);
  });

  it("returns false for the homepage entry path (/)", () => {
    expect(hasMeaningfulSignal(makeSignals({ entryPath: "/" }))).toBe(false);
  });

  it("returns false for a context-only path (demo → urgency, not gate-qualifying)", () => {
    expect(hasMeaningfulSignal(makeSignals({ entryPath: "/demo" }))).toBe(false);
  });

  it("returns false for an unmapped path (/about)", () => {
    expect(hasMeaningfulSignal(makeSignals({ entryPath: "/about" }))).toBe(false);
  });

  it("returns false when entryPath is null/undefined", () => {
    expect(hasMeaningfulSignal(makeSignals({ entryPath: null }))).toBe(false);
    expect(hasMeaningfulSignal(makeSignals({ entryPath: undefined }))).toBe(false);
  });
});

describe("hasMeaningfulSignal — L2 source recovery", () => {
  it("returns true when an in-app browser marker recovered the channel", () => {
    expect(
      hasMeaningfulSignal(
        makeSignals({ appSource: { app: "instagram", channel: "social", confidence: "high" } }),
      ),
    ).toBe(true);
  });

  it("returns true when a click-id name recovered the channel", () => {
    expect(hasMeaningfulSignal(makeSignals({ clickId: "google-ads" }))).toBe(true);
  });

  it("returns true for an Android webview of unknown app (medium confidence)", () => {
    expect(
      hasMeaningfulSignal(
        makeSignals({ appSource: { app: "unknown", channel: "app", confidence: "medium" } }),
      ),
    ).toBe(true);
  });

  it("returns false for the low-confidence iOS webview guess alone", () => {
    expect(
      hasMeaningfulSignal(
        makeSignals({ appSource: { app: "unknown", channel: "app", confidence: "low" } }),
      ),
    ).toBe(false);
  });

  it("returns false when both are explicitly null", () => {
    expect(hasMeaningfulSignal(makeSignals({ appSource: null, clickId: null }))).toBe(false);
  });
});

// Session carry: a page whose only signal is its path keeps the carried
// source (docs/specs/session-carry.md, measure-lab 2026-10-05).
describe("hasSourceSignal", () => {
  it("is false for a path alone, which still counts as meaningful", () => {
    const s = makeSignals({ entryPath: "/pricing" });
    expect(hasMeaningfulSignal(s)).toBe(true);
    expect(hasSourceSignal(s)).toBe(false);
  });

  it("is true for a utm, a referrer from another site, an AI source, a click id or an app marker", () => {
    const path = { entryPath: "/pricing" };
    expect(hasSourceSignal(makeSignals({ ...path, utm: { source: "linkedin" } }))).toBe(true);
    expect(hasSourceSignal(makeSignals({ ...path, referrerHost: "news.ycombinator.com" }))).toBe(
      true,
    );
    expect(hasSourceSignal(makeSignals({ ...path, aiSource: "chatgpt" }))).toBe(true);
    expect(hasSourceSignal(makeSignals({ ...path, clickId: "gclid" }))).toBe(true);
    expect(
      hasSourceSignal(
        makeSignals({
          ...path,
          appSource: { app: "instagram", channel: "social", confidence: "high" },
        }),
      ),
    ).toBe(true);
  });

  it("is false for the low-confidence webview guess", () => {
    expect(
      hasSourceSignal(
        makeSignals({ appSource: { app: "unknown", channel: "app", confidence: "low" } }),
      ),
    ).toBe(false);
  });
});
