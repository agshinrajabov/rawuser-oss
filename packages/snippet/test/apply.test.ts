/**
 * Integration tests for snippet runtime (apply.ts, boot.ts, reveal.ts).
 *
 * Uses jsdom to construct a real DOM environment for each test.
 * Validates the anti-flicker mechanism, applyVariant DOM mutations,
 * XSS safety, and safety-timeout reveal path.
 */

import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VariantBody } from "../src/types.ts";

let originalDocument: Document;
let originalWindow: Window & typeof globalThis;

beforeEach(() => {
  originalDocument = global.document;
  originalWindow = global.window as Window & typeof globalThis;
  vi.useFakeTimers();
});

afterEach(() => {
  global.document = originalDocument;
  global.window = originalWindow;
  vi.useRealTimers();
});

function setupDOM(html: string): Document {
  const dom = new JSDOM(`<!DOCTYPE html><html><head></head><body>${html}</body></html>`);
  global.document = dom.window.document;
  global.window = dom.window as unknown as Window & typeof globalThis;
  return dom.window.document;
}

function makeVariant(overrides: Partial<VariantBody["sections"]> = {}): VariantBody {
  return {
    customer_id: "test-customer",
    profile_key: "test-profile",
    prompt_hash: "abc123",
    generated_at: Date.now(),
    sections: {
      hero: {
        kind: "hero",
        headline: "Personalised Headline",
        body: "Personalised body text.",
        cta: { label: "Enroll Now", href: "/enroll" },
      },
      cta: {
        kind: "cta",
        cta: { label: "Sign Up Today" },
      },
      ...overrides,
    },
  };
}

describe("injectHideStyle — anti-flicker mechanism", () => {
  it("synchronously appends a style element to document.head", async () => {
    setupDOM("");

    const { injectHideStyle } = await import("../src/boot.ts");
    const styleEl = injectHideStyle();

    const found = document.head.querySelector("#__rawuser-hide");
    expect(found).not.toBeNull();
    expect(found).toBe(styleEl);
  });

  it("injected style targets [data-rawuser] (not body)", async () => {
    setupDOM("");

    const { injectHideStyle } = await import("../src/boot.ts");
    injectHideStyle();

    const styleEl = document.head.querySelector("#__rawuser-hide") as HTMLStyleElement;
    expect(styleEl.textContent).toContain("[data-rawuser]");
    expect(styleEl.textContent).not.toContain("body");
  });
});

describe("revealAll — idempotent hide removal", () => {
  it("removes the hide style element from head", async () => {
    setupDOM("");

    const { injectHideStyle } = await import("../src/boot.ts");
    const { revealAll } = await import("../src/reveal.ts");

    const styleEl = injectHideStyle();
    expect(document.head.querySelector("#__rawuser-hide")).not.toBeNull();

    revealAll(styleEl);
    expect(document.head.querySelector("#__rawuser-hide")).toBeNull();
  });

  it("is idempotent — calling twice does not throw", async () => {
    setupDOM("");

    const { injectHideStyle } = await import("../src/boot.ts");
    const { revealAll } = await import("../src/reveal.ts");

    const styleEl = injectHideStyle();
    revealAll(styleEl);
    // Second call should be a no-op, not throw
    expect(() => revealAll(styleEl)).not.toThrow();
  });

  it("handles null safely (defensive pattern)", async () => {
    setupDOM("");

    const { revealAll } = await import("../src/reveal.ts");
    expect(() => revealAll(null)).not.toThrow();
  });
});

describe("applyVariant — DOM mutation", () => {
  // Each test below sets up the full landing-page contract (all 4 leaf
  // elements) because applyVariant's pre-flight (D5.4) requires every
  // non-href / non-kind path to resolve. The aspect under test in each
  // case is the per-path mutation behavior, not the all-or-nothing gate.
  const FULL_LANDING = `
    <h1 data-rawuser="hero.headline">Original headline</h1>
    <p  data-rawuser="hero.body">Original body</p>
    <a  data-rawuser="hero.cta.label" href="/old">Old CTA</a>
    <footer><a data-rawuser="cta.cta.label" href="/signup">Sign Up</a></footer>
  `;

  it("updates textContent of [data-rawuser] elements from variant sections", async () => {
    setupDOM(FULL_LANDING);

    const { applyVariant } = await import("../src/apply.ts");
    applyVariant(makeVariant());

    expect(document.querySelector("[data-rawuser='hero.headline']")?.textContent).toBe(
      "Personalised Headline",
    );
    expect(document.querySelector("[data-rawuser='hero.body']")?.textContent).toBe(
      "Personalised body text.",
    );
    expect(document.querySelector("[data-rawuser='hero.cta.label']")?.textContent).toBe(
      "Enroll Now",
    );
  });

  it("does NOT clear existing href on link CTAs", async () => {
    setupDOM(`
      <h1 data-rawuser="hero.headline">Original</h1>
      <p  data-rawuser="hero.body">Original body</p>
      <a  data-rawuser="hero.cta.label" href="/keep-this">Old label</a>
      <footer><a data-rawuser="cta.cta.label" href="/signup">Sign Up</a></footer>
    `);

    const { applyVariant } = await import("../src/apply.ts");
    applyVariant(makeVariant());

    const link = document.querySelector("[data-rawuser='hero.cta.label']") as HTMLAnchorElement;
    // textContent updated
    expect(link.textContent).toBe("Enroll Now");
    // href preserved (customer's choice wins)
    expect(link.getAttribute("href")).toBe("/keep-this");
  });

  it("does NOT use innerHTML — only textContent (XSS-safe)", async () => {
    setupDOM(FULL_LANDING);

    const variant = makeVariant();
    // Inject a dangerous value into the existing hero section (don't replace
    // the section — the pre-flight requires all paths to remain resolvable).
    const heroSection = variant.sections.hero as unknown as { headline: string };
    heroSection.headline = '<img src="x" onerror="alert(1)">';

    const { applyVariant } = await import("../src/apply.ts");
    applyVariant(variant);

    const el = document.querySelector("[data-rawuser='hero.headline']") as HTMLElement;
    // textContent should be the raw string — no img tag parsed into DOM
    expect(el.textContent).toBe('<img src="x" onerror="alert(1)">');
    expect(el.querySelector("img")).toBeNull();
  });

  it("applies cta.cta.label from nested sections", async () => {
    setupDOM(FULL_LANDING);

    const { applyVariant } = await import("../src/apply.ts");
    applyVariant(makeVariant());

    const el = document.querySelector("[data-rawuser='cta.cta.label']");
    expect(el?.textContent).toBe("Sign Up Today");
  });
});

// ---------------------------------------------------------------------------
// All-or-nothing pre-flight (D5.4 — admin-page hijack prevention)
// ---------------------------------------------------------------------------

describe("applyVariant — return value gates analytics (V2 Fix Pass A / QA-3)", () => {
  it("returns true when mutation happened", async () => {
    setupDOM(`
      <h1 data-rawuser="hero.headline">Original</h1>
      <p  data-rawuser="hero.body">Original body</p>
      <a  data-rawuser="hero.cta.label" href="/old">Old</a>
      <footer><a data-rawuser="cta.cta.label" href="/x">Sign Up</a></footer>
    `);
    const { applyVariant } = await import("../src/apply.ts");
    const result = applyVariant(makeVariant());
    expect(result).toBe(true);
  });

  it("returns false when pre-flight aborts on a missing path (no mutation)", async () => {
    // Hero present, body present, but no .cta element anywhere — same scenario
    // as an admin page or a sub-page where the variant doesn't apply.
    setupDOM(`
      <h1>Admin</h1>
      <p>Body</p>
    `);
    const { applyVariant } = await import("../src/apply.ts");
    const result = applyVariant(makeVariant());
    expect(result).toBe(false);
    // And no mutation actually happened:
    expect(document.querySelector("h1")?.textContent).toBe("Admin");
  });

  it("returns true even when only href paths mutate (label and headline already match)", async () => {
    // Construct a case where text values happen to already equal the variant's
    // value — textContent assignment still counts as mutation in this impl
    // (assignment is unconditional once pre-flight passes). The point of this
    // test is that the return value is true whenever the apply loop ran.
    setupDOM(`
      <h1 data-rawuser="hero.headline">Personalised Headline</h1>
      <p  data-rawuser="hero.body">Personalised body text.</p>
      <a  data-rawuser="hero.cta.label" href="">Enroll Now</a>
      <footer><a data-rawuser="cta.cta.label" href="/x">Sign Up Today</a></footer>
    `);
    const { applyVariant } = await import("../src/apply.ts");
    const result = applyVariant(makeVariant());
    expect(result).toBe(true);
  });
});

describe("applyVariant — all-or-nothing pre-flight", () => {
  it("aborts entirely when a required path has no match (admin-page scenario)", async () => {
    // Admin page: has an h1 (which h1:first-of-type would match by tier-2
    // fallback) but no .cta link/button anywhere. The variant requires
    // both hero.cta.label AND cta.cta.label. Missing → abort.
    setupDOM(`
      <h1>Admin Dashboard</h1>
      <p>Welcome back, operator.</p>
      <table><tr><th>User</th><th>Status</th></tr></table>
    `);

    const { applyVariant } = await import("../src/apply.ts");
    applyVariant(makeVariant());

    // h1 must NOT have been mutated even though h1:first-of-type would match.
    expect(document.querySelector("h1")?.textContent).toBe("Admin Dashboard");
    expect(document.querySelector("p")?.textContent).toBe("Welcome back, operator.");
  });

  it("aborts when a convention-default path is absent and there is no manifest (partial markup)", async () => {
    // No manifest: cta.cta.label is claimed by the convention default
    // (footer a.cta). The page has no footer .cta, so this is not the
    // landing page the defaults describe. Abort, mutate nothing.
    setupDOM(`
      <h1 data-rawuser="hero.headline">Real landing headline</h1>
      <p>Real body</p>
      <a class="cta" href="/start">Real CTA</a>
    `);

    const { applyVariant } = await import("../src/apply.ts");
    expect(applyVariant(makeVariant())).toBe(false);
    expect(document.querySelector("[data-rawuser='hero.headline']")?.textContent).toBe(
      "Real landing headline",
    );
  });

  it("aborts when a section resolves only partly (hero body found, hero CTA missing)", async () => {
    setupDOM(`
      <h1>Admin Dashboard</h1>
      <p>Welcome back, operator.</p>
    `);
    const { applyVariant } = await import("../src/apply.ts");
    expect(applyVariant(makeVariant())).toBe(false);
    expect(document.querySelector("h1")?.textContent).toBe("Admin Dashboard");
  });

  it("a variant section the page never had (comparison) does not block the hero", async () => {
    // Versions written before the page was read can carry sections the page
    // cannot host. Observed on a pilot site 2026-09-11: every visit was skipped.
    setupDOM(`
      <h1 data-rawuser="hero.headline">Original</h1>
      <p  data-rawuser="hero.body">Original body</p>
      <a  data-rawuser="hero.cta.label" href="/enroll">Old CTA</a>
      <footer><a class="cta" data-rawuser="cta.cta.label">Sign Up</a></footer>
    `);
    const { applyVariant } = await import("../src/apply.ts");
    const variant = makeVariant();
    (variant.sections as Record<string, unknown>).comparison = {
      kind: "comparison",
      headline: "Us versus them",
      body: "A table the page does not have",
    };
    expect(applyVariant(variant)).toBe(true);
    expect(document.querySelector("[data-rawuser='hero.headline']")?.textContent).toBe(
      "Personalised Headline",
    );
    expect(document.body.textContent).not.toContain("Us versus them");
  });

  it("with a manifest, only mapped paths are claimed: an unmapped cta.headline is skipped, mapped paths apply", async () => {
    // A pilot site, 2026-09-11: the manifest maps hero.* and cta.cta.label but
    // not cta.headline; the variant carries cta.headline. Before this fix
    // every visit was personalization_skipped.
    setupDOM(`
      <section class="hero"><h1 class="title">Original</h1><p class="lead">Lead</p><a class="ghost" href="/x">Old CTA</a></section>
      <footer><button class="submit">Send</button></footer>
    `);
    const { applyVariant } = await import("../src/apply.ts");
    const variant = makeVariant();
    (variant.sections as Record<string, unknown>).cta = {
      kind: "cta",
      headline: "A headline the manifest never mapped",
      cta: { label: "Send it", href: "/go" },
    };
    const targets = {
      "hero.headline": { css: ["h1.title"], text: [], structural: "h1" },
      "hero.body": { css: ["p.lead"], text: [], structural: "p" },
      "hero.cta.label": { css: ["a.ghost"], text: [], structural: "a" },
      "cta.cta.label": { css: ["footer button.submit"], text: [], structural: "button" },
    };
    expect(applyVariant(variant, targets)).toBe(true);
    expect(document.querySelector("h1.title")?.textContent).toBe("Personalised Headline");
    expect(document.querySelector("footer button.submit")?.textContent).toBe("Send it");
    expect(document.body.textContent).not.toContain("never mapped");
  });

  it("with a manifest, a mapped path that does not resolve still aborts (wrong page)", async () => {
    setupDOM(`<h1 class="title">Admin</h1>`);
    const { applyVariant } = await import("../src/apply.ts");
    const targets = {
      "hero.headline": { css: ["h1.title"], text: [], structural: "h1" },
      "hero.body": { css: ["p.lead"], text: [], structural: "p" },
    };
    expect(applyVariant(makeVariant(), targets)).toBe(false);
    expect(document.querySelector("h1.title")?.textContent).toBe("Admin");
  });

  it("applies fully when every required path resolves", async () => {
    // Landing page has all four required leaf elements via mix of
    // data-rawuser tags and tier-2 defaults.
    setupDOM(`
      <h1 data-rawuser="hero.headline">Original</h1>
      <p  data-rawuser="hero.body">Original body</p>
      <a  data-rawuser="hero.cta.label" href="/enroll">Old CTA</a>
      <footer><a class="cta" data-rawuser="cta.cta.label">Sign Up</a></footer>
    `);

    const { applyVariant } = await import("../src/apply.ts");
    applyVariant(makeVariant());

    expect(document.querySelector("[data-rawuser='hero.headline']")?.textContent).toBe(
      "Personalised Headline",
    );
    expect(document.querySelector("[data-rawuser='cta.cta.label']")?.textContent).toBe(
      "Sign Up Today",
    );
  });

  it("href paths don't block pre-flight (they're co-located metadata)", async () => {
    // The variant has hero.cta.href = "/enroll" but no element specifically
    // matches data-rawuser="hero.cta.href" or DEFAULT_SELECTORS["hero.cta.href"].
    // The pre-flight should still pass because non-href paths all resolve.
    setupDOM(`
      <h1 data-rawuser="hero.headline">Original</h1>
      <p  data-rawuser="hero.body">Original body</p>
      <a  data-rawuser="hero.cta.label" href="">Old CTA</a>
      <footer><a class="cta" data-rawuser="cta.cta.label">Sign Up</a></footer>
    `);

    const { applyVariant } = await import("../src/apply.ts");
    applyVariant(makeVariant());

    // Mutations should still have happened (pre-flight passed)
    expect(document.querySelector("[data-rawuser='hero.headline']")?.textContent).toBe(
      "Personalised Headline",
    );
  });
});

describe("applyVariant — Tier 3 manifest integration", () => {
  it("applies variant text via manifest css selector when no data-rawuser present", async () => {
    // Element has no data-rawuser; manifest css selector targets it directly.
    // Full set of required elements present so the pre-flight (D5.4) passes;
    // the aspect under test is the CSS-selector resolution.
    setupDOM(`
      <main>
        <h1 id="ai-targeted">Original headline</h1>
        <p id="ai-body">Original body</p>
        <a id="ai-cta" href="/enroll">Enroll</a>
      </main>
      <footer><a id="ai-footer-cta">Sign Up</a></footer>
    `);

    const { applyVariant } = await import("../src/apply.ts");

    const variant = makeVariant();
    const targets = {
      "hero.headline": { css: ["#ai-targeted"], text: [], structural: "" },
      "hero.body": { css: ["#ai-body"], text: [], structural: "" },
      "hero.cta.label": { css: ["#ai-cta"], text: [], structural: "" },
      "cta.cta.label": { css: ["#ai-footer-cta"], text: [], structural: "" },
    };

    applyVariant(variant, targets);

    expect(document.querySelector("#ai-targeted")?.textContent).toBe("Personalised Headline");
    expect(document.querySelector("#ai-body")?.textContent).toBe("Personalised body text.");
  });

  it("manifest text signature fallback applies when CSS misses", async () => {
    setupDOM(`
      <main>
        <p id="found-by-text">Welcome to our platform. Learn more today.</p>
      </main>
    `);

    const { applyVariant } = await import("../src/apply.ts");

    // Use an unknown path so no data-rawuser and no DEFAULT_SELECTORS entry fire.
    const variant: import("../src/types.ts").VariantBody = {
      customer_id: "test-customer",
      profile_key: "test-profile",
      prompt_hash: "abc123",
      generated_at: Date.now(),
      sections: {
        promo: { kind: "hero", headline: "New headline from manifest" },
      },
    };

    const targets = {
      "promo.headline": {
        css: [".no-such-class"],
        text: ["Welcome to our platform"],
        structural: "",
      },
    };

    applyVariant(variant, targets);

    expect(document.querySelector("#found-by-text")?.textContent).toBe(
      "New headline from manifest",
    );
  });
});

describe("safety-timeout reveal", () => {
  it("fires after 300ms when fetch never resolves", async () => {
    const dom = setupDOM(`<h1 data-rawuser="hero.headline">Fallback</h1>`);

    const { injectHideStyle } = await import("../src/boot.ts");
    const { revealAll } = await import("../src/reveal.ts");

    const hideStyle = injectHideStyle();
    expect(dom.head.querySelector("#__rawuser-hide")).not.toBeNull();

    let revealed = false;

    // Simulate the safety timer pattern from index.ts
    const safetyTimer = setTimeout(() => {
      if (!revealed) {
        revealed = true;
        revealAll(hideStyle);
      }
    }, 300);

    // Before 300ms — hide style still present
    vi.advanceTimersByTime(299);
    expect(dom.head.querySelector("#__rawuser-hide")).not.toBeNull();
    expect(revealed).toBe(false);

    // At 300ms — hide style removed
    vi.advanceTimersByTime(1);
    expect(dom.head.querySelector("#__rawuser-hide")).toBeNull();
    expect(revealed).toBe(true);

    clearTimeout(safetyTimer);
  });
});
