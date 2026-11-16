/**
 * Results for a customer whose go live started the test (mock
 * design/mock/sales-readiness/measure-at-go-live.html, sections 06 to 08,
 * approved 2026-10-05; spec docs/specs/measure-at-go-live.md sections 7 and
 * 12): the early headlines, the dashed read-date ring and its line, the
 * ended-itself foot, too little traffic with Start anyway, the steps for a
 * switched-off or buttonless go live, the count link on Results, a picked
 * button's off and remove, and the Admin test size line.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { TestAction } from "../../src/components/analytics/MeasureSetup";
import { ProofCard } from "../../src/components/analytics/ProofCard";
import { ResultsHeadline } from "../../src/components/analytics/ResultsHeadline";
import { TestStatus } from "../../src/components/analytics/TestStatus";
import { ButtonList, ButtonRow } from "../../src/components/conversions/ButtonList";
import { humanizeSectionPath } from "../../src/components/conversions/humanize";
import type { SitePick } from "../../src/components/conversions/useSitePick";
import { ApiError } from "../../src/lib/api";
import {
  type Api,
  DELETE_PATH,
  LIST_PATH,
  PICK_STATUS_PATH,
  PICK_TOKEN_PATH,
  TEST_PATH,
  UPSERT_PATH,
  buttonPlace,
  mintCountPick,
  pollCountPick,
  postTest,
  removeTarget,
  resultsLayout,
  setupSteps,
  showsChangeButton,
  testStatus,
  tooLittleTraffic,
  turnOff,
} from "../../src/lib/measure";
import {
  ENDED_ITSELF,
  FIXED_ON_DAY_14,
  afterLine,
  closedDaysLine,
  controlParts,
  controlStatus,
  timelineFor,
} from "../../src/lib/proof";
import { TOO_LITTLE_HEADLINE, headlineFor } from "../../src/lib/results";
import type {
  ConversionTarget,
  HoldoutControl,
  LiftReport,
  TestPeriod,
  TestStart,
} from "../../src/types/api";
import { CONTROL_OFF, REPORTS } from "./proof-fixtures";

const R = REPORTS;
const NOW = Date.parse("2026-10-13T12:00:00Z");
const LOCK =
  "A test is running, so the buttons it counts cannot change. Stop the test first to change them.";

const EST = {
  percent: 20,
  weeks: 10,
  eligible_per_month: 6000,
  baseline_rate: 0.08,
  rate_source: "measured" as const,
};

function start(over: Partial<TestStart> = {}): TestStart {
  return {
    counted_buttons: 1,
    can_start: true,
    blocked: null,
    estimate: EST,
    read_date: "2026-12-14",
    ...over,
  };
}

const GO_LIVE_TEST: TestPeriod = {
  id: "ht_g",
  percent: 20,
  started_at: Date.parse("2026-10-05T09:10:00Z"),
  ended_at: null,
  started_by: "go_live",
  end_reason: null,
  first_day: "2026-10-05",
  last_day: "2026-10-07",
  day: 3,
  read_date: null,
  read_date_fixed: false,
  weeks_total: null,
  readable_lift: null,
};

function running(test: Partial<TestPeriod>, over: Partial<LiftReport> = {}): LiftReport {
  return {
    ...R.not_enough,
    test: { ...GO_LIVE_TEST, ...test },
    arms: {
      treat: { visits: 800, converting_visits: 20, rate: 0.025 },
      holdout: { visits: 200, converting_visits: 4, rate: 0.02 },
    },
    start: start({ can_start: false, blocked: "running", read_date: null }),
    ...over,
  };
}

/** A: day 3, no date yet. */
const FIRST_WEEK = running({});
/** B: day 9, a date from the test's own visits, still "around". */
const DAYS_7_13 = running({ day: 9, last_day: "2026-10-13", read_date: "2026-12-14" });
/** Day 14 on, too few clicks: the date is fixed. */
const FIXED = running({
  day: 15,
  last_day: "2026-10-19",
  read_date: "2026-12-14",
  read_date_fixed: true,
});
/** C: the read date reached, ended by itself. */
const ENDED_ITSELF_REPORT: LiftReport = {
  ...R.ended,
  test: { ...(R.ended.test as TestPeriod), started_by: "go_live", end_reason: "read_date" },
};
/** D, ended on day 14 for low traffic. */
const LOW_TRAFFIC_ENDED: LiftReport = {
  ...R.ended_early,
  sentence:
    "Too little traffic to measure the versions within a year, so the test ended on 19 Oct. Every visit with a signal gets a version again.",
  test: {
    ...GO_LIVE_TEST,
    day: 15,
    ended_at: Date.parse("2026-10-19T10:00:00Z"),
    end_reason: "low_traffic",
  },
  start: start({
    can_start: false,
    blocked: "too_little_traffic",
    estimate: { ...EST, weeks: 70 },
  }),
};
/** D, known at go live: no test, a start refused for traffic. */
const LOW_TRAFFIC_OFF: LiftReport = {
  ...R.off,
  start: start({
    can_start: false,
    blocked: "too_little_traffic",
    estimate: { ...EST, weeks: 70 },
  }),
};
/** A year with no fixed date. */
const LIMIT_ENDED: LiftReport = {
  ...R.ended_early,
  test: {
    ...GO_LIVE_TEST,
    day: 366,
    ended_at: Date.parse("2027-10-05T10:00:00Z"),
    end_reason: "limit",
  },
};
/** E: switched off at go live, the button saved. */
const SWITCHED_OFF: LiftReport = { ...R.off, start: start() };
/** F: no button at go live. */
const NO_BUTTON: LiftReport = {
  ...R.off,
  metric: { kind: "cta_clicks", labels: [] },
  start: start({ counted_buttons: 0, can_start: false, blocked: "no_button" }),
};

const text = (h: string) =>
  h
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

// ---------------------------------------------------------------------------
// Headlines (section 7)
// ---------------------------------------------------------------------------

describe("the early headlines of a go-live test", () => {
  it("A, first week: no date", () => {
    expect(headlineFor(FIRST_WEEK)).toEqual({
      lead: "Test running.",
      tail: "A date after a week of visits.",
      final: false,
    });
  });

  it("A holds in the starting state too", () => {
    const h = headlineFor({ ...FIRST_WEEK, state: "starting", arms: null });
    expect(h.lead).toBe("Test running.");
  });

  it("B, days 7 to 13: around the estimated date", () => {
    expect(headlineFor(DAYS_7_13)).toEqual({
      lead: "Test running,",
      tail: "result around Mon 14 Dec.",
      final: false,
    });
  });

  it("day 14 on, too few clicks: on the fixed date", () => {
    expect(headlineFor(FIXED).tail).toBe("result on Mon 14 Dec.");
  });

  it("interim keeps the approved headline", () => {
    const h = headlineFor({
      ...R.interim,
      test: { ...(R.interim.test as TestPeriod), started_by: "go_live" },
    });
    expect(h.lead).toContain("so far");
  });

  it("a test started by hand keeps the approved measure-setup headline", () => {
    const h = headlineFor({
      ...FIRST_WEEK,
      test: { ...(FIRST_WEEK.test as TestPeriod), started_by: "customer" },
    });
    expect(h.lead).toBe("Too early to say.");
    expect(headlineFor(R.not_enough).lead).toBe("Too early to say.");
  });

  it("C, read date reached: the approved ended headline", () => {
    expect(headlineFor(ENDED_ITSELF_REPORT).lead).toBe(headlineFor(R.ended).lead);
    expect(headlineFor(ENDED_ITSELF_REPORT).final).toBe(true);
  });

  it("D, too little traffic: one line, ink, never a result", () => {
    for (const r of [LOW_TRAFFIC_ENDED, LOW_TRAFFIC_OFF]) {
      expect(headlineFor(r)).toEqual({
        lead: TOO_LITTLE_HEADLINE,
        tail: null,
        final: false,
        title: true,
      });
    }
    expect(TOO_LITTLE_HEADLINE).toBe("Too little traffic to measure the versions within a year.");
  });

  it("a year without a result says so", () => {
    expect(headlineFor(LIMIT_ENDED)).toEqual({
      lead: "The test ended on 5 Oct, a year after it started.",
      tail: "No clear answer.",
      final: false,
    });
  });

  it("E and F keep the steps' title", () => {
    expect(headlineFor(SWITCHED_OFF).lead).toBe("Measure what Rawuser brings.");
    expect(headlineFor(NO_BUTTON).lead).toBe("Measure what Rawuser brings.");
  });
});

// ---------------------------------------------------------------------------
// Which block leads
// ---------------------------------------------------------------------------

describe("the page's layout", () => {
  it("too little traffic: known at go live or ended on day 14", () => {
    expect(tooLittleTraffic(LOW_TRAFFIC_ENDED)).toBe(true);
    expect(tooLittleTraffic(LOW_TRAFFIC_OFF)).toBe(true);
    expect(resultsLayout(LOW_TRAFFIC_ENDED)).toBe("too-little");
    expect(resultsLayout(LOW_TRAFFIC_OFF)).toBe("too-little");
  });

  it("a test stopped by hand is not too little traffic", () => {
    expect(tooLittleTraffic(R.ended_early)).toBe(false);
    expect(resultsLayout(R.ended_early)).toBe("card");
  });

  it("a go-live test never shows the steps", () => {
    for (const r of [FIRST_WEEK, DAYS_7_13, FIXED, ENDED_ITSELF_REPORT]) {
      expect(resultsLayout(r)).toBe("card");
    }
  });

  it("E, switched off at go live: the steps, step 1 done, on step 2", () => {
    expect(resultsLayout(SWITCHED_OFF)).toBe("setup");
    const s = setupSteps(SWITCHED_OFF, null, NOW);
    expect(s.choose.mode).toBe("done");
    expect(s.start.mode).toBe("on");
  });

  it("F, no button at go live: the steps on step 1", () => {
    expect(resultsLayout(NO_BUTTON)).toBe("setup");
    const s = setupSteps(NO_BUTTON, null, NOW);
    expect(s.choose.mode).toBe("on");
    expect(s.start.mode).toBe("locked");
  });

  it("the too-little headline renders small, with no test period under it", () => {
    const h = renderToStaticMarkup(
      createElement(ResultsHeadline, { report: LOW_TRAFFIC_ENDED, loading: false, small: true }),
    );
    expect(text(h)).toBe(TOO_LITTLE_HEADLINE);
    expect(h).toContain("text-[19px]");
    expect(h).not.toContain("Test period");
  });

  it("Test: Off with no quiet action there; Start anyway sits under the line", () => {
    const test: TestAction = { busy: null, said: null, run: async () => true, clear: () => {} };
    const h = renderToStaticMarkup(
      createElement(TestStatus, {
        report: LOW_TRAFFIC_ENDED,
        test,
        onChoose: () => {},
        noAction: true,
      }),
    );
    expect(text(h)).toBe("Test: Off · Change button");
  });

  it("a running go-live test reads Test: On with Stop test", () => {
    expect(testStatus(FIRST_WEEK, NOW)).toEqual({ on: true, action: "stop" });
  });
});

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

describe("the card for a go-live test", () => {
  it("A: a faint ring, a date after day 7, no line", () => {
    const t = timelineFor(FIRST_WEEK);
    expect(t?.ring).toBe("none");
    expect(t?.start).toBe("Mon 5 Oct · start · day 3");
    expect(t?.end).toBe("a date after day 7");
    expect(afterLine(FIRST_WEEK)).toBeNull();
  });

  it("B: a dashed ring, around the date, and the date is fixed on day 14", () => {
    const t = timelineFor(DAYS_7_13);
    expect(t?.ring).toBe("estimate");
    expect(t?.start).toBe("Mon 5 Oct · start · day 9");
    expect(t?.end).toBe("around Mon 14 Dec");
    expect(afterLine(DAYS_7_13)).toBe(FIXED_ON_DAY_14);
    expect(FIXED_ON_DAY_14).toBe("The date is fixed on day 14.");
    const h = renderToStaticMarkup(
      createElement(ProofCard, { report: DAYS_7_13, superadmin: false }),
    );
    expect(h).toContain("border-dashed border-fg-muted");
    expect(text(h)).toContain("The date is fixed on day 14.");
    expect(text(h)).toContain("Test running · day 9");
  });

  it("fixed: a solid ring and the read date", () => {
    const t = timelineFor(FIXED);
    expect(t?.ring).toBe("fixed");
    expect(t?.end).toBe("Mon 14 Dec · read date");
    expect(afterLine(FIXED)).not.toBe(FIXED_ON_DAY_14);
  });

  it("a hand-started test keeps its words, with the ring that matches its date", () => {
    const t = timelineFor(R.not_enough);
    expect(t?.end).toBe("about Mon 7 Dec · read date, fixed on day 14");
    expect(t?.ring).toBe("estimate");
  });

  it("C: the foot says it ended by itself", () => {
    expect(closedDaysLine(ENDED_ITSELF_REPORT)).toBe(ENDED_ITSELF);
    expect(ENDED_ITSELF).toBe("Ended by itself on its read date");
    expect(closedDaysLine(R.ended)).toMatch(/^Read from closed days/);
    const h = renderToStaticMarkup(
      createElement(ProofCard, { report: ENDED_ITSELF_REPORT, superadmin: false }),
    );
    expect(text(h)).toContain("Ended by itself on its read date");
  });
});

// ---------------------------------------------------------------------------
// The calls
// ---------------------------------------------------------------------------

function recorder(answer: (path: string) => unknown) {
  const calls: { path: string; body: unknown }[] = [];
  const api: Api = async <T>(path: string, init?: RequestInit) => {
    calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null });
    const a = answer(path);
    if (a instanceof Error) throw a;
    return a as T;
  };
  return { api, calls };
}

/** A site pick that has not begun: the list shows its entry row. */
const IDLE_PICK: SitePick = {
  slot: null,
  phase: null,
  said: null,
  begin: () => {},
  open: () => {},
  cancel: () => {},
  use: () => {},
  again: () => {},
  settle: () => {},
};

function target(over: Partial<ConversionTarget>): ConversionTarget {
  return {
    id: "ct_p",
    customer_id: "acme",
    section_path: "count:/pricing",
    label: "Sign up",
    conversion_label: "other",
    enabled: true,
    css_selectors: ["#signup"],
    text_selectors: ["Sign up"],
    structural_selector: "header > a",
    created_at: 0,
    updated_at: 0,
    ...over,
  };
}

describe("Start anyway", () => {
  it("sends anyway: true only when asked", async () => {
    const report = { ...R.not_enough };
    const { api, calls } = recorder(() => ({ report }));
    await postTest("acme", "start", api, { anyway: true });
    await postTest("acme", "start", api);
    await postTest("acme", "stop", api, { anyway: true });
    expect(calls.map((c) => c.path)).toEqual([TEST_PATH, TEST_PATH, TEST_PATH]);
    expect(calls[0]?.body).toEqual({ customer_id: "acme", action: "start", anyway: true });
    expect(calls[1]?.body).toEqual({ customer_id: "acme", action: "start" });
    expect(calls[2]?.body).toEqual({ customer_id: "acme", action: "stop" });
  });
});

describe("Pick it on your page, with the count link", () => {
  it("mints a link for the page", async () => {
    const { api, calls } = recorder(() => ({
      token: "t",
      page_path: "/",
      expires_in_s: 900,
      link: "https://acme.dev/#rawuser_pick=t",
    }));
    const out = await mintCountPick("acme", "/", api);
    expect(out).toEqual({ kind: "ok", link: "https://acme.dev/#rawuser_pick=t", pagePath: "/" });
    expect(calls[0]).toEqual({
      path: PICK_TOKEN_PATH,
      body: { customer_id: "acme", page_path: "/" },
    });
  });

  it("a 409 comes back as its sentence", async () => {
    const { api } = recorder(
      () => new ApiError(409, `API error 409: ${JSON.stringify({ error: LOCK })}`),
    );
    expect(await mintCountPick("acme", "/", api)).toEqual({ kind: "refused", sentence: LOCK });
    expect(await pollCountPick("acme", "/", api)).toEqual({ kind: "refused", sentence: LOCK });
  });

  it("polls until landed, on the minted page", async () => {
    const t = target({ section_path: "count:/" });
    let n = 0;
    const { api, calls } = recorder(() =>
      ++n < 3
        ? { landed: false, page_path: "/" }
        : { landed: true, page_path: "/", target: t, items: [t] },
    );
    expect((await pollCountPick("acme", "/", api)).kind).toBe("waiting");
    expect((await pollCountPick("acme", "/", api)).kind).toBe("waiting");
    expect(await pollCountPick("acme", "/", api)).toEqual({
      kind: "landed",
      target: t,
      items: [t],
    });
    expect(calls[0]?.path).toBe(`${PICK_STATUS_PATH}?customer_id=acme&page_path=%2F`);
  });

  it("an unreadable pick is said; a network hiccup keeps waiting", async () => {
    const bad = recorder(
      () =>
        new ApiError(
          500,
          `API error 500: ${JSON.stringify({ error: "picked button unreadable" })}`,
        ),
    );
    expect(await pollCountPick("acme", "/", bad.api)).toEqual({
      kind: "failed",
      message: "picked button unreadable",
    });
    const net = recorder(() => new TypeError("Failed to fetch"));
    expect((await pollCountPick("acme", "/", net.api)).kind).toBe("waiting");
  });
});

describe("a picked button in the list: its words, its page, off and remove (privacy review 9.8, 5)", () => {
  const picked = target({});
  const slot = target({
    id: "ct_1",
    section_path: "hero.cta.label",
    label: "Start free",
    enabled: false,
  });

  it("says which page it was picked on", () => {
    expect(buttonPlace("count:/pricing")).toBe("Picked on /pricing");
    expect(buttonPlace("count:/")).toBe("Picked on the homepage");
    expect(buttonPlace("hero.cta.label")).toBe("Homepage, top");
    expect(humanizeSectionPath("count:/pricing")).toBe("Picked on /pricing");
  });

  it("a button on every page says so in the list and in step 1 (the pilot's navbar link)", () => {
    expect(buttonPlace("a[href$=contact]")).toBe("Counts on every page");
    expect(buttonPlace("site:a[href$=contact]")).toBe("Counts on every page");
    expect(buttonPlace("hero.cta.label", true)).toBe("Counts on every page");
    expect(buttonPlace("a[href$=contact]", false)).toBe("Homepage");
    const site = target({
      id: "ct_site",
      section_path: "a[href$=contact]",
      label: "Əlaqə",
      conversion_label: "contact",
    });
    const h = renderToStaticMarkup(
      createElement(ButtonList, {
        customerId: "acme",
        items: [slot, site],
        blocked: false,
        onItems: () => {},
        pick: IDLE_PICK,
      }),
    );
    expect(text(h)).toContain("“Əlaqə” on every page");
    expect(text(h)).not.toContain("“Əlaqə” on the homepage");
    const s = setupSteps({ ...R.off, start: start() }, [site], NOW);
    expect(s.choose.chosen).toMatchObject({ label: "Əlaqə", place: "counts on every page" });
  });

  it("every row has its own switch; a picked button says its page; Remove sits behind the menu", () => {
    const h = renderToStaticMarkup(
      createElement(ButtonList, {
        customerId: "acme",
        items: [slot, picked],
        blocked: false,
        onItems: () => {},
        pick: IDLE_PICK,
        menuOpenId: picked.id,
      }),
    );
    const t = text(h);
    expect(t).toContain("“Start free” on the homepage Off");
    expect(t).toContain("“Sign up” on /pricing On");
    expect((h.match(/role="switch"/g) ?? []).length).toBe(2);
    // The open menu: a picked-on-a-page row offers Remove only (Pick again is a site row's).
    expect((t.match(/Remove/g) ?? []).length).toBe(1);
    expect(t).not.toContain("Turn off");
  });

  it("an off button reads Off, lighter, and keeps Remove behind its menu", () => {
    const h = renderToStaticMarkup(
      createElement(ButtonRow, {
        target: target({ enabled: false }),
        onToggle: () => {},
        onRemove: () => {},
        menuOpen: true,
      }),
    );
    expect(h).toContain('aria-checked="false"');
    expect(text(h)).toContain("“Sign up” on /pricing Off");
    expect(text(h)).toContain("Remove");
    expect(h).toContain("font-normal text-fg-muted");
  });

  it("Turn off keeps the button's own selectors, then reads the list", async () => {
    const { api, calls } = recorder((p) => (p.startsWith(LIST_PATH) ? { items: [] } : {}));
    expect(await turnOff("acme", picked, api)).toEqual({ kind: "ok", items: [] });
    expect(calls[0]).toEqual({
      path: UPSERT_PATH,
      body: {
        customer_id: "acme",
        id: "ct_p",
        section_path: "count:/pricing",
        label: "Sign up",
        conversion_label: "other",
        enabled: false,
        css_selectors: ["#signup"],
        text_selectors: ["Sign up"],
        structural_selector: "header > a",
      },
    });
    expect(calls[1]?.path).toBe(`${LIST_PATH}?customer_id=acme`);
  });

  it("Remove deletes it; a test lock is said as is", async () => {
    const { api, calls } = recorder((p) =>
      p.startsWith(LIST_PATH) ? { items: [] } : { ok: true },
    );
    expect((await removeTarget("acme", picked, api)).kind).toBe("ok");
    expect(calls[0]).toEqual({ path: DELETE_PATH, body: { id: "ct_p" } });
    const locked = recorder(
      () => new ApiError(409, `API error 409: ${JSON.stringify({ error: LOCK })}`),
    );
    expect(await removeTarget("acme", picked, locked.api)).toEqual({
      kind: "refused",
      sentence: LOCK,
    });
    expect(await turnOff("acme", picked, locked.api)).toEqual({ kind: "refused", sentence: LOCK });
  });
});

// ---------------------------------------------------------------------------
// Admin, the test size row (section 08)
// ---------------------------------------------------------------------------

describe("the Admin test size line", () => {
  const STARTED = Date.parse("2026-10-05T09:10:00Z");
  const ENDED = Date.parse("2026-12-14T10:00:00Z");
  function ctl(over: Partial<HoldoutControl>): HoldoutControl {
    return { ...CONTROL_OFF, ...over };
  }
  function ended(end_reason: "read_date" | "low_traffic" | "limit" | "customer") {
    return ctl({
      history: [
        {
          id: "ht_g",
          percent: 20,
          started_at: STARTED,
          ended_at: ENDED,
          read_date: "2026-12-14",
          started_by: "go_live",
          started_actor: "u_1",
          end_reason,
          ended_actor: end_reason === "customer" ? "u_1" : "system",
        },
      ],
    });
  }

  it("running: started at go live, in ink", () => {
    const parts = controlParts(
      ctl({
        stored_percent: 20,
        since: STARTED,
        running: {
          id: "ht_g",
          percent: 20,
          started_at: STARTED,
          read_date: "2026-12-14",
          read_date_fixed: false,
          started_by: "go_live",
          started_actor: "u_1",
        },
      }),
    );
    expect(parts.find((p) => p.strong)?.text).toBe("started at go live");
    expect(parts.map((p) => p.text).join("")).toMatch(
      /^20% (since|starts) .* · started at go live · read date about Mon 14 Dec, fixed on day 14$/,
    );
  });

  it("the three automatic ends", () => {
    expect(controlStatus(ended("read_date"))).toBe(
      "Started at go live · ended itself on its read date, Mon 14 Dec",
    );
    expect(controlStatus(ended("low_traffic"))).toBe(
      "Started at go live · ended on day 14, too little traffic",
    );
    expect(controlStatus(ended("limit"))).toBe("Started at go live · ended after 365 days");
  });

  it("a stop by the customer, or a test from before, reads as before", () => {
    expect(controlStatus(ended("customer"))).toBe("No test since the last one ended on 14 Dec");
    expect(controlStatus(CONTROL_OFF)).toBe("No test has run");
  });
});

// ---------------------------------------------------------------------------
// "Change button" beside Test: Off (privacy review, section 9 item 8)
// ---------------------------------------------------------------------------

describe("the button list stays one click away when Test is Off", () => {
  const test: TestAction = { busy: null, said: null, run: async () => true, clear: () => {} };
  const row = (report: LiftReport, noAction = false) =>
    text(
      renderToStaticMarkup(
        createElement(TestStatus, { report, test, onChoose: () => {}, noAction }),
      ),
    );

  it("an ended test: Start again and Change button", () => {
    const ended = { ...R.ended, start: start() };
    expect(row(ended)).toBe("Test: Off · Start again · Change button");
    expect(row(ENDED_ITSELF_REPORT)).toContain("Change button");
    expect(row({ ...R.ended_early, start: start() })).toContain("Change button");
  });

  it("too little traffic, ended on day 14 or known at go live: Change button under noAction", () => {
    expect(row(LOW_TRAFFIC_ENDED, true)).toBe("Test: Off · Change button");
    expect(row(LOW_TRAFFIC_OFF, true)).toBe("Test: Off · Change button");
    expect(showsChangeButton(LOW_TRAFFIC_OFF, true, NOW)).toBe(true);
  });

  it("an ended test with no button left: Choose button once, not twice", () => {
    const none = {
      ...R.ended,
      metric: { kind: "cta_clicks" as const, labels: [] },
      start: start({ counted_buttons: 0, can_start: false, blocked: "no_button" }),
    };
    expect(row(none)).toBe("Test: Off · Choose button");
  });

  it("a running test keeps Stop test only; the steps keep their own Change", () => {
    expect(row(FIRST_WEEK)).toBe("Test: On · Stop test");
    expect(showsChangeButton(FIRST_WEEK, false, NOW)).toBe(false);
    expect(showsChangeButton(FIRST_WEEK, true, NOW)).toBe(false);
    expect(row(SWITCHED_OFF)).toBe("Test: Off");
    expect(row(NO_BUTTON)).toBe("Test: Off");
  });
});
