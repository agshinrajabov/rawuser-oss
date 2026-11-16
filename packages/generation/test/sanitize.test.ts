import type { VariantBody } from "@rawuser/shared";
import { describe, expect, it } from "vitest";
import { sanitizeString, sanitizeVariantBody } from "../src/sanitize.ts";

describe("sanitizeString", () => {
  it("replaces em-dash with comma in mid-clause position (Azerbaijani case from friction log)", () => {
    expect(sanitizeString("Real karyera — düşüncə öyrəd")).toBe("Real karyera, düşüncə öyrəd");
  });

  it("replaces en-dash with comma", () => {
    expect(sanitizeString("Start now – free trial")).toBe("Start now, free trial");
  });

  it("handles em-dash without surrounding spaces", () => {
    expect(sanitizeString("foo—bar")).toBe("foo, bar");
  });

  it("handles multiple em-dashes in one string", () => {
    expect(sanitizeString("A — B — C")).toBe("A, B, C");
  });

  it("preserves strings with no dashes", () => {
    expect(sanitizeString("clean sentence with no dashes.")).toBe("clean sentence with no dashes.");
  });

  it("collapses accidental double commas after replacement", () => {
    expect(sanitizeString("X, — Y")).toBe("X, Y");
  });

  it("trims leading/trailing whitespace", () => {
    expect(sanitizeString("  hello  ")).toBe("hello");
  });
});

describe("sanitizeVariantBody", () => {
  function makeVariant(): VariantBody {
    return {
      customer_id: "test",
      profile_key: "intent:competitor",
      sections: {
        hero: {
          kind: "hero",
          headline: "Real karyera — düşüncə öyrəd",
          body: "Burada — daha doğrusu — sənə həqiqi mentor lazımdır.",
          cta: {
            label: "İndi başla — pulsuz",
            href: "#enroll",
          },
        },
        cta: {
          kind: "cta",
          headline: "Hazırsan?",
          cta: {
            label: "Qoş — bu gün",
            href: "#start",
          },
        },
      },
      generated_at: 1000,
      prompt_hash: "abc",
    };
  }

  it("recursively strips em-dashes from all leaf string fields", () => {
    const out = sanitizeVariantBody(makeVariant());
    const hero = out.sections.hero as { headline: string; body: string; cta: { label: string } };
    expect(hero.headline).toBe("Real karyera, düşüncə öyrəd");
    expect(hero.body).toBe("Burada, daha doğrusu, sənə həqiqi mentor lazımdır.");
    expect(hero.cta.label).toBe("İndi başla, pulsuz");
    const cta = out.sections.cta as { cta: { label: string } };
    expect(cta.cta.label).toBe("Qoş, bu gün");
  });

  it("does not mutate the input variant", () => {
    const input = makeVariant();
    const before = JSON.stringify(input);
    sanitizeVariantBody(input);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("preserves non-string metadata fields", () => {
    const out = sanitizeVariantBody(makeVariant());
    expect(out.customer_id).toBe("test");
    expect(out.profile_key).toBe("intent:competitor");
    expect(out.generated_at).toBe(1000);
    expect(out.prompt_hash).toBe("abc");
  });

  it("leaves href untouched (URLs may legitimately contain dashes, though em-dashes in URLs are exceedingly rare)", () => {
    const v = makeVariant();
    const out = sanitizeVariantBody(v);
    const hero = out.sections.hero as { cta: { href: string } };
    expect(hero.cta.href).toBe("#enroll");
  });
});
