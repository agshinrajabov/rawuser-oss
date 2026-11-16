/**
 * Phase 4 of docs/specs/interactive-text.md: candidates chosen by the page's
 * measured wrap (§3.4) and the grammar check on rotating readings (§3.5).
 * The font is synthetic: every character 50 at 100 px, the space 25; at
 * 20 px a character is 10 px, a space 5.
 */
import type { Manifest, VariantBody } from "@rawuser/shared";
import type { WrapMetrics } from "@rawuser/shared/wrap";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MODEL_ENV } from "./model-env.ts";

let answers: string[] = [];
let prompts: string[] = [];
vi.mock("../src/generateVariant.ts", () => ({
  generateVariant: vi.fn(async (input: { prompt: string }) => {
    prompts.push(input.prompt);
    return {
      text: answers.shift() ?? '{"bad":[]}',
      model: "model-a",
      costUsd: 0.0003,
      promptHash: "h",
      cacheHit: false,
      cacheReadTokens: 0,
    };
  }),
}));

const {
  selectByWrap,
  fillTemplates,
  judgeReadings,
  measuredOf,
  checkGrammar,
  promotePassing,
  shortenMissing,
  markEmphasis,
  wrapKnownPhrase,
} = await import("../src/orchestrator.ts");
const { lintVariant, collectNumbers } = await import("../src/lint/index.ts");
const { moreBlock } = await import("../src/prompts/intent-prompts.ts");

beforeEach(() => {
  answers = [];
  prompts = [];
});

const chars: Record<string, number> = { " ": 25 };
for (const c of "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.,") chars[c] = 50;
const width = (w: number, box: number, lines: number) => ({ w, size: 20, box, ls: 0, k: 1, lines });

describe("selectByWrap", () => {
  // The page takes one line at 1280 (box 200) and two on a phone (box 100).
  const metrics: WrapMetrics = {
    v: 1,
    kind: "plain",
    chars,
    widths: [width(1280, 200, 1), width(390, 100, 2)],
  };

  it("keeps the candidates that hold the page's lines, best first, and drops _more", () => {
    const holder: Record<string, unknown> = {
      headline: "Short one",
      headline_alt: "Much too long a headline for the wide screen here",
      headline_alt2: "Short one",
      headline_more: ["Pages that greet why", "Every visit its page", "Nope"],
    };
    selectByWrap({ holder, key: "headline" }, metrics, 20);
    expect(holder.headline_more).toBeUndefined();
    // "Pages that greet why" and "Every visit its page" take 1 line at 200 and 2 at 100.
    expect([holder.headline, holder.headline_alt].sort()).toEqual(
      ["Every visit its page", "Pages that greet why"].sort(),
    );
    // Copies count once.
    const all = [holder.headline, holder.headline_alt, holder.headline_alt2];
    expect(new Set(all).size).toBe(3);
  });

  it("builds a template's word lists before wrapping them, and leaves out a broken one", () => {
    const page = "{s1}Your{/s1} visitors{br}arrive now.";
    const holder: Record<string, unknown> = {
      headline: "{s1}Our{/s1} readers{br}come today.",
      headline_more: [["Every", "visitor", "lands here."], ["no"]],
    };
    const tm: WrapMetrics = { ...metrics, kind: "template", widths: [width(1280, 400, 2)] };
    selectByWrap({ holder, key: "headline" }, tm, 30, page);
    const kept = [holder.headline, holder.headline_alt, holder.headline_alt2].filter(Boolean);
    expect(kept).toContain("{s1}Every{/s1} visitor{br}lands here.");
    expect(kept.every((t) => String(t).includes("{br}"))).toBe(true);
  });

  it("fillTemplates runs it for a measured plain headline and never ships _more", () => {
    const manifest: Manifest = {
      "hero.headline": {
        css: ["h1"],
        text: [],
        structural: "h1",
        original_char_length: 20,
        metrics,
      },
    };
    const sections: Record<string, unknown> = {
      hero: { kind: "hero", headline: "Nope", headline_more: ["Pages that greet why"] },
    };
    fillTemplates(sections, manifest);
    const hero = sections.hero as Record<string, unknown>;
    expect(hero.headline).toBe("Pages that greet why");
    expect(hero.headline_more).toBeUndefined();
    expect(measuredOf(manifest).has("hero.headline")).toBe(true);
  });
});

describe("lint leaves the character caps to the simulation for a measured part", () => {
  it("does not flag a headline over 1.25x of the page when its wrap was chosen", () => {
    const body = {
      customer_id: "c",
      profile_key: "intent:brand",
      generated_at: 1,
      prompt_hash: "",
      sections: { hero: { kind: "hero", headline: "A much longer headline than the page had" } },
    } as unknown as VariantBody;
    const ctx = {
      language: "en",
      allowedNumbers: collectNumbers(["none"]),
      originalLengths: new Map([["hero.headline", 12]]),
    };
    const rules = (r: { hard: { rule: string }[]; soft: { rule: string }[] }) =>
      [...r.hard, ...r.soft].map((f) => f.rule);
    expect(rules(lintVariant(body, ctx))).toContain("length-drift");
    expect(
      rules(lintVariant(body, { ...ctx, simulated: new Set(["hero.headline"]) })),
    ).not.toContain("length-drift");
  });
});

describe("the grammar check", () => {
  const PAGE = "Choose what they can {rot:read|buy}.";
  const manifest: Manifest = {
    "hero.headline": {
      css: ["h1"],
      text: [],
      structural: "h1",
      inline: { icons: "none", emphasis: 0, split: true, animated_text: false, template: PAGE },
    },
  };
  const call = {
    model: "model-a" as const,
    cachedPreamble: "",
    env: MODEL_ENV as never,
    intentDim: "brand" as const,
    customerId: "c",
    manifest,
  };
  const body = (hero: Record<string, unknown>) =>
    ({ sections: { hero: { kind: "hero", ...hero } } }) as unknown as VariantBody;

  it("reads every sentence a visitor will see, one per rotating word per length", async () => {
    answers = ['{"bad":[4]}'];
    const r = await judgeReadings(
      body({
        headline: "Pick what they can {rot:read|buy}.",
        headline_alt: "Greets them {rot:read|buy}.",
      }),
      call,
      "en",
    );
    expect(prompts[0]).toContain("1. Pick what they can read.");
    expect(prompts[0]).toContain("4. Greets them buy.");
    expect(r?.bad.map((b) => [b.suffix, b.text])).toEqual([["_alt", "Greets them buy."]]);
    expect(r?.cost).toBe(0.0003);
  });

  it("puts a length that reads well first when the first reads badly, and fails when none does", async () => {
    const out = (hero: Record<string, unknown>) => ({
      body: body(hero),
      result: {} as never,
      hard: [],
      soft: [],
      extraCost: 0,
      cacheHit: false,
    });
    // One judge call allowed, no revise: reading 1 ("… read.") and 2 of the first are bad.
    answers = ['{"bad":[1,2]}'];
    let calls = 0;
    const once = () => ++calls <= 1;
    const ctx = { language: "en", allowedNumbers: new Set<string>() };
    const promoted = await checkGrammar(
      out({ headline: "Greets them {rot:read|buy}.", headline_alt: "Lets them {rot:read|buy}." }),
      ctx,
      call,
      once,
    );
    const hero = promoted.body.sections.hero as unknown as Record<string, unknown>;
    expect(promoted.hard).toHaveLength(0);
    expect(hero.headline).toBe("Lets them {rot:read|buy}.");
    expect(hero.headline_alt).toBeUndefined();
    expect(promoted.extraCost).toBe(0.0003);
    answers = ['{"bad":[1]}'];
    calls = 0;
    const failed = await checkGrammar(
      out({ headline: "Greets them {rot:read|buy}." }),
      ctx,
      call,
      once,
    );
    expect(failed.hard.map((f) => f.rule)).toEqual(["rotator-grammar"]);
  });

  it("makes no call when no part rotates", async () => {
    const r = await judgeReadings(body({ headline: "Plain" }), { ...call, manifest: {} }, "en");
    expect(r).toBeNull();
    expect(prompts).toHaveLength(0);
  });
});

describe("the prompt asks a measured headline for more candidates", () => {
  it("names the _more path, as sentences or as word lists", () => {
    const m: WrapMetrics = { v: 1, kind: "plain", chars, widths: [width(1280, 200, 1)] };
    expect(
      moreBlock({ "hero.headline": { css: ["h1"], text: [], structural: "h1", metrics: m } }),
    ).toContain("hero.headline_more: three more sentences");
    expect(moreBlock({ "hero.headline": { css: ["h1"], text: [], structural: "h1" } })).toBe("");
  });
});

describe("one safely short length among the three kept (docs/decisions/0031)", () => {
  const metrics: WrapMetrics = { v: 1, kind: "plain", chars, widths: [width(1280, 2000, 1)] };
  it("brings the best short candidate into the third slot when the two best are not short", () => {
    const holder: Record<string, unknown> = {
      headline: "Every visitor reads their own page",
      headline_alt: "Every visitor reads the page for them",
      headline_alt2: "Every visitor gets a page of their own",
      headline_more: ["Pages that fit", "Each visitor sees a page written for why", "Nope"],
    };
    selectByWrap({ holder, key: "headline" }, metrics, 38);
    const kept = [holder.headline, holder.headline_alt, holder.headline_alt2].map(String);
    expect(kept.some((t) => t.length <= 38 * 0.88)).toBe(true);
    // The two best by the simulation stay first.
    expect(kept[0]?.length).toBeGreaterThan(33);
  });
});

describe("spares: the candidates ranked below the three kept", () => {
  const PAGE = "Choose what they can {rot:read|buy}.";
  const metrics: WrapMetrics = {
    v: 1,
    kind: "template",
    chars,
    widths: [{ w: 1280, size: 20, box: 1000, ls: 0, k: 1, lines: 1 }],
  };
  const manifest: Manifest = {
    "hero.headline": {
      css: ["h1"],
      text: [],
      structural: "h1",
      inline: { icons: "none", emphasis: 0, split: true, animated_text: false, template: PAGE },
      metrics,
    },
  };
  const call = {
    model: "model-a" as const,
    cachedPreamble: "",
    env: MODEL_ENV as never,
    intentDim: "brand" as const,
    customerId: "c",
    manifest,
  };
  const make = () => {
    const sections: Record<string, unknown> = {
      hero: {
        kind: "hero",
        headline: ["Greets them"],
        headline_alt: ["Lets them"],
        headline_alt2: ["Tells them"],
        headline_more: [["Pick what they can"], ["Choose what you can"], ["See what they can"]],
      },
    };
    fillTemplates(sections, manifest);
    return { sections } as unknown as VariantBody;
  };

  it("a spare that reads well takes the first place when every kept length reads badly", async () => {
    const body = make();
    const hero = body.sections.hero as unknown as Record<string, unknown>;
    const kept = [hero.headline, hero.headline_alt, hero.headline_alt2];
    // Judge every reading of the three kept as bad (2 readings each), spares good.
    answers = ['{"bad":[1,2,3,4,5,6]}'];
    const out = await checkGrammar(
      { body, result: {} as never, hard: [], soft: [], extraCost: 0, cacheHit: false },
      { language: "en", allowedNumbers: new Set<string>() },
      call,
      () => true,
    );
    expect(out.hard).toHaveLength(0);
    expect(kept).not.toContain(hero.headline);
    // The simulation kept the two closest to the page's length and one safely
    // short (docs/decisions/0031); the best spare took the first place.
    expect(String(kept[2])).toMatch(/^Greets them/);
    expect(String(hero.headline)).toBe("See what they can {rot:read|buy}.");
    // Judged in one call; no revise.
    expect(prompts).toHaveLength(1);
  });

  it("a first length the lint turns down is replaced by a passing one before any revise", () => {
    const body = make();
    const hero = body.sections.hero as unknown as Record<string, unknown>;
    const ctx = {
      language: "en",
      allowedNumbers: collectNumbers(["none"]),
      templates: new Map([["hero.headline", PAGE]]),
      simulated: new Set(["hero.headline"]),
    };
    // "They greet read" dangles (a verb no verb follows, before the rotating word).
    hero.headline = "They greet {rot:read|buy}.";
    const r = promotePassing(body, ctx, manifest);
    expect(r.hard.filter((f) => f.path === "hero.headline")).toHaveLength(0);
    expect(hero.headline).not.toBe("They greet {rot:read|buy}.");
  });
});

describe("a part left without a short length gets one targeted call (docs/decisions/0031)", () => {
  const call = {
    model: "model-a" as const,
    cachedPreamble: "",
    env: MODEL_ENV as never,
    intentDim: "brand" as const,
    customerId: "c",
    manifest: {},
  };
  const para = (n: number) =>
    `${"word "
      .repeat(Math.ceil(n / 5))
      .slice(0, n - 1)
      .trim()}.`;
  const ctx = {
    language: "en",
    allowedNumbers: collectNumbers(["none"]),
    originalLengths: new Map([["hero.body", 140]]),
  };

  it("asks for the same idea in at most 90% and puts it in the short slot, telling a second try how long the first came back", async () => {
    const body = {
      sections: {
        hero: { kind: "hero", body: para(150), body_alt: para(145), body_alt2: para(155) },
      },
    } as unknown as VariantBody;
    const first = lintVariant(body, ctx);
    expect(first.soft.some((f) => f.rule === "short-missing")).toBe(true);
    answers = [JSON.stringify({ text: para(130) }), JSON.stringify({ text: para(120) })];
    const out = await shortenMissing(
      { body, result: {} as never, hard: [], soft: first.soft, extraCost: 0, cacheHit: false },
      ctx,
      call,
      () => true,
    );
    const hero = out.body.sections.hero as unknown as Record<string, string>;
    expect(hero.body_alt?.length).toBe(120);
    expect(prompts[0]).toContain("at most 126 characters");
    expect(prompts[1]).toContain("Last time it came back at 130 characters; at most 126.");
    expect(out.soft.some((f) => f.rule === "short-missing")).toBe(false);
    expect(out.extraCost).toBeCloseTo(0.0006);
  });

  it("puts the asterisks back when the short text kept the emphasised phrase word for word", async () => {
    const hctx = {
      ...ctx,
      originalLengths: new Map([["hero.headline", 40]]),
      emphasisSlots: new Set(["hero.headline"]),
    };
    const body = {
      sections: {
        hero: {
          kind: "hero",
          headline: "We answer the whole question before *building.*",
          headline_alt: "We answer every single question before *building.*",
          headline_alt2: "We settle the argument before *building.*",
        },
      },
    } as unknown as VariantBody;
    answers = [JSON.stringify({ text: "We answer before building." })];
    const out = await shortenMissing(
      {
        body,
        result: {} as never,
        hard: [],
        soft: lintVariant(body, hctx).soft,
        extraCost: 0,
        cacheHit: false,
      },
      hctx,
      call,
      () => true,
    );
    const hero = out.body.sections.hero as unknown as Record<string, string>;
    expect(hero.headline_alt2).toBe("We answer before *building.*");
    expect(prompts[0]).toContain("with its asterisks");
  });

  it("makes no call when every part has a short length", async () => {
    const body = {
      sections: { hero: { kind: "hero", body: para(140), body_alt: para(120) } },
    } as unknown as VariantBody;
    const out = await shortenMissing(
      {
        body,
        result: {} as never,
        hard: [],
        soft: lintVariant(body, ctx).soft,
        extraCost: 0,
        cacheHit: false,
      },
      ctx,
      call,
      () => true,
    );
    expect(prompts).toHaveLength(0);
    expect(out.body).toBe(body);
  });
});

describe("every length of an emphasised part carries its *phrase* (2026-09-30)", () => {
  const call = {
    model: "model-a" as const,
    cachedPreamble: "",
    env: MODEL_ENV as never,
    intentDim: "brand" as const,
    customerId: "c",
    manifest: {} as Manifest,
  };
  const ctx = {
    language: "en",
    allowedNumbers: collectNumbers(["none"]),
    emphasisSlots: new Set(["hero.headline"]),
  };
  const outcome = (body: VariantBody, c: Parameters<typeof lintVariant>[1] = ctx) => ({
    body,
    result: {} as never,
    hard: [],
    soft: lintVariant(body, c).soft,
    extraCost: 0,
    cacheHit: false,
  });
  const heroOf = (body: VariantBody) => body.sections.hero as unknown as Record<string, string>;

  it("wraps another length's phrase by code, with no call, and the flag is gone", async () => {
    const body = {
      sections: {
        hero: {
          kind: "hero",
          headline: "Pages that answer *why they came*",
          headline_alt: "Why they came decides the page each visitor reads",
          headline_alt2: "Pages for why they came",
        },
      },
    } as unknown as VariantBody;
    const first = outcome(body);
    expect(first.soft.filter((f) => f.rule === "emphasis-missing")).toHaveLength(2);
    const out = await markEmphasis(first, ctx, call, () => true);
    expect(prompts).toHaveLength(0);
    // Mid-sentence by exact match; at the start of a sentence by case, on its own characters.
    expect(heroOf(out.body).headline_alt2).toBe("Pages for *why they came*");
    expect(heroOf(out.body).headline_alt).toBe(
      "*Why they came* decides the page each visitor reads",
    );
    expect(out.soft.some((f) => f.rule === "emphasis-missing")).toBe(false);
    expect(out.extraCost).toBe(0);
  });

  it("never wraps a match inside a longer word", () => {
    expect(wrapKnownPhrase("Restart the build", ["art"], "en")).toBeNull();
    expect(wrapKnownPhrase("Art for the build", ["art"], "en")).toBe("*Art* for the build");
  });

  it("asks once when no other length's phrase is in the text, and keeps a clean answer", async () => {
    const body = {
      sections: {
        hero: {
          kind: "hero",
          headline: "Pages that answer *why they came*",
          headline_alt: "Every visitor reads the page made for their question",
        },
      },
    } as unknown as VariantBody;
    answers = [JSON.stringify({ text: "Every visitor reads the page made for *their question*" })];
    const out = await markEmphasis(outcome(body), ctx, call, () => true);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('"Every visitor reads the page made for their question"');
    expect(prompts[0]).toContain('"why they came"');
    expect(heroOf(out.body).headline_alt).toBe(
      "Every visitor reads the page made for *their question*",
    );
    expect(out.soft.some((f) => f.rule === "emphasis-missing")).toBe(false);
    expect(out.extraCost).toBeCloseTo(0.0003);
  });

  it("refuses an answer that changed the text, tells the second try, and keeps the second", async () => {
    const body = {
      sections: {
        hero: {
          kind: "hero",
          headline: "Pages that answer *why they came*",
          headline_alt: "Every visitor reads the page made for their question",
        },
      },
    } as unknown as VariantBody;
    answers = [
      JSON.stringify({ text: "Each visitor reads the page made for *their question*" }),
      JSON.stringify({ text: "Every visitor reads *the page* made for their question" }),
    ];
    const out = await markEmphasis(outcome(body), ctx, call, () => true);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Last time the text itself changed");
    expect(heroOf(out.body).headline_alt).toBe(
      "Every visitor reads *the page* made for their question",
    );
    expect(out.extraCost).toBeCloseTo(0.0006);
  });

  it("leaves the length as it was after two misses", async () => {
    const body = {
      sections: {
        hero: {
          kind: "hero",
          headline: "Pages that answer *why they came*",
          headline_alt: "Every visitor reads the page made for their question",
        },
      },
    } as unknown as VariantBody;
    answers = [
      JSON.stringify({ text: "*Every* visitor reads the page made for *their question*" }),
      JSON.stringify({ text: "Every visitor reads the page made for their question" }),
    ];
    const out = await markEmphasis(outcome(body), ctx, call, () => true);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Last time it had 4 asterisks");
    expect(heroOf(out.body).headline_alt).toBe(
      "Every visitor reads the page made for their question",
    );
    expect(out.soft.some((f) => f.rule === "emphasis-missing")).toBe(true);
  });

  it("makes no call and returns the same outcome when no length is missing its marker", async () => {
    const body = {
      sections: {
        hero: {
          kind: "hero",
          headline: "Pages that answer *why they came*",
          headline_alt: "Every visitor reads the page made for *their question*",
        },
      },
    } as unknown as VariantBody;
    const first = outcome(body);
    const out = await markEmphasis(first, ctx, call, () => true);
    expect(prompts).toHaveLength(0);
    expect(out).toBe(first);
  });

  it("skips a part built word by word", async () => {
    const page = "{s1}Your{/s1} visitors{br}arrive now.";
    const manifest = {
      "hero.headline": {
        css: ["h1"],
        text: [],
        structural: "x",
        inline: { icons: "none", emphasis: 1, split: true, animated_text: false, template: page },
      },
    } as unknown as Manifest;
    const body = {
      sections: {
        hero: {
          kind: "hero",
          headline: "{s1}Our{/s1} readers{br}come today.",
          headline_alt: "{s1}Our{/s1} *readers*{br}come today.",
        },
      },
    } as unknown as VariantBody;
    const soft = [
      { path: "hero.headline", rule: "emphasis-missing", excerpt: "", severity: "soft" as const },
    ];
    const first = { body, result: {} as never, hard: [], soft, extraCost: 0, cacheHit: false };
    const out = await markEmphasis(first, ctx, { ...call, manifest }, () => true);
    expect(prompts).toHaveLength(0);
    expect(heroOf(out.body).headline).toBe("{s1}Our{/s1} readers{br}come today.");
  });
});
