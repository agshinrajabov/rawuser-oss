/**
 * Picker selector generation on jsdom pages: stable ids and classes win,
 * hashed and utility classes are skipped, every emitted selector matches
 * exactly one element, text and structure follow the finder's vocabulary.
 */

import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import {
  cssCandidates,
  describeElement,
  isStableClass,
  structuralDescription,
  textSignature,
} from "../src/picker/selector.ts";

function page(body: string): Document {
  return new JSDOM(`<!doctype html><html><body>${body}</body></html>`).window.document;
}

describe("isStableClass", () => {
  it("keeps human class names", () => {
    for (const c of ["hero-title", "btn", "btn-primary", "cta", "pricing_card", "Hero"]) {
      expect(isStableClass(c), c).toBe(true);
    }
  });
  it("drops hashed, module, utility and variant classes", () => {
    for (const c of [
      "css-1x2y3z",
      "sc-bdVaJa",
      "jsx-1234567",
      "Hero_title__a8f3k",
      "text-4xl",
      "md:flex",
      "p-4",
      "mt-12",
      "w-[320px]",
      "bg-white",
      "hover:underline",
      "a",
      "x9f3a7b",
    ]) {
      expect(isStableClass(c), c).toBe(false);
    }
  });
});

describe("cssCandidates", () => {
  it("prefers a stable id, then stable classes, and every candidate is unique", () => {
    const doc = page(`
      <main><section class="hero p-8">
        <h1 id="hero-title" class="text-4xl font-bold hero-title">Dizaynı sıfırdan öyrən</h1>
        <p class="mt-4 text-lg">Alt mətn</p>
        <a class="btn btn-primary" href="/start">Başla</a>
      </section></main>`);
    const h1 = doc.querySelector("h1") as Element;
    const c = cssCandidates(doc, h1);
    expect(c[0]).toBe("#hero-title");
    expect(c).toContain("h1.hero-title");
    for (const s of c) expect(doc.querySelectorAll(s).length).toBe(1);
  });

  it("falls back to an nth-of-type path from the nearest landmark when nothing is stable", () => {
    const doc = page(`
      <main>
        <div class="css-1abc2d"><p class="mt-2">first</p><p class="mt-2">second</p></div>
      </main>`);
    const p2 = doc.querySelectorAll("p")[1] as Element;
    const c = cssCandidates(doc, p2);
    expect(c.length).toBeGreaterThan(0);
    for (const s of c) {
      expect(doc.querySelectorAll(s).length).toBe(1);
      expect(doc.querySelector(s)).toBe(p2);
      expect(s).not.toContain("css-1abc2d");
      expect(s).not.toContain("mt-2");
    }
  });

  it("uses data-testid and skips generated ids", () => {
    const doc = page(
      `<button id="radix-:r1:" data-testid="signup" class="inline-flex">Sign up</button>`,
    );
    const btn = doc.querySelector("button") as Element;
    const c = cssCandidates(doc, btn);
    expect(c[0]).toBe('button[data-testid="signup"]');
    expect(c.join(" ")).not.toContain("radix");
  });
});

describe("text and structure", () => {
  it("text signature is the first 40 characters of collapsed visible text", () => {
    const doc = page(
      "<h1>  Dizaynı   sıfırdan öyrən, portfolio qur, işə düzəl, sonra davam et  </h1>",
    );
    const h1 = doc.querySelector("h1") as Element;
    const sig = textSignature(h1)[0] ?? "";
    // At most 40 characters, cut at a word boundary, never mid-word.
    expect(sig.length).toBeLessThanOrEqual(40);
    expect(sig).toBe("Dizaynı sıfırdan öyrən, portfolio qur,");
  });

  it("structural description uses the finder's vocabulary", () => {
    const doc = page(
      "<main><h1>a</h1></main><section><button>x</button><button>y</button></section>",
    );
    expect(structuralDescription(doc, doc.querySelector("h1") as Element)).toBe("first h1 in main");
    expect(structuralDescription(doc, doc.querySelectorAll("button")[1] as Element)).toBe(
      "2nd button in section",
    );
  });

  it("describeElement fills the manifest entry shape", () => {
    const doc = page(
      `<section class="hero"><a class="btn-primary" href="#">Get started free</a></section>`,
    );
    const a = doc.querySelector("a") as Element;
    const e = describeElement(doc, a, true);
    expect(e.css.length).toBeGreaterThan(0);
    expect(e.text).toEqual(["Get started free"]);
    expect(e.original_char_length).toBe(16);
    expect(e.original_word_count).toBe(3);
    expect(e.conversion_candidate).toBe(true);
  });
});

describe("an aria-label that repeats the words is not a handle (phase 6, the Webflow test page)", () => {
  it("skips a label a split library copied from the text, keeps a label that names the element", () => {
    const doc = page(
      `<h1 class="rw-title" aria-label="Every visitor reads the page."><div>Every visitor</div> <div>reads the page.</div></h1><button aria-label="Close menu">×</button>`,
    );
    const h1 = doc.querySelector("h1") as Element;
    expect(cssCandidates(doc, h1).some((s) => s.includes("aria-label"))).toBe(false);
    expect(cssCandidates(doc, h1)[0]).toBe("h1.rw-title");
    const btn = doc.querySelector("button") as Element;
    expect(cssCandidates(doc, btn)[0]).toBe('button[aria-label="Close menu"]');
  });
});
