/**
 * Integration tests for three-tier element targeting (targets.ts).
 *
 * Uses jsdom to construct a real DOM environment for each test so
 * the querySelector calls behave identically to a browser.
 */

import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ManifestEntry } from "../src/types.ts";

// Store original globals to restore after each test.
let originalDocument: Document;
let originalWindow: Window & typeof globalThis;

beforeEach(() => {
  originalDocument = global.document;
  originalWindow = global.window as Window & typeof globalThis;
});

afterEach(() => {
  global.document = originalDocument;
  global.window = originalWindow;
});

function setupDOM(html: string): Document {
  const dom = new JSDOM(`<!DOCTYPE html><html><head></head><body>${html}</body></html>`);
  global.document = dom.window.document;
  global.window = dom.window as unknown as Window & typeof globalThis;
  return dom.window.document;
}

/** Helper to build a ManifestEntry with safe defaults. */
function entry(overrides: Partial<ManifestEntry> = {}): ManifestEntry {
  return { css: [], text: [], structural: "", ...overrides };
}

describe("findTargets — three-tier targeting", () => {
  it("Tier 1: data-rawuser attribute takes precedence over h1:first-of-type", async () => {
    // Both a [data-rawuser] element AND an h1 exist; Tier 1 must win.
    setupDOM(`
      <h1 id="plain-h1">Fallback headline</h1>
      <h1 data-rawuser="hero.headline" id="marked">Personalised headline</h1>
    `);

    // Dynamic import so the module picks up the patched global.document.
    const { findTargets } = await import("../src/targets.ts");
    const results = findTargets("hero.headline");

    expect(results).toHaveLength(1);
    expect((results[0] as HTMLElement).id).toBe("marked");
  });

  it("Tier 3: falls back to DEFAULT_SELECTORS when no data-rawuser and no manifest", async () => {
    setupDOM(`<h1 id="first-h1">Hello world</h1><p>Body text</p>`);

    const { findTargets } = await import("../src/targets.ts");
    const results = findTargets("hero.headline");

    expect(results).toHaveLength(1);
    expect((results[0] as HTMLElement).id).toBe("first-h1");
  });

  it("Tier 1 multi-match: multiple [data-rawuser] elements all returned", async () => {
    setupDOM(`
      <h1 data-rawuser="hero.headline" id="a">First</h1>
      <h2 data-rawuser="hero.headline" id="b">Second</h2>
    `);

    const { findTargets } = await import("../src/targets.ts");
    const results = findTargets("hero.headline");

    expect(results).toHaveLength(2);
    const ids = results.map((el) => (el as HTMLElement).id);
    expect(ids).toContain("a");
    expect(ids).toContain("b");
  });

  it("returns empty array when no match in Tier 1, 2, or 3", async () => {
    setupDOM("<div>No matching elements</div>");

    const { findTargets } = await import("../src/targets.ts");
    const results = findTargets("hero.headline");

    // h1:first-of-type matches nothing → empty
    expect(results).toHaveLength(0);
  });

  it("path with no entry in DEFAULT_SELECTORS returns empty array", async () => {
    setupDOM("<div>Content</div>");

    const { findTargets } = await import("../src/targets.ts");
    // "unknown.path" has no data-rawuser attr and no default selector
    const results = findTargets("unknown.path");

    expect(results).toHaveLength(0);
  });
});

describe("findTargets — Tier 3 manifest", () => {
  it("Tier 2 CSS: manifest css[0] selector wins when no data-rawuser", async () => {
    // No data-rawuser, and "unknown.path" has no DEFAULT_SELECTORS entry.
    setupDOM(`<section class="hero"><h2 id="ai-found">AI found this</h2></section>`);

    const { findTargets } = await import("../src/targets.ts");
    const results = findTargets("unknown.path", entry({ css: [".hero h2"] }));

    expect(results).toHaveLength(1);
    expect((results[0] as HTMLElement).id).toBe("ai-found");
  });

  it("Tier 3 CSS: first matching selector in css[] wins; all its matches returned", async () => {
    // Two elements match the second selector; first selector matches nothing.
    setupDOM(`
      <p class="tagline" id="p1">Tagline one</p>
      <p class="tagline" id="p2">Tagline two</p>
    `);

    const { findTargets } = await import("../src/targets.ts");
    const results = findTargets("unknown.path", entry({ css: [".no-match", ".tagline"] }));

    expect(results).toHaveLength(2);
    const ids = results.map((el) => (el as HTMLElement).id);
    expect(ids).toContain("p1");
    expect(ids).toContain("p2");
  });

  it("Tier 3 CSS fallthrough to text: all CSS selectors fail, text sig matches", async () => {
    setupDOM(`<main><p id="body-text">We help developers ship faster.</p></main>`);

    const { findTargets } = await import("../src/targets.ts");
    const results = findTargets(
      "unknown.path",
      entry({
        css: [".no-such-class"],
        text: ["We help developers"],
      }),
    );

    expect(results).toHaveLength(1);
    expect((results[0] as HTMLElement).id).toBe("body-text");
  });

  it("Tier 3 CSS+text fallthrough to structural 'first {tag} in {scope}'", async () => {
    setupDOM(`<main><h1 id="main-h1">Ship faster.</h1></main>`);

    const { findTargets } = await import("../src/targets.ts");
    const results = findTargets(
      "unknown.path",
      entry({
        css: [".no-class"],
        text: ["No match text"],
        structural: "first h1 in main",
      }),
    );

    expect(results).toHaveLength(1);
    expect((results[0] as HTMLElement).id).toBe("main-h1");
  });

  it("Tier 3 structural: 'primary CTA in the hero section' named pattern", async () => {
    setupDOM(`<div class="hero"><a id="cta-link" href="/start">Get started</a></div>`);

    const { findTargets } = await import("../src/targets.ts");
    const results = findTargets(
      "unknown.path",
      entry({
        structural: "primary CTA in the hero section",
      }),
    );

    expect(results).toHaveLength(1);
    expect((results[0] as HTMLElement).id).toBe("cta-link");
  });

  it("Tier 3 structural: 'first {tag}' pattern", async () => {
    setupDOM(`<div><h2 id="first-h2">First h2</h2><h2 id="second-h2">Second h2</h2></div>`);

    const { findTargets } = await import("../src/targets.ts");
    const results = findTargets("unknown.path", entry({ structural: "first h2" }));

    expect(results).toHaveLength(1);
    expect((results[0] as HTMLElement).id).toBe("first-h2");
  });

  it("Tier 3 structural: raw CSS selector fallback (AI sometimes outputs CSS)", async () => {
    setupDOM(`<main><h1 id="raw-css-match">Match me</h1></main>`);

    const { findTargets } = await import("../src/targets.ts");
    // "main h1" is a valid CSS selector — falls through to querySelector.
    const results = findTargets("unknown.path", entry({ structural: "main h1" }));

    expect(results).toHaveLength(1);
    expect((results[0] as HTMLElement).id).toBe("raw-css-match");
  });

  it("Tier 3 structural: invalid descriptor returns empty array (no throw)", async () => {
    setupDOM("<div>content</div>");

    const { findTargets } = await import("../src/targets.ts");
    // An invalid CSS selector — querySelector throws; we catch and return [].
    expect(() => findTargets("unknown.path", entry({ structural: ":::invalid:::" }))).not.toThrow();
    const results = findTargets("unknown.path", entry({ structural: ":::invalid:::" }));
    expect(results).toHaveLength(0);
  });

  it("Tier precedence: data-rawuser (Tier 1) beats manifest (Tier 3)", async () => {
    // Both a [data-rawuser] element AND a manifest CSS selector match.
    setupDOM(`
      <h1 data-rawuser="hero.headline" id="tier1">Tier 1 wins</h1>
      <h1 id="tier3-candidate">Tier 3 candidate</h1>
    `);

    const { findTargets } = await import("../src/targets.ts");
    const results = findTargets("hero.headline", entry({ css: ["#tier3-candidate"] }));

    expect(results).toHaveLength(1);
    expect((results[0] as HTMLElement).id).toBe("tier1");
  });

  it("Tier precedence: the manifest beats DEFAULT_SELECTORS (an operator's pick must win)", async () => {
    // h1 present (matches the convention 'h1:first-of-type'); the manifest points elsewhere.
    setupDOM(`
      <h1 id="convention-h1">Convention candidate</h1>
      <p id="picked-p" class="alt-headline">Picked by the operator</p>
    `);

    const { findTargets } = await import("../src/targets.ts");
    const results = findTargets("hero.headline", entry({ css: [".alt-headline"] }));

    expect(results).toHaveLength(1);
    expect((results[0] as HTMLElement).id).toBe("picked-p");
  });

  it("Tier precedence: convention default is reached when the manifest entry matches nothing", async () => {
    setupDOM(`<h1 id="convention-h1">Convention</h1>`);
    const { findTargets } = await import("../src/targets.ts");
    const results = findTargets(
      "hero.headline",
      entry({ css: [".gone"], text: ["Nothing like this"], structural: "first h4 in main" }),
    );
    expect(results).toHaveLength(1);
    expect((results[0] as HTMLElement).id).toBe("convention-h1");
  });

  it("Manifest missing path entry: does not crash, returns Tier 1/2 results", async () => {
    // Manifest has an entry for a different path; the queried path is absent.
    setupDOM(`<h1 id="default-h1">Default</h1>`);

    const { findTargets } = await import("../src/targets.ts");
    // Pass manifest = undefined explicitly (caller did the lookup, found nothing).
    const results = findTargets("hero.headline", undefined);

    expect(results).toHaveLength(1);
    expect((results[0] as HTMLElement).id).toBe("default-h1");
  });
});
