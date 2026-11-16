/**
 * "Measure what Rawuser brings" on Results (mock design/mock/sales-readiness/
 * measure-setup.html, `6fcb113`; contract docs/specs/proof-engine.md, "The
 * customer's own test"): the three steps in every state, Test: On and Off,
 * Stop's one line, the API's 409 sentence shown as is, and a report from an
 * older worker without `start`.
 */
import "../identity/example";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MeasureSetup, type TestAction } from "../../src/components/analytics/MeasureSetup";
import { TestStatus } from "../../src/components/analytics/TestStatus";
import { ApiError } from "../../src/lib/api";
import {
  type Api,
  COUNT_PATH,
  NO_TRAFFIC_YET,
  START_LINE,
  TEST_PATH,
  TOO_LITTLE,
  buttonPlace,
  countButton,
  postTest,
  setupSteps,
  showsSetup,
  startOf,
  stopConfirm,
  testIsOn,
  testStatus,
} from "../../src/lib/measure";
import { howItWorks } from "../../src/lib/proof";
import type { ConversionTarget, LiftReport, TestStart } from "../../src/types/api";
import { REPORTS } from "./proof-fixtures";

const R = REPORTS;
/** Sun 4 Oct 2026, the mock's today. */
const NOW = Date.parse("2026-10-04T12:00:00Z");

const ESTIMATE = {
  percent: 20,
  weeks: 10,
  eligible_per_month: 6000,
  baseline_rate: 0.08,
  rate_source: "measured" as const,
};

function start(over: Partial<TestStart>): TestStart {
  return {
    counted_buttons: 1,
    can_start: true,
    blocked: null,
    estimate: ESTIMATE,
    read_date: "2026-12-13",
    ...over,
  };
}

function target(over: Partial<ConversionTarget>): ConversionTarget {
  return {
    id: "ct_1",
    customer_id: "brisk",
    section_path: "hero.cta.label",
    label: "Start free",
    conversion_label: "signup",
    enabled: true,
    css_selectors: [],
    text_selectors: [],
    structural_selector: "",
    created_at: 0,
    updated_at: 0,
    ...over,
  };
}

const START_FREE = target({});
const BOOK_A_CALL = target({ id: "ct_2", section_path: "cta.cta.label", label: "Book a call" });

/** The off report as the new worker sends it. */
function off(s: Partial<TestStart>, labels = ["Start free"]): LiftReport {
  return { ...R.off, metric: { kind: "cta_clicks", labels }, start: start(s) };
}

const STATES = {
  noButton: off({ counted_buttons: 0, can_start: false, blocked: "no_button" }, []),
  ready: off({}),
  tooLittle: off({
    can_start: false,
    blocked: "too_little_traffic",
    estimate: { ...ESTIMATE, weeks: 61 },
    read_date: "2027-12-05",
  }),
  noTraffic: off({
    estimate: { ...ESTIMATE, weeks: null, eligible_per_month: 0, rate_source: "default" },
    read_date: null,
  }),
};

const idle: TestAction = { busy: null, said: null, run: async () => true, clear: () => {} };

function renderSetup(report: LiftReport, items: ConversionTarget[] | null, test = idle): string {
  return renderToStaticMarkup(
    createElement(MeasureSetup, { report, items, test, onChoose: () => {} }),
  );
}

describe("which block shows", () => {
  it("the steps only before the first test; the card from Start on", () => {
    expect(showsSetup(R.off)).toBe(true);
    for (const s of [
      "starting",
      "not_enough",
      "interim",
      "held_back",
      "result",
      "ended",
      "ended_early",
    ] as const) {
      expect(showsSetup({ state: s })).toBe(false);
    }
  });
});

describe("the three steps", () => {
  it("no button: step 1 is the one to do, Start is quiet and off", () => {
    const s = setupSteps(STATES.noButton, [], NOW);
    expect(s.choose).toMatchObject({ mode: "on", chosen: null });
    expect(s.choose.line).toBe("The click you want more of, like Start or Sign up.");
    expect(s.start).toMatchObject({
      mode: "locked",
      line: "1 in 5 visits see your original page, to compare.",
      button: { primary: false, enabled: false },
    });
    expect(s.result).toEqual({ mode: "locked", line: "Around Sun 13 Dec, if you start today." });

    const html = renderSetup(STATES.noButton, []);
    expect(html).toContain("Choose button");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Start test<\/button>/);
  });

  it("a disabled button left in the list does not count as chosen", () => {
    const s = setupSteps(STATES.noButton, [target({ enabled: false })], NOW);
    expect(s.choose.mode).toBe("on");
  });

  it("ready: step 1 done with the button's own words, Start test is the one to press", () => {
    const s = setupSteps(
      STATES.ready,
      [START_FREE, target({ ...BOOK_A_CALL, enabled: false })],
      NOW,
    );
    expect(s.choose).toMatchObject({
      mode: "done",
      chosen: { label: "Start free", place: "homepage, top", more: 0 },
    });
    expect(s.start).toMatchObject({ mode: "on", button: { primary: true, enabled: true } });
    expect(s.result.line).toBe("Around Sun 13 Dec, if you start today.");

    const html = renderSetup(STATES.ready, [START_FREE]);
    expect(html).toContain('<b class="font-medium text-fg">Start free</b> · homepage, top');
    expect(html).toContain("Change");
    expect(html).not.toContain("Choose button");
    expect(html).not.toMatch(/disabled=""[^>]*>Start test/);
  });

  it("several counted buttons read as one and more", () => {
    const s = setupSteps(STATES.ready, [START_FREE, BOOK_A_CALL], NOW);
    expect(s.choose.chosen).toMatchObject({ label: "Start free", more: 1 });
    expect(renderSetup(STATES.ready, [START_FREE, BOOK_A_CALL])).toContain("Start free and 1 more");
  });

  it("too little traffic: no Start, step 3 says why", () => {
    const s = setupSteps(STATES.tooLittle, [START_FREE], NOW);
    expect(s.start.button).toBeNull();
    expect(s.start.mode).toBe("locked");
    expect(s.result.line).toBe("Too little traffic to read within a year.");
    expect(renderSetup(STATES.tooLittle, [START_FREE])).not.toContain("Start test<");
  });

  it("no traffic yet: Start stays allowed, the date comes later", () => {
    const s = setupSteps(STATES.noTraffic, [START_FREE], NOW);
    expect(s.start).toMatchObject({ mode: "on", button: { primary: true, enabled: true } });
    expect(s.result.line).toBe(NO_TRAFFIC_YET);
  });

  it("can_start false for another reason keeps Start off", () => {
    const blocked = off({ can_start: false, blocked: "running" });
    expect(setupSteps(blocked, [START_FREE], NOW).start.button).toEqual({
      primary: true,
      enabled: false,
    });
  });

  it("shows the API's sentence under Start test as it came", () => {
    const html = renderSetup(STATES.ready, [START_FREE], {
      ...idle,
      said: "Choose the button to count first.",
    });
    expect(html).toContain("Choose the button to count first.");
  });

  it("before the list loads, step 1 reads from the report", () => {
    const s = setupSteps(STATES.ready, null, NOW);
    expect(s.choose).toMatchObject({ mode: "done", chosen: { label: "Start free", place: null } });
  });

  it("places a button on the homepage in plain words", () => {
    expect(buttonPlace("hero.cta.label")).toBe("Homepage, top");
    expect(buttonPlace("cta.cta.label")).toBe("Homepage, bottom");
    expect(buttonPlace("forms.submit_label")).toBe("Homepage, form");
    expect(buttonPlace("whatever.label")).toBe("Homepage");
  });
});

describe("Test: On and Off", () => {
  it("off before the first test, with nothing beside it", () => {
    expect(testStatus(STATES.ready, NOW)).toEqual({ on: false, action: null });
  });

  it("running: On, and a quiet Stop test", () => {
    for (const s of ["starting", "not_enough", "interim", "held_back", "result"] as const) {
      expect(testIsOn({ state: s })).toBe(true);
    }
    expect(testStatus(R.interim, NOW)).toEqual({ on: true, action: "stop" });
    const html = renderToStaticMarkup(
      createElement(TestStatus, { report: R.interim, test: idle, onChoose: () => {} }),
    );
    expect(html).toContain('Test: <b class="font-medium text-fg">On</b>');
    expect(html).toContain("Stop test");
  });

  it("stopped: Off with a quiet Start again", () => {
    const ended = { ...R.ended_early, start: start({}) };
    expect(testStatus(ended, NOW)).toEqual({ on: false, action: "start-again" });
    const html = renderToStaticMarkup(
      createElement(TestStatus, { report: ended, test: idle, onChoose: () => {} }),
    );
    expect(html).toContain("Off");
    expect(html).toContain("Start again");
    // A text button, not the primary one.
    expect(html).not.toContain("bg-cta-bg");
  });

  it("stopped without a counted button: the way to one; too little traffic: nothing", () => {
    expect(
      testStatus(
        {
          ...R.ended,
          start: start({ counted_buttons: 0, can_start: false, blocked: "no_button" }),
        },
        NOW,
      ),
    ).toEqual({ on: false, action: "choose" });
    expect(
      testStatus(
        { ...R.ended, start: start({ can_start: false, blocked: "too_little_traffic" }) },
        NOW,
      ),
    ).toEqual({ on: false, action: null });
  });

  it("Stop asks once, in one line; red only before the read date", () => {
    expect(stopConfirm(R.interim)).toEqual({
      line: "It ends before Mon 16 Nov, with no answer.",
      danger: true,
    });
    expect(stopConfirm(R.positive)).toEqual({
      line: "The result stays on this page.",
      danger: false,
    });
  });
});

describe("the two calls", () => {
  function fakeApi(answer: unknown | Error): { api: Api; calls: { path: string; body: string }[] } {
    const calls: { path: string; body: string }[] = [];
    const api = (async (path: string, init?: RequestInit) => {
      calls.push({ path, body: String(init?.body ?? "") });
      if (answer instanceof Error) throw answer;
      return answer;
    }) as Api;
    return { api, calls };
  }
  const refusal = (error: string, reason: string) =>
    new ApiError(409, `API error 409: ${JSON.stringify({ error, reason })}`);

  it("start sends exactly {customer_id, action} and shows the answer's report", async () => {
    const { api, calls } = fakeApi({ ok: true, percent: 20, report: R.interim });
    const out = await postTest("brisk", "start", api);
    expect(calls).toEqual([
      { path: TEST_PATH, body: JSON.stringify({ customer_id: "brisk", action: "start" }) },
    ]);
    expect(out).toEqual({ kind: "ok", report: R.interim });
  });

  it("a 409 gives the API's sentence as is", async () => {
    for (const [error, reason] of [
      ["Choose the button to count first.", "no_button"],
      ["Too little traffic to read within a year.", "too_little_traffic"],
      ["A test is already running.", "running"],
    ] as const) {
      const { api } = fakeApi(refusal(error, reason));
      expect(await postTest("brisk", "start", api)).toEqual({
        kind: "refused",
        sentence: error,
        reason,
      });
    }
  });

  it("any other failure says so plainly, never raw JSON", async () => {
    const { api } = fakeApi(new ApiError(500, "API error 500: oops"));
    const out = await postTest("brisk", "stop", api);
    expect(out.kind).toBe("failed");
    expect(out.kind === "failed" && out.message).not.toMatch(/[{}]|500/);
  });

  it("count sends {customer_id, id}; a running test's 409 sentence comes back", async () => {
    const ok = fakeApi({ items: [START_FREE] });
    expect(await countButton("brisk", "ct_1", ok.api)).toEqual({ kind: "ok", items: [START_FREE] });
    expect(ok.calls[0]).toEqual({
      path: COUNT_PATH,
      body: JSON.stringify({ customer_id: "brisk", id: "ct_1" }),
    });
    const lock =
      "A test is running, so the buttons it counts cannot change. Stop the test first to change them.";
    const busy = fakeApi(new ApiError(409, `API error 409: ${JSON.stringify({ error: lock })}`));
    expect(await countButton("brisk", "ct_1", busy.api)).toEqual({
      kind: "refused",
      sentence: lock,
    });
  });
});

describe("a report without start (a worker older than 2026-10-04)", () => {
  it("builds the same answer from the metric and the estimate", () => {
    expect(R.off.start).toBeUndefined();
    expect(startOf(R.off, NOW)).toEqual({
      counted_buttons: 1,
      can_start: true,
      blocked: null,
      estimate: ESTIMATE,
      read_date: "2026-12-13",
    });
    expect(startOf({ ...R.off, metric: { kind: "cta_clicks", labels: [] } }, NOW).blocked).toBe(
      "no_button",
    );
    const slow = { ...R.off, estimate: { ...ESTIMATE, weeks: 1265 } };
    expect(startOf(slow, NOW)).toMatchObject({ can_start: false, blocked: "too_little_traffic" });
    expect(startOf(R.interim, NOW)).toMatchObject({ blocked: "running", read_date: null });
  });

  it("the steps still read right", () => {
    expect(setupSteps(R.off, null, NOW).result.line).toBe("Around Sun 13 Dec, if you start today.");
    const slow = { ...R.off, estimate: { ...ESTIMATE, weeks: 1265 } };
    expect(setupSteps(slow, null, NOW).result.line).toBe(TOO_LITTLE);
    expect(setupSteps(slow, null, NOW).start.button).toBeNull();
    expect(testStatus(R.ended_early, NOW).action).toBe("start-again");
    expect(renderSetup(R.off, null)).toContain(START_LINE);
  });
});

describe("the words", () => {
  it("short, no dashes, nobody to ask", () => {
    const texts: string[] = [];
    for (const r of Object.values(STATES)) {
      const s = setupSteps(r, [START_FREE], NOW);
      texts.push(s.choose.line, s.start.line, s.result.line);
    }
    texts.push(stopConfirm(R.interim).line, stopConfirm(R.positive).line);
    for (const t of texts) {
      expect(t).not.toMatch(/[–—]/);
      expect(t).not.toMatch(/\bSam\b|holdout/i);
      expect(t.split(/\s+/).length).toBeLessThanOrEqual(12);
    }
  });

  it("How this works: the customer stops the test, and the exact meaning of 1 in 5", () => {
    const how = howItWorks(R.interim);
    const cost = how.find((h) => h.k === "What it costs you")?.text ?? "";
    expect(cost).toContain("You stop the test");
    expect(cost).not.toMatch(/We switch/);
    const groups = how.find((h) => h.k === "The two groups")?.text ?? "";
    expect(groups).toContain("at random, once for the whole visit");
  });
});
