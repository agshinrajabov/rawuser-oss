/**
 * The readiness check's shared contract (docs/specs/readiness-check.md):
 * the health words table (a count, never a word), the closed `goes` words,
 * the bundle's `ne`, and that neither `goes` nor the answer can reach a
 * browser through the shared builders (privacy review condition 4).
 */
import { describe, expect, it } from "vitest";
import { GOES_WORDS, isGoes } from "../src/readiness.ts";
import {
  HEALTH_HIT_WORDS,
  foldHealthText,
  healthWordHits,
  readsLikeHealth,
} from "../src/special-category/words.ts";
import {
  BUNDLE_NO_EVENTS_SQL,
  bundleNoEventsFields,
  conversionTargetsFromRows,
  visitorBundleFrom,
} from "../src/visitor-bundle.ts";

describe("the health words", () => {
  it("three distinct words read like a health site; two do not", () => {
    expect(HEALTH_HIT_WORDS).toBe(3);
    expect(readsLikeHealth("A clinic where doctors see patients")).toBe(true);
    expect(readsLikeHealth("Our clinic has doctors. Doctors, doctors.")).toBe(false);
    expect(healthWordHits("Our clinic has doctors. Doctors, doctors.")).toBe(2);
    expect(readsLikeHealth("Forms people finish. Start free. See plans.")).toBe(false);
    expect(readsLikeHealth("")).toBe(false);
    expect(readsLikeHealth(null)).toBe(false);
  });

  it("reads Azerbaijani, Russian and Turkish, folded, with stems", () => {
    expect(readsLikeHealth("Qida əlavəsi, vitaminlər və dərmanlar: sağlamlığınız üçün")).toBe(true);
    expect(readsLikeHealth("Клиника: врачи, лечение и диагностика")).toBe(true);
    expect(readsLikeHealth("Sağlık için takviye ve vitamin, eczanede")).toBe(true);
    // A stem takes an ending, not a whole other word.
    expect(healthWordHits("patients")).toBe(1);
    expect(healthWordHits("patientlessnessability")).toBe(0);
  });

  it("whole words only: a word inside another is not a hit", () => {
    expect(healthWordHits("the liverpool match")).toBe(0);
    expect(healthWordHits("the liver")).toBe(1);
  });

  it("folds case, diacritics, ə and ı", () => {
    expect(foldHealthText("Sağlamlıq Dərman")).toBe("saglamliq derman");
  });

  it("returns a number only: no word of the text leaves", () => {
    const n = healthWordHits("clinic doctor patient");
    expect(typeof n).toBe("number");
    expect(n).toBe(3);
  });
});

describe("goes", () => {
  it("is a closed list of seven words", () => {
    expect([...GOES_WORDS]).toEqual([
      "form",
      "contact_link",
      "same_site",
      "start_page",
      "leaves_site",
      "anchor",
      "none",
    ]);
    expect(isGoes("same_site")).toBe(true);
    expect(isGoes("https://x.test/signup")).toBe(false);
    expect(isGoes(null)).toBe(false);
  });
});

describe("the bundle's ne", () => {
  it("is 1 only for a yes that is not marked, else absent (byte for byte as before)", () => {
    expect(bundleNoEventsFields(null)).toEqual({});
    expect(bundleNoEventsFields(undefined)).toEqual({});
    expect(bundleNoEventsFields({ special_category: null, sensitive: 0 })).toEqual({});
    expect(bundleNoEventsFields({ special_category: 0, sensitive: 0 })).toEqual({});
    expect(bundleNoEventsFields({ special_category: 1, sensitive: 1 })).toEqual({});
    expect(bundleNoEventsFields({ special_category: 1, sensitive: 0 })).toEqual({ ne: 1 });
    expect(bundleNoEventsFields({ special_category: 1 })).toEqual({ ne: 1 });
    expect(BUNDLE_NO_EVENTS_SQL).toMatch(
      /^SELECT special_category, sensitive FROM customers WHERE id = \?$/,
    );
  });

  it("the shared builder itself never sets ne: only the writers' last spread does", () => {
    const b = visitorBundleFrom([], [], null, null, null, null);
    expect(b).not.toHaveProperty("ne");
    expect(JSON.stringify(b)).toBe('{"v":1,"pages":{},"conv":[]}');
  });
});

describe("goes never reaches a browser (condition 4)", () => {
  it("conversionTargetsFromRows drops goes from a row that carries it", () => {
    const rows = [
      {
        section_path: "hero.cta.label",
        conversion_label: "other",
        css_selectors: '["#cta"]',
        text_selectors: '["See products"]',
        structural_selector: "hero link",
        goes: "same_site",
      },
    ];
    const conv = conversionTargetsFromRows(rows);
    expect(conv).toEqual([
      {
        section_path: "hero.cta.label",
        conversion_label: "other",
        css: ["#cta"],
        text: ["See products"],
        structural: "hero link",
      },
    ]);
    expect(JSON.stringify(visitorBundleFrom([], rows))).not.toMatch(/goes|same_site/);
  });
});
