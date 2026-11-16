/**
 * The button switch, shared side (docs/specs/button-rewrite.md): which parts
 * a visitor's browser is given, and that the switch itself never reaches it.
 */
import { describe, expect, it } from "vitest";
import {
  isButtonLabelPath,
  isOffButton,
  rewriteOn,
  writtenManifest,
  writtenSections,
} from "../src/button-rewrite.ts";
import type { ElementTargets, Manifest } from "../src/types.ts";
import {
  type ConversionTargetRow,
  manifestForVisitors,
  visitorBundleFrom,
} from "../src/visitor-bundle.ts";

const part = (css: string, extra: Record<string, unknown> = {}): ElementTargets =>
  ({ css: [css], text: [], structural: css, ...extra }) as ElementTargets;

/** A stored manifest: two buttons off (one never switched, one switched off), one on. */
const STORED: Manifest = {
  "hero.headline": part("h1"),
  "hero.body": part("h1 + p"),
  "hero.cta.label": part("a.hero"),
  "hero.cta.href": part("a.hero"),
  "cta.cta.label": part("a.closing", { rewrite: true }),
  "cta.cta.href": part("a.closing"),
  "forms.submit_label": part("form button", { rewrite: false }),
};

const COUNTED: ConversionTargetRow = {
  section_path: "hero.cta",
  conversion_label: "trial_start",
  css_selectors: JSON.stringify(["a.hero"]),
  text_selectors: JSON.stringify(["Start free"]),
  structural_selector: "a.hero",
};

describe("isButtonLabelPath", () => {
  it("reads the four button slots and nothing else", () => {
    for (const path of [
      "hero.cta.label",
      "cta.cta.label",
      "pricing.cta.label",
      "forms.submit_label",
    ]) {
      expect(isButtonLabelPath(path), path).toBe(true);
    }
    for (const path of [
      "hero.headline",
      "hero.body",
      "hero.cta.href",
      "features.headline",
      "label",
      "hero.label_text",
      "forms.submit_label.href",
    ]) {
      expect(isButtonLabelPath(path), path).toBe(false);
    }
  });
});

describe("the switch", () => {
  it("is on only for exactly true", () => {
    expect(rewriteOn(part("a", { rewrite: true }))).toBe(true);
    for (const v of [false, "true", 1, null, undefined, {}, "on"]) {
      expect(rewriteOn(part("a", { rewrite: v })), String(v)).toBe(false);
    }
    expect(rewriteOn(part("a"))).toBe(false);
    expect(rewriteOn(undefined)).toBe(false);
    expect(rewriteOn(null)).toBe(false);
  });

  it("means nothing on a part that is not a button", () => {
    expect(isOffButton("hero.headline", part("h1"))).toBe(false);
    expect(isOffButton("hero.headline", part("h1", { rewrite: false }))).toBe(false);
    expect(isOffButton("hero.cta.label", part("a"))).toBe(true);
    expect(isOffButton("hero.cta.label", part("a", { rewrite: true }))).toBe(false);
  });
});

describe("writtenManifest", () => {
  it("leaves out the buttons that are off, with the link path of such a button", () => {
    expect(Object.keys(writtenManifest(STORED))).toEqual([
      "hero.headline",
      "hero.body",
      "cta.cta.label",
      "cta.cta.href",
    ]);
  });

  it("never changes the stored manifest, and twice is once", () => {
    const before = JSON.stringify(STORED);
    const once = writtenManifest(STORED);
    expect(JSON.stringify(STORED)).toBe(before);
    expect(writtenManifest(once)).toEqual(once);
    // The entries are the stored ones, switch and all: this removes parts, not fields.
    expect(once["cta.cta.label"]).toBe(STORED["cta.cta.label"]);
  });

  it("a manifest from before the switch reads as every button off", () => {
    const old: Manifest = {
      "hero.headline": part("h1"),
      "hero.cta.label": part("a.cta"),
      "pricing.cta.label": part("a.buy"),
    };
    expect(Object.keys(writtenManifest(old))).toEqual(["hero.headline"]);
  });

  it("an href whose label is not in the manifest stays", () => {
    const m: Manifest = { "hero.headline": part("h1"), "hero.cta.href": part("a") };
    expect(Object.keys(writtenManifest(m))).toEqual(["hero.headline", "hero.cta.href"]);
  });
});

describe("manifestForVisitors", () => {
  it("drops the wrap measurement and the switch, and keeps what the snippet reads", () => {
    const m: Manifest = {
      "hero.headline": part("h1", {
        metrics: { v: 1 },
        original_char_length: 30,
        inline: { icons: "none", emphasis: 0, split: false, animated_text: false },
        skip: true,
      }),
      "cta.cta.label": part("a.closing", { rewrite: true, plain: true }),
    };
    const out = manifestForVisitors(m);
    expect(out["hero.headline"]).toEqual({
      css: ["h1"],
      text: [],
      structural: "h1",
      original_char_length: 30,
      inline: { icons: "none", emphasis: 0, split: false, animated_text: false },
      skip: true,
    });
    expect(out["cta.cta.label"]).toEqual({
      css: ["a.closing"],
      text: [],
      structural: "a.closing",
      plain: true,
    });
    expect(JSON.stringify(out)).not.toContain("rewrite");
    expect(JSON.stringify(out)).not.toContain("metrics");
    // The stored manifest keeps both.
    expect(m["cta.cta.label"]?.rewrite).toBe(true);
    expect(m["hero.headline"]?.metrics).toBeDefined();
  });

  it("removes fields, never parts: an off button handed to it comes back", () => {
    expect(Object.keys(manifestForVisitors(STORED))).toEqual(Object.keys(STORED));
  });
});

describe("visitorBundleFrom knows the switch", () => {
  const bundle = visitorBundleFrom([{ page_path: "/", manifest: STORED }], [COUNTED], 20);

  it("an off button is not a page target; an on button is, without its switch", () => {
    expect(Object.keys(bundle.pages["/"] ?? {})).toEqual([
      "hero.headline",
      "hero.body",
      "cta.cta.label",
      "cta.cta.href",
    ]);
    expect(bundle.pages["/"]?.["cta.cta.label"]).toEqual({
      css: ["a.closing"],
      text: [],
      structural: "a.closing",
    });
    expect(JSON.stringify(bundle.pages)).not.toContain("rewrite");
  });

  it("a counted button that is off is still in conv, with its own selectors", () => {
    expect(bundle.conv).toEqual([
      {
        section_path: "hero.cta",
        conversion_label: "trial_start",
        css: ["a.hero"],
        text: ["Start free"],
        structural: "a.hero",
      },
    ]);
    expect(bundle.h).toBe(20);
  });

  it("rows a caller already filtered give the same bundle (generation's writtenRows)", () => {
    const filtered = visitorBundleFrom(
      [{ page_path: "/", manifest: writtenManifest(STORED) }],
      [COUNTED],
      20,
    );
    expect(filtered).toEqual(bundle);
  });

  it("a page whose every part is an off button stays in the bundle with no targets", () => {
    const only = visitorBundleFrom(
      [
        { page_path: "/", manifest: STORED },
        { page_path: "/contact", manifest: { "forms.submit_label": part("form button") } },
      ],
      [],
      null,
    );
    // The page is still a confirmed page (an empty manifest claims nothing).
    expect(only.pages["/contact"]).toEqual({});
  });

  it("the caller's rows are not changed", () => {
    const rows = [{ page_path: "/", manifest: STORED }];
    const before = JSON.stringify(rows);
    visitorBundleFrom(rows, [COUNTED], null);
    expect(JSON.stringify(rows)).toBe(before);
  });
});

describe("writtenSections: the words of a button that is off are not handed out (H9)", () => {
  /** What a browser's page is given for STORED: the hero and form buttons are off. */
  const WRITTEN = manifestForVisitors(writtenManifest(STORED));

  /** A version written while every button was rewritten, with every length. */
  const body = () => ({
    hero: {
      kind: "hero",
      headline: "A headline for this visit",
      headline_alt: "A longer headline for this visit",
      headline_alt2: "A headline",
      body: "A paragraph that says why.",
      cta: {
        label: "Tell us your problem",
        label_alt: "Tell us about your problem",
        label_alt2: "Tell us",
        href: "/contact",
      },
    },
    cta: {
      kind: "cta",
      headline: "Ready?",
      cta: { label: "See how it works", label_alt: "See it work", href: "/how" },
    },
    forms: { kind: "forms", submit_label: "Send it", submit_label_alt: "Send" },
  });

  function freeze<T>(value: T): T {
    if (value && typeof value === "object") {
      for (const v of Object.values(value)) freeze(v);
      Object.freeze(value);
    }
    return value;
  }

  it("an off button loses its label, its other lengths and its link; its empty holder goes", () => {
    const out = writtenSections(body(), WRITTEN) as Record<string, unknown>;
    expect(out.hero).toEqual({
      kind: "hero",
      headline: "A headline for this visit",
      headline_alt: "A longer headline for this visit",
      headline_alt2: "A headline",
      body: "A paragraph that says why.",
    });
    // The form's button was the section's only part: nothing left to write.
    expect(out.forms).toBeUndefined();
    const text = JSON.stringify(out);
    for (const gone of ["Tell us", "/contact", "Send"]) expect(text).not.toContain(gone);
  });

  it("an on button keeps every word and its link, and the other parts are untouched", () => {
    const stored = body();
    const out = writtenSections(stored, WRITTEN);
    expect(out.cta).toEqual(stored.cta);
    // Untouched means the very object, not a copy of it.
    expect(out.cta).toBe(stored.cta);
    expect(Object.keys(out)).toEqual(["hero", "cta"]);
    expect(Object.keys(out.hero)).toEqual([
      "kind",
      "headline",
      "headline_alt",
      "headline_alt2",
      "body",
    ]);
  });

  it("a body without the label is the same object, and every button on changes nothing", () => {
    const plain = freeze({ hero: { kind: "hero", headline: "A headline" }, cta: body().cta });
    expect(writtenSections(plain, WRITTEN)).toBe(plain);
    const all = freeze(body());
    const everyButton = {
      ...WRITTEN,
      "hero.cta.label": part("a.hero"),
      "forms.submit_label": part("form button"),
    };
    expect(writtenSections(all, everyButton)).toBe(all);
  });

  it("the stored body is never changed", () => {
    const stored = freeze(body());
    const out = writtenSections(stored, WRITTEN);
    expect(out).not.toBe(stored);
    expect(stored).toEqual(body());
  });

  it("the link goes with the label, unless the manifest lists the link as a part of its own", () => {
    // On: the label is written, so the link beside it stays, listed or not.
    const on = { "hero.cta.label": part("a") };
    const sections = { hero: { kind: "hero", cta: { label: "Start", href: "/start" } } };
    expect(writtenSections(sections, on)).toBe(sections);
    // Off, the link not a part: both go.
    expect(writtenSections(sections, { "hero.headline": part("h1") })).toEqual({});
    // A manifest that lists the link alone (it never had the label): the link stays.
    expect(writtenSections(sections, { "hero.cta.href": part("a") })).toEqual({
      hero: { kind: "hero", cta: { href: "/start" } },
    });
  });

  it("a page whose manifest has no part at all hands out no button's words", () => {
    const out = writtenSections(body(), {}) as Record<string, unknown>;
    expect(out).toEqual({
      hero: {
        kind: "hero",
        headline: "A headline for this visit",
        headline_alt: "A longer headline for this visit",
        headline_alt2: "A headline",
        body: "A paragraph that says why.",
      },
      cta: { kind: "cta", headline: "Ready?" },
    });
  });

  it("only a button's path is read: a headline that ends like one, a list, a stray value", () => {
    const sections = {
      hero: { kind: "hero", headline: "label", labels: "not a button", items: [{ label: "x" }] },
      n: 3,
      none: null,
    };
    expect(writtenSections(sections, {})).toBe(sections);
    // A name every object carries is not a part of the manifest.
    const odd = { constructor: { label: "x" }, hero: { kind: "hero", headline: "h" } };
    expect(writtenSections(odd, {})).toEqual({ hero: { kind: "hero", headline: "h" } });
    // What is not a sections object comes back as it is.
    for (const v of [null, undefined, "text", 7, [{ label: "x" }]]) {
      expect(writtenSections(v, {})).toBe(v);
    }
  });
});
