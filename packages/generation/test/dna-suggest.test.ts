/**
 * dna-suggest: page text → evidence-checked brief suggestions.
 * generateVariant is mocked; no network.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MODEL_ENV_WITH_FALLBACK } from "./model-env.ts";

vi.mock("../src/generateVariant.ts", () => ({
  generateVariant: vi.fn(),
}));

const { generateVariant } = await import("../src/generateVariant.ts");
const mock = vi.mocked(generateVariant);
const { evidenceOnPage, htmlToText, parseSuggestions, suggestDnaFromHtml } = await import(
  "../src/dna-suggest.ts"
);
const { resetProviderState } = await import("../src/call-model.ts");

const HTML = `
<html><body>
<h1>Lumera School</h1>
<p>6 aylıq UX/UI dizayn kursu, Azərbaycan dilində.</p>
<h2>Niyə biz</h2>
<ul><li>Real layihələr üzərində iş</li><li>Mentor dəstəyi hər həftə</li></ul>
<p>400+ məzun artıq dizayner kimi işləyir. Tərəfdaşlar: Numune Bank, Şəhər Bank.</p>
<p>Qeydiyyat açıqdır.</p>
</body></html>`;

const ENV = { ...MODEL_ENV_WITH_FALLBACK };

function reply(text: string) {
  mock.mockResolvedValueOnce({
    text,
    model: "model-a",
    costUsd: 0,
    promptHash: "x",
    cacheHit: false,
    cacheReadTokens: 0,
  } as never);
}

beforeEach(() => mock.mockReset());

describe("htmlToText", () => {
  it("keeps the words, drops the tags, breaks on block elements", () => {
    const t = htmlToText(HTML);
    expect(t).toContain("Lumera School");
    expect(t).toContain("400+ məzun");
    expect(t).not.toContain("<");
    expect(t.split("\n").length).toBeGreaterThan(4);
  });
});

describe("evidenceOnPage", () => {
  it("is whitespace- and case-insensitive and rejects tiny quotes", () => {
    const t = htmlToText(HTML);
    expect(evidenceOnPage("400+ məzun artıq dizayner kimi işləyir", t)).toBe(true);
    expect(evidenceOnPage("MENTOR DƏSTƏYİ   HƏR HƏFTƏ", t)).toBe(true);
    expect(evidenceOnPage("1000 məzun", t)).toBe(false);
    expect(evidenceOnPage("kurs", t)).toBe(false);
  });
});

describe("parseSuggestions", () => {
  it("keeps entries whose evidence is on the page and drops the rest", () => {
    const t = htmlToText(HTML);
    const raw = JSON.stringify({
      language: "AZ",
      brand_voice: "warm, direct, confident",
      product: "6 aylıq UX/UI dizayn kursu",
      icp: "Karyera dəyişənlər",
      target_market: null,
      value_props: [
        { text: "Real layihələr", evidence: "Real layihələr üzərində iş" },
        { text: "Uydurma", evidence: "Dünyanın ən yaxşı kursu" },
      ],
      differentiators: [{ text: "Həftəlik mentor", evidence: "Mentor dəstəyi hər həftə" }],
      proof_points: [
        { text: "400+ məzun işləyir", evidence: "400+ məzun artıq dizayner kimi işləyir" },
        { text: "Bank tərəfdaşları", evidence: "Numune Bank, Şəhər Bank" },
        { text: "5000 tələbə", evidence: "5000 tələbə" },
        { text: "Evidence yoxdur", evidence: "" },
      ],
    });
    const s = parseSuggestions(`Here you go:\n${raw}\nDone.`, t, "https://lumera.test");
    expect(s.language).toBe("az");
    expect(s.product).toBe("6 aylıq UX/UI dizayn kursu");
    expect(s.brand_voice).toBe("warm, direct, confident");
    expect(s.target_market).toBeNull();
    expect(s.value_props.map((v) => v.text)).toEqual(["Real layihələr"]);
    expect(s.differentiators).toHaveLength(1);
    expect(s.proof_points.map((v) => v.text)).toEqual(["400+ məzun işləyir", "Bank tərəfdaşları"]);
  });

  it("caps each list at 5 and dedupes by text", () => {
    const t = "alpha beta gamma delta epsilon zeta eta theta";
    const item = { text: "same", evidence: "alpha beta gamma" };
    const raw = JSON.stringify({ value_props: [item, item, item, item, item, item, item] });
    expect(parseSuggestions(raw, t, "u").value_props).toHaveLength(1);
    const many = Array.from({ length: 8 }, (_, i) => ({
      text: `t${i}`,
      evidence: "alpha beta gamma",
    }));
    expect(
      parseSuggestions(JSON.stringify({ value_props: many }), t, "u").value_props,
    ).toHaveLength(5);
  });

  it("throws on output with no JSON object", () => {
    expect(() => parseSuggestions("nope", "text text text", "u")).toThrow(/parse failed/);
  });
});

describe("suggestDnaFromHtml", () => {
  it("sends the page text on the read role with the cached preamble and returns checked suggestions", async () => {
    reply(
      JSON.stringify({
        language: "az",
        product: "UX/UI kursu",
        value_props: [{ text: "Real layihələr", evidence: "Real layihələr üzərində iş" }],
        differentiators: [],
        proof_points: [{ text: "invented", evidence: "not on page at all" }],
      }),
    );
    const s = await suggestDnaFromHtml(HTML, "https://lumera.test", ENV);
    expect(mock).toHaveBeenCalledTimes(1);
    const input = mock.mock.calls[0]?.[0];
    expect(input?.role).toBe("read");
    expect(input?.jsonMode).toBe(true);
    expect(input?.cachedPreamble).toContain("Never invent");
    expect(input?.prompt).toContain("400+ məzun");
    expect(s.value_props).toHaveLength(1);
    expect(s.proof_points).toHaveLength(0);
    expect(s.url).toBe("https://lumera.test");
  });

  it("names no model: the env decides which one the read role is", async () => {
    reply(
      JSON.stringify({ language: "az", value_props: [], differentiators: [], proof_points: [] }),
    );
    const env = { ...ENV, MODEL_ID_READ: "model-read" };
    await suggestDnaFromHtml(HTML, "https://lumera.test", env);
    expect(mock.mock.calls[0]?.[0]).not.toHaveProperty("model");
    expect(mock.mock.calls[0]?.[1]).toBe(env);
  });

  it("refuses a page with almost no text before calling the model", async () => {
    await expect(suggestDnaFromHtml("<p>hi</p>", "u", ENV)).rejects.toThrow(/too little text/);
    expect(mock).not.toHaveBeenCalled();
  });

  // 2026-10-02: the primary model took the request and sent nothing back; the
  // apply page sat on "Reading your page..." because this read had no timeout.
  it("gives a silent primary 15 s, then answers from the fallback", async () => {
    vi.useFakeTimers();
    try {
      mock.mockImplementationOnce(() => new Promise(() => {}) as never);
      reply(
        JSON.stringify({ language: "az", value_props: [], differentiators: [], proof_points: [] }),
      );
      const done = suggestDnaFromHtml(HTML, "https://lumera.test", ENV);
      await vi.advanceTimersByTimeAsync(15_000);
      const s = await done;
      expect(mock.mock.calls.map((c) => c[2] ?? "primary")).toEqual(["primary", "fallback"]);
      expect(s.url).toBe("https://lumera.test");
    } finally {
      vi.useRealTimers();
      resetProviderState();
    }
  });

  it("fails within 40 s when neither model answers, so the page can say so", async () => {
    vi.useFakeTimers();
    try {
      mock.mockImplementation(() => new Promise(() => {}) as never);
      const done = suggestDnaFromHtml(HTML, "https://lumera.test", ENV);
      const caught = done.catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(40_000);
      expect(String(await caught)).toMatch(/Suggestion call failed: .*Timeout after 25000ms/);
    } finally {
      mock.mockReset();
      vi.useRealTimers();
      resetProviderState();
    }
  });
});
