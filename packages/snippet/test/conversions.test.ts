/**
 * Tests for snippet/src/conversions.ts — document-level click delegation
 * (V2 Fix Pass A / QA-4).
 *
 * The previous per-element attachment was replaced with a single
 * document listener using event.target.closest(selector). These tests
 * verify the new model, including the critical case where a click on a
 * nested icon inside a CTA anchor still resolves via closest().
 */

import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ConversionTarget, installConversionListeners } from "../src/conversions.ts";
import { at } from "./helpers.ts";

let dom: JSDOM;
let sentCalls: Array<{ url: string; blob: Blob }>;

beforeEach(() => {
  dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
    url: "https://customer.example.com/pricing",
  });
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("location", dom.window.location);
  vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
  vi.stubGlobal("Element", dom.window.Element);
  vi.stubGlobal("Node", dom.window.Node);
  // Do NOT stub Blob — use Node's built-in (has .text() for test assertions).

  sentCalls = [];
  vi.stubGlobal("navigator", {
    sendBeacon: (url: string, blob: Blob) => {
      sentCalls.push({ url, blob });
      return true;
    },
  });
  // A conversion leaves by a keepalive fetch (events.ts); recorded in the
  // same list, its body as a Blob, so the assertions below read either.
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    if (url.includes("/event")) sentCalls.push({ url, blob: new Blob([String(init?.body)]) });
    return Promise.resolve(new Response(null, { status: 202 }));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function seedHtml(html: string): void {
  dom.window.document.body.innerHTML = html;
}

function makeTarget(over: Partial<ConversionTarget> = {}): ConversionTarget {
  return {
    section_path: "hero.cta.label",
    conversion_label: "signup",
    css: ["#cta"],
    text: [],
    structural: "primary cta",
    ...over,
  };
}

describe("installConversionListeners — document delegation basics", () => {
  it("clicking a CSS-matching element fires a conversion event", () => {
    seedHtml('<button id="cta">Get started</button>');
    installConversionListeners([makeTarget()], {
      edgeOrigin: "https://edge.rawuser.test",
      customerId: "acme",
      prov: { variant_key: "competitor:ai", intent_dim: "competitor", source_dim: "ai" },
    });

    dom.window.document.querySelector<HTMLButtonElement>("#cta")?.click();

    expect(sentCalls).toHaveLength(1);
    expect(at(sentCalls, 0).url).toBe("https://edge.rawuser.test/event?cid=acme");
  });

  it("clicking a NESTED span inside the CTA still resolves via closest() — React-icon scenario", async () => {
    // The exact failure case from QA-4 / real production: framework wraps the
    // anchor with icon spans, and the click event target is the inner span.
    // Per-element attachment to the <a> wouldn't catch this if React replaces
    // the anchor post-hydration; closest() walks up and finds the matching
    // anchor regardless.
    seedHtml('<a href="/signup" class="cta-primary"><span class="icon">→</span> Sign up</a>');
    installConversionListeners([makeTarget({ css: [".cta-primary"] })], {
      edgeOrigin: "https://edge.rawuser.test",
      customerId: "acme",
    });

    const span = dom.window.document.querySelector<HTMLSpanElement>("span.icon");
    span?.click();

    expect(sentCalls).toHaveLength(1);
    const body = JSON.parse(await at(sentCalls, 0).blob.text());
    expect(body.event_type).toBe("conversion");
    expect(body.conversion_label).toBe("signup");
  });

  it("survives a post-install DOM replacement — the React re-render scenario", async () => {
    // Simulate React swapping the entire hero subtree AFTER installation.
    // Per-element listeners would die with the old DOM. Document delegation
    // keeps working because the listener is on document, not on the
    // replaced nodes.
    seedHtml('<section id="hero"><button class="btn">old</button></section>');
    installConversionListeners([makeTarget({ css: [".btn"] })], {
      edgeOrigin: "https://edge.rawuser.test",
      customerId: "acme",
    });

    // Simulate hydration: replace the entire #hero subtree.
    const hero = dom.window.document.getElementById("hero");
    if (hero) {
      hero.innerHTML = '<button class="btn">new (post-hydration)</button>';
    }

    // Now click the NEW button.
    dom.window.document.querySelector<HTMLButtonElement>(".btn")?.click();
    expect(sentCalls).toHaveLength(1);
  });

  it("a click that matches no target does not fire a conversion event", () => {
    seedHtml('<button class="btn-primary">primary</button><a id="other">other</a>');
    installConversionListeners([makeTarget({ css: [".btn-primary"] })], {
      edgeOrigin: "https://edge.rawuser.test",
      customerId: "acme",
    });
    dom.window.document.querySelector<HTMLAnchorElement>("#other")?.click();
    expect(sentCalls).toHaveLength(0);
  });

  it("empty targets array → no listener installed, no fire on any click", () => {
    seedHtml('<button id="cta">x</button>');
    installConversionListeners([], { edgeOrigin: "https://edge.rawuser.test", customerId: "acme" });
    dom.window.document.querySelector<HTMLButtonElement>("#cta")?.click();
    expect(sentCalls).toHaveLength(0);
  });
});

describe("installConversionListeners — multiple targets, first-match wins", () => {
  it("each unique click matches at most one target — first in array wins", () => {
    // One element, two targets that both match the same selector.
    // Document delegation runs handler once per click, first-match returns.
    seedHtml('<button id="cta" class="btn-primary">x</button>');
    installConversionListeners(
      [
        makeTarget({
          section_path: "hero.cta.label",
          conversion_label: "signup",
          css: ["#cta"],
        }),
        makeTarget({
          section_path: "secondary",
          conversion_label: "contact",
          css: [".btn-primary"],
        }),
      ],
      { edgeOrigin: "https://edge.rawuser.test", customerId: "acme" },
    );
    dom.window.document.querySelector<HTMLButtonElement>("#cta")?.click();
    expect(sentCalls).toHaveLength(1);
  });

  it("two different targets each fire on their respective clicks", () => {
    seedHtml('<button id="hero-cta">A</button><button id="pricing-cta">B</button>');
    installConversionListeners(
      [
        makeTarget({ section_path: "hero.cta.label", css: ["#hero-cta"] }),
        makeTarget({ section_path: "pricing.cta.label", css: ["#pricing-cta"] }),
      ],
      { edgeOrigin: "https://edge.rawuser.test", customerId: "acme" },
    );
    dom.window.document.querySelector<HTMLButtonElement>("#hero-cta")?.click();
    dom.window.document.querySelector<HTMLButtonElement>("#pricing-cta")?.click();
    expect(sentCalls).toHaveLength(2);
  });
});

describe("installConversionListeners — selector fallbacks", () => {
  it("falls through CSS selectors in order — first that matches via closest() wins", () => {
    seedHtml('<button class="real-cta">Real</button>');
    installConversionListeners([makeTarget({ css: ["#nope", ".real-cta"] })], {
      edgeOrigin: "https://edge.rawuser.test",
      customerId: "acme",
    });
    dom.window.document.querySelector<HTMLButtonElement>(".real-cta")?.click();
    expect(sentCalls).toHaveLength(1);
  });

  it("uses structural as fallback CSS when css[] has no match", () => {
    seedHtml('<button class="some-button">x</button>');
    installConversionListeners([makeTarget({ css: ["#nope"], structural: ".some-button" })], {
      edgeOrigin: "https://edge.rawuser.test",
      customerId: "acme",
    });
    dom.window.document.querySelector<HTMLButtonElement>(".some-button")?.click();
    expect(sentCalls).toHaveLength(1);
  });

  it("ignores invalid selector strings safely (no throw, just no match)", () => {
    seedHtml('<button id="cta">x</button>');
    installConversionListeners([makeTarget({ css: ["???not valid CSS???", "#cta"] })], {
      edgeOrigin: "https://edge.rawuser.test",
      customerId: "acme",
    });
    expect(() => {
      dom.window.document.querySelector<HTMLButtonElement>("#cta")?.click();
    }).not.toThrow();
    expect(sentCalls).toHaveLength(1);
  });
});

describe("installConversionListeners — payload contents", () => {
  it("payload contains variant attribution when supplied", async () => {
    seedHtml('<button id="cta">x</button>');
    installConversionListeners([makeTarget()], {
      edgeOrigin: "https://edge.rawuser.test",
      customerId: "acme",
      prov: { variant_key: "pricing:organic", intent_dim: "pricing", source_dim: "organic" },
    });
    dom.window.document.querySelector<HTMLButtonElement>("#cta")?.click();
    const body = JSON.parse(await at(sentCalls, 0).blob.text());
    expect(body.event_type).toBe("conversion");
    expect(body.conversion_label).toBe("signup");
    expect(body.page_path).toBe("/pricing");
    expect(body.variant_key).toBe("pricing:organic");
    expect(body.intent_dim).toBe("pricing");
    expect(body.source_dim).toBe("organic");
  });

  it("omits variant attribution fields when undefined", async () => {
    seedHtml('<button id="cta">x</button>');
    installConversionListeners([makeTarget()], {
      edgeOrigin: "https://edge.rawuser.test",
      customerId: "acme",
    });
    dom.window.document.querySelector<HTMLButtonElement>("#cta")?.click();
    const body = JSON.parse(await at(sentCalls, 0).blob.text());
    expect(body).not.toHaveProperty("variant_key");
    expect(body).not.toHaveProperty("intent_dim");
    expect(body).not.toHaveProperty("source_dim");
  });
});
