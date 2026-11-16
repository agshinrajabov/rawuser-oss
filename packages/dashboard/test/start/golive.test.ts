/**
 * Measure at go live on the Look screen (mock design/mock/sales-readiness/
 * measure-at-go-live.html, sections 01 to 05, approved 2026-10-05; contract
 * docs/specs/measure-at-go-live.md section 12): the button row in its five
 * states, the Go live line in its five states with the switch, the body Go
 * live sends, the notice paragraph word for word, and the privacy review's
 * conditions 1 and 2 on what renders.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ButtonToCount, GoLiveTestLine, NoticeLink } from "../../src/components/start/Measure";
import {
  type GoLiveTest,
  LIVE_TEST_LINE,
  LOW_TRAFFIC_LINE,
  NOTICE_LINK,
  NOTICE_PARAGRAPH,
  NO_BUTTON_LINE,
  NO_BUTTON_TEST_LINE,
  TEST_ACCOUNT_LINE,
  TEST_OFF_LINE,
  TEST_ON_LINE,
  buttonRow,
  candidates,
  goLiveTest,
  measureBody,
  pathList,
  slotPlace,
  switchDefault,
  tickedPaths,
} from "../../src/lib/golive";
import type { LanguagePage, MeasureButton, MeasureProposal } from "../../src/types/api";

const START_FREE: MeasureButton = { section_path: "hero.cta.label", label: "Start free" };
const TEMPLATE: MeasureButton = { section_path: "forms.submit_label", label: "Get the template" };
const DEMO: MeasureButton = { section_path: "cta.cta.label", label: "Book a demo" };
const PLANS: MeasureButton = { section_path: "pricing.cta.label", label: "See plans" };
const PICKED: MeasureButton = { section_path: "count:/", label: "Sign up" };

function measure(over: Partial<MeasureProposal> = {}): MeasureProposal {
  return {
    proposal: START_FREE,
    others: [TEMPLATE, DEMO, PLANS],
    per_language: [],
    baseline_days: 0,
    estimate_weeks: null,
    low_traffic: false,
    ...over,
  };
}

const AZ_HAS_HERO = [
  { lang: "az", path: "/az", found: true, slots: ["hero.cta.label", "forms.submit_label"] },
];
const AZ_NO_HERO = [{ lang: "az", path: "/az", found: false, slots: ["forms.submit_label"] }];

function html(el: ReturnType<typeof createElement>): string {
  return renderToStaticMarkup(el);
}

const text = (h: string) =>
  h
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

// ---------------------------------------------------------------------------
// The button to count, five states
// ---------------------------------------------------------------------------

describe("the button to count", () => {
  it("A, proposed: its own words and where it sits", () => {
    const r = buttonRow(measure(), START_FREE, []);
    expect(r).toEqual({
      kind: "chosen",
      label: "Start free",
      rest: ", top of the page.",
      warn: false,
    });
  });

  it("names every slot's place as the mock's list does", () => {
    expect(slotPlace("hero.cta.label")).toBe("top of the page");
    expect(slotPlace("forms.submit_label")).toBe("the form");
    expect(slotPlace("cta.cta.label")).toBe("bottom of the page");
    expect(slotPlace("pricing.cta.label")).toBe("pricing");
    expect(slotPlace("count:/")).toBe("picked on the page");
  });

  it("B, change open: the proposal first, then the others, each once", () => {
    const list = candidates(measure({ others: [TEMPLATE, START_FREE, DEMO, PLANS] }));
    expect(list.map((b) => b.label)).toEqual([
      "Start free",
      "Get the template",
      "Book a demo",
      "See plans",
    ]);
    expect(candidates(null)).toEqual([]);
    expect(candidates(measure({ proposal: null, others: [] }))).toEqual([]);
  });

  it("C, several languages: also counted where the ticked page carries the slot", () => {
    const r = buttonRow(measure({ per_language: AZ_HAS_HERO }), START_FREE, ["/az"]);
    expect(r).toEqual({
      kind: "chosen",
      label: "Start free",
      rest: ". Also counted on /az.",
      warn: false,
    });
  });

  it("D, missing on a language page: amber, the line names the page, not the button", () => {
    const r = buttonRow(measure({ per_language: AZ_NO_HERO }), START_FREE, ["/az"]);
    expect(r).toEqual({
      kind: "missing",
      line: "Not found on /az, so clicks there are not counted.",
      warn: true,
    });
  });

  it("D answers for another choice too, from the page's slots", () => {
    const r = buttonRow(measure({ per_language: AZ_NO_HERO }), TEMPLATE, ["/az"]);
    expect(r.kind).toBe("chosen");
  });

  it("a button picked on the page counts on its own page only", () => {
    const r = buttonRow(measure({ per_language: AZ_HAS_HERO }), PICKED, ["/az"]);
    expect(r.kind).toBe("missing");
    expect(buttonRow(measure(), PICKED, [])).toEqual({
      kind: "chosen",
      label: "Sign up",
      rest: ", picked on the page.",
      warn: false,
    });
  });

  it("an unticked language page says nothing", () => {
    expect(buttonRow(measure({ per_language: AZ_NO_HERO }), START_FREE, []).kind).toBe("chosen");
  });

  it("E, no button found: amber", () => {
    expect(buttonRow(measure({ proposal: null, others: [] }), null, [])).toEqual({
      kind: "none",
      line: NO_BUTTON_LINE,
      warn: true,
    });
    expect(NO_BUTTON_LINE).toBe("No main button found.");
  });

  it("ticked pages: ready, ticked, not the page on screen", () => {
    const langs: LanguagePage[] = [
      {
        lang: "en",
        path: "/",
        source: "html-lang",
        status: "primary",
        parts: 8,
        brief_drafted: true,
        enabled: true,
      },
      {
        lang: "az",
        path: "/az",
        source: "hreflang",
        status: "ready",
        parts: 8,
        brief_drafted: true,
        enabled: true,
      },
      {
        lang: "ru",
        path: "/ru",
        source: "hreflang",
        status: "unreachable",
        parts: 0,
        brief_drafted: false,
        enabled: false,
      },
    ];
    expect(tickedPaths(langs, new Set(["en", "az", "ru"]), "/")).toEqual(["/az"]);
    expect(tickedPaths(langs, new Set(["en"]), "/")).toEqual([]);
    expect(pathList(["/az", "/ru", "/tr"])).toBe("/az, /ru and /tr");
  });
});

describe("the button row, rendered", () => {
  const props = {
    customerId: "acme",
    pagePath: "/",
    onChoose: () => {},
  };

  it("A: the words in ink, Change, an ok tick", () => {
    const h = html(
      createElement(ButtonToCount, {
        ...props,
        measure: measure(),
        chosen: START_FREE,
        ticked: [],
      }),
    );
    expect(text(h)).toContain("The button to count Start free , top of the page. Change");
    expect(h).toContain('<b class="font-medium text-fg">Start free</b>');
    expect(h).not.toContain("color-mix(in_srgb,var(--state-warn)_5%");
  });

  it("B: the radio list with the current one checked, Done, and the count link", () => {
    const h = html(
      createElement(ButtonToCount, {
        ...props,
        measure: measure(),
        chosen: START_FREE,
        ticked: [],
        defaultOpen: true,
      }),
    );
    const t = text(h);
    expect(t).toContain("Buttons we found on your page.");
    expect(t).toContain("Done");
    expect(t).toContain("Start free top of the page");
    expect(t).toContain("See plans pricing");
    expect(t).toContain("Not here? Pick it on your page");
    expect((h.match(/type="radio"/g) ?? []).length).toBe(4);
    const checked = h.match(/<input[^>]*checked=""[^>]*>/g) ?? [];
    expect(checked).toHaveLength(1);
    expect(checked[0]).toContain('value="hero.cta.label"');
    expect(h).not.toContain("/onboard");
  });

  it("D: amber with Change", () => {
    const h = html(
      createElement(ButtonToCount, {
        ...props,
        measure: measure({ per_language: AZ_NO_HERO }),
        chosen: START_FREE,
        ticked: ["/az"],
      }),
    );
    expect(text(h)).toContain("Not found on /az, so clicks there are not counted. Change");
    expect(h).toContain("var(--state-warn)_5%");
  });

  it("E: amber, and Pick it on your page as a button under the line", () => {
    const h = html(
      createElement(ButtonToCount, {
        ...props,
        measure: measure({ proposal: null, others: [] }),
        chosen: null,
        ticked: [],
      }),
    );
    expect(text(h)).toContain("No main button found. Pick it on your page");
    expect(text(h)).not.toContain("Change");
  });
});

// ---------------------------------------------------------------------------
// Beside Go live
// ---------------------------------------------------------------------------

describe("the line and the switch beside Go live", () => {
  const base = { plan: "pilot", chosen: START_FREE, lowTraffic: false, switchOn: true };

  it("1, On by default: the line, and Go live sends test: true", () => {
    expect(switchDefault("pilot")).toBe(true);
    const t = goLiveTest(base);
    expect(t).toEqual({ control: "switch", on: true, line: TEST_ON_LINE });
    expect(TEST_ON_LINE).toBe("A test starts too: 1 in 5 visits see your original page.");
    expect(measureBody(START_FREE, t)).toEqual({
      count: { section_path: "hero.cta.label" },
      test: true,
    });
  });

  it("2, switched off: no test field, the button still sent", () => {
    const t = goLiveTest({ ...base, switchOn: false });
    expect(t).toEqual({ control: "switch", on: false, line: TEST_OFF_LINE });
    expect(TEST_OFF_LINE).toBe("No test. You can start one on Test.");
    const body = measureBody(START_FREE, t);
    expect(body).toEqual({ count: { section_path: "hero.cta.label" } });
    expect("test" in body).toBe(false);
  });

  it("3, no button: a hollow dot, no test", () => {
    const t = goLiveTest({ ...base, chosen: null });
    expect(t).toEqual({ control: "none", on: false, line: NO_BUTTON_TEST_LINE });
    expect(measureBody(null, t)).toEqual({ count: null });
  });

  it("4, too little traffic known now: no test, the button still sent", () => {
    const t = goLiveTest({ ...base, lowTraffic: true });
    expect(t).toEqual({ control: "none", on: false, line: LOW_TRAFFIC_LINE });
    expect(LOW_TRAFFIC_LINE).toBe(
      "Too little traffic for a test. Visitors shows who comes and from where.",
    );
    expect(measureBody(START_FREE, t)).toEqual({ count: { section_path: "hero.cta.label" } });
  });

  it("5, a test customer: Off and disabled, even if the switch state says On", () => {
    expect(switchDefault("test")).toBe(false);
    const t = goLiveTest({ ...base, plan: "test", switchOn: true });
    expect(t).toEqual({ control: "disabled", on: false, line: TEST_ACCOUNT_LINE });
    expect(TEST_ACCOUNT_LINE).toBe("Test accounts never run a test.");
    expect(measureBody(START_FREE, t)).toEqual({ count: { section_path: "hero.cta.label" } });
  });

  it("the server's order: a test customer before no button before traffic", () => {
    expect(goLiveTest({ ...base, plan: "test", chosen: null, lowTraffic: true }).control).toBe(
      "disabled",
    );
    expect(goLiveTest({ ...base, chosen: null, lowTraffic: true }).line).toBe(NO_BUTTON_TEST_LINE);
  });

  it("renders the switch with its state, and the notice link in every state (privacy review 1 and 2)", () => {
    const states = [
      goLiveTest(base),
      goLiveTest({ ...base, switchOn: false }),
      goLiveTest({ ...base, chosen: null }),
      goLiveTest({ ...base, lowTraffic: true }),
      goLiveTest({ ...base, plan: "test" }),
    ];
    for (const t of states) {
      const h = html(createElement(GoLiveTestLine, { test: t, onToggle: () => {} }));
      expect(text(h)).toContain(t.line);
      expect(text(h)).toContain(NOTICE_LINK);
      expect(h).not.toContain("<details");
    }
    const on = html(
      createElement(GoLiveTestLine, { test: states[0] as GoLiveTest, onToggle: () => {} }),
    );
    expect(on).toContain('role="switch"');
    expect(on).toContain('aria-checked="true"');
    expect(text(on)).toContain("Test: On");
    const off = html(
      createElement(GoLiveTestLine, { test: states[1] as GoLiveTest, onToggle: () => {} }),
    );
    expect(off).toContain('aria-checked="false"');
    const none = html(
      createElement(GoLiveTestLine, { test: states[2] as GoLiveTest, onToggle: () => {} }),
    );
    expect(none).not.toContain('role="switch"');
    expect(text(none)).toContain("Test: Off");
    const dis = html(
      createElement(GoLiveTestLine, { test: states[4] as GoLiveTest, onToggle: () => {} }),
    );
    expect(dis).toMatch(/role="switch"[^>]*disabled=""|disabled=""[^>]*role="switch"/);
    expect(text(dis)).toContain("Test: Off");
  });

  it("the switch row is 44 px tall to tap on a phone", () => {
    const h = html(createElement(GoLiveTestLine, { test: goLiveTest(base), onToggle: () => {} }));
    expect(h).toContain("min-h-[44px]");
  });
});

// ---------------------------------------------------------------------------
// The notice paragraph
// ---------------------------------------------------------------------------

describe("Text for your privacy notice", () => {
  it("says what a notice has to say: the test, and where a visit's reason comes from", () => {
    expect(NOTICE_PARAGRAPH).toContain("While a test runs, some visits");
    // Site-shaped intents, privacy review condition 7 (spec §18.3): the page opened.
    expect(NOTICE_PARAGRAPH).toContain(
      "(for example a campaign link, the site a visitor came from, the page opened, or an AI assistant that cited us)",
    );
  });

  it("opens with the paragraph and a Copy button", () => {
    const h = html(createElement(NoticeLink, { defaultOpen: true }));
    const t = text(h);
    expect(t).toContain("Paste it where your notice lists the tools on your site.");
    expect(t).toContain(NOTICE_PARAGRAPH.slice(0, 80));
    expect(t).toContain("Copy");
    expect(h).toContain('aria-expanded="true"');
  });

  it("closed, it is a link that says so", () => {
    const h = html(createElement(NoticeLink, {}));
    expect(text(h)).toBe(NOTICE_LINK);
    expect(h).toContain('aria-expanded="false"');
  });
});

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

describe("the words", () => {
  const lines = [
    TEST_ON_LINE,
    TEST_OFF_LINE,
    NO_BUTTON_TEST_LINE,
    LOW_TRAFFIC_LINE,
    TEST_ACCOUNT_LINE,
    NO_BUTTON_LINE,
    LIVE_TEST_LINE,
    NOTICE_LINK,
  ];

  it("no dashes anywhere, the notice paragraph included", () => {
    for (const l of [...lines, NOTICE_PARAGRAPH]) expect(l).not.toMatch(/[\u2013\u2014]/);
  });

  it("no screen line claims an exemption, no consent or no cookies (privacy review)", () => {
    for (const l of lines) expect(l).not.toMatch(/exempt|consent|cookie/i);
  });

  it("Live's one line", () => {
    expect(LIVE_TEST_LINE).toBe("A test is running. Test gives its date after a week of visits.");
  });
});
