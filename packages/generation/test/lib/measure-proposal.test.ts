/**
 * The button to count (docs/specs/measure-at-go-live.md §4, §15 "Proposal"):
 * the hero button wins over a form submit with equal words; an uncertain
 * slot is never proposed; a same-page anchor and reading words rank down;
 * action words in en, az, ru and tr; no candidate gives nothing; the words
 * set the closed conversion label.
 */
import type { Manifest } from "@rawuser/shared";
import { describe, expect, it } from "vitest";
import {
  conversionLabelFor,
  conversionLabelOf,
  isActionWords,
  isReadingWords,
  onceSelectors,
  rankButtons,
} from "../../src/lib/measure-proposal.ts";

const entry = (css: string, text: string, extra: Partial<Manifest[string]> = {}) => ({
  css: [css],
  text: [text],
  structural: css,
  ...extra,
});

function page(body: string): string {
  return `<html lang="en"><body>${body}</body></html>`;
}

describe("ranking", () => {
  it("the hero button wins over a form submit with equal words", () => {
    const html = page(
      `<section class="hero"><a id="hero-cta" href="/signup">Start free</a></section>
       <form action="/join"><button id="submit">Start free</button></form>`,
    );
    const manifest: Manifest = {
      "forms.submit_label": entry("#submit", "Start free"),
      "hero.cta.label": entry("#hero-cta", "Start free"),
    };
    const ranked = rankButtons(html, manifest, [], "/");
    expect(ranked.map((b) => b.section_path)).toEqual(["hero.cta.label", "forms.submit_label"]);
    expect(ranked[0]?.label).toBe("Start free");
  });

  it("ties go to the earlier slot", () => {
    // hero 4 - 2 (anchor) = 2; cta 2: equal, the hero comes first.
    const html = page(`<a id="h" href="#how">Pricing</a><a id="c" href="/x">Pricing</a>`);
    const manifest: Manifest = {
      "cta.cta.label": entry("#c", "Pricing"),
      "hero.cta.label": entry("#h", "Pricing"),
    };
    // cta: 2 + 2 (leaves) = 4 beats the hero's 2.
    expect(rankButtons(html, manifest, [], "/")[0]?.section_path).toBe("cta.cta.label");
    const both = page(`<a id="h" href="/a">Pricing</a><a id="c" href="/x">Pricing</a>`);
    const tie: Manifest = {
      "pricing.cta.label": entry("#c", "Pricing"),
      "hero.cta.label": entry("#h", "Pricing"),
    };
    expect(rankButtons(both, tie, [], "/")[0]?.section_path).toBe("hero.cta.label");
  });

  it("an uncertain slot is never proposed, nor one detection marked as no conversion", () => {
    const html = page(
      `<a id="h" href="/signup">Start free</a><a id="c" href="/demo">Book a demo</a>`,
    );
    const manifest: Manifest = {
      "hero.cta.label": entry("#h", "Start free"),
      "cta.cta.label": entry("#c", "Book a demo", { conversion_candidate: false }),
    };
    expect(rankButtons(html, manifest, ["hero.cta.label"], "/")).toEqual([]);
  });

  it("a same-page anchor ranks down", () => {
    const html = page(
      `<a id="h" href="#how-it-works">Start free</a>
       <form><button id="s" type="submit">Start free</button></form>`,
    );
    const manifest: Manifest = {
      "hero.cta.label": entry("#h", "Start free"),
      "forms.submit_label": entry("#s", "Start free"),
    };
    // hero 4 + 3 - 2 = 5; form 3 + 3 + 2 = 8.
    const ranked = rankButtons(html, manifest, [], "/");
    expect(ranked.map((b) => [b.section_path, b.score])).toEqual([
      ["forms.submit_label", 8],
      ["hero.cta.label", 5],
    ]);
  });

  it("a link to the same path with a hash is an anchor; to another path it leaves", () => {
    const html = page(
      `<a id="h" href="/pricing#plans">Get it</a><a id="c" href="/#faq">Get it</a>`,
    );
    const manifest: Manifest = {
      "hero.cta.label": entry("#h", "Get it"),
      "cta.cta.label": entry("#c", "Get it"),
    };
    const ranked = rankButtons(html, manifest, [], "/");
    expect(ranked.find((b) => b.section_path === "hero.cta.label")?.score).toBe(4 + 3 + 2);
    expect(ranked.find((b) => b.section_path === "cta.cta.label")?.score).toBe(2 + 3 - 2);
  });

  it("reading words rank down", () => {
    const html = page(`<a id="h" href="/how">Learn more</a><a id="c" href="/signup">Sign up</a>`);
    const manifest: Manifest = {
      "hero.cta.label": entry("#h", "Learn more"),
      "cta.cta.label": entry("#c", "Sign up"),
    };
    expect(rankButtons(html, manifest, [], "/")[0]?.section_path).toBe("cta.cta.label");
  });

  it("no candidate gives nothing", () => {
    const manifest: Manifest = { "hero.headline": entry("h1", "Forms people finish.") };
    expect(rankButtons(page("<h1>Forms people finish.</h1>"), manifest, [], "/")).toEqual([]);
  });

  it("returns the slot, the words and where it goes as a closed word, never the link", () => {
    const html = page(`<a id="h" href="https://app.acme.dev/signup?ref=hero">Start free</a>`);
    const ranked = rankButtons(html, { "hero.cta.label": entry("#h", "Start free") }, [], "/");
    expect(JSON.stringify(ranked)).not.toMatch(/href|app\.acme\.dev|signup\?/);
    expect(Object.keys(ranked[0] ?? {}).sort()).toEqual(["goes", "label", "score", "section_path"]);
    expect(ranked[0]?.goes).toBe("leaves_site");
  });
});

describe("words in four languages", () => {
  it.each([
    ["Start free", "trial_start"],
    ["Try it free", "trial_start"],
    ["Sign up", "signup"],
    ["Get started", "signup"],
    ["Book a demo", "demo_request"],
    ["Join the waitlist", "waitlist"],
    ["Buy now", "purchase"],
    ["Contact us", "contact"],
    ["Download", "download"],
    ["Pulsuz başla", "trial_start"],
    ["Qeydiyyatdan keç", "signup"],
    ["Başla →", "signup"],
    ["Satın al", "purchase"],
    ["Bizimlə əlaqə", "contact"],
    ["Попробовать бесплатно", "trial_start"],
    ["Зарегистрироваться", "signup"],
    ["Купить", "purchase"],
    ["Запросить демо", "demo_request"],
    ["Ücretsiz dene", "trial_start"],
    ["Kaydol", "signup"],
    ["Hemen başla", "signup"],
    ["İletişim", "contact"],
    ["Bekleme listesine katıl", "waitlist"],
    ["See plans", "other"],
    // A form's Send button (E1.1): the click on it is a contact.
    ["Send", "contact"],
    ["Send message", "contact"],
    ["Submit", "contact"],
    ["Göndər", "contact"],
    ["Отправить", "contact"],
    ["Gönder", "contact"],
  ])("%s → %s", (words, label) => {
    expect(conversionLabelOf(words)).toBe(label);
  });

  it("a form's submit button is contact when its words say nothing; its words win otherwise", () => {
    expect(conversionLabelFor("forms.submit_label", "Go")).toBe("contact");
    expect(conversionLabelFor("forms.submit_label", "Get the template")).toBe("contact");
    expect(conversionLabelFor("forms.submit_label", "Join the waitlist")).toBe("waitlist");
    expect(conversionLabelFor("hero.cta.label", "Go")).toBe("other");
    expect(conversionLabelFor("count:/", "Göndər")).toBe("contact");
  });

  it("action and reading words", () => {
    for (const w of ["Start free", "Əldə et", "Получить доступ", "Hemen al", "Get it"])
      expect(isActionWords(w)).toBe(true);
    for (const w of ["See plans", "Necə işlədiyimizə bax →", "Подробнее"])
      expect(isActionWords(w)).toBe(false);
    for (const w of ["Learn more", "See how it works", "Ətraflı", "Подробнее", "Daha fazla bilgi"])
      expect(isReadingWords(w)).toBe(true);
    for (const w of ["Get ready", "Start free"]) expect(isReadingWords(w)).toBe(false);
  });
});

describe("onceSelectors", () => {
  it("keeps per count slot only the selectors that match exactly once", () => {
    const html = page(`<a class="btn">A</a><a class="btn">B</a><a id="h">Start</a>`);
    const manifest: Manifest = {
      "hero.cta.label": { css: [".btn", "#h", "#nope"], text: ["Start"], structural: "x" },
      "hero.headline": { css: ["#h"], text: ["Start"], structural: "x" },
      "cta.cta.label": { css: [".btn"], text: ["A"], structural: "x" },
    };
    expect(onceSelectors(html, manifest)).toEqual({ "hero.cta.label": ["#h"] });
  });
});
