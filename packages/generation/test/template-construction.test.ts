/**
 * Construction (docs/specs/template-writing.md §4.2): the model writes a
 * word list per run, code places every token. The second lab run
 * (2026-09-28) showed blanks and asked for a template: 0 of 19 kept it.
 */
import type { Manifest, VariantBody } from "@rawuser/shared";
import { fillTemplate, templateEntries, templateSlots } from "@rawuser/shared/template";
import { describe, expect, it } from "vitest";
import { collectNumbers, lintVariant } from "../src/lint/index.ts";
import { keepBuiltTemplates, parseAndValidate, withTemplateEntries } from "../src/orchestrator.ts";

const PAGE =
  "{s1}Your{/s1} {g1}visitors {s1}already{/s1}{br}{s1}arrive through{/s1} {g2}AI tools.{br}{s2}Choose what they can {rot:read|compare|buy|skip}.{/s2}";

const manifest: Manifest = {
  "hero.headline": {
    css: ["h1"],
    text: [],
    structural: "h1",
    original_char_length: 76,
    inline: { icons: "none", emphasis: 0, split: true, animated_text: false, template: PAGE },
  },
};

describe("templateSlots", () => {
  it("lists the runs and the rotating slot by line; a capital counts only at a sentence start", () => {
    const slots = templateSlots(PAGE);
    expect(
      slots.map((s) => (s.kind === "run" ? `${s.line}:${s.words}` : `${s.line}:rot${s.n}`)),
    ).toEqual(["0:1", "0:1", "0:1", "1:2", "1:2", "2:4", "2:rot4"]);
    // "AI tools" starts with a capital but inside a sentence; "Choose" after a full stop.
    expect(slots.map((s) => s.kind === "run" && s.capital)).toEqual([
      true,
      false,
      false,
      false,
      false,
      true,
      false,
    ]);
  });
});

describe("fillTemplate", () => {
  it("places the page's tokens around the version's words", () => {
    expect(
      fillTemplate(PAGE, [
        "You",
        "pay",
        "for",
        "traffic that",
        "leaves fast.",
        "Most of them",
        ["bounce", "stall", "go", "quit"],
      ]),
    ).toBe(
      "{s1}You{/s1} {g1}pay {s1}for{/s1}{br}{s1}traffic that{/s1} {g2}leaves fast.{br}{s2}Most of them {rot:read|compare|buy|skip}.{/s2}",
    );
  });

  it("lets the version carry a sentence past the page's full stop, and adds nothing before the rotating word", () => {
    expect(
      fillTemplate(PAGE, [
        "every",
        "page",
        "here",
        "was written",
        "for one kind",
        "of visitor who is.",
        ["new.", "back", "lost", "ready"],
      ]),
    ).toBe(
      "{s1}Every{/s1} {g1}page {s1}here{/s1}{br}{s1}was written{/s1} {g2}for one kind{br}{s2}of visitor who is {rot:read|compare|buy|skip}.{/s2}",
    );
  });

  it("deals a list cut at other places to the runs by the page's word counts", () => {
    // The lab trial: one word per string, eight entries for seven runs.
    const filled = fillTemplate(PAGE, [
      "One",
      "snippet",
      "serves",
      "thirty",
      "versions",
      "written",
      "for",
      ["intent", "reason", "context", "purpose"],
    ]);
    // Eleven page words, seven written: the longest runs give theirs up first.
    expect(filled).toBe(
      "{s1}One{/s1} {g1}snippet {s1}serves{/s1}{br}{s1}thirty{/s1} {g2}versions{br}{s2}written for {rot:read|compare|buy|skip}.{/s2}",
    );
    expect(filled).not.toBeNull();
    // Every run has at least one word and the tokens are the page's.
    expect(templateEntries(PAGE, filled as string)).not.toBeNull();
  });

  it("keeps the page's rotating words whatever the list says, and refuses fewer words than runs", () => {
    // The founder's call (2026-09-28, spec §7.2): the rotating words are the page's own.
    expect(fillTemplate(PAGE, ["a", "b", "c", "d e", "f g", "h i j k", ["x", "y", "z"]])).toContain(
      "h i j k {rot:read|compare|buy|skip}",
    );
    expect(fillTemplate(PAGE, ["a", "b", "c", "d e", "f g", "h i j k"])).toContain(
      "h i j k {rot:read|compare|buy|skip}",
    );
    expect(fillTemplate(PAGE, ["a", "b", ["w", "x", "y", "z"]])).toBeNull();
    expect(fillTemplate(PAGE, "a plain sentence")).toBeNull();
  });

  it("gives the revise pass the list back, and the list builds the same template", () => {
    const tpl = fillTemplate(PAGE, [
      "You",
      "pay",
      "for",
      "traffic that",
      "leaves fast.",
      "Most of them",
      ["bounce", "stall", "go", "quit"],
    ]) as string;
    const entries = templateEntries(PAGE, tpl);
    expect(entries).toEqual(["You", "pay", "for", "traffic that", "leaves fast", "Most of them"]);
    // The list drops the stop at the run's end; building it again puts it back.
    expect(fillTemplate(PAGE, entries)).toBe(tpl);
  });
});

const body = (headline: unknown, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    customer_id: "c",
    profile_key: "intent:brand",
    generated_at: 1,
    prompt_hash: "",
    sections: {
      hero: {
        kind: "hero",
        headline,
        body: "Hero body",
        cta: { label: "Go", href: "#go" },
        ...extra,
      },
      features: { kind: "features", headline: "Features", body: "Features body" },
      social_proof: { kind: "social_proof", headline: "Proof", body: "Proof body" },
      pricing: { kind: "pricing", headline: "Pricing", body: "Pricing body" },
      cta: { kind: "cta", headline: "CTA", cta: { label: "Enroll", href: "#enroll" } },
    },
  });

const LIST = [
  "You",
  "pay",
  "for",
  "traffic that",
  "leaves fast.",
  "Most of them",
  ["bounce", "stall", "go", "quit"],
];

describe("parseAndValidate builds the templates", () => {
  it("turns each length's word list into the page's template", () => {
    const r = parseAndValidate(
      body(LIST, { headline_alt: LIST, headline_alt2: ["bad"] }),
      "brand",
      "c",
      manifest,
    );
    expect(r.ok).toBe(true);
    const hero = (r as { body: VariantBody }).body.sections.hero as unknown as Record<
      string,
      unknown
    >;
    expect(hero.headline).toBe(fillTemplate(PAGE, LIST));
    expect(hero.headline_alt).toBe(fillTemplate(PAGE, LIST));
    // Another length that does not fit is left out, never shipped half built.
    expect(hero.headline_alt2).toBeUndefined();
  });

  it("fails a base list that does not fit instead of shipping half a structure", () => {
    expect(parseAndValidate(body(["bad"]), "brand", "c", manifest).ok).toBe(false);
  });
});

describe("the revise pass edits words, never tokens", () => {
  it("hands the revise pass the word lists and keeps a length it broke", () => {
    const good = JSON.parse(body(fillTemplate(PAGE, LIST))) as VariantBody;
    const shown = withTemplateEntries(good, manifest).sections.hero as unknown as Record<
      string,
      unknown
    >;
    expect(Array.isArray(shown.headline)).toBe(true);
    const broken = JSON.parse(body("You pay for traffic that leaves fast.")) as VariantBody;
    keepBuiltTemplates(good, broken, manifest);
    expect((broken.sections.hero as unknown as Record<string, unknown>).headline).toBe(
      fillTemplate(PAGE, LIST),
    );
  });
});

describe("template-copy on a line", () => {
  const ctx = {
    language: "en",
    allowedNumbers: collectNumbers(["none"]),
    templates: new Map([["hero.headline", PAGE]]),
  };
  const lint = (headline: string) =>
    lintVariant(JSON.parse(body(headline)) as VariantBody, ctx).hard.filter(
      (f) => f.rule === "template-copy",
    );

  it("fails one of the page's own lines kept whole", () => {
    const kept = fillTemplate(PAGE, [
      "Your",
      "buyers",
      "today",
      "arrive through",
      "AI tools.",
      "Most of them",
      ["bounce", "stall", "go", "quit"],
    ]) as string;
    expect(lint(kept)[0]?.excerpt).toBe(
      "line 2 is the page's own line; write this visitor's words",
    );
  });

  it("passes the page's own rotating words: they are kept by design", () => {
    const kept = fillTemplate(PAGE, [
      "You",
      "pay",
      "for",
      "traffic that",
      "leaves fast.",
      "Decide what you can",
    ]) as string;
    expect(kept).toContain("{rot:read|compare|buy|skip}");
    expect(lint(kept)).toEqual([]);
  });

  it("passes new words", () => {
    expect(lint(fillTemplate(PAGE, LIST) as string)).toEqual([]);
  });
});

describe("template-stop and rotator-spread (soft)", () => {
  const ctx = {
    language: "en",
    allowedNumbers: collectNumbers(["none"]),
    templates: new Map([["hero.headline", PAGE]]),
  };
  const soft = (headline: string) =>
    lintVariant(JSON.parse(body(headline)) as VariantBody, ctx).soft.map((f) => f.rule);

  it("flags a sentence that ends at a line's end without its full stop", () => {
    // A template string (a revise pass may return one) with the stops missing.
    const runOn =
      "{s1}You{/s1} {g1}compared {s1}tools{/s1}{br}{s1}Most read{/s1} {g2}who came{br}{s2}Rawuser reads intent {rot:here|now|today|next}.{/s2}";
    expect(soft(runOn)).toContain("template-stop");
    expect(soft(fillTemplate(PAGE, LIST) as string)).not.toContain("template-stop");
  });

  it("flags rotating words far apart in length", () => {
    // A template string (a revise pass may return one) with its own rotating words.
    const wide =
      "{s1}You{/s1} {g1}pay {s1}for{/s1}{br}{s1}traffic that{/s1} {g2}leaves fast.{br}{s2}Most of them {rot:go|stall|quit|vanishing}.{/s2}";
    expect(soft(wide)).toContain("rotator-spread");
    expect(soft(fillTemplate(PAGE, LIST) as string)).not.toContain("rotator-spread");
  });
});

describe("rotator-repeats (hard)", () => {
  it("fails rotating words that are one word", () => {
    const ctx = {
      language: "en",
      allowedNumbers: collectNumbers(["none"]),
      templates: new Map([["hero.headline", PAGE]]),
    };
    const same =
      "{s1}One{/s1} {g1}page {s1}for{/s1}{br}{s1}every visitor{/s1} {g2}wastes it.{br}{s2}It wastes the traffic {rot:you|you|You|you}.{/s2}";
    const hard = lintVariant(JSON.parse(body(same)) as VariantBody, ctx).hard.map((f) => f.rule);
    expect(hard).toContain("rotator-repeats");
  });
});

describe("the stop at a line's end, and a broken other length", () => {
  it("puts the full stop where a line ends a sentence and the next line starts one", () => {
    expect(
      fillTemplate(PAGE, [
        "You",
        "compared",
        "tools",
        "Most read",
        "who came",
        "Rawuser reads intent",
        ["here", "now", "today", "next"],
      ]),
    ).toBe(
      "{s1}You{/s1} {g1}compared {s1}tools.{/s1}{br}{s1}Most read{/s1} {g2}who came.{br}{s2}Rawuser reads intent {rot:read|compare|buy|skip}.{/s2}",
    );
    // A line that carries its sentence on in lower case gets nothing.
    expect(fillTemplate(PAGE, LIST)).toContain("{s1}for{/s1}{br}{s1}traffic that{/s1}");
  });

  it("leaves out another length that arrives as a broken template and keeps the version", () => {
    const r = parseAndValidate(
      body(LIST, { headline_alt: "Your buyers came from AI search." }),
      "brand",
      "c",
      manifest,
    );
    expect(r.ok).toBe(true);
    const hero = (r as { body: VariantBody }).body.sections.hero as unknown as Record<
      string,
      unknown
    >;
    expect(hero.headline_alt).toBeUndefined();
    expect(hero.headline).toBe(fillTemplate(PAGE, LIST));
  });

  it("after a revise, drops another length that is still broken and had no good value", () => {
    const before = JSON.parse(body(fillTemplate(PAGE, LIST))) as VariantBody;
    const after = JSON.parse(
      body(fillTemplate(PAGE, LIST), { headline_alt2: "A plain sentence." }),
    ) as VariantBody;
    keepBuiltTemplates(before, after, manifest);
    expect(
      (after.sections.hero as unknown as Record<string, unknown>).headline_alt2,
    ).toBeUndefined();
  });
});

describe("no stop before a name in capitals or after a small word", () => {
  it("leaves 'through an / AI answer' as one sentence", () => {
    expect(
      fillTemplate(PAGE, [
        "You",
        "found",
        "us",
        "through an",
        "AI answer",
        "about the real",
        ["cost", "price", "spend", "budget"],
      ]),
    ).toContain("{s1}us{/s1}{br}");
    expect(
      fillTemplate(PAGE, [
        "You",
        "found",
        "us",
        "through an",
        "AI answer",
        "about the real",
        ["cost", "price", "spend", "budget"],
      ]),
    ).not.toContain("an.");
    // "us" before "Through" would be a stop; "an" before "AI" is not.
    expect(
      fillTemplate(PAGE, [
        "Your",
        "traffic",
        "lands",
        "on the",
        "Pricing page",
        "and leaves for",
        ["good", "now", "today", "later"],
      ]),
    ).toContain("on the{/s1}");
  });
});

describe("rotator-dangling and rotator-doubled (hard, the page's rotating verbs)", () => {
  const ctx = {
    language: "en",
    allowedNumbers: collectNumbers(["none"]),
    templates: new Map([["hero.headline", PAGE]]),
  };
  const hard = (runs: string[]) =>
    lintVariant(JSON.parse(body(fillTemplate(PAGE, runs))) as VariantBody, ctx).hard.map(
      (f) => f.rule,
    );

  it("fails a finished phrase with the page's verb hanging after it", () => {
    expect(
      hard(["Most", "tools", "guess.", "You serve", "intent instead", "and skip the banner"]),
    ).toContain("rotator-dangling");
  });

  it("passes a run that leads into the verb", () => {
    expect(
      hard(["Thirty", "versions", "cost", "about $0.45", "per page.", "And you can"]),
    ).not.toContain("rotator-dangling");
  });

  it("fails the page's verb written twice", () => {
    expect(
      hard(["Every", "page", "here", "was written", "for one", "kind of visitor to read"]),
    ).toContain("rotator-doubled");
  });
});

describe("the lengths against the page's lines", () => {
  // The page's lines: 21, 24 and 29 characters (the last with "compare").
  const fits = [
    "Every",
    "visitor",
    "already",
    "arrives through",
    "a search.",
    "Pick what they can",
  ];
  const longLast = [
    "Every",
    "visitor",
    "already",
    "arrives through",
    "a search.",
    "Pick what each visitor can",
  ];
  const short = ["One", "page", "for", "all", "visitors.", "Pick what they can"];

  it("leaves out another length whose last line is longer than the page's", () => {
    const r = parseAndValidate(
      body(fits, { headline_alt: longLast, headline_alt2: fits }),
      "brand",
      "c",
      manifest,
    );
    expect(r.ok).toBe(true);
    const hero = (r as { body: VariantBody }).body.sections.hero as unknown as Record<
      string,
      unknown
    >;
    expect(hero.headline_alt).toBeUndefined();
    expect(hero.headline_alt2).toBe(fillTemplate(PAGE, fits));
  });

  it("gives a base whose last line is over the place of a length whose last line fits", () => {
    const r = parseAndValidate(body(longLast, { headline_alt: fits }), "brand", "c", manifest);
    const hero = (r as { body: VariantBody }).body.sections.hero as unknown as Record<
      string,
      unknown
    >;
    expect(hero.headline).toBe(fillTemplate(PAGE, fits));
    expect(hero.headline_alt).toBe(fillTemplate(PAGE, longLast));
    // A short base keeps its place: the windows other than the last line's cap guide, never swap.
    const r2 = parseAndValidate(body(short, { headline_alt: fits }), "brand", "c", manifest);
    const hero2 = (r2 as { body: VariantBody }).body.sections.hero as unknown as Record<
      string,
      unknown
    >;
    expect(hero2.headline).toBe(fillTemplate(PAGE, short));
  });

  it("fails 'to can' before the rotating verb", () => {
    const ctx = {
      language: "en",
      allowedNumbers: collectNumbers(["none"]),
      templates: new Map([["hero.headline", PAGE]]),
    };
    const t = fillTemplate(PAGE, [
      "One",
      "page",
      "for",
      "every visitor",
      "built to",
      "sell, built to can",
    ]) as string;
    expect(lintVariant(JSON.parse(body(t)) as VariantBody, ctx).hard.map((f) => f.rule)).toContain(
      "rotator-dangling",
    );
  });
});

describe("a word split into letters (interactive text phase 3)", () => {
  const LETTERS = "Your visitors already arrive through AI tools.";
  const lettersManifest: Manifest = {
    "hero.headline": {
      css: ["h1"],
      text: [],
      structural: "h1",
      original_char_length: 46,
      inline: {
        icons: "none",
        emphasis: 0,
        split: true,
        animated_text: false,
        template: LETTERS,
        letters: true,
      },
    },
    "hero.body": { css: ["p"], text: [], structural: "p", original_char_length: 60 },
  };
  const variant = (headline: unknown, bodyText: unknown) => body(headline, { body: bodyText });

  it("keeps a headline longer than the page's: it wraps as plain text, no line to hold", () => {
    const long = "Every visitor who arrives from an AI tool finds a page for them.";
    const r = parseAndValidate(
      variant([long], "A short body sentence."),
      "brand",
      "c",
      lettersManifest,
    );
    expect((r as { reason?: string }).reason).toBeUndefined();
    const hero = (r as { body: VariantBody }).body.sections.hero as unknown as Record<
      string,
      unknown
    >;
    expect(hero.headline).toBe(long);
    const lint = lintVariant((r as { body: VariantBody }).body, {
      language: "en",
      allowedNumbers: collectNumbers(["none"]),
      templates: new Map([["hero.headline", LETTERS]]),
    });
    expect(lint.hard.filter((f) => f.rule === "template-line-length")).toHaveLength(0);
  });

  it("joins a plain part the model wrote as a list, instead of failing it as empty", () => {
    const r = parseAndValidate(
      variant(["Pages that answer why they came."], ["You pay for the visit.", "Make it count."]),
      "brand",
      "c",
      lettersManifest,
    );
    expect((r as { reason?: string }).reason).toBeUndefined();
    const hero = (r as { body: VariantBody }).body.sections.hero as unknown as Record<
      string,
      unknown
    >;
    expect(hero.body).toBe("You pay for the visit. Make it count.");
  });
});
