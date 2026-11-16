/**
 * New other lengths when a part built word by word came back with the same
 * text in its lengths (the lab, 2026-09-28: three keys with three identical
 * lengths left the snippet's fit check nothing to choose from).
 */
import type { Manifest, VariantBody } from "@rawuser/shared";
import { fillTemplate } from "@rawuser/shared/template";
import { beforeEach, describe, expect, it, vi } from "vitest";

let answer = "";
let calls = 0;
vi.mock("../src/generateVariant.ts", () => ({
  generateVariant: vi.fn(async () => {
    calls++;
    return {
      text: answer,
      model: "model-a",
      costUsd: 0.0003,
      promptHash: "h",
      cacheHit: false,
      cacheReadTokens: 0,
    };
  }),
}));

const { diversifyLengths } = await import("../src/orchestrator.ts");

const PAGE =
  "{s1}Your{/s1} {g1}visitors {s1}already{/s1}{br}{s1}arrive through{/s1} {g2}AI tools.{br}{s2}Choose what they can {rot:read|compare|buy|skip}.{/s2}";
const manifest: Manifest = {
  "hero.headline": {
    css: ["h1"],
    text: [],
    structural: "h1",
    inline: { icons: "none", emphasis: 0, split: true, animated_text: false, template: PAGE },
  },
};
const BASE = ["Every", "visitor", "already", "arrives through", "a search.", "Pick what they can"];
const LONGER = [
  "Every",
  "single",
  "visitor",
  "now arrives through",
  "a search.",
  "Pick what they can",
];
const SHORTER = ["Most", "visitors", "now", "arrive via", "search.", "Pick what they can"];
const OVER = [
  "Every",
  "visitor",
  "already",
  "arrives through",
  "a search.",
  "Pick exactly what each of them can",
];

const bodyWith = (hero: Record<string, unknown>): VariantBody =>
  ({
    customer_id: "c",
    profile_key: "intent:brand",
    generated_at: 1,
    prompt_hash: "",
    sections: { hero: { kind: "hero", ...hero } },
  }) as unknown as VariantBody;
const call = {
  model: "model-a" as const,
  cachedPreamble: "",
  env: {} as never,
  intentDim: "brand" as const,
  customerId: "c",
  manifest,
};
const hero = (b: VariantBody) => b.sections.hero as unknown as Record<string, unknown>;

beforeEach(() => {
  calls = 0;
});

describe("diversifyLengths", () => {
  it("writes new other lengths when the three are the same text", async () => {
    const same = fillTemplate(PAGE, BASE) as string;
    answer = JSON.stringify({ alt: LONGER, alt2: SHORTER });
    const out = await diversifyLengths(
      bodyWith({ headline: same, headline_alt: same, headline_alt2: same }),
      call,
    );
    expect(calls).toBe(1);
    expect(hero(out?.body as VariantBody).headline).toBe(same);
    expect(hero(out?.body as VariantBody).headline_alt).toBe(fillTemplate(PAGE, LONGER));
    expect(hero(out?.body as VariantBody).headline_alt2).toBe(fillTemplate(PAGE, SHORTER));
    expect(out?.cost).toBeCloseTo(0.0003);
  });

  it("tries twice, then leaves out a length that still breaks the cap or repeats the base", async () => {
    const same = fillTemplate(PAGE, BASE) as string;
    answer = JSON.stringify({ alt: OVER, alt2: BASE });
    const out = await diversifyLengths(bodyWith({ headline: same, headline_alt: same }), call);
    expect(calls).toBe(2);
    const h = hero(out?.body as VariantBody);
    expect(h.headline).toBe(same);
    // Never the same text twice: the copy is gone rather than kept.
    expect(h.headline_alt).toBeUndefined();
    expect(h.headline_alt2).toBeUndefined();
  });

  it("replaces only the length that repeats, and keeps the one that differs", async () => {
    const base = fillTemplate(PAGE, BASE) as string;
    const longer = fillTemplate(PAGE, LONGER) as string;
    answer = JSON.stringify({ alt: LONGER, alt2: SHORTER });
    const out = await diversifyLengths(
      bodyWith({ headline: base, headline_alt: longer, headline_alt2: base }),
      call,
    );
    const h = hero(out?.body as VariantBody);
    expect(h.headline_alt).toBe(longer);
    expect(h.headline_alt2).toBe(fillTemplate(PAGE, SHORTER));
    expect(calls).toBe(1);
  });

  it("makes no call when the three lengths already differ", async () => {
    const out = await diversifyLengths(
      bodyWith({
        headline: fillTemplate(PAGE, BASE),
        headline_alt: fillTemplate(PAGE, LONGER),
        headline_alt2: fillTemplate(PAGE, SHORTER),
      }),
      call,
    );
    expect(calls).toBe(0);
    expect(out).toBeNull();
  });
});
